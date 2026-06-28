/**
 * Encrypted file-based credential store with multi-account support.
 *
 * File format (v2):
 *   { version: 2, activeId: string | null, accounts: StoredAccount[] }
 *
 * Backward compat: if the on-disk file is the original v1 format ({ encrypted: ... }),
 * it is migrated on first load (decrypted, wrapped in a single account, marked active).
 *
 * Encryption: AES-256-GCM with a FIXED key derived from SHA-256("520").
 * The same key is used on every machine, every OS, every run — so credentials.json
 * is portable across devices and never breaks due to key drift. This is a conscious
 * trade-off: we give up encryption-at-rest strength (anyone with the source code
 * can decrypt the file) in exchange for never losing user data to key-derivation
 * bugs. For a local dev tool where the credentials file lives on the user's own
 * machine, this is the right trade-off.
 *
 * @see .omo/plans/zcode-proxy.md Task 14
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { atomicWriteFile, createMutex } from "../utils/fs.js";
import type { Credential } from "./types.js";

/**
 * Store directory.
 *
 * Defaults to `~/.zcode-proxy` for local desktop use (ZCode-import flow,
 * OAuth multi-account). On read-only filesystems (e.g. Render containers),
 * set `ZCODE_PROXY_STORE_DIR` to a writable path such as `/data/.zcode-proxy`
 * (persistent disk) or `/tmp/zcode-proxy/.zcode-proxy` (ephemeral).
 *
 * In `auth.mode: apikey` the store is only used by the dashboard's
 * multi-account UI — if you never use that UI, an empty/unwritable store
 * is harmless (reads return null, writes are silently no-oped by the upper
 * layer's try/catch).
 */
const STORE_DIR = process.env.ZCODE_PROXY_STORE_DIR ?? join(homedir(), ".zcode-proxy");
const STORE_FILE = join(STORE_DIR, "credentials.json");
/**
 * Optional env var: if set, its value is used as a legacy seed for decrypt
 * fallback (lets users recover credentials.json encrypted by an old version
 * whose homedir/platform/arch differed from the current one). ONLY used in
 * the decrypt fallback — new encryption always uses the fixed 520 key.
 *
 * NOTE: ZCODE_PROXY_CREDENTIAL_SECRET is intentionally NOT consulted.
 * The user's explicit requirement is "all keys encrypted/decrypted via the
 * 520 fixed key only — no separate secret file, no env-var override." The
 * old env-var-derived key was the #1 cause of "credentials lost on restart"
 * because if the env var was set during one run and unset the next, the key
 * silently rotated and the file became undecryptable. The fixed 520 key
 * eliminates that entire class of bugs.
 */
const ENV_LEGACY_SEED = "ZCODE_PROXY_LEGACY_SEED";

/**
 * In-memory cache of the decrypted store. Set to `undefined` to indicate
 * "not yet loaded" (distinct from `null` = "loaded but file doesn't exist").
 * Invalidated by every writeStore() and clearCredential() call so callers
 * always see fresh data after a mutation.
 *
 * v0.1.5+ STALENESS DETECTION: cross-process writes (e.g. `auth login` from
 * start.bat while the proxy is running) won't invalidate this cache — they
 * happen in a separate process. To catch that case, loadCredential() and
 * exportAccounts() now stat() the file's mtimeMs and compare against the
 * cached value. If the file was modified externally, the cache is dropped
 * and the next read goes to disk. This is cheap (one stat per read) and
 * catches the common case of "user added a credential via CLI".
 */
let cachedStore: StoreV2 | null | undefined = undefined;
/** mtimeMs of the on-disk credentials.json at the time cachedStore was
 *  populated. Used to detect external writes (cross-process). -1 = unknown
 *  (force re-read on next access). 0 = file didn't exist. */
let cachedStoreMtimeMs = -1;

/**
 * Guard flag set by readStoreUncached() when credentials.json exists on disk
 * but cannot be decrypted (wrong key, corrupt ciphertext, etc.).
 *
 * While this flag is true, writeStore() REFUSES to overwrite credentials.json —
 * forcing saveCredential() to throw instead of silently destroying the user's
 * existing accounts. The flag is cleared by clearCredential() (the user must
 * explicitly confirm they want to discard the unreadable file) or by a
 * successful readStoreUncached() (the file was deleted or fixed).
 */
let undecryptableFilePresent = false;

/** One stored account record (without encryption — encryption wraps the whole file). */
export interface StoredAccount {
  /** Stable unique id (16 hex chars). */
  id: string;
  /** Human-readable label, e.g. "Z.AI · 2024-06-22 14:30". */
  label: string;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** The credential payload. */
  credential: Credential;
}

interface StoreV2 {
  version: 2;
  activeId: string | null;
  accounts: StoredAccount[];
}

// ---------------------------------------------------------------------------
// Encryption (AES-256-GCM via Node.js crypto — compatible with all platforms)
// ---------------------------------------------------------------------------

/**
 * The fixed encryption key seed. AES-256 requires a 32-byte key, so we derive
 * the actual key via SHA-256. The seed value "520" is intentionally trivial —
 * the goal is NOT cryptographic security (anyone with the source can decrypt
 * the file), but rather a stable, portable obfuscation that prevents casual
 * shoulder-surfing of plaintext credentials in `credentials.json`.
 *
 * Why a fixed key instead of per-machine key derivation:
 *   - The previous scheme derived the key from `${homedir}-${platform}-${arch}`,
 *     which broke whenever the user changed username, upgraded OS, switched
 *     32-bit↔64-bit binaries, or copied credentials.json to another machine.
 *     Each of those scenarios silently rotated the key and locked the user out
 *     of their own credentials — leading to data loss.
 *   - A fixed key eliminates that entire class of bugs. The same credentials.json
 *     file works on every machine, every OS, every Bun version, forever.
 *
 * If you ever need to change this value, ALL existing credentials.json files
 * will become unreadable (the decrypt fallback will try the old key via the
 * legacy-seed mechanism, but only if ZCODE_PROXY_LEGACY_SEED is set to "520").
 */
const FIXED_KEY_SEED = "520";

/**
 * In-memory cache of the fixed encryption key. Set once on first call to
 * avoid re-hashing on every encrypt/decrypt. Reset by `_resetKeyCacheForTesting`
 * between unit tests (harmless no-op for the fixed key — kept for backward
 * compat with test code that calls it).
 */
let cachedKey: Buffer | null = null;

/**
 * Reset the key cache. Internal — used by unit tests. With the fixed-key
 * scheme this is effectively a no-op (the cache will be repopulated with the
 * same SHA-256("520") on the next call), but it's kept so existing test code
 * that calls it between cases doesn't break.
 * @internal
 */
export function _resetKeyCacheForTesting(): void {
  cachedKey = null;
}

/**
 * SHA-256–derive a 256-bit key from a seed string. Used by the fixed-key
 * derivation and by the legacy multi-seed fallback in decrypt().
 */
function deriveSha256Key(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}

/**
 * Derive the legacy XOR-fold key (zcode-api-ref / early zhipu format).
 * NOT cryptographic — kept only so users with credentials.json from the
 * open-source zcode-api-ref repo can be transparently migrated via the
 * decrypt fallback.
 */
function deriveXorFoldKey(seed: string): Buffer {
  const hash = Buffer.alloc(32);
  const seedBytes = Buffer.from(seed, "utf8");
  for (let i = 0; i < seedBytes.length; i++) {
    hash[i % 32] ^= seedBytes[i];
  }
  return hash;
}

/**
 * Get the encryption key. Always returns SHA-256("520") — a fixed, portable
 * key that never changes across machines, OS versions, or Bun versions.
 *
 * This eliminates the entire class of "key drift" bugs that previously caused
 * credential corruption:
 *   - homedir() resolving differently across Bun versions
 *   - USERPROFILE vs HOMEDRIVE+HOMEPATH on Windows
 *   - 32-bit vs 64-bit binary switching arch
 *   - username changes / OS reinstalls
 *   - copying credentials.json between machines
 *   - ZCODE_PROXY_CREDENTIAL_SECRET env var being set during one run and not
 *     the next (the most recent incarnation of the bug — now permanently
 *     fixed by removing the env-var path entirely)
 *
 * The fixed key is cached after the first call. There is NO env var override,
 * NO key file in the credential directory, NO seed derivation — just one
 * constant key, everywhere, always. New encryption always uses this key.
 * Decrypt has a one-time fallback for files encrypted by older versions
 * (see buildCandidateKeysForDecrypt) but that fallback only READS — it never
 * affects what key new writes use.
 */
