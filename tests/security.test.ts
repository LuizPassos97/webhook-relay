import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashKey, issueKey } from '../packages/core/src/credentials.js';
import { decryptSecret, encryptSecret } from '../packages/core/src/secrets.js';
import { sign, verify } from '../packages/core/src/signatures.js';

describe('API keys', () => {
  it('issues independent, unpredictable tokens with one-way hashes', () => {
    const first = issueKey();
    const second = issueKey();

    expect(first.token).not.toBe(second.token);
    expect(first.token.length).toBeGreaterThan(40);
    expect(first.hash).toBe(hashKey(first.token));
    expect(first.hash).not.toContain(first.token);
  });
});

describe('secret encryption', () => {
  const masterKey = Buffer.alloc(32, 7);

  it('round-trips and uses a fresh nonce for every encryption', () => {
    const encrypted = encryptSecret('secret-value', masterKey);

    expect(encrypted).not.toContain('secret-value');
    expect(encrypted).not.toBe(encryptSecret('secret-value', masterKey));
    expect(decryptSecret(encrypted, masterKey)).toBe('secret-value');
  });

  it('rejects a wrong key, tampered ciphertext and malformed input', () => {
    const encrypted = encryptSecret('secret-value', masterKey);
    const tampered = encrypted.slice(0, -5) + 'aaaaa';

    expect(() => decryptSecret(encrypted, Buffer.alloc(32, 8))).toThrow();
    expect(() => decryptSecret(tampered, masterKey)).toThrow();
    expect(() => decryptSecret('invalid', masterKey)).toThrow();
  });
});

describe('webhook signatures', () => {
  const body = Buffer.from('{"x":1}');
  const timestamp = 1000;
  const signature = sign(body, timestamp, 'secret');

  it('signs "<timestamp>.<body>" with HMAC-SHA256', () => {
    const expected = createHmac('sha256', 'secret').update('1000.{"x":1}').digest('hex');
    expect(signature).toBe(expected);
  });

  it('accepts the exact body within the tolerance window', () => {
    expect(verify(body, timestamp, signature, 'secret', timestamp + 1)).toBe(true);
  });

  it('rejects changed content, stale or future timestamps and malformed signatures', () => {
    expect(verify(Buffer.from('{}'), timestamp, signature, 'secret', timestamp + 1)).toBe(false);
    expect(verify(body, timestamp, signature, 'secret', timestamp + 301)).toBe(false);
    expect(verify(body, timestamp, signature, 'secret', timestamp - 400)).toBe(false);
    expect(verify(body, timestamp, 'zz', 'secret', timestamp)).toBe(false);
  });
});
