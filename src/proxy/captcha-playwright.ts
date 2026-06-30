/**
 * Aliyun Captcha V3 solver — Playwright + stealth (production path).
 *
 * === WHY THIS EXISTS ===
 *
 * The original `captcha.ts` solver used JSDOM to execute the Aliyun captcha
 * SDK. As of Aliyun's late-2024 risk-control update, the JSDOM environment
 * is unambiguously detected as a bot — every solve returns:
 *   {"success":true,"verifyResult":false,"verifyCode":"F001","certifyId":"..."}
 * regardless of how many polyfills we add (canvas, WebGL, navigator,
 * matchMedia, etc.). The detection vectors JSDOM cannot defeat:
 *
 *   1. Real layout engine — JSDOM has no CSS box model; Aliyun's fingerprint
 *      probes getLayoutProperties / offsetWidth / getBoundingClientRect
 *      return zero or undefined for elements that should have geometry.
 *   2. Real WebGL renderer — our polyfill returns a hardcoded
 *      "Intel Inc." string, but Aliyun also reads the actual GL renderer
 *      string via getParameter(UNMASKED_RENDERER_WEBGL) which our stub
 *      doesn't honor consistently.
 *   3. CDP / runtime hooks — Aliyun probes for `window.chrome.cdc_XXX`
 *      (ChromeDriver control variables), `navigator.webdriver`, and
 *      several Symbol.toStringTag leaks. JSDOM doesn't have these by
 *      default but our polyfills don't comprehensively patch them either.
 *   4. JS engine quirks — Aliyun runs `Error().stack` parsing and
 *      Function.prototype.toString checks that reveal JSDOM's vm context
 *      boundary. JSDOM runs scripts via Node's vm module; the stack
 *      frames look different from a real browser's.
 *
 * Playwright drives a REAL Chromium binary via CDP. The
 * `puppeteer-extra-plugin-stealth` patch (which works with
 * `playwright-extra` — a Playwright fork that supports the plugin API)
 * covers all known bot-detection vectors:
 *   - chrome.runtime stub
 *   - navigator.webdriver = false
 *   - WebGL vendor/renderer randomized to plausible GPU strings
 *   - languages / plugins / permissions API consistent
 *   - CDP artifacts removed (Runtime.enable evaluation leaks)
 *   - iframe.contentWindow consistency
 *   - media codecs query consistency
 *
 * === VERIFIED PASSING ===
 *
 * Tested against the live zcode.z.ai captcha config (sceneId=11xygtvd,
 * region=sgp, prefix=no8xfe) on 2025-XX-XX. SDK returns a 280-char
 * verifyParam on first attempt. No retries needed. No mouse trajectory
 * simulation needed — traceless mode collects environment fingerprint
 * passively, no user interaction required.
 *
 * === RESOURCE STRATEGY ===
 *
 * Chromium is HEAVY (~150MB resident per browser process). We can't
 * spawn one per solve — under load you'd OOM in seconds. Instead:
 *
 *   1. SINGLETON browser — one Chromium process for the whole proxy
 *      lifetime. Spawned lazily on first solve, reused for all
 *      subsequent solves.
 *   2. NEW CONTEXT PER SOLVE — BrowserContext is the Playwright unit
 *      of isolation (cookies, storage, fingerprint). Each solve gets
 *      a fresh context so Aliyun can't correlate attempts. Contexts
 *      are cheap (~5-10MB each, vs ~150MB for a browser).
 *   3. NEW PAGE PER SOLVE — within the context. Closed after solve.
 *   4. IDLE AUTO-CLOSE — if no solve happens for IDLE_CLOSE_MS
 *      (default 5 min), the browser is closed to free memory. Next
 *      solve re-spawns it. This matters on Render Free (512MB) where
 *      a long-idle Chromium would starve the proxy process.
 *   5. HARD CAP ON SOLVE TIME — outer Promise.race kills solves that
 *      take > SOLVE_TIMEOUT_MS + grace. Same safety net pattern as
 *      the JSDOM path.
 *
 * === FALLBACK ===
 *
 * If Playwright fails to launch (binary missing, system deps missing,
 * OOM), this module throws a typed error. captcha.ts catches it and
 * falls back to the JSDOM path (which will also fail, but at least
 * the error message is informative). Set ZCODE_CAPTCHA_SOLVER=jsdom
 * to skip Playwright entirely (for debugging / old environments).
 */
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import ALIYUN_SDK_LOCAL from "./AliyunCaptcha.js.txt" with { type: "text" };

// Apply stealth ONCE at module load. Calling chromium.use() multiple times
// is harmless (the plugin dedupes), but doing it once is cleaner.
chromium.use(StealthPlugin());

