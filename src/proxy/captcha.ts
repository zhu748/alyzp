/**
 * Aliyun Captcha V3 solver — in-process jsdom (single binary).
 *
 * The AliyunCaptcha.js SDK is bundled as a text import (no runtime dependency
 * on the alicdn CDN — the CDN is the #1 source of solve failures in restricted
 * networks, and a local file path would break under `bun build --compile`).
 * Solve attempts are retried, and errors from the SDK's `getInstance`
 * callback are propagated rather than silently swallowed (a swallowed error
 * there means `success`/`fail` never fires and we hang until the outer
 * timeout rejects).
 *
 * Static `import { JSDOM, VirtualConsole } from "jsdom"` (not dynamic) —
 * dynamic `await import("jsdom")` returns a namespace `{ default: {...} }`
 * for the CJS package under `bun build --compile`, leaving the named exports
 * undefined. Static import lets Bun's bundler fully inline jsdom (including
 * its internal `xhr-sync-worker.js` via `require.resolve`) into the binary,
 * so the compiled exe has zero runtime dependency on node_modules.
 *
 * === OPTIMIZATION HISTORY (v0.1.5+) ===
 *
 * 1. MUTEX on getCaptchaToken — previously N concurrent start-plan requests
 *    that all hit a token cache miss would each spin up a separate JSDOM
 *    instance (50-100MB each). 4 concurrent = 400MB peak. A single mutex
 *    serializes solve attempts so only ONE JSDOM exists at a time. The
 *    second+ caller waits ~10-40s for the first to complete, then benefits
 *    from the freshly-cached token — zero JSDOM cost.
 *
 * 2. DOUBLE-CHECKED LOCKING — after acquiring the mutex, we re-check
 *    cachedToken. The first caller already solved it while we were waiting;
 *    we can return immediately without spawning another JSDOM.
 *
 * 3. ERROR CLASSIFICATION — config-fetch failures (network, JSON parse) are
 *    NOT retried (the upstream is unreachable, retrying wastes time). Only
 *    actual solve failures (SDK timeout, instance init error) trigger the
 *    retry loop. This cuts "config unavailable" retry storms from 3×40s
 *    = 120s to a single 40s attempt.
 *
 * 4. INVARIANT-VALIDATING INVALIDATE — invalidateCaptchaToken() now also
 *    clears a "solving" flag so that a re-solve triggered by a 403 doesn't
 *    race with an in-flight solve from a previous request that's about to
 *    finish. The previous race: req A starts solve → req B gets 403,
 *    invalidateCaptchaToken (sets cachedToken=null) → req A's solve
 *    completes, sets cachedToken=A's result → req B starts its own solve,
 *    overwrites cachedToken. Result: req B burned another JSDOM for nothing.
 *
 * 5. JSDOM RESOURCE CLEANUP — solveInJsdom now wraps everything in a
 *    try/finally that explicitly closes the window AND aborts pending
 *    timers / event listeners. JSDOM instances that fail to close leak
 *    their timer queue forever (memory grows ~1MB/h per leaked instance).
 *
 * 6. SOLVE TIMEOUT HONESTY — the SDK load timeout (SDK_LOAD_TIMEOUT_MS)
 *    and the solve timeout (SOLVE_TIMEOUT_MS) are now independent. If the
 *    SDK fails to load (e.g. the bundled JS is corrupt), we fail fast
 *    instead of waiting for the solve timeout.
 *
 * 7. SOLVE IN-FLIGHT COALESCING — if invalidateCaptchaToken() is called
 *    WHILE a solve is in flight (e.g. concurrent 403 + the original solve
 *    hasn't finished), we set a "pendingInvalidate" flag. The in-flight
 *    solve's result is discarded (not cached), and the next
 *    getCaptchaToken() call starts a fresh solve. Without this, the
 *    stale result from the in-flight solve would be cached and used,
 *    defeating the invalidate.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import ALIYUN_SDK_LOCAL from "./AliyunCaptcha.js.txt" with { type: "text" };
import { createMutex } from "../utils/fs.js";
import type { AsyncMutex } from "../utils/fs.js";

// v0.2.1.8+: Playwright-based solver is the production path. JSDOM is kept
// as a fallback (controlled by ZCODE_CAPTCHA_SOLVER env var) for
// environments where Playwright can't run (no Chromium binary, no system
// deps, OOM-prone Free tier, etc).
//
// Why Playwright is the default:
//   - Aliyun's risk control has evolved to detect JSDOM environments
//     with near-100% accuracy (every solve returns verifyCode F001).
//     The detection vectors (no real layout engine, no real WebGL,
//     vm-boundary stack frames) cannot be patched via polyfills.
//   - Playwright drives a REAL Chromium binary via CDP; combined with
//     the stealth plugin, it passes traceless verification on first
//     attempt. Verified against live zcode.z.ai captcha config.
//
// Solver selection precedence:
//   1. ZCODE_CAPTCHA_SOLVER=jsdom  → force JSDOM (debug / old envs)
//   2. ZCODE_CAPTCHA_SOLVER=playwright → force Playwright
//   3. unset / auto → Playwright first, fall back to JSDOM on launch
//      failure (auto mode — sensible default for mixed environments).
const CAPTCHA_SOLVER_MODE = (process.env.ZCODE_CAPTCHA_SOLVER || "auto").toLowerCase();
const USE_PLAYWRIGHT = CAPTCHA_SOLVER_MODE !== "jsdom";
const USE_JSDOM_FALLBACK = CAPTCHA_SOLVER_MODE !== "playwright";

// Lazy-import Playwright solver so environments without the dependency
// installed (e.g. legacy deployments that haven't run `bun install`
// after upgrading) don't crash at module load.
let _solveInPlaywright: typeof import("./captcha-playwright.js").solveInPlaywright | null = null;
async function getPwSolver() {
  if (!_solveInPlaywright) {
    const mod = await import("./captcha-playwright.js");
    _solveInPlaywright = mod.solveInPlaywright;
  }
  return _solveInPlaywright;
}

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";
// v0.1.6+: TOKEN_TTL_MS no longer used (no token cache). Kept as a comment
// for documentation — Aliyun verifyParam is valid for ~45s upstream, but
// we solve fresh each time so TTL doesn't matter to us.
// const TOKEN_TTL_MS = 45_000;
const FAKE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** How many times to retry a single captcha solve. Overridable via env. */
const SOLVE_RETRIES = Number(process.env.ZCODE_CAPTCHA_RETRIES || 3);
/** Per-attempt solve timeout (ms). Overridable via env. */
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT_MS || 40_000);
/** Timeout (ms) waiting for the SDK to expose `initAliyunCaptcha`. */
const SDK_LOAD_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_SDK_LOAD_MS || 20_000);
/** Config-fetch timeout (ms). The configs API is fast; 15s is generous
 *  for slow networks. Overridable via env. */
