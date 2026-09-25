import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export function encryptSecret(secret: string, key: Buffer): string {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}
export function decryptSecret(secret: string, key: Buffer): string {
  const raw = Buffer.from(secret, 'base64');
  if (raw.length < 29 || raw.toString('base64') !== secret) throw new Error('Invalid encrypted secret');
  const cipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0,12));
  cipher.setAuthTag(raw.subarray(12,28));
  return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString('utf8');
}
