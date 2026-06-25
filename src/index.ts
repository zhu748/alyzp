/**
 * Entry point — load config, create auth manager, start proxy server.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { loadConfig } from "./config/loader.js";
import { EXAMPLE_CONFIG_YAML } from "./config/template.js";
import { AuthManager } from "./auth/manager.js";
import { startServer } from "./server/server.js";
import { loadCredential, saveCredential, clearCredential, getStorePath, exportAccounts, listAccounts } from "./auth/store.js";
import { ZaiOAuthClient, BigmodelOAuthClient } from "./auth/oauth.js";
import { KeyResolver } from "./auth/resolver.js";
import { readZCodeImport } from "./auth/zcode-config.js";
import type { Credential, PlanId } from "./auth/types.js";
import type { ProviderId } from "./provider/types.js";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const VERSION = "0.1.5";

// ---------------------------------------------------------------------------
// Process-level error handlers — installed ONCE before main() so they cover
// every code path including the dynamic import("./admin/api.js") below.
//
// Without these, ANY uncaught async error kills the Bun process — that's the
// #1 cause of "exe在window运行时有时候不知道为什么会用着用着突然退出". A single
// rejected promise from an SSE observer, an unhandled exception in a captcha
// callback, or an error thrown by Bun.inspect during console.log formatting
// would all silently terminate the process with no log trail.
//
// We LOG and CONTINUE rather than crash. For a long-running local proxy,
// crashing mid-stream on a single bad request is worse than logging the error
// and serving the next request. The proxy's per-request try/catch in
// handler.ts already returns 502 to the client on upstream failures — these
// handlers are the safety net for errors that escape THAT catch.
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  // Bun's default behavior is to print + exit. We override to print + continue.
  // The error is logged to stderr (visible in the dashboard log panel via the
  // console.error interceptor installed in serve()).
  try {
    console.error("[uncaughtException]", err?.stack ?? err);
  } catch {
    // If even console.error throws (e.g. during shutdown), fall back to raw write.
    try { process.stderr.write(`[uncaughtException] ${String(err)}\n`); } catch {}
  }
});
process.on("unhandledRejection", (reason) => {
  try {
    console.error("[unhandledRejection]", reason instanceof Error ? reason.stack ?? reason : String(reason));
  } catch {
    try { process.stderr.write(`[unhandledRejection] ${String(reason)}\n`); } catch {}
  }
});

main();

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "serve";

  if (cmd === "auth") {
    authCommand(args.slice(1));
  } else if (cmd === "serve" || cmd.endsWith(".yaml") || cmd.endsWith(".yml")) {
    // `serve` may be followed by either a positional path or `--config <path>`
    // (or `--config=<path>`). The legacy start.bat/start.sh used `--config`,
    // which the old parser mis-read as the path itself — creating a file
    // literally named `--config` and silently loading the bundled template.
    const configPath = cmd === "serve" ? parseServeConfigArg(args.slice(1)) : cmd;
    serve(configPath).catch(fatalError);
  } else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(`zcode-proxy ${VERSION}`);
  } else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
  } else {
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
  }
}

/**
 * Parse the arguments after `serve`, accepting both forms:
 *   zcode-proxy serve config.yaml
 *   zcode-proxy serve --config config.yaml
 *   zcode-proxy serve --config=config.yaml
 */
function parseServeConfigArg(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--config" && i + 1 < rest.length) return rest[i + 1];
    if (a.startsWith("--config=")) return a.slice("--config=".length);
    if (!a.startsWith("-")) return a; // first positional non-flag arg
  }
  return undefined;
}

/**
 * Last-resort error handler. Prints the error and waits briefly so the user
 * can read it before the window closes — important on Windows where
 * double-clicking the exe gives no parent terminal to scroll back.
 */
async function fatalError(err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\n[FATAL] " + msg);
  console.error("\nServer could not start. This window will close in 15 seconds.");
  // Give the user time to read the message before the window disappears.
  // 15s is long enough to read but short enough to not feel stuck when run
  // from an interactive terminal.
  await new Promise(r => setTimeout(r, 15_000));
  process.exit(1);
}