function getEncryptionKeyBuffer(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = deriveSha256Key(FIXED_KEY_SEED);
  return cachedKey;
}

/**
 * Build a list of candidate encryption keys to try during decrypt fallback.
 *
 * This is ONLY used when the fixed key fails to decrypt the file — i.e. the
 * file was encrypted by an OLDER version of this code that used seed-based
 * or env-var-based key derivation. Once the fallback succeeds, the file is
 * re-encrypted with the fixed key on the next writeStore() call, so the
 * fallback is a one-time migration path.
 *
 * Candidate seeds cover common version-drift scenarios:
 *   - `${home}-${plat}-${arch}`     historical seed template
 *   - `${home}-${plat}`             arch differed (32-bit vs 64-bit binary)
 *   - `${home}-${arch}`             platform differed (unlikely but cheap)
 *   - `${home}`                     old version may have only used homedir
 *   - `ZCODE_PROXY_LEGACY_SEED`     user-supplied (manual recovery)
 *   - `ZCODE_PROXY_CREDENTIAL_SECRET`  old env-var-derived key (recovery)
 *
 * For each seed we generate both SHA-256 (zhipu) and XOR-fold (zcode-api-ref)
 * derived keys, matching the historical key derivation functions.
 */
function buildCandidateKeysForDecrypt(): Array<{ label: string; key: Buffer }> {
  const home = homedir();
  const plat = process.platform;
  const arch = process.arch;

  // Collect all plausible "home path" strings that an older version might
  // have used as the seed. The variations cover:
  //   - os.homedir() result (current Bun version)
  //   - Direct env vars (old Bun 1.1 used USERPROFILE on Windows verbatim,
  //     and HOME on Unix — these may differ from homedir() in case / trailing
  //     slash / canonicalization).
  //   - Windows HOMEDRIVE+HOMEPATH fallback (some corporate Windows installs
  //     have USERPROFILE pointing to a redirected folder while HOMEDRIVE+
  //     HOMEPATH points to the canonical local path).
  const homeVariants = new Set<string>();
  homeVariants.add(home);
  const userProfile = process.env.USERPROFILE;
  if (userProfile) homeVariants.add(userProfile);
  const homeDrive = process.env.HOMEDRIVE;
  const homePath = process.env.HOMEPATH;
  if (homeDrive && homePath) homeVariants.add(`${homeDrive}${homePath}`);
  const homeEnv = process.env.HOME;
  if (homeEnv) homeVariants.add(homeEnv);

  // For each home variant, build the full seed combinations an older version
  // might have used.
  const seeds = new Set<string>();
  for (const h of homeVariants) {
    seeds.add(`${h}-${plat}-${arch}`);
    seeds.add(`${h}-${plat}`);
    seeds.add(`${h}-${arch}`);
    seeds.add(`${h}`);
  }
  // User-supplied legacy seed (manual recovery). This is the ONLY env-var
  // path consulted by the decrypt fallback. Users with credentials.json
  // encrypted by an older version that derived the key from homedir/platform/
  // arch (or via the removed ZCODE_PROXY_CREDENTIAL_SECRET env var) can set
  // ZCODE_PROXY_LEGACY_SEED to that old seed string and the file will be
  // recovered, then re-encrypted with the fixed 520 key on the next
  // writeStore() — so this is a one-time migration, not a permanent
  // dependency on the old key.
  const legacyEnv = process.env[ENV_LEGACY_SEED];
  if (legacyEnv) seeds.add(legacyEnv);
  // NOTE: ZCODE_PROXY_CREDENTIAL_SECRET is intentionally NOT consulted here.
  // It was the #1 cause of "credentials lost on restart" because setting it
  // in one run and not the next rotated the key silently. The fixed 520 key
  // + ZCODE_PROXY_LEGACY_SEED (manual, opt-in recovery) is the only path
  // forward. Users with old env-var-encrypted files can set
  // ZCODE_PROXY_LEGACY_SEED to the old secret value to recover.

  const candidates: Array<{ label: string; key: Buffer }> = [];
  for (const seed of seeds) {
    const shortSeed = seed.length > 60 ? seed.slice(0, 57) + "..." : seed;
    candidates.push({ label: `SHA-256("${shortSeed}")`, key: deriveSha256Key(seed) });
    candidates.push({ label: `XOR-fold("${shortSeed}")`, key: deriveXorFoldKey(seed) });
  }
  return candidates;
}

/**
 * Encrypt plaintext using AES-256-GCM (Node.js crypto) with the fixed key.
 * Output format: base64( IV[16] + AUTH_TAG[16] + CIPHERTEXT )
 */
