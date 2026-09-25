import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'wr_';
const TOKEN_BYTES = 32; // 256 bits of entropy

export interface IssuedKey {
  /** Returned to the caller once and never stored. */
  token: string;
  /** Stored in the database and used for lookups. */
  hash: string;
}

/**
 * Hashes an API token for storage.
 *
 * A plain SHA-256 digest is sufficient because tokens are long random values,
 * not user-chosen passwords, so they cannot be brute-forced.
 */
export function hashKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueKey(): IssuedKey {
  // The prefix makes leaked tokens easy to recognize in logs and secret scanners.
  const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashKey(token) };
}