const CONFIG_FETCH_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_CONFIG_TIMEOUT_MS || 15_000);

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; }
let cachedConfig: { value: FetchedCaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };

/**
 * v0.1.6+ FIX: NO token cache.
 *
 * Aliyun captcha verifyParam is ONE-SHOT — zcode.z.ai consumes it on first
 * verification. If two concurrent requests share the same cached token,
 * the second request gets `{"code":3007,"msg":"captcha verify failed"}`.
 *
 * The previous v0.1.5 cache + the mutex double-checked-locking I added
 * made this worse: concurrent cache-miss callers would all get the SAME
 * token (first solves, rest hit cache). This caused 3007 errors.
 *
 * New design:
 *   - getCaptchaToken() ALWAYS solves a fresh token (no cache)
 *   - solveMutex serializes solves so only ONE JSDOM exists at a time
 *     (prevents OOM from N concurrent JSDOM instances)
 *   - handler.ts caches the token PER-REQUEST (retry reuses, 403 re-solves)
 *
 * This means concurrent requests each get their own token (safe), at the
 * cost of serialized solve latency (N requests = N × ~20s solve time).
 * For a single-user local proxy this is acceptable — concurrent
 * start-plan requests are rare.
 */

/**
 * Mutex serializing captcha solves. Ensures only ONE JSDOM exists at a time.
 * Solves take 10-40s; concurrent solves would each spawn a JSDOM (50-100MB
 * each) → OOM under load. With the mutex, the second+ caller waits for the
 * first to finish, then starts its own solve (NOT sharing the result).
 *
 * The mutex is module-level (singleton) so all callers share the same lock.
 */
