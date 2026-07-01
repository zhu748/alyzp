#!/usr/bin/env bun
/**
 * Patch playwright-core for bun build --compile compatibility.
 *
 * === WHY THIS EXISTS ===
 *
 * `playwright-core/lib/coreBundle.js` has top-level `__esm` init blocks that
 * use `__dirname` to find files at module load time:
 *
 *   1. packageRoot = path.join(__dirname, "..");
 *      packageJSON = require(path.join(packageRoot, "package.json"));
 *
 *   2. registry = new Registry(require(path.join(packageRoot, "browsers.json")));
 *
 * Under `bun build --compile`, `__dirname` is resolved at BUILD TIME to the
 * absolute path of the build machine's node_modules. The compiled exe hardcodes
 * this path (e.g. `/home/runner/work/alyzp/alyzp/node_modules/playwright-core/`).
 * On Windows, this Linux path doesn't exist → `require()` throws
 * `Cannot find module '\home\runner\work\...\package.json'` → `chromium` object
 * is undefined → `chromium.launch()` throws `undefined is not an object` →
 * captcha solver falls back to JSDOM → F001.
 *
 * `--define "require.resolve=undefined"` doesn't help because this is
 * `require(path)`, not `require.resolve`.
 *
 * === THE PATCH ===
 *
 * `packageJSON` is ONLY used to read `.version` (for User-Agent header and
 * CLI version display). We replace the `require()` with a hardcoded version
 * string.
 *
 * `browsers.json` is used by the Registry to know which Chromium revision
 * to launch. We inline its content directly into coreBundle.js so no file
 * lookup is needed at runtime.
 *
 * `packageRoot` is set to `"."` (binPath is only used by CLI commands
 * we don't invoke).
 *
 * === USAGE ===
 *
 *   bun run scripts/patch-playwright.ts
 *
 * Automatically runs via `postinstall` in package.json (after `bun install`).
 * Also runs in GitHub Actions before `bun build`.
 *
 * Safe to run multiple times — detects if already patched and skips.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

const CORE_BUNDLE_PATH = new URL(
  "../node_modules/playwright-core/lib/coreBundle.js",
  import.meta.url,
).pathname;
const BROWSERS_JSON_PATH = new URL(
  "../node_modules/playwright-core/browsers.json",
  import.meta.url,
).pathname;

const PLAYWRIGHT_VERSION = "1.61.1";

function main() {
  if (!existsSync(CORE_BUNDLE_PATH)) {
    console.warn(
      "[patch-playwright] WARN: node_modules/playwright-core/lib/coreBundle.js not found.\n" +
        "  Run `bun install` first. Skipping patch.",
    );
    return;
  }

  // Read browsers.json content to inline it
  let browsersJsonContent = "{}";
  if (existsSync(BROWSERS_JSON_PATH)) {
    browsersJsonContent = readFileSync(BROWSERS_JSON_PATH, "utf-8").trim();
  } else {
    console.warn(
      "[patch-playwright] WARN: browsers.json not found, using empty object",
    );
  }

  let content = readFileSync(CORE_BUNDLE_PATH, "utf-8");
  let patched = 0;

  // Patch 1: packageRoot __dirname -> "."
  const patch1From = 'packageRoot = import_path8.default.join(__dirname, "..");';
  const patch1To = 'packageRoot = ".";';
  if (content.includes(patch1To)) {
    // already patched
  } else if (content.includes(patch1From)) {
    content = content.replace(patch1From, patch1To);
    console.log("[patch-playwright] ✓ packageRoot __dirname -> CWD-relative");
    patched++;
  } else {
    console.warn("[patch-playwright] WARN: packageRoot pattern not found");
  }

  // Patch 2: packageJSON require() -> hardcoded version
  const patch2From = 'packageJSON = require(import_path8.default.join(packageRoot, "package.json"));';
  const patch2To = `packageJSON = { version: "${PLAYWRIGHT_VERSION}" };`;
  if (content.includes(patch2To)) {
    // already patched
  } else if (content.includes(patch2From)) {
    content = content.replace(patch2From, patch2To);
    console.log("[patch-playwright] ✓ packageJSON require() -> hardcoded version");
    patched++;
  } else {
    console.warn("[patch-playwright] WARN: packageJSON pattern not found");
  }

  // Patch 3: browsers.json require() -> inlined content
  // This appears as: require(import_path19.default.join(packageRoot, "browsers.json"))
  // We replace the entire require() call with the JSON literal.
  const patch3From = 'require(import_path19.default.join(packageRoot, "browsers.json"))';
  const patch3To = browsersJsonContent;
  if (content.includes('registry = new Registry(' + browsersJsonContent.substring(0, 30))) {
    // already patched (check by looking for the start of the inlined JSON)
  } else if (content.includes(patch3From)) {
    content = content.replace(patch3From, patch3To);
    console.log("[patch-playwright] ✓ browsers.json require() -> inlined content");
    patched++;
  } else {
    console.warn("[patch-playwright] WARN: browsers.json pattern not found");
  }

  if (patched > 0) {
    writeFileSync(CORE_BUNDLE_PATH, content, "utf-8");
    console.log(`[patch-playwright] Done. ${patched} patch(es) applied to coreBundle.js`);
  } else {
    console.log("[patch-playwright] Already patched, nothing to do.");
  }
}

main();
