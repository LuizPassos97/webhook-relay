import { createHmac, timingSafeEqual } from 'node:crypto';

/** Receivers reject requests whose timestamp differs from their clock by more than this. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Computes the hex HMAC-SHA256 of `"<timestamp>.<body>"`.
 * Including the timestamp in the signed content prevents replaying an old request
 * with a fresh timestamp header.
 */
export function sign(body: Buffer, timestamp: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(String(timestamp))
    .update('.')
    .update(body)
    .digest('hex');
}

/**
 * Verifies a webhook signature. All times are Unix seconds.
 * Returns false (never throws) for stale timestamps or malformed signatures.
 */
export function verify(
  body: Buffer,
  timestamp: number,
  signature: string,
  secret: string,
  now: number,
): boolean {
  if (!Number.isSafeInteger(timestamp)) return false;
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  if (!SIGNATURE_PATTERN.test(signature)) return false;

  const expected = Buffer.from(sign(body, timestamp, secret), 'hex');
  // Constant-time comparison so response timing does not leak how many bytes matched.
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}