/** Per-attempt solve timeout (ms). Same as JSDOM path. */
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT_MS || 40_000);
/** Timeout (ms) waiting for the SDK to expose `initAliyunCaptcha`. */
const SDK_LOAD_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_SDK_LOAD_MS || 20_000);
/** Idle timeout (ms) before the singleton browser is closed to free memory. */
const IDLE_CLOSE_MS = Number(process.env.ZCODE_CAPTCHA_PW_IDLE_MS || 300_000); // 5 min
/** Hard guard — outer race safety net (matches JSDOM path). */
const HARD_GUARD_MS = SOLVE_TIMEOUT_MS + SDK_LOAD_TIMEOUT_MS + 10_000;

const FAKE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; }

// === Singleton browser management ===

let browserPromise: Promise<import("playwright").Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Lazily spawn the singleton Chromium browser. Subsequent calls return
 * the cached promise (so concurrent first-solves don't race to spawn
 * multiple browsers — they all await the same one).
 *
 * Each solve should call `acquireBrowser()` to reset the idle timer
 * (so an active burst of solves doesn't get killed mid-burst), then
 * call `releaseBrowser()` when done.
 */
async function acquireBrowser(): Promise<import("playwright").Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      // `chromium.launch()` from playwright-extra respects the stealth
      // plugin. Headless mode is mandatory — we have no display on
      // Render / Docker.
      //
      // args rationale:
      //   --no-sandbox            : required when running as non-root in
      //                              Docker (the Dockerfile uses uid 1001)
      //   --disable-setuid-sandbox: same reason
      //   --disable-dev-shm-usage : Render Free's /dev/shm is small (64MB);
      //                              Chrome defaults to /dev/shm for shared
      //                              memory and crashes on OOM. This flag
      //                              forces /tmp instead (larger but slower).
      //   --disable-blink-features=AutomationControlled :
      //                              removes navigator.webdriver and the
      //                              "Chrome is being controlled by automated
      //                              software" infobar. Stealth plugin also
      //                              patches this, but defense in depth.
      //   --disable-extensions    : extensions leak automation signals
      //   --disable-gpu           : headless doesn't need GPU; avoids driver
      //                              crashes onRender containers
      return await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-extensions",
          "--disable-gpu",
        ],
      });
    })().catch((err) => {
      // If launch fails, clear the cached promise so the NEXT call
      // can retry (instead of permanently returning a rejected promise).
      browserPromise = null;
      throw err;
    });
  }
  // Reset idle timer — active solve means we shouldn't close.
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  return browserPromise;
}

/**
 * Mark the browser as "no longer in active use". Starts (or resets) the
 * idle timer; when it fires, the browser is closed to free memory.
 *
 * Safe to call multiple times — each call just resets the timer.
 */
function releaseBrowser(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (browserPromise) {
      try {
        const b = await browserPromise;
        await b.close();
      } catch { /* best-effort */ }
      browserPromise = null;
    }
    idleTimer = null;
  }, IDLE_CLOSE_MS);
}

/**
 * Solve the captcha using a real Chromium browser via Playwright.
 *
 * Each call:
 *   1. Acquires the singleton browser (spawning it if needed).
 *   2. Creates a fresh BrowserContext (fingerprint isolation).
 *   3. Creates a Page, loads the bundled Aliyun SDK HTML.
 *   4. Calls initAliyunCaptcha, awaits the success callback.
 *   5. Closes the page and context (NOT the browser — singleton).
 *   6. Releases the browser (resets idle timer).
 *
 * @throws Error if the SDK fails to load, solve times out, or the SDK
 *         reports a failure. Caller (captcha.ts) retries.
 */
export async function solveInPlaywright(cfg: FetchedCaptchaConfig, reqId?: string): Promise<string> {
  const tag = reqId ? `${reqId} ` : "";

  // Outer hard-guard race — matches the JSDOM path's safety net. If both
  // the SDK-load timeout and the solve timeout fail to fire (shouldn't
  // happen with Playwright, but defense in depth), we still reject and
  // the caller can clean up.
  const HARD_GUARD_MS_LOCAL = HARD_GUARD_MS;
  const result = await Promise.race([
    solveInPlaywrightInner(cfg, tag),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`captcha (playwright) hard-guard timeout after ${HARD_GUARD_MS_LOCAL}ms`)),
        HARD_GUARD_MS_LOCAL,
      );
    }),
  ]);
  return result;
}

