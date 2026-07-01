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
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcess } from "child_process";
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
let chromeProcess: ChildProcess | null = null;

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
      ensureChromiumPath();

      // v0.0.0.5: Find the bundled chrome.exe.
      const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
      let executablePath: string | undefined;
      if (browsersPath) {
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
      // v0.0.0.8: If no bundled chromium found, ask Playwright for its
      // default executable path (works in source mode after
      // `playwright install chromium`).
      if (!executablePath) {
        try {
          executablePath = chromium.executablePath();
          console.log(`[captcha] Using Playwright default Chromium: ${executablePath}`);
        } catch {
          // executablePath() throws if chromium not installed
        }
      }

      // v0.0.0.8: Bypass Playwright's launch entirely. Spawn chrome.exe
      // ourselves with a FIXED debug port, wait for "DevTools listening"
      // message on stderr, then connectOverCDP.
      //
      // Why: Playwright's launch (even with pipe:false) uses
      // --remote-debugging-port=0 and reads DevToolsActivePort file to
      // discover the chosen port. Chrome for Testing 149 on some Windows
      // setups doesn't write this file (confirmed by user manual test:
      // chrome prints "DevTools listening on ws://127.0.0.1:9222/..."
      // but DevToolsActivePort file is never created). Playwright waits
      // 30s for the file then times out.
      //
      // Our approach:
      //   1. Pick a fixed port (9222 — unlikely to conflict)
      //   2. spawn chrome.exe with --remote-debugging-port=9222
      //   3. Read chrome's stderr until we see "DevTools listening on ws://"
      //   4. chromium.connectOverCDP("http://127.0.0.1:9222") to connect
      //
      // This is 100% reliable — no dependency on DevToolsActivePort file,
      // no dependency on Playwright's launch logic, no pipe inheritance.
      const CDP_PORT = 9222;
      const userDataDir = process.env.PLAYWRIGHT_BROWSERS_PATH
        ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "..", "pw-profile")
        : join(tmpdir(), "zcode-pw-profile");

      // Clean up stale profile (avoids "ProfileInUse" errors).
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
      try { mkdirSync(userDataDir, { recursive: true }); } catch {}

      if (!executablePath) {
        throw new Error("captcha: chromium executable not found");
      }

      const launchStart = Date.now();
      console.log(`[captcha] Spawning chrome.exe on port ${CDP_PORT}...`);

      const args = [
        "--headless=new",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
        "--disable-gpu",
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
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        "about:blank",
      ];

      chromeProcess = spawn(executablePath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      // Wait for chrome to print "DevTools listening on ws://..." on stderr.
      // Chrome writes its startup logs to stderr, not stdout.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`captcha: chrome didn't start DevTools server within 15s`));
        }, 15_000);

        const onExit = (code: number | null) => {
          clearTimeout(timeout);
          reject(new Error(`captcha: chrome exited with code ${code} before DevTools started`));
        };
        chromeProcess!.on("exit", onExit);

        let stderrBuf = "";
        const checkOutput = (data: Buffer | string) => {
          stderrBuf += data.toString();
          if (stderrBuf.includes("DevTools listening on ws://")) {
            clearTimeout(timeout);
            chromeProcess!.removeListener("exit", onExit);
            resolve();
          }
        };
        chromeProcess!.stderr?.on("data", checkOutput);
        chromeProcess!.stdout?.on("data", checkOutput);
      });

      console.log(`[captcha] chrome.exe DevTools ready in ${Date.now() - launchStart}ms`);

      // Connect to chrome via CDP.
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      // connectOverCDP returns a Browser; get its default context.
      const context = browser.contexts()[0] || await browser.newContext({
        userAgent: FAKE_UA,
        locale: "en-US",
        viewport: { width: 1280, height: 720 },
        extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
      });

      console.log(`[captcha] Chromium connected in ${Date.now() - launchStart}ms total`);

      // Inject stealth init scripts ONCE at context creation.
      await context.addInitScript(STEALTH_EVASIONS);
      await context.addInitScript(`
        try {
          Object.defineProperty(navigator, 'platform', {
            get: () => 'Win32', configurable: true,
          });
        } catch (e) {}
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
                getHighEntropyValues: () => Promise.resolve({
                  architecture: 'x86', bitness: '64',
                  brands: [
                    { brand: ' Not A(Brand', version: '99.0.0.0' },
                    { brand: 'Chromium', version: '131.0.0.0' },
                    { brand: 'Google Chrome', version: '131.0.0.0' },
                  ],
                  fullVersion: '131.0.0.0', mobile: false, model: '',
                  platform: 'Windows', platformVersion: '10.0.0',
                  uaFullVersion: '131.0.0.0', wow64: false,
                }),
                toJSON: () => ({
                  brands: [
                    { brand: ' Not A(Brand', version: '99' },
                    { brand: 'Chromium', version: '131' },
                    { brand: 'Google Chrome', version: '131' },
                  ],
                  mobile: false, platform: 'Windows',
                }),
              }),
              configurable: true,
            });
          }
        } catch (e) {}
      `);

      return context;
    })().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
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
    // v0.0.0.8: Also kill the chrome process we spawned.
    if (chromeProcess) {
      try { chromeProcess.kill(); } catch { /* best-effort */ }
      chromeProcess = null;
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
  // v0.0.0.8: Kill the chrome process we spawned.
  if (chromeProcess) {
    try { chromeProcess.kill(); } catch { /* best-effort */ }
    chromeProcess = null;
  }
}

// === Process lifecycle hooks ===
process.on("beforeExit", () => { void shutdownPlaywrightBrowser(); });
process.on("exit", () => {
  if (chromeProcess) {
    try { chromeProcess.kill("SIGKILL"); } catch {}
  }
});
