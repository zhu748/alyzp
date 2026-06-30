#!/usr/bin/env bun
/**
 * Standalone captcha solver smoke test.
 *
 * Usage:
 *   bun run scripts/test-captcha.ts                 # default: auto mode
 *   ZCODE_CAPTCHA_SOLVER=playwright bun run scripts/test-captcha.ts
 *   ZCODE_CAPTCHA_SOLVER=jsdom bun run scripts/test-captcha.ts
 *
 * What it does:
 *   1. Fetches the live captcha config from zcode.z.ai/api/v1/client/configs
 *   2. Calls getCaptchaToken() (the same function handler.ts uses)
 *   3. Prints the resulting verifyParam length + first 80 chars
 *   4. Exits 0 on success, 1 on failure
 *
 * This is the fastest way to verify the captcha pipeline works without
 * needing to configure a full proxy + send a real chat request.
 *
 * Run this after `bun install` to confirm Playwright + Chromium are
 * correctly installed and the stealth plugin is bypassing Aliyun's
 * risk control.
 */
import { getCaptchaToken } from "../src/proxy/captcha.js";

const solver = process.env.ZCODE_CAPTCHA_SOLVER || "auto";
console.log(`[test-captcha] solver mode: ${solver}`);
console.log("[test-captcha] fetching captcha config + solving...");
console.log("[test-captcha] (first solve takes ~5-15s for Chromium launch + SDK load)\n");

const start = Date.now();
try {
  const result = await getCaptchaToken("test");
  const elapsed = Date.now() - start;
  console.log(`\n[test-captcha] ✓ SUCCESS in ${elapsed}ms`);
  console.log(`  verifyParam length: ${result.verifyParam.length}`);
  console.log(`  verifyParam prefix: ${result.verifyParam.substring(0, 80)}...`);
  console.log(`  region: ${result.region}`);
  console.log(`  solveMs: ${result.solveMs}ms`);
  console.log("\n[test-captcha] This token can be sent to zcode.z.ai as");
  console.log("  x-aliyun-captcha-verify-param: <token>");
  console.log("  x-aliyun-captcha-verify-region: <region>");
  process.exit(0);
} catch (err) {
  const elapsed = Date.now() - start;
  console.error(`\n[test-captcha] ✗ FAILED in ${elapsed}ms`);
  console.error(`  error: ${(err as Error).message}`);
  console.error(`\n[test-captcha] stack: ${(err as Error).stack ?? "(none)"}`);
  console.error("\n[test-captcha] Troubleshooting:");
  console.error("  1. If using playwright mode: ensure `bun install` ran the");
  console.error("     postinstall script (`playwright install chromium`).");
  console.error("  2. If on Docker: ensure the Dockerfile's apt-get install");
  console.error("     for libnss3, libatk1.0-0, etc. ran successfully.");
  console.error("  3. Try ZCODE_CAPTCHA_SOLVER=jsdom to isolate whether the");
  console.error("     issue is Playwright-specific or captcha-config-level.");
  console.error("  4. If jsdom ALSO fails with 'SDK fail: F001', that confirms");
  console.error("     Aliyun risk control is blocking this environment — use");
  console.error("     playwright mode (the default).");
  process.exit(1);
}
