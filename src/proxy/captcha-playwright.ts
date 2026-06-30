/**
 * Aliyun Captcha V3 solver — Playwright (production path, exe-compatible).
 *
 * === v0.0.0.2 REWRITE ===
 *
 * The v0.0.0.1 implementation used `playwright-extra` +
 * `puppeteer-extra-plugin-stealth`. Both are CJS packages that use
 * `require.resolve` to dynamically load sub-modules at runtime. Under
 * `bun build --compile --target=bun-windows-x64` (the release artifact),
 * these dynamic resolves fail catastrophically:
 *
 *   - `Cannot find package 'kind-of'` (stealth plugin's transitive dep)
 *   - `Playwright is missing. :-) I've tried loading "playwright-core"...`
 *
 * The release zip ships a single .exe with no node_modules — the entire
 * dynamic-require strategy is fundamentally incompatible with that model.
 *
 * This rewrite uses pure `playwright` (static ESM import, fully bundleable)
 * and implements the stealth patches manually via `page.addInitScript()`.
 * The init script runs BEFORE any page script, so Aliyun's fingerprint
 * probes see a "real" browser environment from the very first access.
 *
 * === STEALTH PATCHES (manual) ===
 *
 * The 10 patches below cover the bot-detection vectors Aliyun captcha V3
 * is known to check. They're a hand-picked subset of what
 * puppeteer-extra-plugin-stealth does — enough to pass traceless
 * verification, no more. Each patch is annotated with WHY it matters.
 *
 * === CHERNIUM BINARY ===
 *
 * Playwright's Chromium binary is NOT bundled in the .exe — it's a
 * separate ~150MB download installed via `playwright install chromium`.
 * The binary lives in:
 *   - Windows: %USERPROFILE%\AppData\Local\ms-playwright\chromium-{ver}\
 *   - macOS:   ~/Library/Caches/ms-playwright/chromium-{ver}/
 *   - Linux:   ~/.cache/ms-playwright/chromium-{ver}/
 *
 * `start.bat` / `start.sh` (in the release zip) auto-install the binary
 * on first run if missing. Users running from source (`bun run src/index.ts`)
 * get it via the `postinstall` script in package.json.
 */
import { chromium } from "playwright";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import ALIYUN_SDK_LOCAL from "./AliyunCaptcha.js.txt" with { type: "text" };
import STEALTH_EVASIONS from "./stealth-evasions.js.txt" with { type: "text" };

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

/**
 * v0.0.0.3: Locate the bundled Chromium binary.
 *
 * Priority:
 *   1. PLAYWRIGHT_BROWSERS_PATH env var (set by start.bat / start.sh to
 *      point at the chromium/ directory in the zip extraction folder).
 *      Playwright reads this natively — we just need to make sure it's
 *      set before chromium.launch() is called.
 *
 *   2. ./chromium/ relative to CWD (zip extraction folder layout).
 *      If PLAYWRIGHT_BROWSERS_PATH is NOT set, but ./chromium/ exists,
 *      set PLAYWRIGHT_BROWSERS_PATH=./chromium before launch. This is
 *      the "extract-and-run" path — no env var config needed.
 *
 *   3. Playwright's default search path (system cache like
 *      ~/.cache/ms-playwright/ on Linux, %USERPROFILE%\AppData\Local\
 *      ms-playwright\ on Windows). Used when running from source
 *      (`bun run src/index.ts`) after `playwright install chromium`.
 *
 * This function MUST be called before chromium.launch(). It mutates
 * process.env.PLAYWRIGHT_BROWSERS_PATH as a side effect.
 */
function ensureChromiumPath(): void {
  // Already set — nothing to do.
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;

  // Check for ./chromium/ relative to CWD (zip extraction folder).
  // The zip bundles Chromium at chromium/chromium-1228/chrome-win64/chrome.exe
  // on Windows, chromium/chromium-1228/chrome-linux64/chrome on Linux.
  const localChromiumDir = join(process.cwd(), "chromium");
  if (existsSync(localChromiumDir)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = localChromiumDir;
    return;
  }

  // Fall through to Playwright's default search path.
  // This works if the user ran `playwright install chromium` (via
  // `start.bat` option i in v0.0.0.2, or via `bun install` postinstall).
}

