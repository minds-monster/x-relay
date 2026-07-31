/**
 * These tests exist to prove the two properties the design leans on: that ciphertext is
 * bound to its owner, and that a token blob cannot be decrypted as a client secret.
 * Both are AAD/HKDF-info properties that are easy to write and easy to silently break.
 */
import { describe, expect, it } from 'vitest';
import {
  b64uDecode,
  b64uEncode,
  decryptForUser,
  encryptForUser,
  hmacHex,
  pkcePair,
  randomBytes,
  sha256Hex,
  timingSafeEqual,
} from '../worker/lib/crypto.ts';

const MASTER = b64uEncode(randomBytes(32));
const MASTER_2 = b64uEncode(randomBytes(32));

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    for (const n of [1, 12, 16, 31, 32, 100]) {
      const bytes = randomBytes(n);
      expect([...b64uDecode(b64uEncode(bytes))]).toEqual([...bytes]);
    }
  });

  it('emits no padding or url-unsafe characters', () => {
    const s = b64uEncode(randomBytes(32));
    expect(s).not.toMatch(/[+/=]/);
  });

  it('accepts standard base64 from `openssl rand -base64 32`', () => {
    // openssl emits +/= — decoding must still yield 32 bytes.
    const std = btoa(String.fromCharCode(...randomBytes(32)));
    expect(b64uDecode(std).length).toBe(32);
  });
});

describe('envelope encryption', () => {
  it('round-trips a token blob', async () => {
    const plain = JSON.stringify({ access_token: 'at', refresh_token: 'rt', scope: 's' });
    const ct = await encryptForUser(MASTER, plain, 'tokens', 'adam');
    expect(ct).toMatch(/^v1\./);
    expect(ct).not.toContain('access_token');
    expect(await decryptForUser(MASTER, ct, 'tokens', 'adam')).toBe(plain);
  });

  it('produces different ciphertext for identical plaintext (random salt + iv)', async () => {
    const a = await encryptForUser(MASTER, 'same', 'tokens', 'adam');
    const b = await encryptForUser(MASTER, 'same', 'tokens', 'adam');
    expect(a).not.toBe(b);
  });

  // The property that stops a DB-write attacker from moving user B's row into user A's.
  it('refuses to decrypt another user\'s ciphertext', async () => {
    const ct = await encryptForUser(MASTER, 'beth-secret', 'tokens', 'beth');
    await expect(decryptForUser(MASTER, ct, 'tokens', 'adam')).rejects.toThrow();
  });

  // Domain separation: a token blob must not be readable as a client secret.
  it('refuses to decrypt across purposes', async () => {
    const ct = await encryptForUser(MASTER, 'token-blob', 'tokens', 'adam');
    await expect(decryptForUser(MASTER, ct, 'client', 'adam')).rejects.toThrow();
  });

  it('refuses a wrong master key', async () => {
    const ct = await encryptForUser(MASTER, 'x', 'tokens', 'adam');
    await expect(decryptForUser(MASTER_2, ct, 'tokens', 'adam')).rejects.toThrow();
  });

  it('falls back to the previous master key during rotation', async () => {
    const ct = await encryptForUser(MASTER_2, 'rotated', 'tokens', 'adam');
    // New key first, old key as fallback — what the Worker does after a rotation.
    expect(await decryptForUser(MASTER, ct, 'tokens', 'adam', MASTER_2)).toBe('rotated');
  });

  it('detects tampering with the ciphertext', async () => {
    const ct = await encryptForUser(MASTER, 'authentic', 'tokens', 'adam');
    const parts = ct.split('.');
    const body = b64uDecode(parts[3]!);
    body[0] = body[0]! ^ 0xff;
    parts[3] = b64uEncode(body);
    await expect(decryptForUser(MASTER, parts.join('.'), 'tokens', 'adam')).rejects.toThrow();
  });

  it('rejects a master key that is not 32 bytes', async () => {
    await expect(encryptForUser(b64uEncode(randomBytes(16)), 'x', 'tokens', 'a')).rejects.toThrow(
      /32 bytes/,
    );
  });

  it('rejects an unknown format version', async () => {
    await expect(decryptForUser(MASTER, 'v9.a.b.c', 'tokens', 'adam')).rejects.toThrow(
      /unsupported ciphertext format/,
    );
  });
});

describe('PKCE', () => {
  it('produces an S256 challenge of the right shape', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toHaveLength(43); // 32 bytes base64url
    expect(challenge).toHaveLength(43); // SHA-256 base64url
    expect(challenge).not.toBe(verifier);
    expect(verifier).not.toMatch(/[+/=]/);
  });

  it('is deterministic: the same verifier always hashes to the same challenge', async () => {
    const { verifier, challenge } = await pkcePair();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    expect(b64uEncode(new Uint8Array(digest))).toBe(challenge);
  });
});

describe('hmac + comparison', () => {
  it('is stable and key-dependent', async () => {
    expect(await hmacHex('k1', 'draft:7')).toBe(await hmacHex('k1', 'draft:7'));
    expect(await hmacHex('k1', 'draft:7')).not.toBe(await hmacHex('k2', 'draft:7'));
    expect(await hmacHex('k1', 'draft:7')).not.toBe(await hmacHex('k1', 'draft:8'));
  });

  it('compares equal and unequal strings correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('sha256Hex', () => {
  it('matches a known digest', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
