import { expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { issueKey, hashKey } from '../packages/core/src/credentials.js';
import { encryptSecret, decryptSecret } from '../packages/core/src/secrets.js';
import { sign, verify } from '../packages/core/src/signatures.js';
it('creates independent unpredictable tokens and one-way hashes', () => {
  const a=issueKey(), b=issueKey();
  expect(a.token).not.toBe(b.token); expect(a.token.length).toBeGreaterThan(40);
  expect(a.hash).toBe(hashKey(a.token)); expect(a.hash).not.toContain(a.token);
});
it('encrypts independently and rejects tampered ciphertext', () => {
  const key=Buffer.alloc(32,7), a=encryptSecret('secret-value',key);
  expect(a).not.toContain('secret-value'); expect(a).not.toBe(encryptSecret('secret-value',key));
  expect(decryptSecret(a,key)).toBe('secret-value');
  expect(()=>decryptSecret(a,Buffer.alloc(32,8))).toThrow();
  expect(()=>decryptSecret(a.slice(0,-5)+'aaaaa',key)).toThrow();
  expect(()=>decryptSecret('invalid',key)).toThrow();
});
it('signs exact body bytes and rejects changed content and stale timestamps', () => {
  const body=Buffer.from('{"x":1}'), signature=sign(body,1000,'secret');
  expect(signature).toBe(createHmac('sha256','secret').update('1000.{"x":1}').digest('hex'));
  expect(verify(body,1000,signature,'secret',1001)).toBe(true);
  expect(verify(Buffer.from('{}'),1000,signature,'secret',1001)).toBe(false);
  expect(verify(body,1000,signature,'secret',1301)).toBe(false);
  expect(verify(body,1000,signature,'secret',600)).toBe(false);
  expect(verify(body,1000,'zz','secret',1000)).toBe(false);
});
