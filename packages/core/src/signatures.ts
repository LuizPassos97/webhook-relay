import { createHmac, timingSafeEqual } from 'node:crypto';
export function sign(body: Buffer, timestamp: number, secret: string): string {
  return createHmac('sha256',secret).update(String(timestamp)).update('.').update(body).digest('hex');
}
export function verify(body: Buffer, timestamp: number, signature: string, secret: string, now: number): boolean {
  if (!Number.isSafeInteger(timestamp) || Math.abs(now-timestamp)>300 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature,'hex'), Buffer.from(sign(body,timestamp,secret),'hex'));
}
