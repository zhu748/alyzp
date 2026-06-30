# syntax=docker/dockerfile:1
# Bun-based Dockerfile for zcode-proxy — designed for Render (and any other
# container host that supports Docker: Fly.io, Railway, Cloud Run, etc.).
#
# Why Bun (not Node)?
#   - server.ts uses Bun.serve() directly, so we MUST run on Bun.
#   - oven/bun:1.2-slim is a slim image that supports both Bun runtime
#     and standard Linux glibc/musl tools Render's healthcheck needs.
#     Note: bun.lock uses the new JSON lockfile format (lockfileVersion: 1)
#     introduced in Bun 1.2, so we MUST use Bun >= 1.2 here.
#
# v0.2.0.8 hardening:
#   - Multi-stage build (deps stage cached separately from source).
#   - `oven/bun:1.2-slim` base (smaller than `-debian`).
#   - `tini` as PID 1 for proper signal forwarding / zombie reaping.
#   - Non-root `zcode` user (uid 1001) — a container escape can no longer
#     grant root inside the image.

# --- Stage 1: dependencies (cached layer) -----------------------------------
FROM oven/bun:1.2-slim AS deps
WORKDIR /app
# Copy only lock manifests so this layer caches across source edits.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
# v0.2.1.8+: Download Chromium binary for Playwright. The `postinstall`
# script in package.json does this on `bun install`, but `--production`
# skips scripts in some Bun versions — so we run it explicitly here to
# be safe. The binary lands in node_modules/playwright-core/.local-browsers
# and gets copied to the runtime stage with the rest of node_modules.
#
# Why not use a system Chromium package? Playwright pins to a specific
# Chromium build it's tested against — using a system Chromium risks
# version drift and missing CDP features the stealth plugin relies on.
RUN bunx playwright install chromium

# --- Stage 2: runtime --------------------------------------------------------
FROM oven/bun:1.2-slim AS runtime

# tini: minimal init for proper SIGTERM forwarding + zombie reaping.
# Render sends SIGTERM on scale-down; without tini, Bun might exit uncleanly
# and lose in-flight SSE responses.
#
# v0.2.1.8+: Chromium system dependencies for Playwright headless.
# The captcha solver now uses Playwright + stealth (real Chromium binary)
# instead of JSDOM — Aliyun's risk control detects JSDOM with ~100%
# accuracy (verifyCode F001 on every solve). Playwright needs these
# shared libraries to launch headless Chromium.
#
# `playwright install-deps chromium` would install these automatically,
# but that command requires playwright to be installed first (chicken-
# and-egg with the multi-stage build). Listing them explicitly here means
# the runtime stage doesn't need playwright's CLI at all — the deps are
# system-level and the binary ships inside node_modules.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       tini \
       # Chromium runtime deps (Playwright headless minimum set)
       libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
       libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
       libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
       libatspi2.0-0 libxshmfence1 \
       # Font fallback (Aliyun SDK injects CSS that references CJK fonts;
       # without these, canvas measurements return 0 and trigger detection)
       fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Render injects PORT at runtime. We default to 8080 for local `docker run`.
ENV ZCODE_PROXY_PORT=8080 \
    ZCODE_PROXY_CONFIG=/data/config.yaml \
    ZCODE_PROXY_STORE_DIR=/data/.zcode-proxy \
    NODE_ENV=production

# Non-root user. uid 1001 avoids colliding with any host-assigned uid in
# Render's container runtime (which typically uses 0 or 1000+).
RUN adduser --disabled-password --gecos "" --uid 1001 zcode

WORKDIR /app

# Copy installed dependencies from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy source + entrypoint. All files are chown'd to the non-root user so
# runtime writes (config.yaml seed, credential store under /data) succeed.
COPY --chown=zcode:zcode package.json bun.lock tsconfig.json ./
COPY --chown=zcode:zcode src ./src
COPY --chown=zcode:zcode config.example.yaml index.html render-start.sh ./
RUN chmod +x render-start.sh

# Writable data dir. On Render free tier this is ephemeral (lost on restart);
# on paid Render with a persistent disk mounted at /data it survives restarts.
# /data is only needed if you want OAuth multi-account credentials to persist
# across deploys. In apikey mode (the recommended Render setup), /data only
# holds the auto-generated config.yaml — losing it on restart is harmless
# because env vars repopulate the secrets.
RUN mkdir -p /data && chown -R zcode:zcode /data
VOLUME ["/data"]

EXPOSE 8080

# Render uses TCP health checks via healthCheckPath in render.yaml, but we
# also bake in a Docker HEALTHCHECK for non-Render hosts (Fly.io, Cloud Run).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+process.env.ZCODE_PROXY_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER zcode

# tini forwards SIGTERM/SIGINT to the bun process and reaps zombies.
ENTRYPOINT ["/usr/bin/tini", "--"]

# render-start.sh:
#   1. Maps Render's $PORT -> $ZCODE_PROXY_PORT
#   2. Falls back to /tmp if /data is not writable (free tier without disk)
#   3. Seeds config.yaml from env vars on first run
CMD ["./render-start.sh"]
