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
    console.warn(`${tag}[captcha] config fetch failed: ${(err as Error).message}`);
    return null;
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
    const cfg = await fetchCaptchaConfig(reqId);
    if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) {
      // Hard failure — config unavailable. Throwing here means retry attempts
      // upstream won't help (the config won't suddenly appear), so handler.ts
      // returns 503 immediately.
      throw new Error(
        "Captcha config unavailable (zcode.z.ai unreachable or returned disabled/empty config). " +
        "Check network connectivity to zcode.z.ai; if behind a corporate proxy, set ZCODE_CAPTCHA_CONFIG_TIMEOUT_MS.",
      );
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
 */
async function solveInJsdomWithRetry(cfg: FetchedCaptchaConfig, reqId?: string): Promise<string> {
  const tag = reqId ? `${reqId} ` : "";
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
    try {
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
