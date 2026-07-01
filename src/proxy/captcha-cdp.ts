/**
 * Aliyun Captcha V3 solver — pure CDP (Chrome DevTools Protocol) implementation.
 *
 * v0.0.0.9: COMPLETELY REPLACES Playwright.
 *
 * === WHY NO PLAYWRIGHT ===
 *
 * Playwright had 3 fatal issues under `bun build --compile --target=bun-windows-x64`:
 *
 *   1. __dirname hardcoded to build machine path → chromium undefined
 *      (fixed in v0.0.0.4 with patch-playwright.ts)
 *   2. DevToolsActivePort file not written by Chrome for Testing 149
 *      → Playwright's launch hangs 30s (fixed in v0.0.0.8 by spawning
 *      chrome ourselves with fixed port)
 *   3. connectOverCDP's WebSocket implementation times out on Bun
 *      ("retrieving websocket url" succeeds, "ws connecting" hangs)
 *      — this is a Bun + Playwright WebSocket incompatibility, unfixable
 *      without patching Playwright internals
 *
 * Solution: skip Playwright entirely. Use Bun's native WebSocket (which
 * works perfectly — tested 2ms connect time) + hand-written CDP commands.
 * We only need 4 CDP operations:
 *   - Page.navigate (to load the SDK HTML via data: URL)
 *   - Runtime.evaluate (to call initAliyunCaptcha + await result)
 *   - Page.addScriptToEvaluateOnNewDocument (stealth injection)
 *   - Emulation.setUserAgentOverride (UA + platform)
 *
 * === ARCHITECTURE ===
 *
 *   1. spawn chrome.exe with --remote-debugging-port=9222 (fixed port)
 *   2. fetch http://127.0.0.1:9222/json/version to get wsUrl
 *   3. Bun WebSocket connects to wsUrl (browser-level CDP)
 *   4. Create a new tab: Target.createTarget({ url: "about:blank" })
 *   5. Attach to the tab: Target.attachToTarget({ targetId, flatten: true })
 *   6. Inject stealth via Page.addScriptToEvaluateOnNewDocument
 *   7. Navigate to data:<html with Aliyun SDK>
 *   8. Runtime.evaluate: call initAliyunCaptcha, await success callback
 *   9. Close tab, kill chrome
 */
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcess } from "child_process";
import ALIYUN_SDK_LOCAL from "./AliyunCaptcha.js.txt" with { type: "text" };
import STEALTH_EVASIONS from "./stealth-evasions.js.txt" with { type: "text" };

const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT_MS || 40_000);

const CDP_PORT = 9222;

const FAKE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; }

// === Singleton chrome process ===
let chromeProcess: ChildProcess | null = null;
let wsConnection: { ws: WebSocket; sessionId: string } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Locate the bundled Chromium binary.
 */
