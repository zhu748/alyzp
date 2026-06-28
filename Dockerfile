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

# --- Stage 2: runtime --------------------------------------------------------
FROM oven/bun:1.2-slim AS runtime

# tini: minimal init for proper SIGTERM forwarding + zombie reaping.
# Render sends SIGTERM on scale-down; without tini, Bun might exit uncleanly
# and lose in-flight SSE responses.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
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