function printHelp(): void {
  console.log(`zcode-proxy ${VERSION}

Usage:
  zcode-proxy serve [config.yaml]   Start the proxy server (default)
  zcode-proxy auth login <provider> Login via OAuth (provider: zai | bigmodel)
  zcode-proxy auth login <provider> --import
                                    Import API key from ~/.zcode/v2/config.json
  zcode-proxy auth logout           Clear stored credentials
  zcode-proxy auth status           Show current authentication state
  zcode-proxy auth export           Print base64 credential for remote deploy
  zcode-proxy version               Show version
  zcode-proxy help                  Show this help

Examples:
  zcode-proxy                       Start server with default config.yaml
  zcode-proxy auth login bigmodel   OAuth login for Bigmodel
  zcode-proxy auth login bigmodel --import
                                    Import existing key from ZCode config
  zcode-proxy auth status           Check if logged in
  zcode-proxy auth export           Print ZCODE_OAUTH_CREDENTIAL value for Render
`);
}

async function serve(configPath?: string): Promise<void> {
  const path = configPath ?? process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    writeFileSync(path, EXAMPLE_CONFIG_YAML, "utf-8");
    console.log(`Created ${path} from bundled template.`);
    console.log(`Edit auth.apiKey, or run: zcode-proxy auth login <zai|bigmodel>\n`);
  }
  const config = loadConfig(path);

  const auth = new AuthManager({
    mode: config.auth.mode,
    provider: config.provider,
    apiKey: config.auth.apiKey ?? config.providers[config.provider].credential,
    // Provide access to all stored credentials so the proxy can auto-switch
    // to a different account when the current one fails repeatedly.
    // In apikey mode there's only one credential, so switching is a no-op
    // (switchToNextCredential returns null) — that's fine.
    listAllCredentials: async () => {
      const accounts = await exportAccounts();
      return accounts.map(a => a.credential);
    },
  });

  if (config.auth.mode === "oauth") {
    const cred = await loadCredential();
    if (!cred) {
      // DON'T throw / exit — let the server start so the user can open the
      // dashboard and log in via OAuth. The previous behavior (throw + exit
      // with "Not logged in for OAuth mode") was a chicken-and-egg trap:
      // the user couldn't open the dashboard to log in because the server
      // refused to start, and couldn't log in from the CLI without a
      // terminal (Windows exe double-click scenario).
      //
      // Now: server starts, dashboard is accessible, and any /v1/* request
      // before login returns 503 "credential_unavailable" (handled by
      // AuthManager.getCredential throwing, which proxyRequest catches).
      // The user opens the dashboard, clicks "OAuth 登录" or "从 ZCode 导入",
      // and the new credential is hot-swapped into the running server via
      // opts.auth.setOAuthCredential — no restart needed.
      console.warn("");
      console.warn("  ⚠  OAuth mode: no credential stored yet.");
      console.warn("  ⚠  The server is starting anyway so you can log in via the dashboard.");
      console.warn(`  ⚠  Open http://127.0.0.1:${config.server.port}/admin and click "OAuth 登录" or "从 ZCode 导入".`);
      console.warn("  ⚠  API requests will return 503 until a credential is added.");
      console.warn("");
    } else {
      auth.setOAuthCredential(cred);
      // Resolve the effective plan from the credential. Priority:
      //   1. cred.plan — explicit (set by v0.1.4+ import or dashboard)
      //   2. inferred from cred.jwt — if a JWT is present, the credential
      //      came from start-plan flow (JWTs are start-plan exclusive).
      //      This handles v1 imports from zcode-api-ref which have no plan
      //      field but DO carry a start-plan JWT.
      //   3. config.yaml's plan — final fallback (default coding-plan)
      //
      // The credential's plan (explicit or inferred) wins over config.yaml
      // because the credential determines which upstream URL and auth headers
      // we use — sending a start-plan JWT to a coding-plan endpoint would
      // fail with 401, and a coding-plan API key to zcode.z.ai would fail too.
      let effectivePlan: PlanId;
      let planSource: string;
      if (cred.plan) {
        effectivePlan = cred.plan;
        planSource = `explicit on credential`;
      } else if (cred.jwt) {
        effectivePlan = "start-plan";
        planSource = `inferred from JWT presence (v1 credential, no plan field)`;
      } else {
        // No plan on credential, no JWT — use config.yaml verbatim.
        // Don't change config.plan; just log the source.
        console.log(`  Using plan from config.yaml: ${config.plan}`);
        effectivePlan = config.plan;
        planSource = ""; // unused
      }

      if (cred.plan || cred.jwt) {
        // We inferred/overrode the plan from the credential
        if (effectivePlan !== config.plan) {
          console.log(`  Overriding plan: ${config.plan} → ${effectivePlan} (source: ${planSource})`);
          config.plan = effectivePlan;
        } else {
          console.log(`  Plan: ${effectivePlan} (source: ${planSource})`);
        }
      }
    }
  }

  // Intercept console.log for admin dashboard log streaming.
  // Wrapped in try/catch so a logging failure never breaks the actual console output.
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const { appendLog } = await import("./admin/api.js");

  /**
   * Serialize a single console argument to a single string.
   *
   * Three things the old code got wrong:
   *   1. `JSON.stringify(Error)` returns "{}" because Error properties are
   *      non-enumerable — so errors were logged as empty objects.
   *   2. The .stack property (most useful diagnostic) was dropped in favor
   *      of just .message.
   *   3. `JSON.stringify` throws on circular structures (TypeError) — caught
   *      silently, so the log line was lost entirely.
   */
  const serialize = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error) {
      // Preserve the stack trace — it's the single most useful diagnostic.
      return a.stack ?? `${a.name}: ${a.message}`;
    }
    if (typeof a === "number" || typeof a === "boolean" || a === null || a === undefined) {
      return String(a);
    }
    try {
      return JSON.stringify(a);
    } catch {
      // Circular structure or other stringify failure — fall back to String().
      // String() on objects returns "[object Object]", which is unhelpful, so
      // try a custom inspect for plain objects before giving up.
      if (a && typeof a === "object") {
        try {
          // bun's Bun.inspect handles circular refs and is much more useful
          // than "[object Object]" for nested data.
          // Using globalThis.Bun to avoid import overhead in non-Bun envs.
          const BunRef = (globalThis as any).Bun;
          if (BunRef && typeof BunRef.inspect === "function") {
            return BunRef.inspect(a);
          }
        } catch { /* fall through */ }
      }
      return String(a);
    }
  };

  // logging.level enforcement: filter what gets buffered for the dashboard
  // based on the configured minimum level. The console itself still prints
  // everything (origLog/origError/origWarn are called unconditionally) —
  // this only controls what the admin dashboard exposes. Previously the
  // YAML field was parsed but never enforced, silently ignoring user config.
  const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const minLevel = LEVEL_ORDER[config.logging.level] ?? 1; // default info

  const safeAppend = (level: string, levelRank: number, args: unknown[]) => {
    if (levelRank < minLevel) return; // below configured minimum — skip
    try { appendLog(level, args.map(serialize).join(" ")); }
    catch (e) { /* appendLog itself may throw if log buffer is full; never let it kill the request */ void e; }
  };
  console.log = (...args: unknown[]) => { origLog(...args); safeAppend("info", 1, args); };
  console.error = (...args: unknown[]) => { origError(...args); safeAppend("error", 3, args); };
  console.warn = (...args: unknown[]) => { origWarn(...args); safeAppend("warn", 2, args); };

  // CORS allowlist is now loaded via config.corsAllowList (resolved from
  // ZCODE_PROXY_CORS_ALLOWLIST env var in loadConfig) and passed through
  // dependency injection — no more globalThis hack.

  const server = startServer({ config, auth, configPath: path });
  const url = `http://${server.hostname}:${server.port}`;
  console.log(`zcode-proxy ${VERSION} listening on ${url}`);
  console.log(`  provider: ${config.provider}`);
  console.log(`  plan: ${config.plan}`);
  console.log(`  auth mode: ${config.auth.mode}`);
  console.log(`  models: ${config.models.length} available`);
  // Helpful access hint: when bound to 0.0.0.0, the user must use 127.0.0.1
  // (or localhost, or the machine's LAN IP) to reach the proxy. Browsers on
  // Windows especially refuse to connect to http://0.0.0.0:port — this is
  // the #1 "I can't open the dashboard" cause for Windows users.
  if (server.hostname === "0.0.0.0" || server.hostname === "::") {
    console.log(`  dashboard: http://127.0.0.1:${server.port}/admin`);
    console.log(`  (bound to 0.0.0.0 — access via 127.0.0.1, localhost, or your LAN IP)`);
  } else {
    console.log(`  dashboard: ${url}/admin`);
  }

  // Security warning: if proxyApiKey is unset, anyone on the network can
  // call /v1/* with this proxy and burn the user's quota. Surface this
  // prominently at startup so users don't accidentally run open.
  if (!config.auth.proxyApiKey) {
    console.warn("");
    console.warn("  ⚠  WARNING: auth.proxyApiKey is NOT configured.");
    console.warn("  ⚠  Anyone who can reach this port can use your upstream credentials.");
    console.warn("  ⚠  Set `auth.proxyApiKey` in config.yaml or env ZCODE_PROXY_API_KEY.");
    console.warn("");
  }

  // Graceful shutdown: stop accepting new connections, give in-flight
  // requests up to 30s to finish (long enough for most LLM streams to
  // complete, short enough that a stuck process won't hang forever).
  // The old code called server.stop(true) (force=true) followed by
  // process.exit(0) — which truncated SSE streams and long reasoning
  // responses mid-flight.
  //
  // BUGFIX (this version): the old Promise.race didn't catch rejection
  // from server.stop(), so if stop() rejected (e.g. already-stopped
  // server, internal Bun error), the .then(() => process.exit(0)) never
  // fired and the process hung indefinitely until killed externally.
  // Now we use .finally() so rejection ALSO exits, and a second signal
  // (Ctrl+C) force-exits immediately as the comment always claimed.
  let shuttingDown = false;
  let forceExitScheduled = false;
  const shutdown = (signal: string) => {
    if (forceExitScheduled) return; // already forcing — nothing more to do
    if (shuttingDown) {
      // Second signal — force exit IMMEDIATELY. The old code only set
      // shuttingDown=true again and relied on the 30s timeout, which
      // contradicted the user-facing "press Ctrl+C again to force-exit"
      // message. Now we honor it.
      console.log(`\nReceived second ${signal}, force-exiting now.`);
      forceExitScheduled = true;
      process.exit(130); // 128 + SIGINT(2) — conventional exit code for Ctrl+C
      return;
    }
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    console.log("  (press Ctrl+C again to force-exit)");
    // server.stop(false) = wait for in-flight requests; returns Promise.
    // We race it against a 30s timeout so we don't hang forever.
    // .finally (not .then) ensures we exit EVEN IF server.stop() rejects —
    // previously a rejection here left the process in a hung state with no
    // log trail, requiring Task Manager to kill on Windows.
    Promise.race([
      server.stop().catch((err) => {
        console.error("[shutdown] server.stop() rejected:", err);
      }),
      new Promise<void>(r => setTimeout(r, 30_000)),
    ]).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function authCommand(args: string[]): void {
  const sub = args[0];

  if (sub === "login") {
    authLogin(args.slice(1)).catch(fatalError);
  } else if (sub === "logout") {
    authLogout();
  } else if (sub === "status") {
    authStatus().catch(fatalError);
  } else if (sub === "export") {
    authExport().catch(fatalError);
  } else {
    console.error("Usage: zcode-proxy auth <login|logout|status|export>");
    process.exit(1);
  }
}

async function authLogin(args: string[]): Promise<void> {
  const provider = args[0] as ProviderId | undefined;
  const importMode = args.includes("--import");
  const planFlag = args.find(a => a.startsWith("--plan="));
  const plan: PlanId = planFlag === "--plan=start-plan" ? "start-plan" : "coding-plan";

  if (!provider || (provider !== "zai" && provider !== "bigmodel")) {
    console.error("Usage: zcode-proxy auth login <zai|bigmodel> [--import] [--plan=coding-plan|start-plan]");
    process.exit(1);
  }

  // Helpful hint when --plan= is omitted. For --import mode, the proxy
  // auto-detects the active plan from ZCode config, so no hint needed.
  // For OAuth mode, plan determines which credential structure to build,
  // so we remind the user to be explicit if they omit it.
  if (!planFlag && !importMode) {
    console.log(`[hint] --plan= not specified, defaulting to coding-plan.`);
    console.log(`[hint] If you meant to use start-plan, re-run with: --plan=start-plan`);
    console.log();
  }

  console.log(`Logging in: ${provider}${importMode ? " (import)" : " (OAuth)"} [${plan}]\n`);

  let cred: Credential;

  if (importMode) {
    // For --import: pass undefined when --plan= was NOT specified, so
    // readZCodeImport can auto-detect from ZCode config's enabled flag.
    // Only pass plan when user explicitly set --plan= (forced override).
    // readZCodeImport merges config.json + credentials.json (the latter
    // supplements email/userId and drives provider auto-detect).
    const source = readZCodeImport(provider, planFlag ? plan : undefined);
    if (planFlag) {
      console.log(`[import] --plan=${plan} specified, overriding auto-detected plan.`);
    }
    console.log(`[import] Read from ~/.zcode/v2/ (config.json + credentials.json).`);
    if (source.email) console.log(`[import] Email (from credentials.json): ${source.email}`);
    // A raw access_token JWT (no plaintext apiKey in config.json) needs the
    // biz-API exchange to become a usable apiKey.secret.
    if (source.isRawAccessToken) {
      console.log("[import] Resolving access_token via biz API...");
      const resolver = new KeyResolver();
      cred = await resolver.resolveCredential(source.apiKey, source.provider, source.userId, source.plan, source.jwt, source.email);
    } else {
      cred = {
        apiKey: source.apiKey,
        provider: source.provider,
        plan: source.plan,
        jwt: source.jwt,
        userId: source.userId,
        email: source.email,
      };
    }
    // Auto-generate name: prefer {email}-{plan} (like OAuth) when we have an
    // email; otherwise fall back to zcode(N)-{plan} numbering.
    if (source.email) {
      cred.name = `${source.email}-${source.plan}`;
    } else {
      try {
        const list = await listAccounts();
        const zcodeCount = list.accounts.filter(a =>
          (a.name || "").startsWith("zcode(")
        ).length;
        cred.name = `zcode(${zcodeCount + 1})-${source.plan}`;
      } catch {
        // Non-fatal: if store read fails, just leave name unset
      }
    }
  } else {
    const { accessToken, userId, jwt, email } = await runOAuth(provider);
    console.log("\nResolving API key...");
    const resolver = new KeyResolver();
    cred = await resolver.resolveCredential(accessToken, provider, userId, plan, jwt, email);
    // Auto-generate name from email + plan (vceshi0.0.4+).
    // Falls back to no name (label auto-generated by store) if email is missing.
    if (email) {
      cred.name = `${email}-${plan}`;
    }
  }

  // Import mode: preserve the currently-active credential — the new account
  // is added but NOT activated. The user can switch to it manually via the
  // dashboard. OAuth login (non-import) DOES activate, matching the
  // historical behavior where `auth login` is the primary login flow.
  // This matches the user's requirement: "通过zcode导入的凭证会直接开启它，
  // 应该不默认开启，而是保留原来凭证开启，就是不要立马切换新导入凭证".
  if (importMode) {
    await saveCredential(cred, { keepActive: true });
  } else {
    await saveCredential(cred);
  }
  // Use cred.plan (auto-detected) instead of the local `plan` variable,
  // because import mode may have auto-detected a different plan than the default.
  const actualPlan = cred.plan || plan;
  console.log(`\nLogged in as ${provider} (${actualPlan}).`);
  console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  if (cred.email) console.log(`  Email:   ${cred.email}`);
  if (cred.name) console.log(`  Name:    ${cred.name}`);
  console.log(`  Plan:    ${actualPlan}`);
  console.log(`  Stored:  ${getStorePath()}`);
}

function authLogout(): void {
  if (!existsSync(getStorePath())) {
    console.log("Not logged in.");
    return;
  }
  clearCredential();
  console.log("Logged out. Credentials removed.");
}

async function authStatus(): Promise<void> {
  const cred = await loadCredential();
  if (!cred) {
    console.log("Not logged in.");
    console.log("Run: zcode-proxy auth login <zai|bigmodel>");
    return;
  }
  console.log(`Logged in: ${cred.provider}`);
  console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  console.log(`  Plan:    ${cred.plan || "(not set — uses config.yaml)"}`);
  if (cred.jwt) console.log(`  JWT:     ${cred.jwt.substring(0, 12)}...`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  console.log(`  Store:   ${getStorePath()}`);
}

/**
 * Export the currently active credential as a base64-encoded JSON blob.
 *
 * Purpose: lets users who logged in locally (via `zcode-proxy auth login`)
 * reuse that credential on a remote host (Render, Fly.io, K8s, etc.) where
 * browser-based OAuth isn't possible.
 *
 * Usage:
 *   1. Locally:   zcode-proxy auth login zai
 *   2. Locally:   zcode-proxy auth export   # prints base64 blob
 *   3. Remotely:  set ZCODE_AUTH_MODE=oauth
 *                 set ZCODE_OAUTH_CREDENTIAL=<base64 blob from step 2>
 *
 * The blob contains the credential in plaintext (apiKey, optional secret,
 * JWT, userId, plan). Treat it like a password — never commit it to git.
 * On Render, mark the env var as "Secret" so it's masked in the dashboard.
 *
 * Optionally pass --accounts to export ALL stored accounts (multi-account
 * setup) instead of just the active one. The remote host's render-start.sh
 * currently only consumes the single-credential form; --accounts is for
 * custom deployment scripts that import via the dashboard's import endpoint.
 */
async function authExport(): Promise<void> {
  const cred = await loadCredential();
  if (!cred) {
    console.error("Not logged in. Run: zcode-proxy auth login <zai|bigmodel>");
    process.exit(1);
  }

  const json = JSON.stringify(cred);
  const b64 = Buffer.from(json, "utf8").toString("base64");

  console.log("=== ZCODE_OAUTH_CREDENTIAL (base64) ===");
  console.log(b64);
  console.log("=== END ===");
  console.log("");
  console.log("To use on Render / Fly.io / K8s:");
  console.log("  1. Copy the base64 blob above (between the === markers).");
  console.log("  2. On your host, set these environment variables:");
  console.log("       ZCODE_AUTH_MODE=oauth");
  console.log("       ZCODE_OAUTH_CREDENTIAL=<paste blob here>");
  console.log("  3. Restart the service.");
  console.log("");
  console.log("⚠  This blob contains your upstream credential in plaintext.");
  console.log("⚠  Treat it like a password. Never commit it to git.");
  console.log("⚠  On Render, mark the env var as Secret so it's masked in logs.");
}

async function runOAuth(provider: ProviderId): Promise<{ accessToken: string; userId?: string; jwt?: string; email?: string }> {
  if (provider === "bigmodel") {
    const oauth = new BigmodelOAuthClient();
    const result = await oauth.authorize((url) => {
      console.log("Open this URL to authorize:\n");
      console.log(`  ${url}\n`);
      console.log("Waiting for authorization... (expires in 300s)\n");
      openBrowser(url);
    });
    return { accessToken: result.accessToken, userId: result.userId, jwt: result.jwt, email: result.email };
  }

  // Z.AI uses the same auth-code/callback loop as bigmodel (localhost server
  // + zcode.z.ai token proxy). This loop is what activates the start-plan
  // trial on a fresh account. See src/auth/oauth.ts and test-zai-oauth.cjs.
  const oauth = new ZaiOAuthClient();
  const result = await oauth.authorize((url) => {
    console.log("Open this URL to authorize:\n");
    console.log(`  ${url}\n`);
    console.log("Waiting for authorization... (expires in 300s)\n");
    openBrowser(url);
  });
  return { accessToken: result.accessToken, userId: result.userId, jwt: result.jwt, email: result.email };
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", `start "" "${url}"`], {
        detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch { /* user copies URL manually */ }
}