function findChromiumExecutable(): string {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath) {
    const candidates = [
      join(browsersPath, "chromium-1228", "chrome-win64", "chrome.exe"),
      join(browsersPath, "chromium-1228", "chrome-linux64", "chrome"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  // Fallback: look in default Playwright cache locations
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const fallbacks = [
    join(home, ".cache", "ms-playwright", "chromium-1228", "chrome-linux64", "chrome"),
    join(home, "AppData", "Local", "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe"),
  ];
  for (const f of fallbacks) {
    if (existsSync(f)) return f;
  }
  throw new Error("captcha: chromium executable not found (looked in PLAYWRIGHT_BROWSERS_PATH and default cache)");
}

/**
 * Spawn chrome.exe with a fixed debug port, wait for "DevTools listening"
 * message, then connect via CDP.
 */
async function ensureChromeRunning(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const executablePath = findChromiumExecutable();
    console.log(`[captcha] Using Chromium: ${executablePath}`);

    const userDataDir = process.env.PLAYWRIGHT_BROWSERS_PATH
      ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "..", "pw-profile")
      : join(tmpdir(), "zcode-pw-profile");
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    try { mkdirSync(userDataDir, { recursive: true }); } catch {}

    console.log(`[captcha] Spawning chrome on port ${CDP_PORT}...`);
    const launchStart = Date.now();

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

    // Wait for "DevTools listening on ws://..." on stderr
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("captcha: chrome didn't start DevTools within 15s"));
      }, 15_000);
      const onExit = (code: number | null) => {
        clearTimeout(timeout);
        reject(new Error(`captcha: chrome exited (code ${code}) before DevTools started`));
      };
      chromeProcess!.on("exit", onExit);
      let buf = "";
      const check = (data: Buffer | string) => {
        buf += data.toString();
        if (buf.includes("DevTools listening on ws://")) {
          clearTimeout(timeout);
          chromeProcess!.removeListener("exit", onExit);
          resolve();
        }
      };
      chromeProcess!.stderr?.on("data", check);
      chromeProcess!.stdout?.on("data", check);
    });

    console.log(`[captcha] chrome DevTools ready in ${Date.now() - launchStart}ms`);

    // Connect WebSocket to browser-level CDP
    const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const info = await resp.json() as { webSocketDebuggerUrl: string };
    console.log(`[captcha] CDP wsUrl: ${info.webSocketDebuggerUrl}`);

    const ws = new WebSocket(info.webSocketDebuggerUrl);
    // Register message handlers IMMEDIATELY (before await open) so
    // we don't miss any CDP responses.
    setupWSHandlers(ws);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("captcha: WS connect timeout 5s")), 5_000);
      ws.onopen = () => { clearTimeout(timeout); resolve(); };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error("captcha: WS connect error")); };
    });

    // Create a new tab
    const tabResult = await sendCDP(ws, "Target.createTarget", { url: "about:blank" }) as { targetId: string };
    console.log(`[captcha] Created tab: ${tabResult.targetId}`);

    // Attach to the tab
    const attachResult = await sendCDP(ws, "Target.attachToTarget", { targetId: tabResult.targetId, flatten: true }) as { sessionId: string };

    wsConnection = { ws, sessionId: attachResult.sessionId };

    // Enable Page + Runtime domains on the tab
    await sendCDPSession(ws, attachResult.sessionId, "Page.enable", {});
    await sendCDPSession(ws, attachResult.sessionId, "Runtime.enable", {});

    // Inject stealth init script
    await sendCDPSession(ws, attachResult.sessionId, "Page.addScriptToEvaluateOnNewDocument", {
      source: STEALTH_EVASIONS + "\n" +
        `try { Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true }); } catch(e) {}
         try { if (!navigator.userAgentData) { Object.defineProperty(navigator, 'userAgentData', { get: () => ({ brands: [{brand:' Not A(Brand',version:'99'},{brand:'Chromium',version:'131'},{brand:'Google Chrome',version:'131'}], mobile: false, platform: 'Windows' }), configurable: true }); } } catch(e) {}`,
    });

    // Set UA override
    await sendCDPSession(ws, attachResult.sessionId, "Emulation.setUserAgentOverride", {
      userAgent: FAKE_UA,
      acceptLanguage: "en-US,en",
      platform: "Windows",
      userAgentMetadata: {
        brands: [{ brand: " Not A(Brand", version: "99" }, { brand: "Chromium", version: "131" }, { brand: "Google Chrome", version: "131" }],
        fullVersion: "131.0.0.0",
        platform: "Windows",
        platformVersion: "10.0.0",
        architecture: "x86",
        bitness: "64",
        model: "",
        mobile: false,
        wow64: false,
      },
    });

    console.log(`[captcha] Chrome fully initialized in ${Date.now() - launchStart}ms`);
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

// === CDP protocol helpers ===