const solveMutex: AsyncMutex = createMutex();

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Invalidate any cached captcha token. With the v0.1.6+ no-cache design,
 * this is effectively a no-op (there's nothing to invalidate) — but kept
 * for API compatibility with handler.ts which calls it on 403 responses.
 *
 * Safe to call multiple times in quick succession (idempotent).
 */
export function invalidateCaptchaToken(): void {
  // No-op: we don't cache tokens anymore. Each getCaptchaToken() call
  // solves fresh. Handler.ts's per-request cache is cleared separately.
}

async function fetchCaptchaConfig(reqId?: string): Promise<FetchedCaptchaConfig | null> {
  if (cachedConfig.value && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  const tag = reqId ? `${reqId} ` : "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(`${CONFIGS_API}?app_version=3.1.1&platform=win32-x64`, {
        signal: ctrl.signal,
      });
      const json = (await resp.json()) as { data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
      const cfg = json?.data?.configs?.captcha ?? null;
      cachedConfig = { value: cfg, expiresAt: Date.now() + 60000 };
      return cfg;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Config fetch failure is unrecoverable — don't retry. The retry loop
    // in getCaptchaToken treats null-config as a hard failure.
    //
    // v0.2.2+: tag the error so refreshCaptchaHeaders can distinguish
    // "network error fetching config" (hard-fail, retry won't help) from
    // "config returned but captcha disabled" (soft-fail, skip captcha
    // and let the upstream decide if it's needed).
    const wrapped = new Error(`captcha_config_fetch_failed: ${(err as Error).message}`);
    (wrapped as Error & { configFetchFailed?: boolean }).configFetchFailed = true;
    console.warn(`${tag}[captcha] config fetch failed: ${(err as Error).message}`);
    throw wrapped;
  }
}

/**
 * Get a FRESH captcha token. Always solves — no cache (see module header
 * for why: Aliyun verifyParam is one-shot, sharing causes 3007 errors).
 *
 * Serialized via solveMutex so only one JSDOM exists at a time (prevents
 * OOM from N concurrent JSDOM instances, each 50-100MB).
 *
 * handler.ts is responsible for caching the token PER-REQUEST (so retries
 * within the same request reuse the token, but different requests get
 * different tokens).
 *
 * @throws Error if the config is unavailable OR all solve retries fail.
 *         Callers (handler.ts) catch this and return 503 to the client.
 */
export async function getCaptchaToken(reqId?: string): Promise<{ verifyParam: string; region: string; solveMs: number }> {
  const tag = reqId ? `${reqId} ` : "";
  const solveStart = Date.now();
  return solveMutex.run(async () => {
    let cfg: FetchedCaptchaConfig | null;
    try {
      cfg = await fetchCaptchaConfig(reqId);
    } catch (err) {
      // Config FETCH failed (network error) — re-throw with the tag so
      // handler.ts can hard-fail the retry loop. We DON'T catch this
      // here because retrying getCaptchaToken won't help (the network
      // won't suddenly recover).
      throw err;
    }
    if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) {
      // Config was returned but captcha is disabled or malformed.
      // This is NOT a hard-fail — the upstream may not require captcha.
      // handler.ts treats this as a soft-fail (skip captcha, let the
      // upstream decide). Throw a distinguishable error.
      throw new Error("captcha_disabled_by_config");
    }

    const verifyParam = await solveInJsdomWithRetry(cfg, reqId);
    const solveMs = Date.now() - solveStart;
    console.log(`${tag}captcha solved in ${solveMs}ms`);
    return { verifyParam, region: cfg.region, solveMs };
  });
}