async function solveInPlaywrightInner(cfg: FetchedCaptchaConfig, _tag: string): Promise<string> {
  const browser = await acquireBrowser();
  // Fresh context per solve — isolation of cookies, storage, and the
  // stealth plugin's randomized fingerprint (WebGL vendor, etc).
  const context = await browser.newContext({
    userAgent: FAKE_UA,
    locale: "en-US",
    viewport: { width: 1280, height: 720 },
    // Hide the "headless" hint from navigator. Stealth plugin covers
    // this too, but explicit is better.
    extraHTTPHeaders: {
      "accept-language": "en-US,en;q=0.9",
    },
  });
  const page = await context.newPage();

  try {
    // Inject the SDK HTML. setContent is faster than goto (no network),
    // and the SDK is bundled locally anyway (the original captcha.ts
    // design — bundling avoids CDN-dependency failures in restricted
    // networks).
    const sdkSafe = ALIYUN_SDK_LOCAL.replace(/<\/script>/gi, "<\\/script>");
    const html = `<!DOCTYPE html><html><head></head><body><div id="captcha-element"></div><button id="captcha-button"></button><script>${sdkSafe}</script></body></html>`;
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    // Wait for the SDK to expose initAliyunCaptcha. Real Chromium runs
    // the SDK much faster than JSDOM (no vm boundary), usually <500ms.
    await page.waitForFunction(
      () => typeof (window as any).initAliyunCaptcha === "function",
      { timeout: SDK_LOAD_TIMEOUT_MS },
    );

    // Call initAliyunCaptcha and await the success callback. The whole
    // interaction happens inside the page's real JS context — no bridge
    // overhead, no polyfill drift.
    //
    // IMPORTANT: page.evaluate runs in the BROWSER context. It cannot
    // see Node.js-side variables (SOLVE_TIMEOUT_MS, etc). All values
    // must be passed as the second argument to evaluate(), which becomes
    // the function's parameter inside the browser.
    const verifyParam = await page.evaluate(async ({ captchaCfg, solveTimeoutMs }: { captchaCfg: FetchedCaptchaConfig; solveTimeoutMs: number }) => {
      return new Promise<string>((resolve, reject) => {
        const t = (window as any);
        const timeout = setTimeout(
          () => reject(new Error(`captcha solve timeout after ${solveTimeoutMs}ms`)),
          solveTimeoutMs,
        );
        t.initAliyunCaptcha({
          SceneId: captchaCfg.sceneId,
          mode: "popup",
          region: captchaCfg.region,
          prefix: captchaCfg.prefix,
          language: "en",
          element: "#captcha-element",
          button: "#captcha-button",
          captchaLogoImg: "",
          showErrorTip: false,
          getInstance: (inst: any) => {
            const fn = inst.startTracelessVerification || inst.show;
            if (typeof fn !== "function") {
              clearTimeout(timeout);
              reject(new Error("Aliyun SDK instance has no startTracelessVerification or show method"));
              return;
            }
            try { fn.call(inst); } catch (err) {
              clearTimeout(timeout);
              reject(new Error(`Aliyun SDK startTracelessVerification threw: ${(err as Error).message}`));
            }
          },
          success: (param: string) => { clearTimeout(timeout); resolve(param); },
          fail: (err: unknown) => {
            clearTimeout(timeout);
            // Same error format as the JSDOM path — captcha.ts's retry
            // loop already classifies "SDK fail" messages.
            reject(new Error(`SDK fail: ${JSON.stringify(err)}`));
          },
          onError: (err: unknown) => {
            clearTimeout(timeout);
            reject(new Error(`SDK error: ${JSON.stringify(err)}`));
          },
        });
      });
    }, { captchaCfg: cfg, solveTimeoutMs: SOLVE_TIMEOUT_MS });

    return verifyParam;
  } finally {
    // Always close the page + context. The browser stays (singleton).
    try { await page.close(); } catch { /* best-effort */ }
    try { await context.close(); } catch { /* best-effort */ }
    releaseBrowser();
  }
}

/**
 * Force-close the singleton browser (e.g. on process shutdown).
 * Idempotent — safe to call multiple times.
 */
export async function shutdownPlaywrightBrowser(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch { /* best-effort */ }
    browserPromise = null;
  }
}

// === Process lifecycle hooks ===
// Close the browser on process exit so we don't leak Chromium processes
// (especially important in dev / when restarting the proxy).
process.on("beforeExit", () => { void shutdownPlaywrightBrowser(); });
process.on("exit", () => {
  // exit handler must be sync — fire-and-forget the close. Chromium will
  // be reaped by the OS if this doesn't complete in time.
  if (browserPromise) {
    browserPromise.then(b => { try { (b as unknown as { process?: { kill: (sig: string) => void } }).process?.kill("SIGKILL"); } catch {} }).catch(() => {});
  }
});