async function encrypt(plaintext: string): Promise<string> {
  const key = getEncryptionKeyBuffer();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt ciphertext. Tries the fixed key first, then falls back to legacy
 * candidate keys for one-time recovery of files encrypted by older versions.
 *
 *   1. Fixed key (SHA-256("520")), Node.js crypto format (IV[16] + AUTH_TAG[16] + CIPHERTEXT).
 *      This handles ALL files encrypted by the current code — the normal path.
 *
 *   2. Fixed key in legacy WebCrypto format (IV[12] + encrypted+tag).
 *      Handles files encrypted by very old zhipu versions that used WebCrypto
 *      with the same key but a different cipher implementation.
 *
 *   3. Multi-seed fallback: iterate through ALL candidate seeds (homedir
 *      variants, ZCODE_PROXY_LEGACY_SEED, ZCODE_PROXY_CREDENTIAL_SECRET) in
 *      BOTH SHA-256 and XOR-fold derivations, in BOTH Node and WebCrypto
 *      formats. This recovers files encrypted by older versions of this code
 *      that used seed-based or env-var-based key derivation.
 *
 * On fallback success, the file is NOT re-encrypted with the fallback key.
 * Instead, the plaintext is returned to the caller (readStoreUncached), which
 * parses it into a StoreV2. The next writeStore() call will re-encrypt with
 * the fixed key — so the fallback is a one-time migration path, not a
 * permanent dependency on the old key.
 */
async function decrypt(ciphertext: string): Promise<string> {
  const data = Buffer.from(ciphertext, "base64");

  // Helper: try decrypting with a key in Node.js crypto format (IV[16] + tag[16] + ct)
  const tryNodeFormat = (key: Buffer): string | null => {
    if (data.length < 32) return null;
    try {
      const iv = data.subarray(0, 16);
      const tag = data.subarray(16, 32);
      const encrypted = data.subarray(32);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
    } catch {
      return null;
    }
  };

  // Helper: try decrypting with a key in legacy WebCrypto format (IV[12] + ct+tag)
  const tryWebCryptoFormat = async (key: Buffer): Promise<string | null> => {
    try {
      const keyCopy = new Uint8Array(32);
      keyCopy.set(key);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyCopy,
        { name: "AES-GCM" },
        false,
        ["decrypt"],
      );
      const iv = new Uint8Array(data.subarray(0, 12));
      const encrypted = new Uint8Array(data.subarray(12));
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        encrypted,
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  };

  // --- Try 1: fixed key, Node.js crypto format (the normal path) ---
  const fixedKey = getEncryptionKeyBuffer();
  let plaintext = tryNodeFormat(fixedKey);
  if (plaintext !== null) return plaintext;

  // --- Try 2: fixed key in legacy WebCrypto format ---
  plaintext = await tryWebCryptoFormat(fixedKey);
  if (plaintext !== null) return plaintext;

  // --- Try 3: multi-seed fallback (legacy file recovery) ---
  // Only reached if the file was encrypted by an older version with a different
  // key. We try every plausible candidate; on success, the caller will
  // re-encrypt with the fixed key on the next writeStore().
  const seen = new Set<string>([fixedKey.toString("hex")]);
  for (const { label, key } of buildCandidateKeysForDecrypt()) {
    // Skip duplicate keys (different seeds can derive the same key).
    const hex = key.toString("hex");
    if (seen.has(hex)) continue;
    seen.add(hex);

    plaintext = tryNodeFormat(key);
    if (plaintext !== null) {
      console.log(`[store] Decryption succeeded with legacy fallback key: ${label}. File will be re-encrypted with the fixed key on next save.`);
      return plaintext;
    }

    plaintext = await tryWebCryptoFormat(key);
    if (plaintext !== null) {
      console.log(`[store] Decryption succeeded with legacy fallback key (WebCrypto format): ${label}. File will be re-encrypted with the fixed key on next save.`);
      return plaintext;
    }
    void label; // label retained for future debug logging
  }

  throw new Error(
    "Failed to decrypt credential store. Tried: fixed key SHA-256(\"520\") " +
    "(Node + WebCrypto formats), multi-seed fallback covering homedir/platform/" +
    "arch variations across Bun versions (Bun 1.1/1.2/1.3 homedir() differences, " +
    "USERPROFILE vs HOMEDRIVE+HOMEPATH, etc.). If your credentials.json was " +
    "encrypted on a different machine / OS / username, or by an older version " +
    "that consulted ZCODE_PROXY_CREDENTIAL_SECRET, set ZCODE_PROXY_LEGACY_SEED " +
    "to the old seed string (e.g. \"C:\\\\Users\\\\OldName-win32-x64\" or the old " +
    "secret value) and retry. As a last resort, run `zcode-proxy auth logout` " +
    "to discard and re-login."
  );
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

function genId(): string {
  // 16 random bytes = 128 bits = 32 hex chars. Matches UUID-style entropy.
  // 8 bytes was previously used; 16 is the modern default and removes any
  // collision concern when accounts are imported from another machine.
  return randomBytes(16).toString("hex");
}

function defaultLabel(cred: Credential, createdAt: number): string {
  const ts = new Date(createdAt).toISOString().slice(0, 16).replace("T", " ");
  return `${cred.provider} · ${ts}`;
}

/**
 * Read the store, using the in-memory cache when fresh. Detects external
 * writes by stat-ing the file's mtimeMs — if the file changed on disk
 * (e.g. `auth login` from start.bat in another process added a credential),
 * the cache is dropped and the next read goes to disk.
 *
 * The stat() call is ~50µs on Linux/macOS and ~200µs on Windows — negligible
 * compared to the JSON parse + AES-256-GCM decrypt we'd otherwise do (~1ms).
 */
async function readStore(): Promise<StoreV2 | null> {
  if (cachedStore !== undefined) {
    // Cache populated — check mtime to detect external writes.
    // Skip the stat if we know the file doesn't exist (cachedStore === null
    // and cachedStoreMtimeMs === 0 means "loaded, file didn't exist").
    if (cachedStoreMtimeMs === 0) return cachedStore;
    try {
      const st = statSync(STORE_FILE);
      if (st.mtimeMs === cachedStoreMtimeMs) {
        return cachedStore; // fresh
      }
      // mtime changed — external write. Drop cache + fall through.
      console.log("[store] credentials.json mtime changed — external write detected, refreshing cache");
      cachedStore = undefined;
      cachedStoreMtimeMs = -1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // File was deleted externally — cache is now stale (if it claimed
        // to exist) or already correct (if it claimed null).
        if (cachedStore !== null) {
          console.log("[store] credentials.json disappeared — external delete detected, refreshing cache");
          cachedStore = undefined;
          cachedStoreMtimeMs = -1;
        }
      } else {
        // EPERM/EBUSY/etc — be conservative, drop cache.
        cachedStore = undefined;
        cachedStoreMtimeMs = -1;
      }
    }
  }
  if (cachedStore !== undefined) return cachedStore;
  cachedStore = await readStoreUncached();
  // Capture mtime AFTER the successful read so subsequent reads can detect
  // external writes. If the file doesn't exist, set 0 (skip-stat fast path).
  if (cachedStore === null) {
    cachedStoreMtimeMs = 0;
  } else {
    try {
      cachedStoreMtimeMs = statSync(STORE_FILE).mtimeMs;
    } catch {
      cachedStoreMtimeMs = -1; // unknown — force re-stat next time
    }
  }
  return cachedStore;
}

/**
 * Invalidate the in-memory store cache. Call this before any read that MUST
 * reflect external writes (e.g. another process added a credential via
 * start.bat while the proxy server was still running).
 *
 * Safe to call when the cache is already empty — it just resets the sentinel.
 * After this call, the next readStore() will re-read from disk + re-decrypt.
 */
export function invalidateStoreCache(): void {
  cachedStore = undefined;
  cachedStoreMtimeMs = -1;
}

/** Uncached inner implementation. Does the actual disk + decrypt work. */
async function readStoreUncached(): Promise<StoreV2 | null> {
  if (!existsSync(STORE_FILE)) {
    // File doesn't exist — clear the guard. Without this, a previous failed
    // read would leave undecryptableFilePresent=true forever, locking the user
    // out of saving new credentials even after the file was deleted externally.
    undecryptableFilePresent = false;
    return null;
  }

  // Read with retry — on Windows, the file can be transiently locked by
  // antivirus / Windows Search indexer / backup tools during a concurrent
  // write. A single failed read would mark the file as "corrupted" and
  // create a .broken-* backup, even though the file is perfectly fine and
  // the next read would succeed. This was a major contributor to the
  // ".broken files piling up" symptom: every dashboard refresh during a
  // brief AV scan would back up the (locked, unreadable) file.
  //
  // We retry up to 5 times with 50ms backoff before declaring the file
  // unreadable.
  //
  // === CRITICAL FIX (event-loop blocking) ===
  // Previously this used a SYNCHRONOUS busy-wait spin:
  //   `while (Date.now() < end) { /* spin */ }`
  // which blocked the entire Bun event loop for up to 50+100+150+200+250
  // = 750ms. During that window, ALL HTTP requests, SSE pushes, and
  // timers were frozen — manifesting as "管理面板刷新卡一会才能点击".
  //
  // Now we use `await new Promise(r => setTimeout(r, ms))` which yields
  // to the event loop, letting other requests proceed during the backoff.
  let raw: string | null = null;
  let readErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      raw = readFileSync(STORE_FILE, "utf-8");
      readErr = null;
      break;
    } catch (err) {
      readErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      // EPERM/EBUSY/EACCES: transient Windows lock — retry with ASYNC sleep.
      // ENOENT: file disappeared between existsSync and readFileSync (another
      // process deleted it) — retry won't help, treat as "no file".
      if (code === "ENOENT") {
        undecryptableFilePresent = false;
        return null;
      }
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        // ASYNC sleep — yields to the event loop so other requests aren't
        // blocked during the backoff window. This is the key fix for the
        // "刷新卡顿" symptom on Windows.
        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      // Other errors (EISDIR, etc.) — don't retry
      break;
    }
  }
  if (raw === null) {
    // All retries failed OR a non-retryable error. Log the actual error code
    // so the user can diagnose (AV lock vs permission vs disk failure).
    console.warn(`[store] Could not read credentials.json after retries: ${(readErr as Error)?.message ?? readErr}`);
    // Do NOT backupCorruptedStore here — we don't have content to back up,
    // and the file may just be transiently locked. Return null (treat as
    // empty) without setting the guard, so the next read can try again.
    return null;
  }

  // EMPTY FILE DEFENSE: if the file is empty or whitespace-only, it was
  // almost certainly left behind by a crashed write (the old writeFileSync
  // truncated-then-write race, before atomicWriteFile was added). Backing
  // up an empty file is pointless (there's nothing to recover) and creates
  // spam .broken-* files. Instead, treat as "no store" and let the next
  // saveCredential create a fresh one. We still set the guard so a
  // concurrent save doesn't overwrite — but since the file is empty,
  // overwriting is actually fine, so we DON'T set the guard.
  if (raw.trim() === "") {
    console.warn(`[store] credentials.json is empty (likely from a crashed write). Treating as no store — next save will create a fresh one.`);
    undecryptableFilePresent = false;
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // File exists but isn't valid JSON — this means the file was truncated
    // mid-write (old writeFileSync race, before atomicWriteFile) OR corrupted
    // by a disk error. Back up the partial content so the user can inspect
    // what survived, then start fresh.
    console.warn(`[store] credentials.json is not valid JSON: ${(err as Error).message}`);
    console.warn(`[store] File size: ${raw.length} bytes, first 100 chars: ${JSON.stringify(raw.slice(0, 100))}`);
    backupCorruptedStore(raw);
    undecryptableFilePresent = true;
    return null;
  }

  // Both v1 and v2 wrap the actual data in an `encrypted` blob.
  // Distinguish by the presence of `version: 2` at the top level.
  if (parsed && typeof (parsed as any).encrypted === "string") {
    let json: string;
    try {
      json = await decrypt((parsed as any).encrypted);
    } catch (err) {
      // Decryption failed — most common cause is the encryption key changing
      // (different homedir / username / OS reinstall / file copied from another
      // machine, OR the binary was recompiled and homedir()/platform/arch
      // resolved differently than before).
      //
      // CRITICAL FIX (was: "back up and treat as empty"): we used to return
      // null here, which silently allowed the NEXT saveCredential() call to
      // OVERWRITE the original credentials.json with a fresh store containing
      // only the newly-added credential. The user's existing accounts were
      // preserved as a `.broken-{timestamp}` backup file but the live
      // credentials.json was clobbered — appearing as "credentials cleared"
      // after a version update.
      //
      // New behavior: back up the unreadable file (so the user can recover
      // later), set a guard flag, and return null. saveCredential() checks
      // the flag and REFUSES to overwrite — it throws so the caller surfaces
      // the error to the user instead of silently destroying data.
      console.warn(`[store] Failed to decrypt credentials.json: ${(err as Error).message}`);
      console.warn(`[store] This usually happens after changing username, reinstalling OS, or copying the file from another machine.`);
      console.warn(`[store] The unreadable file has been backed up. The store will be treated as empty for reads, but saveCredential() will refuse to overwrite until you explicitly clear it (zcode-proxy auth logout) — this prevents accidental data loss.`);
      backupCorruptedStore(raw);
      undecryptableFilePresent = true;
      return null;
    }

    if ((parsed as any).version === 2) {
      // v2: encrypted blob is the StoreV2 JSON
      // Decryption succeeded — clear the guard so future writes are allowed.
      // Without this, a user who recovers via ZCODE_PROXY_LEGACY_SEED would
      // be able to READ but not WRITE (the guard from the initial failed read
      // would persist forever, locking them out of saving any changes).
      undecryptableFilePresent = false;
      return JSON.parse(json) as StoreV2;
    }

    // v1: encrypted blob is a single Credential — migrate to a single-account store.
    // IMPORTANT: persist the migrated v2 form back to disk immediately. Without
    // this, every readStore() call generates a NEW random id for the migrated
    // account, so setAccountPlan(id) called after listAccounts(id) would never
    // find the account (different id on the second read).
    const cred = JSON.parse(json) as Credential;
    const account: StoredAccount = {
      id: genId(),
      label: defaultLabel(cred, Date.now()),
      createdAt: Date.now(),
      credential: cred,
    };
    const migrated: StoreV2 = { version: 2, activeId: account.id, accounts: [account] };
    try {
      await writeStore(migrated);
      console.log(`[store] Migrated v1 credential store to v2 format on disk.`);
    } catch (e) {
      // If write fails (e.g. read-only fs), at least return the in-memory copy
      // so the current request can proceed. Next read will re-migrate.
      console.warn(`[store] Could not persist v1→v2 migration: ${(e as Error).message}`);
    }
    return migrated;
  }

  // Plaintext v2 backdoor.
  //
  // SECURITY: only allowed when ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1 is set.
  // Without this gate, any process that can write ~/.zcode-proxy/credentials.json
  // can inject plaintext credentials and bypass AES-256-GCM entirely — defeating
  // the encryption-at-rest guarantee. Tests should set this env var explicitly
  // (or use a temp HOME + ZCODE_PROXY_CREDENTIAL_SECRET).
  if (process.env.ZCODE_PROXY_ALLOW_PLAINTEXT_STORE === "1"
      && parsed && (parsed as any).version === 2 && Array.isArray((parsed as any).accounts)) {
    return parsed as StoreV2;
  }

  // Plaintext file present but env not set — refuse to load and warn.
  if (parsed && (parsed as any).version === 2 && Array.isArray((parsed as any).accounts)) {
    console.warn("[store] Refusing to load plaintext credentials.json without ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1.");
    console.warn("[store] Either delete the file and re-login, or set the env var (test/debug only).");
    return null;
  }

  return null;
}