// === Singleton browser management ===

let browserPromise: Promise<import("playwright").BrowserContext> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hand-written stealth init script. Covers the bot-detection vectors
 * Aliyun captcha V3 is known to probe. Injected via page.addInitScript()
 * so it runs BEFORE the Aliyun SDK loads.
 *
 * Why these patches (ordered by importance):
 *   1. navigator.webdriver   — headless Chromium sets this to true; Aliyun
 *                              explicitly checks. THE #1 bot tell.
 *   2. window.chrome         — headless Chromium lacks this entirely.
 *                              Real Chrome has chrome.runtime, chrome.app,
 *                              chrome.csi, chrome.loadTimes. Aliyun probes
 *                              for chrome.runtime existence.
 *   3. navigator.languages   — headless default is empty array. Real
 *                              browsers have at least ['en-US', 'en'].
 *   4. navigator.plugins     — headless default is empty. Real Chrome
 *                              reports 3 fake PDF plugins. Aliyun checks
 *                              plugins.length > 0.
 *   5. WebGL vendor/renderer — headless returns "Google Inc. (Google)".
 *                              Real Chrome returns the actual GPU vendor
 *                              (e.g. "Intel Inc." / "ANGLE (Intel, ...)").
 *                              Aliyun reads UNMASKED_VENDOR_WEBGL (37445)
 *                              and UNMASKED_RENDERER_WEBGL (37446).
 *   6. permissions.query     — headless returns 'denied' for notifications,
 *                              real Chrome returns 'prompt'. Occasionally
 *                              checked.
 *   7. Function.prototype.toString — make our patched functions look
 *                              native. Some detectors call toString() on
 *                              overridden methods to detect monkey-patching.
 *   8. window.outerWidth/Height — headless sets these to 0. Harmless to
 *                              fake to non-zero.
 *
 * Patches NOT included (Aliyun captcha V3 doesn't check these):
 *   - iframe.contentWindow consistency (only checked by Cloudflare Turnstile)
 *   - media codec query (only checked by some video DRM systems)
 *   - sourceURL leakage in stack traces (rare, complex to fake correctly)
 */
/**
 * Lazily spawn the singleton Chromium browser. Subsequent calls return
 * the cached promise (so concurrent first-solves don't race to spawn
 * multiple browsers — they all await the same one).
 */
async function acquireBrowser(): Promise<import("playwright").BrowserContext> {
  if (!browserPromise) {
    browserPromise = (async () => {
      // v0.0.0.3: Ensure Playwright can find the bundled Chromium.
      // This MUST happen before chromium.launch() — Playwright reads
      // PLAYWRIGHT_BROWSERS_PATH at launch time, not at import time.
      ensureChromiumPath();

      // v0.0.0.5: Use executablePath to directly point at the bundled
      // chrome.exe. This bypasses Playwright's browser lookup logic
      // entirely (which involves Registry lookups, browsers.json parsing,
      // channel resolution — all of which can hang or fail in exe mode).
      //
      // We compute the path from PLAYWRIGHT_BROWSERS_PATH (which start.bat
      // / start.sh sets to the zip's chromium/ directory). The layout is:
      //   <PLAYWRIGHT_BROWSERS_PATH>/chromium-1228/chrome-win64/chrome.exe  (Windows)
      //   <PLAYWRIGHT_BROWSERS_PATH>/chromium-1228/chrome-linux64/chrome   (Linux)
      //
      // If the file doesn't exist, we fall back to letting Playwright find
      // it (which works in source mode after `playwright install chromium`).
      const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
      let executablePath: string | undefined;
      if (browsersPath) {
        // Also check if the exe is running on Windows even if platform
        // detection is off (bun build --compile can mismatch).
        const candidates = [
          join(browsersPath, "chromium-1228", "chrome-win64", "chrome.exe"),
          join(browsersPath, "chromium-1228", "chrome-linux64", "chrome"),
        ];
        for (const c of candidates) {
          if (existsSync(c)) {
            executablePath = c;
            break;
          }
        }
        if (executablePath) {
          console.log(`[captcha] Using bundled Chromium: ${executablePath}`);
        } else {
          console.warn(`[captcha] Bundled Chromium not found under ${browsersPath}, falling back to Playwright default search`);
        }
      }

      console.log("[captcha] Launching Chromium...");
      const launchStart = Date.now();
      // v0.0.0.6: Use launchPersistentContext instead of launch.
      // Playwright forbids --user-data-dir in launch() args; must use
      // launchPersistentContext(userDataDir, options). This also gives
      // us a fresh temp profile dir per launch (avoids permission issues
      // and locks from other Chrome instances on Windows).
      const userDataDir = process.env.PLAYWRIGHT_BROWSERS_PATH
        ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "..", "pw-profile")
        : join(tmpdir(), "zcode-pw-profile");
      const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        // v0.0.0.6: Explicit timeout — if launch hangs (Chrome for Testing
        // on Windows Server can hang on first-run checks / Google Update
        // service / default browser check), fail fast at 30s instead of
        // waiting 70s for the hard-guard.
        timeout: 30_000,
        // Context-level options (launchPersistentContext returns a context,
        // so UA / locale / viewport go here, not in newContext()).
        userAgent: FAKE_UA,
        locale: "en-US",
        viewport: { width: 1280, height: 720 },
        extraHTTPHeaders: {
          "accept-language": "en-US,en;q=0.9",
        },
        ...(executablePath ? { executablePath } : {}),
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-extensions",
          "--disable-gpu",
          // v0.0.0.6: Skip Windows first-run / default-browser checks.
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-sync",
          "--disable-translate",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--disable-device-discovery-notifications",
          "--disable-default-apps",
          "--disable-component-extensions-with-background-pages",
          "--disable-features=TranslateUI",
        ],
      });
      console.log(`[captcha] Chromium launched in ${Date.now() - launchStart}ms`);

      // v0.0.0.6: Inject stealth init scripts ONCE at context creation
      // (not per-solve). addInitScript registers a script that runs on
      // every navigation / setContent, before the page's own scripts.
      await browser.addInitScript(STEALTH_EVASIONS);
      await browser.addInitScript(`
        // Patch navigator.platform to match the Windows UA.
        try {
          Object.defineProperty(navigator, 'platform', {
            get: () => 'Win32',
            configurable: true,
          });
        } catch (e) {}
        // Patch navigator.userAgentData if the CDP call didn't set it.
        try {
          if (!navigator.userAgentData) {
            Object.defineProperty(navigator, 'userAgentData', {
              get: () => ({
                brands: [
                  { brand: ' Not A(Brand', version: '99' },
                  { brand: 'Chromium', version: '131' },
                  { brand: 'Google Chrome', version: '131' },
                ],
                mobile: false,
                platform: 'Windows',
                getHighEntropyValues: (hints) => Promise.resolve({
                  architecture: 'x86',
                  bitness: '64',
                  brands: [
                    { brand: ' Not A(Brand', version: '99.0.0.0' },
                    { brand: 'Chromium', version: '131.0.0.0' },
                    { brand: 'Google Chrome', version: '131.0.0.0' },
                  ],
                  fullVersionList: [
                    { brand: ' Not A(Brand', version: '99.0.0.0' },
                    { brand: 'Chromium', version: '131.0.0.0' },
                    { brand: 'Google Chrome', version: '131.0.0.0' },
                  ],
                  fullVersion: '131.0.0.0',
                  mobile: false,
                  model: '',
                  platform: 'Windows',
                  platformVersion: '10.0.0',
                  uaFullVersion: '131.0.0.0',
                  wow64: false,
                }),
                toJSON: () => ({
                  brands: [
                    { brand: ' Not A(Brand', version: '99' },
                    { brand: 'Chromium', version: '131' },
                    { brand: 'Google Chrome', version: '131' },
                  ],
                  mobile: false,
                  platform: 'Windows',
                }),
              }),
              configurable: true,
            });
          }
        } catch (e) {}
      `);

      return browser;
    })().catch((err) => {
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
 *   3. Injects STEALTH_EVASIONS via addInitScript (runs before any
 *      page script — patches navigator.webdriver, window.chrome, etc).
 *   4. Creates a Page, loads the bundled Aliyun SDK HTML.
 *   5. Calls initAliyunCaptcha, awaits the success callback.
 *   6. Closes the page and context (NOT the browser — singleton).
 *   7. Releases the browser (resets idle timer).
 *
 * @throws Error if the SDK fails to load, solve times out, or the SDK
 *         reports a failure. Caller (captcha.ts) retries.
 */
export async function solveInPlaywright(cfg: FetchedCaptchaConfig, _reqId?: string): Promise<string> {
  void _reqId;

  // Outer hard-guard race — matches the JSDOM path's safety net.
  const HARD_GUARD_MS_LOCAL = HARD_GUARD_MS;
  const result = await Promise.race([
    solveInPlaywrightInner(cfg),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`captcha (playwright) hard-guard timeout after ${HARD_GUARD_MS_LOCAL}ms`)),
        HARD_GUARD_MS_LOCAL,
      );
    }),
  ]);
  return result;
}