/**
 * Solve the captcha with retries. Config-fetch failures are NOT retried
 * (unrecoverable); only solve failures (SDK timeout, instance init error)
 * trigger the retry loop.
 *
 * v0.2.0.8: each solveInJsdom() call is now wrapped in a HARD outer timeout
 * (SOLVE_TIMEOUT_MS + 10s grace) as a safety net. The inner solve already
 * has two independent timeouts (SDK_LOAD_TIMEOUT_MS, SOLVE_TIMEOUT_MS), but
 * JSDOM on Bun has edge cases where a Promise can hang without either timer
 * firing — e.g. the SDK's internal callback never runs AND the setTimeout
 * gets swallowed by a jsdom event-loop quirk. The outer race guarantees we
 * always reject (and run finally cleanup) even in those pathological cases.
 *
 * The grace margin is deliberately large (10s over the inner timeout) so we
 * NEVER pre-empt a healthy solve — if the inner timeout is 40s, the outer
 * guard only fires at 50s, by which point the inner path has definitely
 * failed. This is a pure safety net, not a behavior change.
 *
 * v0.2.1.8+: RENAMED conceptually to solveCaptchaWithRetry. The function
 * now dispatches between Playwright (default, high success rate) and JSDOM
 * (fallback for environments without Chromium). The original JSDOM-only
 * behavior is preserved when ZCODE_CAPTCHA_SOLVER=jsdom.
 *
 * Dispatch logic:
 *   - USE_PLAYWRIGHT (default): try Playwright first. If it fails to LAUNCH
 *     (binary missing, deps missing, OOM) AND USE_JSDOM_FALLBACK is true,
 *     fall back to JSDOM for this attempt and all subsequent attempts in
 *     this call (we set a flag to skip the launch probe on retries — once
 *     Playwright is known-broken, retrying it wastes time).
 *   - USE_JSDOM_FALLBACK only matters in "auto" mode. In "playwright" mode
 *     (USE_JSDOM_FALLBACK=false), Playwright failures are surfaced as
 *     retries (no JSDOM fallback).
 *   - In "jsdom" mode (USE_PLAYWRIGHT=false), Playwright is never tried.
 */