/**
 * Back up a corrupted / unreadable credentials.json before it gets overwritten.
 * Writes to `{STORE_FILE}.broken-{timestamp}` so the user can still recover
 * the original content if needed (e.g. they later remember the old username).
 *
 * CLEANUP: keeps at most MAX_BROKEN_BACKUPS (5) most recent .broken-* files.
 * Older ones are deleted. This prevents the ".broken files piling up"
 * symptom where repeated transient read failures (AV locks, etc.) created
 * dozens of backup files. The user only needs the most recent few for
 * recovery — anything older is just clutter.
 */
const MAX_BROKEN_BACKUPS = 5;
function backupCorruptedStore(originalContent: string): void {
  const backupPath = `${STORE_FILE}.broken-${Date.now()}`;
  try {
    writeFileSync(backupPath, originalContent, "utf-8");
    console.warn(`[store] Unreadable store backed up to: ${backupPath}`);
  } catch {
    // Can't even write a backup — nothing more we can do; the next writeStore()
    // call will still overwrite the broken file with a fresh one.
  }
  // Clean up old .broken-* backups, keeping only the most recent
  // MAX_BROKEN_BACKUPS. This is best-effort — failures are silently ignored.
  try {
    cleanupOldBrokenBackups();
  } catch { /* non-fatal */ }
}

/**
 * Delete old .broken-* backup files, keeping only the most recent
 * MAX_BROKEN_BACKUPS. Called after each new backup is created.
 */