async function solveInPlaywrightInner(cfg: FetchedCaptchaConfig): Promise<string> {
  // v0.0.0.6: acquireBrowser() returns a BrowserContext with stealth
  // init scripts already injected. We just create a new page.
  const context = await acquireBrowser();
  const page = await context.newPage();

  try {
    // v0.0.0.6: Stealth is already injected via addInitScript at context
    // creation time, so the HTML only needs the Aliyun SDK. (Previously
    // we embedded STEALTH_EVASIONS in the HTML <head> too — redundant.)
    const sdkSafe = ALIYUN_SDK_LOCAL.replace(/<\/script>/gi, "<\\/script>");
    const html =
      "<!DOCTYPE html><html><head></head>" +
      "<body><div id=\"captcha-element\"></div><button id=\"captcha-button\"></button>" +
      "<script>" + sdkSafe + "</script></body></html>";

    console.log("[captcha] setContent...");
    const t1 = Date.now();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    console.log(`[captcha] setContent done in ${Date.now() - t1}ms`);

    console.log("[captcha] waiting for SDK to load...");
    const t2 = Date.now();
    await page.waitForFunction(
      () => typeof (window as any).initAliyunCaptcha === "function",
      { timeout: SDK_LOAD_TIMEOUT_MS },
    );
    console.log(`[captcha] SDK loaded in ${Date.now() - t2}ms`);

    // Call initAliyunCaptcha and await the success callback.
    //
    // IMPORTANT: page.evaluate runs in the BROWSER context. It cannot
    // see Node.js-side variables (SOLVE_TIMEOUT_MS, etc). All values
    // must be passed as the second argument to evaluate(), which becomes
    // the function's parameter inside the browser.
    console.log("[captcha] calling initAliyunCaptcha...");
    const t3 = Date.now();
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
    console.log(`[captcha] initAliyunCaptcha returned in ${Date.now() - t3}ms, verifyParam length: ${verifyParam.length}`);

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
// Close the browser on process exit so we don't leak Chromium processes.
process.on("beforeExit", () => { void shutdownPlaywrightBrowser(); });
process.on("exit", () => {
  // exit handler must be sync — fire-and-forget the close. Chromium will
  // be reaped by the OS if this doesn't complete in time.
  if (browserPromise) {
    browserPromise.then(b => { try { (b as unknown as { process?: { kill: (sig: string) => void } }).process?.kill("SIGKILL"); } catch {} }).catch(() => {});
  }
});