let cdpId = 0;
const pendingCDP = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function sendCDP(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = ++cdpId;
  return new Promise((resolve, reject) => {
    pendingCDP.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function sendCDPSession(ws: WebSocket, sessionId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = ++cdpId;
  return new Promise((resolve, reject) => {
    pendingCDP.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

function setupWSHandlers(ws: WebSocket): void {
  ws.onmessage = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(ev.data as string);
      if (msg.id && pendingCDP.has(msg.id)) {
        const p = pendingCDP.get(msg.id)!;
        pendingCDP.delete(msg.id);
        if (msg.error) p.reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    } catch { /* ignore non-JSON */ }
  };
  ws.onerror = () => {
    for (const [, p] of pendingCDP) p.reject(new Error("captcha: WS error"));
    pendingCDP.clear();
  };
  ws.onclose = () => {
    for (const [, p] of pendingCDP) p.reject(new Error("captcha: WS closed"));
    pendingCDP.clear();
  };
}

/**
 * Solve the captcha using pure CDP.
 */
export async function solveInPlaywright(cfg: FetchedCaptchaConfig, _reqId?: string): Promise<string> {
  void _reqId;
  await ensureChromeRunning();
  if (!wsConnection) throw new Error("captcha: CDP connection not established");

  const { ws, sessionId } = wsConnection;
  // Handlers already set in ensureChromeRunning

  // Build the HTML with Aliyun SDK
  const sdkSafe = ALIYUN_SDK_LOCAL.replace(/<\/script>/gi, "<\\/script>");
  const html = `<!DOCTYPE html><html><head></head><body><div id="captcha-element"></div><button id="captcha-button"></button><script>${sdkSafe}</script></body></html>`;
  const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);

  // Navigate to the data URL
  console.log("[captcha] navigating to SDK page...");

  await sendCDPSession(ws, sessionId, "Page.navigate", { url: dataUrl });

  // Wait for initAliyunCaptcha to be available
  console.log("[captcha] waiting for SDK...");
  const t2 = Date.now();
  while (Date.now() - t2 < 20_000) {
    try {
      const result = await sendCDPSession(ws, sessionId, "Runtime.evaluate", {
        expression: "typeof window.initAliyunCaptcha === 'function' ? 'ready' : 'not-ready'",
        returnByValue: true,
      }) as { result: { value: string } };
      if (result.result.value === "ready") break;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`[captcha] SDK loaded in ${Date.now() - t2}ms`);

  // v0.0.0.10: Diagnose stealth patch effectiveness. If F001 persists,
  // this log shows exactly which fingerprint property Aliyun is detecting.
  // v0.0.0.11: Expanded to include behavioral signals (visibility, focus,
  // mouse events, RAF timing) — Aliyun traceless mode checks these too.
  try {
    const diag = await sendCDPSession(ws, sessionId, "Runtime.evaluate", {
      expression: `JSON.stringify({
        webdriver: navigator.webdriver,
        chrome: typeof window.chrome,
        chromeRuntime: typeof window.chrome?.runtime,
        plugins: navigator.plugins?.length,
        languages: navigator.languages?.length,
        vendor: navigator.vendor,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        uaDataBrands: navigator.userAgentData?.brands?.length,
        uaDataPlatform: navigator.userAgentData?.platform,
        webglVendor: (function(){ try { var c=document.createElement('canvas').getContext('webgl'); return c?c.getParameter(37445):null; } catch(e){ return 'err:'+e.message; } })(),
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        hasFocus: document.hasFocus(),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        screenWidth: screen.width,
        screenHeight: screen.height,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        cookieEnabled: navigator.cookieEnabled,
        doNotTrack: navigator.doNotTrack,
        maxTouchPoints: navigator.maxTouchPoints,
        pdfViewerEnabled: navigator.pdfViewerEnabled,
        webdriverProto: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'webdriver'),
        chromeApp: typeof window.chrome?.app,
        chromeCsi: typeof window.chrome?.csi,
        chromeLoadTimes: typeof window.chrome?.loadTimes,
        permissionsQuery: typeof navigator.permissions?.query,
        mediaCodecsMp4: (function(){ try { var v=document.createElement('video'); return v.canPlayType('video/mp4; codecs="avc1.42E01E"'); } catch(e){ return 'err'; } })(),
        mediaCodecsWebm: (function(){ try { var v=document.createElement('video'); return v.canPlayType('video/webm; codecs="vp8, vorbis"'); } catch(e){ return 'err'; } })(),
        iframeContentWindow: (function(){ try { var f=document.createElement('iframe'); document.body.appendChild(f); var r=typeof f.contentWindow; document.body.removeChild(f); return r; } catch(e){ return 'err:'+e.message; } })(),
      })`,
      returnByValue: true,
    }) as { result: { value: string } };
    console.log(`[captcha] stealth check: ${diag.result.value}`);
  } catch (e) {
    console.log(`[captcha] stealth check failed: ${(e as Error).message}`);
  }

  // Call initAliyunCaptcha and await the success callback
  console.log("[captcha] calling initAliyunCaptcha...");
  const t3 = Date.now();
  const solveExpression = `
    (function() {
      return new Promise(function(resolve, reject) {
        var timeout = setTimeout(function() { reject(new Error('solve timeout ${SOLVE_TIMEOUT_MS}ms')); }, ${SOLVE_TIMEOUT_MS});
        window.initAliyunCaptcha({
          SceneId: ${JSON.stringify(cfg.sceneId)},
          mode: "popup",
          region: ${JSON.stringify(cfg.region)},
          prefix: ${JSON.stringify(cfg.prefix)},
          language: "en",
          element: "#captcha-element",
          button: "#captcha-button",
          captchaLogoImg: "",
          showErrorTip: false,
          getInstance: function(inst) {
            var fn = inst.startTracelessVerification || inst.show;
            if (typeof fn !== "function") { clearTimeout(timeout); reject(new Error("no startTracelessVerification")); return; }
            try { fn.call(inst); } catch(e) { clearTimeout(timeout); reject(new Error("startTracelessVerification threw: " + e.message)); }
          },
          success: function(param) { clearTimeout(timeout); resolve(param); },
          fail: function(err) { clearTimeout(timeout); reject(new Error("SDK fail: " + JSON.stringify(err))); },
          onError: function(err) { clearTimeout(timeout); reject(new Error("SDK error: " + JSON.stringify(err))); }
        });
      });
    })()
  `;
  const solveResult = await sendCDPSession(ws, sessionId, "Runtime.evaluate", {
    expression: solveExpression,
    awaitPromise: true,
    returnByValue: true,
    timeout: SOLVE_TIMEOUT_MS,
  }) as { result: { value: string }, exceptionDetails?: { exception: { description: string } } };

  if (solveResult.exceptionDetails) {
    throw new Error(solveResult.exceptionDetails.exception.description || "captcha: solve failed");
  }
  console.log(`[captcha] solved in ${Date.now() - t3}ms, param length: ${solveResult.result.value.length}`);
  return solveResult.result.value;
}

/**
 * Shutdown chrome process.
 */
export async function shutdownPlaywrightBrowser(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (wsConnection) {
    try { wsConnection.ws.close(); } catch {}
    wsConnection = null;
  }
  if (chromeProcess) {
    try { chromeProcess.kill("SIGKILL"); } catch {}
    chromeProcess = null;
  }
  initPromise = null;
}

process.on("beforeExit", () => { void shutdownPlaywrightBrowser(); });
process.on("exit", () => {
  if (chromeProcess) { try { chromeProcess.kill("SIGKILL"); } catch {} }
});