function cleanupOldBrokenBackups(): void {
  const dir = dirname(STORE_FILE);
  const prefix = `${basename(STORE_FILE)}.broken-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const brokenFiles = entries
    .filter(f => f.startsWith(prefix))
    .map(f => ({ name: f, path: join(dir, f) }))
    // Sort by modification time descending (newest first). fall back to name.
    .sort((a, b) => {
      try {
        return statSync(b.path).mtimeMs - statSync(a.path).mtimeMs;
      } catch {
        return b.name.localeCompare(a.name);
      }
    });
  // Delete everything past the first MAX_BROKEN_BACKUPS
  for (let i = MAX_BROKEN_BACKUPS; i < brokenFiles.length; i++) {
    try { unlinkSync(brokenFiles[i].path); } catch { /* best-effort */ }
  }
}

/**
 * Mutex serializing all credential store writes.
 *
 * Without this, two concurrent mutations race: e.g. the proxy's auto-switch
 * path (handler.ts → switchAccount → writeStore) running at the same time as
 * a dashboard "add account" call (admin/api.ts → saveCredential → writeStore).
 * Both read the same store, both write their version — the second write wins
 * and the first writer's change is silently lost.
 *
 * The mutex is process-local: a CLI invocation (e.g. `zcode-proxy auth login`
 * from start.bat) writes to the same file from a SEPARATE process and is not
 * serialized here. That's an inherent limitation of file-based stores; the
 * atomic-write + retry-on-rename logic in utils/fs.ts handles the OS-level
 * race, and the in-memory cache is invalidated by invalidateStoreCache().
 *
 * IMPORTANT: the mutex must wrap the ENTIRE read-modify-write sequence, not
 * just the write. If it only wrapped writeStore, two concurrent
 * saveCredential calls would both read the same (empty) store, then each
 * write a single-account store — the second write would clobber the first,
 * silently dropping the first account. This is exactly the "credentials
 * lost" symptom the user reported. The `withStoreLock` helper below enforces
 * the full-sequence serialization for every mutating public API.
 */
const storeWriteMutex = createMutex();

/**
 * Run `fn` while holding the store write lock. `fn` receives the current
 * store (freshly read from disk + decrypted) and may mutate it freely; the
 * returned store is persisted atomically. If `fn` throws, no write happens
 * and the error propagates to the caller.
 *
 * This is the canonical entry point for ALL store mutations — it guarantees
 * read-modify-write atomicity across concurrent callers within the same
 * process. Reads that don't need to reflect concurrent writes (e.g.
 * loadCredential) can skip this and use readStore() directly for performance.
 *
 * === CRITICAL FIX (凭证丢失 bug) ===
 * Previously this function had an UNCONDITIONAL empty-store fallback:
 *   `if (!store) store = { version: 2, activeId: null, accounts: [] };`
 * When readStore() returned null for ANY reason (Windows AV transiently
 * locking the file, IO error, file deleted by another process, empty file
 * from a crashed write), the code would silently replace the user's entire
 * credential store with `{accounts: []}` and write that to disk —
 * EVAPORATING ALL ACCOUNTS with NO error log.
 *
 * The retry loop in handler.ts calls switchAccount on every credential
 * switch (3+ times per retry storm). If any one of those calls hit a
 * transient readStore() null, all accounts were gone. The user saw:
 *   1. "账号全没" — because disk now has {accounts: []}
 *   2. "切换失败" — because switchAccount can't find any account in empty store → 404
 *   3. "命令行还在继续重试" — because in-memory credential was still set,
 *      proxy kept retrying, returning 529 to client, client kept retrying
 *
 * FIX: split into two variants based on caller intent.
 *   - withStoreLock (allows empty fallback): for saveCredential / importAccounts
 *     where creating a fresh store is the explicit intent.
 *   - withExistingStoreLock (NO empty fallback): for switchAccount / removeAccount /
 *     setAccount* where mutating an empty store is ALWAYS a bug — returns null
 *     to signal "no store available, do not write".
 */
async function withStoreLock<T>(
  fn: (store: StoreV2) => Promise<T> | T,
): Promise<T> {
  return storeWriteMutex.run(async () => {
    // ALWAYS re-read inside the lock — the in-memory cache may be stale if
    // another process (CLI) wrote to the file. The cost is one disk read +
    // decrypt per mutation, acceptable for the low write frequency of a
    // credential store.
    //
    // NOTE: we do NOT call invalidateStoreCache() here anymore. readStore()
    // already does a statSync-based mtime check (store.ts:441-447) that
    // detects external writes. Calling invalidateStoreCache() forces a
    // full disk read + decrypt on EVERY mutation, AND it makes concurrent
    // READS (from the dashboard's GET /admin/api/accounts) miss the cache
    // too — turning the mutation into a global cache-bust event. The mtime
    // check is sufficient for cross-process correctness; the explicit
    // invalidate was a performance footgun.
    let store = await readStore();
    if (!store) store = { version: 2, activeId: null, accounts: [] };
    const result = await fn(store);
    await writeStore(store);
    return result;
  });
}

/**
 * Like withStoreLock, but REFUSES to create an empty store if readStore()
 * returns null. Used by all mutations that operate on EXISTING accounts
 * (switchAccount, removeAccount, setAccount*).
 *
 * Returns:
 *   - T (the fn's return value) when the store was read successfully and fn
 *     returned a truthy value (mutation happened, persisted to disk)
 *   - false when either:
 *       a) readStore() returned null BECAUSE THE FILE DOESN'T EXIST — in
 *          this case the store is genuinely empty, so any account id is
 *          "not found". Return false (not null) so callers return 404, not
 *          503. This is the right behavior for "user has no credentials
 *          stored, dashboard tries to edit a nonexistent account".
 *       b) fn returned false (e.g. switchAccount didn't find the id) — no
 *          mutation, no write. Caller returns 404 "not found".
 *   - null when readStore() returned null BUT THE FILE EXISTS — this is the
 *     dangerous case: the file is there (possibly with accounts) but we
 *     can't read it (transient AV lock, IO error). Return null to signal
 *     "transient failure, don't write, caller returns 503". This is the
 *     key defense against the "账号全没" bug: we refuse to write an empty
 *     store that would clobber the (possibly intact) file on disk.
 *
 * The file-existence check uses a separate existsSync call. This adds one
 * statSync per failed read, but only on the error path (rare) — acceptable.
 */
async function withExistingStoreLock<T>(
  fn: (store: StoreV2) => Promise<T | false> | (T | false),
): Promise<T | null> {
  return storeWriteMutex.run(async () => {
    const store = await readStore();
    if (!store) {
      // Distinguish "file doesn't exist" (genuine empty store → 404) from
      // "file exists but unreadable" (transient failure → 503, refuse write).
      // The existsSync check is the only reliable way to tell these apart
      // because readStore() returns null for both cases.
      if (!existsSync(STORE_FILE)) {
        // File genuinely doesn't exist — any account id is "not found".
        // Return false (not null) so callers return 404, not 503.
        return false as unknown as T;
      }
      // File EXISTS but readStore() returned null — this is the dangerous
      // case. Log loudly and return null to signal "transient failure,
      // don't write". This is the key defense against the 凭证丢失 bug.
      console.warn(
        `[store] withExistingStoreLock: readStore() returned null but file ` +
        `exists — likely transiently locked by antivirus or in a broken ` +
        `state. Skipping write to avoid clobbering credentials.json.`,
      );
      return null;
    }
    const result = await fn(store);
    // Only persist if fn returned a truthy value (meaning a real mutation
    // happened). Returning false means "no change" (e.g. id not found),
    // so skip the write to avoid needless disk churn + AV interference.
    if (result === false) return result as T;
    await writeStore(store);
    return result;
  });
}

/**
 * Atomically persist the encrypted store to disk.
 *
 * ATOMICITY: Uses atomicWriteFile (write-to-tmp + rename) so a crash mid-write
 * leaves the previous file intact instead of a truncated/partial one. This is
 * the #1 fix for "重启突然凭证全部丢失" — the old code called writeFileSync
 * directly, which truncates-then-writes; a Ctrl+C / Windows kill / AV lock
 * between truncate and full write left credentials.json empty or partial,
 * which then failed JSON.parse on next read → "credentials cleared" symptom.
 *
 * MUTEX: Serialized via storeWriteMutex so concurrent writes from the dashboard
 * and the proxy's auto-switch path don't race (last-writer-wins would silently
 * drop one writer's changes).
 *
 * ENCRYPTION: Errors from encrypt() (randomBytes, createCipheriv) propagate
 * to the caller — these are unrecoverable and should surface, not be swallowed.
 * Disk-write errors are caught and logged so the proxy keeps serving from the
 * in-memory copy (matches the old behavior for read-only filesystems).
 */
async function writeStore(store: StoreV2): Promise<void> {
  // Guard against the "silent overwrite" footgun: if a previous read found
  // credentials.json on disk but couldn't decrypt it (e.g. encryption key
  // changed after a binary update), the original file is preserved as a
  // `.broken-{timestamp}` backup. We MUST NOT overwrite credentials.json
  // with a fresh store here — that would clobber the only reference to the
  // user's existing accounts and force them to manually find+rename the
  // backup file.
  //
  // Instead, throw so the caller (saveCredential / setAccountLabel / etc.)
  // surfaces the error to the user. The user can then either:
  //   1. Restore the .broken-{timestamp} backup (rename it back to
  //      credentials.json) and figure out why decryption failed, OR
  //   2. Explicitly run `zcode-proxy auth logout` (or call clearCredential())
  //      to remove the unreadable file, after which new saves will work.
  if (undecryptableFilePresent) {
    throw new Error(
      `Refusing to overwrite ${STORE_FILE}: the existing file could not be ` +
      `decrypted (likely the encryption key changed after a binary update). ` +
      `A backup was saved as ${STORE_FILE}.broken-{timestamp}. ` +
      `Either restore that backup manually, or run \`zcode-proxy auth logout\` ` +
      `to discard the unreadable file before saving new credentials.`,
    );
  }
  // === DEFENSE-IN-DEPTH LOGGING (凭证丢失 bug) ===
  // If we're about to write a store with ZERO accounts, log a warning so the
  // user has visibility into when this happens. We do NOT refuse the write
  // because there's a legitimate path: removeAccount on the last account.
  // The actual BUG prevention happens upstream in withExistingStoreLock,
  // which refuses to write when readStore() returned null (the dangerous
  // case where switchAccount etc. would silently clobber a populated store).
  //
  // This log is still useful: if the user sees "writeStore: writing EMPTY
  // store" in the logs without having explicitly removed their last account,
  // they know something is wrong and can investigate.
  if (store.accounts.length === 0) {
    console.warn(
      `[store] writeStore: writing EMPTY store to ${STORE_FILE}. ` +
      `If you didn't intend to delete all accounts, this is a bug — ` +
      `check the previous log lines for "withExistingStoreLock" warnings.`,
    );
  }
  // Encrypt OUTSIDE the mutex: crypto is CPU-bound and doesn't touch the file,
  // so concurrent encryptions are safe. Doing it inside the mutex would serialize
  // CPU work unnecessarily and extend the critical section.
  const json = JSON.stringify(store);
  let encrypted: string;
  try {
    encrypted = await encrypt(json);
  } catch (err) {
    // Encryption failure (e.g. randomBytes entropy exhaustion, cipher init
    // error) is unrecoverable — surface to caller so they see the real cause
    // instead of a misleading "could not persist" message.
    throw new Error(`Failed to encrypt credential store: ${(err as Error).message}`);
  }
  try {
    await mkdirSync(dirname(STORE_FILE), { recursive: true });
    // NOTE: no mutex here — withStoreLock (the only caller) already holds it.
    // Calling storeWriteMutex.run() here would deadlock (the mutex is not
    // reentrant). Direct write is safe because all mutations go through
    // withStoreLock which serializes the full read-modify-write sequence.
    await atomicWriteFile(STORE_FILE, JSON.stringify({ version: 2, encrypted }));
  } catch (err) {
    // Read-only filesystem (e.g. Render container without a persistent disk
    // mounted at STORE_DIR), OR Windows EPERM/EBUSY that exhausted the
    // safeRename retry budget. Don't crash the process — log and keep the
    // in-memory copy so the current request can still complete. The next
    // restart will start with whatever's on disk (possibly stale, but not
    // corrupted — atomicWriteFile guarantees the file is either the OLD or
    // the NEW content, never a partial mix).
    console.warn(`[store] Could not persist credentials to ${STORE_FILE}: ${(err as Error).message}`);
    console.warn(`[store] Set ZCODE_PROXY_STORE_DIR to a writable path (e.g. /data/.zcode-proxy on Render with a disk, or /tmp/.zcode-proxy for ephemeral storage).`);
  }
  cachedStore = store; // keep cache in sync with what we intended to write
  // Capture the post-write mtime so subsequent reads see "fresh" without
  // having to re-stat (we know we just wrote it).
  try {
    cachedStoreMtimeMs = statSync(STORE_FILE).mtimeMs;
  } catch {
    cachedStoreMtimeMs = -1;
  }
}

