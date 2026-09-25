import { randomBytes, createHash } from 'node:crypto';
export function hashKey(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function issueKey(): {token: string; hash: string} {
  const token = `wr_${randomBytes(32).toString('base64url')}`;
  return {token, hash: hashKey(token)};
}