async function solveInJsdomWithRetry(cfg: FetchedCaptchaConfig, reqId?: string): Promise<string> {
  const tag = reqId ? `${reqId} ` : "";
  let lastErr: Error | null = null;
  // Tracks whether Playwright has been observed to be unavailable in this
  // call. Once true, we skip Playwright entirely on subsequent attempts
  // (avoiding the launch probe delay on every retry).
  let playwrightDisabled = !USE_PLAYWRIGHT;

  for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
    try {
      // Try Playwright first (if not disabled for this call).
      if (!playwrightDisabled) {
        try {
          const solve = await getPwSolver();
          const result = await solve(cfg, reqId);
          return result;
        } catch (err) {
          // Classify the Playwright failure.
          //
          // Two categories:
          //   (A) "SDK fail: ..." → Aliyun REJECTED the verification (F001).
          //       The browser worked, the SDK ran, Aliyun just said no.
          //       Retrying MAY help (different fingerprint from new context).
          //       Don't disable Playwright for this — just retry.
          //
          //   (B) ANY OTHER ERROR → Playwright is BROKEN in this environment.
          //       This covers:
          //         - "Cannot find package 'kind-of'" (transitive dep missing
          //            under bun build --compile)
          //         - "Playwright is missing. :-)" (playwright-extra runtime
          //            require.resolve failed under --compile)
          //         - "Executable doesn't exist" (chromium binary not installed)
          //         - "Failed to launch" (chromium system deps missing)
          //         - "Browser has been closed" / "Target page...closed"
          //         - "captcha (playwright) hard-guard timeout"
          //         - "captcha solve timeout" (when SDK never loads —
          //            environment issue, not Aliyun rejection)
          //
          // v0.0.0.2 BUGFIX: previously the isLaunchFailure regex only
          // matched specific keywords (playwright, chromium, Executable,
          // etc). This missed "Cannot find package 'kind-of'" — kind-of
          // is a transitive dep of puppeteer-extra-plugin-stealth, and
          // its absence is a clear sign the exe is missing modules.
          // The result: attempt 1 threw "kind-of" error, was NOT
          // classified as launch failure, did NOT fall back to JSDOM,
          // and was surfaced as a regular retry. Then attempt 2 re-tried
          // Playwright (got "Playwright is missing" — which DID match
          // the regex) and only THEN fell back. Wasted one full solve
          // cycle (~20s) per request.
          //
          // Fix: invert the logic. ONLY "SDK fail" errors are treated
          // as retry-able (Aliyun said no). Everything else is treated
          // as a Playwright environment failure → disable + fall back.
          const msg = (err as Error).message ?? "";
          const isSdkFailure = /SDK fail/i.test(msg);
          if (!isSdkFailure) {
            console.warn(`${tag}[captcha] Playwright unavailable (${msg.substring(0, 120)}${msg.length > 120 ? "..." : ""}), ${USE_JSDOM_FALLBACK ? "falling back to JSDOM" : "no fallback configured"} (attempt ${attempt}/${SOLVE_RETRIES})`);
            playwrightDisabled = true;
            if (!USE_JSDOM_FALLBACK) {
              // No fallback — surface as a regular retry-able error.
              throw err;
            }
            // Fall through to JSDOM path below.
          } else {
            // SDK-level failure (F001) — retry-able, NOT a Playwright
            // environment issue. Don't disable Playwright.
            throw err;
          }
        }
      }

      // JSDOM fallback path (also the primary path when ZCODE_CAPTCHA_SOLVER=jsdom).
      // v0.2.0.8: outer hard-timeout race. If solveInJsdom's internal
      // timeouts both fail to fire (jsdom edge case), this guarantee
      // ensures we still reject and the finally block runs to release the
      // JSDOM instance (50-100MB each).
      const HARD_GUARD_MS = SOLVE_TIMEOUT_MS + SDK_LOAD_TIMEOUT_MS + 10_000;
      const result = await Promise.race([
        solveInJsdom(cfg),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`captcha hard-guard timeout after ${HARD_GUARD_MS}ms (inner timeouts failed to fire — JSDOM may be stuck)`)),
            HARD_GUARD_MS,
          );
        }),
      ]);
      return result;
    } catch (err) {
      lastErr = err as Error;
      const msg = (err as Error).message ?? "unknown";
      // Classify: config-related errors are unrecoverable, don't retry.
      // We've already fetched the config successfully to get here, so this
      // branch is unreachable in practice — kept as a safety net.
      if (/config unavailable|disabled|empty config/i.test(msg)) {
        throw err;
      }
      console.error(`${tag}[captcha] solve attempt ${attempt}/${SOLVE_RETRIES} failed: ${msg}`);
      // Brief backoff between retries — gives the SDK a chance to release
      // any lingering timers / event-loop work from the failed attempt.
      if (attempt < SOLVE_RETRIES) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  throw new Error(`captcha solve failed after ${SOLVE_RETRIES} attempts: ${lastErr?.message ?? "unknown"}`);
}

/**
 * Solve the captcha in a fresh JSDOM instance. Resources (window, timers,
 * event listeners) are explicitly cleaned up in finally — JSDOM instances
 * that fail to close leak their internal timer queue indefinitely.
 */