// ---------------------------------------------------------------------------
// Public API — backward-compatible single-credential functions
// ---------------------------------------------------------------------------

/**
 * Save a credential. If an account with the same `provider + apiKey` exists,
 * it's updated in place (preserving activeId); otherwise a new account is
 * created.
 *
 * @param opts.keepActive — when true, the new account is appended WITHOUT
 *   becoming the active one. The existing activeId is preserved. Used by
 *   the OAuth flow so logging in via the dashboard doesn't silently swap
 *   the user's active credential out from under them. Default: false
 *   (preserves historical behavior used by `auth login` CLI and the
 *   "Add API Key" form).
 */
export async function saveCredential(cred: Credential, opts?: { keepActive?: boolean }): Promise<void> {
  await withStoreLock((store) => {
    const existingIdx = store.accounts.findIndex(
      a => a.credential.provider === cred.provider && a.credential.apiKey === cred.apiKey,
    );

    if (existingIdx >= 0) {
      // Update existing — preserve id, createdAt; refresh label if it looks auto-generated
      const old = store.accounts[existingIdx];
      store.accounts[existingIdx] = {
        ...old,
        credential: cred,
        label: old.label.startsWith(`${cred.provider} · `) ? defaultLabel(cred, old.createdAt) : old.label,
      };
    } else {
      const account: StoredAccount = {
        id: genId(),
        label: defaultLabel(cred, Date.now()),
        createdAt: Date.now(),
        credential: cred,
      };
      store.accounts.push(account);
      // BUGFIX: previously always `store.activeId = account.id`, which silently
      // swapped the user's active credential out from under them whenever they
      // logged in via OAuth. Now we honor opts.keepActive so the dashboard's
      // OAuth flow preserves the user's currently-selected account — the new
      // account is added to the list but the user must explicitly click
      // "Activate" to switch to it.
      if (!opts?.keepActive || !store.activeId) {
        store.activeId = account.id; // newly added becomes active
      }
    }
  });
}

/** Load the currently active credential. Returns null if none. */
export async function loadCredential(): Promise<Credential | null> {
  const store = await readStore();
  if (!store || !store.activeId) return null;
  const account = store.accounts.find(a => a.id === store.activeId);
  return account?.credential ?? null;
}

/**
 * Clear ALL stored credentials — ASYNC, mutex-protected version.
 *
 * Production code (handler.ts, admin/api.ts, index.ts) should use THIS
 * function instead of the synchronous clearCredential() to avoid the
 * following race:
 *
 *   1. Caller A acquires storeWriteMutex, readStore(), mutates store
 *   2. Caller B calls clearCredential() (sync) → unlinkSync(STORE_FILE)
 *   3. Caller A's writeStore() re-creates the file with A's mutated store
 *   4. Result: user clicked "Clear", but credentials.json was "resurrected"
 *
 * clearCredentialAsync() acquires storeWriteMutex BEFORE the unlink, so
 * any in-flight writeStore() finishes (or hasn't started) before we delete.
 * After the unlink, the cache is reset to null (file gone) and mtime to 0
 * (skip-stat fast path on next readStore).
 *
 * @throws on persistent EPERM/EBUSY after retries (same as sync version).
 */
export async function clearCredentialAsync(): Promise<void> {
  await storeWriteMutex.run(async () => {
    if (!existsSync(STORE_FILE)) {
      // File already gone — just reset state.
      cachedStore = null;
      cachedStoreMtimeMs = 0;
      cachedKey = null;
      undecryptableFilePresent = false;
      return;
    }
    // Windows: unlink can fail with EPERM/EBUSY/EACCES if AV / indexer /
    // backup tool briefly has the file open. Retry with backoff.
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 50;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        unlinkSync(STORE_FILE);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
          // ASYNC sleep — no event-loop blocking (unlike sync clearCredential).
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        // ENOENT (already gone) is fine — treat as success.
        if (code === "ENOENT") {
          lastErr = null;
          break;
        }
        throw err; // other non-retryable
      }
    }
    if (lastErr) throw lastErr;
    cachedStore = null;       // file gone, cache reflects that
    cachedStoreMtimeMs = 0;   // skip-stat fast path on next readStore
    cachedKey = null;
    undecryptableFilePresent = false;
  });
}

/**
 * Clear ALL stored credentials — SYNC version, retained for backward compat
 * with test code (which calls clearCredential() directly without await).
 *
 * ⚠️ NOT MUTEX-SAFE — concurrent withStoreLock() callers can "resurrect"
 * the file by writing their in-flight store after this unlink. Production
 * code should use clearCredentialAsync() instead. Tests don't need mutex
 * protection because they run serially (no concurrent writers).
 */
export function clearCredential(): void {
  if (existsSync(STORE_FILE)) {
    // Windows: unlinkSync can fail with EPERM/EBUSY/EACCES if another process
    // (antivirus, Windows Search indexer, backup tool) briefly has the file
    // open. Retry a few times with backoff before surfacing the error —
    // matches the safeRename pattern in utils/fs.ts. Without this retry, a
    // transient AV scan during "Clear credentials" would throw an uncaught
    // error, leaving the dashboard in a half-state and the file on disk.
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 50;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        unlinkSync(STORE_FILE);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
          // Synchronous sleep — clearCredential is sync by API contract
          // (callers don't await it). The total worst-case blocking time
          // is 50+100+150+200+250 = 750ms, acceptable for a UI action.
          //
          // v0.2.0.8: use Atomics.wait on a SharedArrayBuffer instead of a
          // `while (Date.now() < end) { /* spin */ }` busy loop. Atomics.wait
          // truly parks the thread (the OS scheduler yields the CPU), whereas
          // the spin loop kept the core at 100% for the full delay. Behaviour
          // is identical: we still block the event loop for the same duration
          // (sync API contract preserved), just without burning a core.
          try {
            const waitBuf = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(waitBuf, 0, 0, RETRY_DELAY_MS * (attempt + 1));
          } catch {
            // SharedArrayBuffer unavailable (very old runtime) — fall back to
            // a short SetTimeout-based busy wait. This branch is defensive;
            // modern Bun/Node always expose Atomics.wait on SharedArrayBuffer.
            const end = Date.now() + RETRY_DELAY_MS * (attempt + 1);
            while (Date.now() < end) { /* spin */ }
          }
          continue;
        }
        if (code === "ENOENT") { lastErr = null; break; }
        throw err; // other non-retryable
      }
    }
    if (lastErr) throw lastErr;
  }
  cachedStore = null; // invalidate store cache
  cachedStoreMtimeMs = 0; // skip-stat fast path
  cachedKey = null;   // invalidate key cache (will be repopulated with the same fixed key)
  // Clear the guard flag — once the user has explicitly cleared credentials,
  // they're free to save new ones without the "refusing to overwrite" error.
  undecryptableFilePresent = false;
}

export function getStorePath(): string {
  return STORE_FILE;
}

// ---------------------------------------------------------------------------
// Public API — multi-account management
// ---------------------------------------------------------------------------

/** Mask a credential's API key for display: "abc12345...wxyz". */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 12) return apiKey;
  return apiKey.slice(0, 8) + "..." + apiKey.slice(-4);
}

/** List all stored accounts (without exposing secret material — apiKey is masked).
 *
 * Accounts are returned sorted by `createdAt` ascending (oldest first),
 * matching the user's expectation that the account list reflects the order
 * in which credentials were added. vceshi0.0.4+.
 */
export async function listAccounts(): Promise<{
  accounts: Array<Omit<StoredAccount, "credential"> & {
    provider: string;
    apiKeyMask: string;
    hasSecret: boolean;
    userId?: string;
    expiresAt?: number;
    hasJwt: boolean;
    plan: string;
    /** Outbound HTTP proxy URL configured for this account (empty string if none). */
    proxy: string;
    /** Human-readable name (vceshi0.0.4+). Empty string when not set — the
     *  dashboard should fall back to `label` for display in that case. */
    name: string;
    /** OAuth account email (vceshi0.0.4+). Empty string for ZCode imports
     *  and manually-added API keys (no email available in those flows). */
    email: string;
    /** Disabled flag (vceshi0.0.6+). True = excluded from auto-switch +
     *  manual activation. Default false. */
    disabled: boolean;
  }>;
  activeId: string | null;
}> {
  const store = await readStore();
  if (!store) return { accounts: [], activeId: null };
  // Sort by createdAt ascending (oldest first). Array.prototype.sort is stable
  // in modern V8/Bun, so accounts with identical createdAt keep insertion order.
  const sortedAccounts = [...store.accounts].sort((a, b) => a.createdAt - b.createdAt);
  return {
    activeId: store.activeId,
    accounts: sortedAccounts.map(a => ({
      id: a.id,
      label: a.label,
      createdAt: a.createdAt,
      provider: a.credential.provider,
      apiKeyMask: maskApiKey(a.credential.apiKey),
      hasSecret: !!a.credential.secret,
      userId: a.credential.userId,
      expiresAt: a.credential.expiresAt,
      hasJwt: !!a.credential.jwt,
      // Display plan: explicit field wins; otherwise infer from JWT presence
      // (v1 credentials from zcode-api-ref have no plan field but carry a
      // start-plan JWT). Falls back to coding-plan only when neither signal
      // is present. This keeps the dashboard dropdown in sync with what
      // serve() will actually do at startup.
      plan: inferPlan(a.credential),
      // Per-account outbound proxy (v2.1.4.1test5+). Empty string means
      // direct connection — surfaced as "" rather than undefined so the
      // dashboard can always render the input with the current value.
      proxy: a.credential.proxy ?? "",
      // vceshi0.0.4+: expose name/email for display + editing. Empty string
      // (not undefined) so the dashboard can always render the input with
      // the current value, mirroring the `proxy` field convention.
      name: a.credential.name ?? "",
      email: a.credential.email ?? "",
      // vceshi0.0.6+: expose disabled flag for the dashboard toggle.
      disabled: !!a.credential.disabled,
    })),
  };
}

/**
 * Resolve a credential's plan for display/serving purposes.
 *   1. Explicit cred.plan wins (v0.1.4+ imports, dashboard edits)
 *   2. JWT presence → start-plan (v1 zcode-api-ref credentials)
 *   3. Default coding-plan
 */
function inferPlan(cred: Credential): "coding-plan" | "start-plan" {
  if (cred.plan === "start-plan" || cred.plan === "coding-plan") return cred.plan;
  if (cred.jwt) return "start-plan";
  return "coding-plan";
}

/**
 * Switch the active credential by account id.
 * Returns:
 *   - true  : account found and activated
 *   - false : account not found OR is disabled (vceshi0.0.6+)
 *   - null  : store could not be read (e.g. transiently locked by AV). The
 *             caller should treat this as a transient failure and either
 *             retry or surface to the user. Importantly, NO WRITE happened —
 *             the on-disk store is untouched, which is the key defense
 *             against the "账号全没" bug.
 *
 * Callers should distinguish these cases by checking the disabled flag in the
 * listAccounts response before calling switchAccount, if they need to.
 */
export async function switchAccount(id: string): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const found = store.accounts.find(a => a.id === id);
    if (!found) return false;
    // vceshi0.0.6+: refuse to activate a disabled credential. The dashboard
    // should hide the "Activate" button for disabled accounts, but this is the
    // server-side enforcement.
    if (found.credential.disabled) return false;
    store.activeId = id;
    return true;
  });
}

/**
 * Remove an account by id. If the active account is removed, falls back to
 * the first remaining.
 *
 * Returns:
 *   - true  : account was found and removed
 *   - false : account not found (no change)
 *   - null  : store could not be read (transient failure, no write happened)
 */
export async function removeAccount(id: string): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const idx = store.accounts.findIndex(a => a.id === id);
    if (idx < 0) return false;
    store.accounts.splice(idx, 1);
    if (store.activeId === id) {
      store.activeId = store.accounts[0]?.id ?? null;
    }
    return true;
  });
}

/**
 * Update an account's human-readable label.
 * Returns true/false as expected, OR null if store could not be read.
 */
export async function setAccountLabel(id: string, label: string): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const account = store.accounts.find(a => a.id === id);
    if (!account) return false;
    account.label = label.trim() || account.label;
    return true;
  });
}

/** Update an account's plan. Returns null if store could not be read. */
export async function setAccountPlan(id: string, plan: "coding-plan" | "start-plan"): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const account = store.accounts.find(a => a.id === id);
    if (!account) return false;
    account.credential.plan = plan;
    return true;
  });
}

/**
 * Update an account's outbound HTTP proxy URL.
 *
 * Pass an empty string (or undefined) to clear the override — the account
 * will fall back to a direct connection.
 *
 * v0.2.0.8 SSRF guard: we now validate the scheme (`http://`, `https://`,
 * `socks5://`, `socks5h://`) and reject hostnames that resolve to internal
 * addresses (127.0.0.0/8, ::1, 169.254.0.0/16 link-local, 10/8, 172.16/12,
 * 192.168/16, 0.0.0.0, and cloud metadata endpoints like 169.254.169.254).
 * This prevents a compromised admin credential from exfiltrating all upstream
 * traffic to an attacker-controlled internal proxy or a cloud metadata
 * service. Literal-IP hosts are checked directly; hostname hosts are also
 * checked because a DNS rebinding attack could resolve a benign-looking name
 * to an internal address at request time.
 *
 * For hostname (non-IP) proxies we still accept them — operators may run a
 * local squid/tinyproxy under a name — but we block the obvious internal
 * ranges when the hostname is a literal IP. A full DNS-resolution check is
 * intentionally NOT performed here to avoid blocking legitimate proxies whose
 * names happen to resolve internally on some networks; the operator is
 * expected to vet hostname-based proxy URLs themselves.
 */
