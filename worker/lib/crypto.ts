/**
 * Envelope encryption for tokens and per-user X client secrets.
 *
 * One master secret (MASTER_KEY_B64, 32 bytes) derives a per-record AES-256-GCM key:
 *
 *   HKDF-SHA256(master, salt=<16 random bytes>, info=<domain>) -> AES-256-GCM key
 *
 * Two properties are deliberate and load-bearing:
 *
 *  - `info` is domain-separated per purpose AND per user, so a token blob can never
 *    be decrypted as a client secret and vice versa.
 *  - AAD binds the ciphertext to `userId:purpose`. This is the step that is usually
 *    skipped, and it is what stops an attacker with database write access from moving
 *    user B's ciphertext into user A's row and having it decrypt successfully.
 *
 * Serialised as `v1.<b64u salt>.<b64u iv>.<b64u ciphertext>`. The version prefix plus
 * a decrypt-only MASTER_KEY_B64_PREV allows master-key rotation without downtime.
 *
 * Native crypto.subtle only — no dependencies.
 */

const FORMAT_VERSION = 'v1';
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit nonce, the AES-GCM standard
const INFO_PREFIX = 'x-relay:v1:';

export type CryptoPurpose = 'tokens' | 'client';

export function b64uEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function decodeMasterKey(b64: string): Uint8Array {
  // Accept standard base64 (what `openssl rand -base64 32` emits) and base64url.
  const bytes = b64uDecode(b64.trim());
  if (bytes.length !== 32) {
    throw new Error(
      `MASTER_KEY_B64 must decode to exactly 32 bytes, got ${bytes.length}. Generate with: openssl rand -base64 32`,
    );
  }
  return bytes;
}

async function deriveKey(
  masterB64: string,
  salt: Uint8Array,
  purpose: CryptoPurpose,
  userId: string,
): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey(
    'raw',
    decodeMasterKey(masterB64) as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode(`${INFO_PREFIX}${purpose}:${userId}`) as BufferSource,
    },
    master,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** AAD binds ciphertext to its owner and purpose. */
function aad(userId: string, purpose: CryptoPurpose): Uint8Array {
  return new TextEncoder().encode(`${userId}:${purpose}`);
}

export async function encryptForUser(
  masterB64: string,
  plaintext: string,
  purpose: CryptoPurpose,
  userId: string,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(masterB64, salt, purpose, userId);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(userId, purpose) as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return [FORMAT_VERSION, b64uEncode(salt), b64uEncode(iv), b64uEncode(new Uint8Array(ct))].join('.');
}

async function tryDecrypt(
  masterB64: string,
  salt: Uint8Array,
  iv: Uint8Array,
  ct: Uint8Array,
  purpose: CryptoPurpose,
  userId: string,
): Promise<string> {
  const key = await deriveKey(masterB64, salt, purpose, userId);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(userId, purpose) as BufferSource },
    key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

/**
 * Decrypt, falling back to MASTER_KEY_B64_PREV so a master-key rotation can proceed
 * while old ciphertext is still being re-encrypted lazily.
 */
export async function decryptForUser(
  masterB64: string,
  serialized: string,
  purpose: CryptoPurpose,
  userId: string,
  masterB64Prev?: string,
): Promise<string> {
  const parts = serialized.split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error(`unsupported ciphertext format: ${parts[0] ?? '(empty)'}`);
  }
  const salt = b64uDecode(parts[1]!);
  const iv = b64uDecode(parts[2]!);
  const ct = b64uDecode(parts[3]!);

  try {
    return await tryDecrypt(masterB64, salt, iv, ct, purpose, userId);
  } catch (err) {
    if (!masterB64Prev) throw err;
    return tryDecrypt(masterB64Prev, salt, iv, ct, purpose, userId);
  }
}

/** HMAC-SHA256 hex, used to sign human approval links. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message) as BufferSource);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare, for HMAC verification. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PKCE: verifier is 32 random bytes base64url; challenge is base64url(SHA-256(verifier)). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64uEncode(randomBytes(32));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier) as BufferSource,
  );
  return { verifier, challenge: b64uEncode(new Uint8Array(digest)) };
}
