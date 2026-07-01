/**
 * Build-time script: extracts all stealth-plugin evasions into a single
 * JavaScript string and writes it to src/proxy/stealth-evasions.js.txt.
 *
 * === WHY THIS EXISTS ===
 *
 * `puppeteer-extra-plugin-stealth` uses `require()` dynamically at runtime
 * to load evasion modules. Under `bun build --compile --target=bun-windows-x64`,
 * all node_modules are gone — the .exe is standalone. Any `require()` at
 * runtime fails with "Cannot find package".
 *
 * This script solves the problem by running the stealth plugin AT BUILD
 * TIME (when node_modules still exist), capturing all the JavaScript code
 * that would be injected into the browser, and saving it as a text file.
 * The text file is then bundled into the .exe via `import ... with {type:"text"}`
 * — same pattern as AliyunCaptcha.js.txt.
 *
 * === HOW IT WORKS ===
 *
 * 1. Mock a `page` object with `evaluateOnNewDocument(fn, ...args)` that
 *    captures `fn.toString()` + the args (serialized as JSON).
 * 2. Load the stealth plugin's `withUtils` wrapper — it provides the
 *    `utils` object (replaceGetterWithProxy, makeHandler, etc.) that
 *    evasions use.
 * 3. Instantiate each evasion plugin, call `onPageCreated(mockPage)`.
 * 4. Capture the generated JS code (evasion function source + utils).
 * 5. Concatenate everything into one big IIFE.
 * 6. Write to src/proxy/stealth-evasions.js.txt.
 *
 * === USAGE ===
 *
 *   bun run scripts/generate-stealth-evasions.ts
 *
 * Run this after `bun install` (when stealth plugin is available) and
 * before `bun build`. The generated file is committed to the repo so
 * CI doesn't need to re-generate it.
 *
 * Re-run when:
 *   - puppeteer-extra-plugin-stealth is updated
 *   - New evasions are added
 *   - Aliyun risk control changes (may need custom evasions)
 */
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "src", "proxy", "stealth-evasions.js.txt");

// === Mock page object ===
// Captures every evaluateOnNewDocument call's function source + args.
const capturedScripts: string[] = [];

const mockPage = {
  evaluateOnNewDocument: (fn: Function, ...args: any[]) => {
    // The stealth plugin's withUtils wrapper passes an object like:
    //   { _utilsFns: {...}, _mainFunction: "...", _args: [...] }
    // where _utilsFns is a map of function-name → function-source-string,
    // _mainFunction is the evasion function source, and _args are the
    // evasion's options.
    //
    // We capture the FULL evaluated code — the wrapper that materializes
    // utils + the evasion function call — so the output is exactly what
    // would run in the browser.
    if (args.length > 0 && args[0]?._utilsFns) {
      // withUtils path
      const { _utilsFns, _mainFunction, _args } = args[0];
      const utilsCode = `
const _utilsFns = ${JSON.stringify(_utilsFns)};
const _mainFunction = ${JSON.stringify(_mainFunction)};
const _args = ${JSON.stringify(_args || [])};
const utils = Object.fromEntries(
  Object.entries(_utilsFns).map(function(entry) { return [entry[0], eval(entry[1])]; })
);
utils.init();
eval(_mainFunction)(utils, ..._args);
`;
      capturedScripts.push(`(function(){${utilsCode}})();`);
    } else {
      // Direct evaluateOnNewDocument(fn) path (no utils)
      capturedScripts.push(`(${fn.toString()})();`);
    }
    return Promise.resolve();
  },
  // Some evasions check page._client (for CDP interception). We don't
  // need CDP-level evasions (sourceurl) — they can't be done via
  // addInitScript anyway. Mock _client to null so those evasions skip.
  _client: null as any,
};

// === Load and run all evasions ===

async function generate() {
  console.log("[generate-stealth] Loading stealth plugin evasions...");

  const evasionNames = [
    "chrome.app",
    "chrome.csi",
    "chrome.loadTimes",
    "chrome.runtime",
    "iframe.contentWindow",
    "media.codecs",
    "navigator.hardwareConcurrency",
    "navigator.languages",
    "navigator.permissions",
    "navigator.plugins",
    "navigator.vendor",
    "navigator.webdriver",
    "user-agent-override",
    "webgl.vendor",
    "window.outerdimensions",
  ];

  for (const name of evasionNames) {
    try {
      const mod = require(
        `puppeteer-extra-plugin-stealth/evasions/${name}`
      );
      const plugin = mod({});

      // chrome.runtime evasion skips on non-HTTPS pages by default.
      // Our page is about:blank (not HTTPS), so we must enable
      // runOnInsecureOrigins to get chrome.runtime patched.
      if (name === "chrome.runtime") {
        try {
          plugin.opts.runOnInsecureOrigins = true;
        } catch { /* opts may be readonly in some versions */ }
      }

      // user-agent-override needs a userAgent string. Use a realistic
      // Chrome 131 on Windows UA (matches our FAKE_UA in captcha-playwright.ts).
      // Must pass via constructor, not plugin.opts assignment (readonly).
      if (name === "user-agent-override") {
        const uaPlugin = mod({
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          locale: "en-US,en",
          maskLinux: true,
        });
        if (typeof uaPlugin.onPageCreated === "function") {
          await uaPlugin.onPageCreated(mockPage);
          console.log(`[generate-stealth]   ✓ ${name} (with custom UA)`);
        }
        continue;
      }
      // navigator.vendor — default is "Google Inc." which is correct for Chrome.
      // navigator.hardwareConcurrency — default is 4, fine.

      if (typeof plugin.onPageCreated === "function") {
        await plugin.onPageCreated(mockPage);
        console.log(`[generate-stealth]   ✓ ${name}`);
      } else {
        console.log(`[generate-stealth]   - ${name} (no onPageCreated, skipping)`);
      }
    } catch (err) {
      console.warn(`[generate-stealth]   ✗ ${name}: ${(err as Error).message}`);
    }
  }

  // === Combine into one IIFE ===
  const combined = `(function(){
'use strict';
// AUTO-GENERATED by scripts/generate-stealth-evasions.ts
// Source: puppeteer-extra-plugin-stealth@2.11.2 evasions
// Do not edit manually — re-run the generator after updating stealth plugin.
//
// This file is loaded via page.addInitScript() BEFORE any page script.
// It patches navigator, window, chrome, WebGL, etc. to make headless
// Chromium look like a real Chrome browser to bot-detection systems
// (Aliyun captcha V3 risk control).
${capturedScripts.map((s, i) => `\n// --- evasion ${i + 1} ---\n${s}`).join("\n")}
})();`;

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, combined, "utf-8");

  console.log(`\n[generate-stealth] ✓ Wrote ${capturedScripts.length} evasions to:`);
  console.log(`  ${OUTPUT_PATH}`);
  console.log(`  Size: ${combined.length} bytes`);
}

generate().catch((err) => {
  console.error("[generate-stealth] FAILED:", err);
  process.exit(1);
});