async function solveInJsdom(cfg: FetchedCaptchaConfig): Promise<string> {
  const vc = new VirtualConsole();
  // Silence the SDK's verbose console.log noise — we only care about
  // errors, which surface via the reject path.
  // v0.1.6+: also silence the `vm.runInContext` TypeError that jsdom
  // throws on Bun (Bun's vm module is incomplete). These errors are
  // non-fatal — the SDK has fallback paths and solve still succeeds.
  // Logging them floods the dashboard with scary-looking errors that
  // don't actually break anything.
  vc.on("jsdomError", (err: Error) => {
    const msg = err.message ?? "";
    // Silence known-non-fatal jsdom errors on Bun:
    //   - "undefined is not an object (evaluating 'vm.runInContext...')"
    //     → Bun's vm module doesn't expose runInContext; jsdom's script
    //       execution falls back to eval, which works for the SDK.
    //   - "Not implemented: HTMLCanvasElement.prototype.getContext"
    //     → we polyfill this, but some code paths still hit the native one
    if (/vm\.runInContext|Not implemented:/i.test(msg)) {
      return; // suppress
    }
    console.error(`[captcha] jsdomError: ${msg}`);
  });

  const sdkSafe = ALIYUN_SDK_LOCAL.replace(/<\/script>/gi, "<\\/script>");
  const html = `<!DOCTYPE html><html><head></head><body><div id="captcha-element"></div><button id="captcha-button"></button><script>${sdkSafe}</script></body></html>`;
  const dom = new JSDOM(html, {
    url: "https://zcode.z.ai/", runScripts: "dangerously", resources: "usable",
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window: any) { applyPolyfills(window); window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix }; },
  });
  const w = dom.window as any;
  // Track the solve timeout so we can clear it on early return / error.
  let solveTimeout: ReturnType<typeof setTimeout> | null = null;
  // Track the SDK-load interval so we can clear it on early return / error.
  let sdkLoadInterval: ReturnType<typeof setInterval> | null = null;

  try {
    // Wait for the SDK to expose initAliyunCaptcha. Independent timeout
    // from the solve timeout — if the SDK fails to load, we fail fast.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      sdkLoadInterval = setInterval(() => {
        let ok = false;
        try { ok = typeof w.initAliyunCaptcha === "function"; } catch {}
        if (ok) {
          if (sdkLoadInterval) clearInterval(sdkLoadInterval);
          sdkLoadInterval = null;
          resolve();
        } else if (Date.now() - start > SDK_LOAD_TIMEOUT_MS) {
          if (sdkLoadInterval) clearInterval(sdkLoadInterval);
          sdkLoadInterval = null;
          reject(new Error(`Aliyun SDK failed to load within ${SDK_LOAD_TIMEOUT_MS}ms — bundled JS may be corrupt`));
        }
      }, 80);
    });

    return await new Promise<string>((resolve, reject) => {
      solveTimeout = setTimeout(
        () => reject(new Error(`captcha solve timeout after ${SOLVE_TIMEOUT_MS}ms`)),
        SOLVE_TIMEOUT_MS,
      );
      w.initAliyunCaptcha({
        SceneId: cfg.sceneId, mode: "popup", region: cfg.region, prefix: cfg.prefix, language: "en",
        element: "#captcha-element", button: "#captcha-button", captchaLogoImg: "", showErrorTip: false,
        getInstance: (inst: any) => {
          const fn = inst.startTracelessVerification || inst.show;
          if (typeof fn !== "function") {
            if (solveTimeout) clearTimeout(solveTimeout);
            solveTimeout = null;
            reject(new Error("Aliyun SDK instance has no startTracelessVerification or show method"));
            return;
          }
          try {
            fn.call(inst);
          } catch (err) {
            if (solveTimeout) clearTimeout(solveTimeout);
            solveTimeout = null;
            reject(new Error(`Aliyun SDK startTracelessVerification threw: ${(err as Error).message}`));
          }
        },
        success: (param: string) => {
          if (solveTimeout) clearTimeout(solveTimeout);
          solveTimeout = null;
          resolve(param);
        },
        fail: (err: unknown) => {
          if (solveTimeout) clearTimeout(solveTimeout);
          solveTimeout = null;
          reject(new Error(`SDK fail: ${JSON.stringify(err)}`));
        },
        onError: (err: unknown) => {
          if (solveTimeout) clearTimeout(solveTimeout);
          solveTimeout = null;
          reject(new Error(`SDK error: ${JSON.stringify(err)}`));
        },
      });
    });
  } finally {
    // Aggressive cleanup — JSDOM instances hold timers, event listeners,
    // and a fake XMLHttpRequest pool that all leak if we don't tear down.
    if (sdkLoadInterval) { try { clearInterval(sdkLoadInterval); } catch {} sdkLoadInterval = null; }
    if (solveTimeout) { try { clearTimeout(solveTimeout); } catch {} solveTimeout = null; }
    // v0.2.2+ PERF: remove the jsdomError listener explicitly before
    // closing the window. VirtualConsole keeps an internal listener list
    // that can retain references to the dom/window even after w.close().
    // Without this, every solve leaves a small closure graph behind
    // (~50-200KB) that adds up under sustained start-plan traffic.
    try {
      vc.removeAllListeners?.("jsdomError");
      vc.removeAllListeners?.();
    } catch { /* VirtualConsole API may differ across jsdom versions */ }
    try {
      // Close the window — fires the unload event, releases internal
      // resources. Second arg "true" forces close even if pending
      // operations exist.
      w.close();
    } catch {}
    // JSDOM windows sometimes hold references via document event listeners.
    // Null out the major references to help GC.
    try { (dom as any)._document = null; } catch {}
    try { (dom as any)._defaultView = null; } catch {}
    // v0.2.2+: also null out the captured window reference (the `w` const
    // above) so the JSDOM internal map of windows can drop this instance.
    // We can't reassign `w` (it's a const), but we can clear its key
    // properties to break reference cycles.
    try {
      delete (w as any).document;
      delete (w as any).navigator;
    } catch { /* some props are non-configurable; ignore */ }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function applyPolyfills(window: any): void {
  // --- matchMedia polyfill ---
  window.matchMedia = () => ({
    matches: false, media: "", onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  });

  // --- Canvas polyfills ---
  const proto = window.HTMLCanvasElement.prototype;

  proto.getContext = function (type: string) {
    if (/webgl/i.test(type)) {
      return {
        canvas: this,
        getParameter: () => "Intel Inc.",
        getExtension: () => null,
        getSupportedExtensions: () => ["WEBGL_debug_renderer_info"],
        getContextAttributes: () => ({}),
        getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
      };
    }
    return {
      canvas: this,
      fillRect() {}, clearRect() {},
      getImageData: (_x: number, _y: number, w = 1, h = 1) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
      putImageData() {},
      createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      setTransform() {}, transform() {}, drawImage() {},
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, closePath() {},
      clip() {}, stroke() {}, fill() {}, arc() {}, rect() {},
      ellipse() {}, translate() {}, scale() {}, rotate() {},
      fillText() {}, strokeText() {},
      measureText: (t: string) => ({ width: ("" + t).length * 8 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => ({}),
      isPointInPath: () => false,
      font: "10px sans-serif", textBaseline: "alphabetic", textAlign: "start",
      fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, lineWidth: 1,
      shadowBlur: 0, shadowColor: "",
    };
  };

  proto.toDataURL = () =>
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  proto.toBlob = (cb: any) => cb && cb(null);

  // --- Worker / OffscreenCanvas polyfills ---
  window.Worker = class {
    postMessage() {} terminate() {}
    addEventListener() {} removeEventListener() {}
    onmessage = null; onerror = null;
  };
  window.OffscreenCanvas = class {
    width = 0; height = 0;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext() { return proto.getContext.call(this); }
  };

  // --- Document visibility polyfill ---
  try {
    Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
    Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
  } catch {}

  // --- Navigator polyfills ---
  const navProps: Record<string, unknown> = {
    userAgent: FAKE_UA, platform: "Win32", language: "en-US",
    languages: ["en-US", "en"], vendor: "Google Inc.", webdriver: false,
    hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, cookieEnabled: true,
    plugins: { length: 3, item: (): null => null, namedItem: (): null => null, refresh() {} },
    mimeTypes: { length: 0, item: (): null => null, namedItem: (): null => null },
  };
  for (const [k, v] of Object.entries(navProps)) {
    try { Object.defineProperty(window.navigator, k, { value: v, configurable: true }); } catch {}
  }

  // --- Screen / viewport polyfills ---
  window.screen = {
    width: 1920, height: 1080, availWidth: 1920, availHeight: 1040,
    colorDepth: 24, pixelDepth: 24,
  };
  window.chrome = { runtime: {} };
  window.outerWidth = 1920;
  window.outerHeight = 1080;
  window.innerWidth = 1280;
  window.innerHeight = 720;
  window.devicePixelRatio = 1;
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };
