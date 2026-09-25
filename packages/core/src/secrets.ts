import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Encrypted secrets are stored as base64(nonce | auth tag | ciphertext).
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = NONCE_BYTES + TAG_BYTES;

/** Encrypts an endpoint signing secret with the installation master key. */
export function encryptSecret(secret: string, masterKey: Buffer): string {
  // A fresh random nonce per encryption is required for AES-GCM to stay secure.
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/**
 * Decrypts a value produced by `encryptSecret`.
 * Throws if the encoding is malformed, the key is wrong or the data was tampered with.
 */
export function decryptSecret(encrypted: string, masterKey: Buffer): string {
  const raw = Buffer.from(encrypted, 'base64');

  // Buffer.from silently skips invalid base64 characters, so a round-trip check is needed
  // to reject malformed input instead of decrypting a partially decoded value.
  const isCanonicalBase64 = raw.toString('base64') === encrypted;
  if (!isCanonicalBase64 || raw.length <= HEADER_BYTES) {
    throw new Error('Invalid encrypted secret');
  }

  const nonce = raw.subarray(0, NONCE_BYTES);
  const authTag = raw.subarray(NONCE_BYTES, HEADER_BYTES);
  const ciphertext = raw.subarray(HEADER_BYTES);

  const decipher = createDecipheriv(ALGORITHM, masterKey, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