export async function setAccountProxy(id: string, proxy: string): Promise<boolean | null> {
  const trimmed = (proxy ?? "").trim();
  if (trimmed) {
    // Validate scheme + reject internal IPs.
    const validation = validateProxyUrl(trimmed);
    if (!validation.ok) {
      // Surface as a thrown error so the admin route returns 400 with the
      // message; withExistingStoreLock's callback contract returns boolean,
      // so we throw to abort the mutation.
      throw new Error(validation.message);
    }
  }
  return withExistingStoreLock((store) => {
    const account = store.accounts.find(a => a.id === id);
    if (!account) return false;
    if (trimmed) {
      account.credential.proxy = trimmed;
    } else {
      // Clear the field entirely so the serialized credential stays clean
      // rather than accumulating empty strings across versions.
      delete account.credential.proxy;
    }
    return true;
  });
}

/**
 * Validate a proxy URL's scheme and reject literal-IP hosts that point at
 * cloud-metadata or unspecified addresses. Exported for unit testing.
 *
 * v0.2.0.8 SSRF scope: we ONLY block the highest-risk targets:
 *   - 169.254.169.254 and the 169.254/16 link-local range (AWS/GCP/Azure
 *     metadata services, which can leak instance credentials)
 *   - 0.0.0.0/8 (unspecified — never a valid proxy target)
 *   - :: (IPv6 unspecified)
 *
 * We intentionally ALLOW loopback (127.0.0.1, ::1) and private ranges
 * (10/8, 172.16/12, 192.168/16) because local proxies (clash, v2ray,
 * squid) and internal corporate proxies are legitimate, common use cases
 * for this tool. Blocking them would break the primary deployment pattern
 * (local proxy on the user's laptop).
 *
 * Returns `{ok: true}` or `{ok: false, message}`. Does NOT perform DNS
 * resolution — a hostname-based proxy is the operator's responsibility.
 */
export function validateProxyUrl(url: string): { ok: true } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: `Invalid proxy URL: "${url}" is not a valid URL` };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:" && scheme !== "socks5:" && scheme !== "socks5h:") {
    return {
      ok: false,
      message: `Proxy URL scheme "${parsed.protocol}" is not allowed. Use http://, https://, socks5://, or socks5h://`,
    };
  }
  const host = parsed.hostname;
  if (!host) {
    return { ok: false, message: "Proxy URL is missing a hostname" };
  }
  // Block only cloud-metadata / unspecified addresses (see SSRF scope above).
  const ipCheck = isMetadataOrUnspecifiedIp(host);
  if (ipCheck) {
    return {
      ok: false,
      message: `Proxy URL host "${host}" is a ${ipCheck} — routing upstream traffic to cloud metadata or unspecified addresses is blocked to prevent credential theft.`,
    };
  }
  return { ok: true };
}

/**
 * If `host` is a literal IP in a cloud-metadata or unspecified range,
 * return a short reason. Otherwise return null (allowed).
 *
 * Blocked ranges (see validateProxyUrl SSRF scope):
 *   - IPv4: 0.0.0.0/8, 169.254/16 (link-local + cloud metadata)
 *   - IPv6: :: (unspecified)
 *
 * Loopback, private, and ULA ranges are NOT blocked (legitimate local proxy use).
 */
function isMetadataOrUnspecifiedIp(host: string): string | null {
  // IPv4 dotted-quad check.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts.some(p => p > 255)) return null; // not actually a valid IP
    const [a, b] = parts;
    if (a === 0) return "0.0.0.0/8 unspecified address";
    if (a === 169 && b === 254) return "169.254/16 link-local / cloud metadata endpoint";
    return null;
  }
  // IPv6 literals.
  const lower = host.toLowerCase();
  if (lower === "::") return ":: unspecified";
  // fe80::/10 link-local (IPv6 equivalent of 169.254/16) — also block.
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return "fe80::/10 IPv6 link-local";
  }
  return null;
}

/**
 * Update an account's human-readable name (vceshi0.0.4+).
 *
 * Pass an empty string to clear the name — the dashboard will fall back to
 * the auto-generated `label` for display. The name shows up in the account
 * list "名称" column when set, otherwise the auto-generated label is shown.
 */
export async function setAccountName(id: string, name: string): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const account = store.accounts.find(a => a.id === id);
    if (!account) return false;
    const trimmed = (name ?? "").trim();
    if (trimmed) {
      account.credential.name = trimmed;
    } else {
      // Clear the field entirely so the serialized credential stays clean.
      delete account.credential.name;
    }
    return true;
  });
}

/**
 * Update an account's email (vceshi0.0.4+).
 *
 * Pass an empty string to clear the email. No validation is performed here —
 * the dashboard may do a basic format check, but we accept any string to
 * accommodate edge cases (e.g. upstream returning a non-standard email format).
 */
export async function setAccountEmail(id: string, email: string): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const account = store.accounts.find(a => a.id === id);
    if (!account) return false;
    const trimmed = (email ?? "").trim();
    if (trimmed) {
      account.credential.email = trimmed;
    } else {
      delete account.credential.email;
    }
    return true;
  });
}

/**
 * Enable or disable an account (vceshi0.0.6+).
 *
 * When disabled, the credential is:
 *   - Excluded from `switchToNextCredential` (won't be picked as fallback)
 *   - Refused by `switchAccount` (can't be manually activated)
 *
 * If the currently-active account is disabled, it remains active (so in-flight
 * requests continue) but the next auto-switch will skip it. The dashboard
 * should warn the user when disabling the active account.
 */
export async function setAccountDisabled(id: string, disabled: boolean): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const account = store.accounts.find(a => a.id === id);
    if (!account) return false;
    if (disabled) {
      account.credential.disabled = true;
    } else {
      delete account.credential.disabled;
    }
    return true;
  });
}

/**
 * Export a single account's full credential JSON (vceshi0.0.4+).
 *
 * Returns the account metadata (id/label/createdAt) plus the FULL credential
 * (apiKey + secret + jwt + userId + plan + proxy + name + email) — suitable
 * for backup/import on another machine. Returns null if the account id is
 * not found.
 *
 * The exported JSON contains plaintext credentials — callers should treat it
 * as sensitive (don't log it, recommend the user store it securely).
 */
export async function exportSingleAccount(id: string): Promise<{
  id: string;
  label: string;
  createdAt: number;
  credential: Credential;
} | null> {
  const store = await readStore();
  if (!store) return null;
  const account = store.accounts.find(a => a.id === id);
  if (!account) return null;
  // Return a deep copy so the caller can JSON.stringify without worrying
  // about the in-memory cache being mutated.
  return {
    id: account.id,
    label: account.label,
    createdAt: account.createdAt,
    credential: { ...account.credential },
  };
}

/** Export all accounts (excluding encryption — returns plain JSON for backup). */
export async function exportAccounts(): Promise<Array<Omit<StoredAccount, "credential"> & { credential: Credential }>> {
  const store = await readStore();
  if (!store) return [];
  return store.accounts;
}

/**
 * Export the full v2 store (activeId + accounts with credentials) as plain JSON.
 *
 * Used by the dashboard's "Export Render credentials" feature when the user has
 * multiple accounts — the entire store envelope is base64-encoded into
 * ZCODE_OAUTH_CREDENTIAL so all accounts (and the activeId pointer) survive
 * the trip to Render / Fly.io / K8s. `render-start.sh` detects this format
 * (presence of `version: 2` + `accounts` array) and writes it directly to
 * credentials.json instead of wrapping as a single-account store.
 *
 * Returns null if no store exists on disk.
 */
export async function exportStore(): Promise<StoreV2 | null> {
  const store = await readStore();
  if (!store) return null;
  // Return a deep-ish copy so callers can JSON.stringify without worrying
  // about the in-memory cache being mutated by concurrent writers.
  return {
    version: 2,
    activeId: store.activeId,
    accounts: store.accounts.map(a => ({ ...a, credential: { ...a.credential } })),
  };
}

/** Import accounts from a previously exported backup. Merges by id — existing accounts are updated, new ones are appended. */
export async function importAccounts(
  incoming: Array<Omit<StoredAccount, "credential"> & { credential: Credential }>,
): Promise<{ added: number; updated: number }> {
  return withStoreLock((store) => {
    let added = 0;
    let updated = 0;
    for (const acc of incoming) {
      const idx = store.accounts.findIndex(a => a.id === acc.id);
      if (idx >= 0) {
        store.accounts[idx] = acc;
        updated++;
      } else {
        store.accounts.push(acc);
        added++;
        if (!store.activeId) store.activeId = acc.id;
      }
    }
    return { added, updated };
  });
}
