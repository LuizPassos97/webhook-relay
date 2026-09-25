import { readFileSync } from 'node:fs';
export interface Config {
  databaseUrl: string; masterKey: Buffer; production: boolean; demoOrigin?: string;
  port: number; workerPort: number; concurrency: number; timeoutMs: number;
  leaseMs: number; maxAttempts: number; retentionDays: number; rateLimit: number;
  retryScale: number;
}
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const secret = (name: string): string | undefined => env[`${name}_FILE`]
    ? readFileSync(env[`${name}_FILE`]!, 'utf8').trim() : env[name];
  const databaseUrl = secret('DATABASE_URL');
  if (!databaseUrl || !/^postgres(ql)?:$/.test(new URL(databaseUrl).protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  const key = secret('MASTER_KEY');
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new Error('MASTER_KEY must contain 32 bytes encoded as hexadecimal');
  const production = env.NODE_ENV === 'production';
  const demoOrigin = env.DEMO_ORIGIN;
  if (demoOrigin && (production || !/^http:\/\/(demo-receiver|localhost|127\.0\.0\.1):[0-9]+$/.test(demoOrigin))) throw new Error('Unsafe demo origin');
  const integer = (name: string, fallback: number, max: number): number => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const timeoutMs = integer('DELIVERY_TIMEOUT_MS', 5000, 30000);
  const leaseMs = integer('LEASE_MS', 30000, 300000);
  if (leaseMs < timeoutMs * 2) throw new Error('LEASE_MS must be at least twice the delivery timeout');
  const retryScale = Number(env.RETRY_SCALE ?? 1);
  if (!Number.isFinite(retryScale) || retryScale <= 0 || retryScale > 1 || (production && retryScale !== 1)) throw new Error('Invalid retry scale');
  return { databaseUrl, masterKey: Buffer.from(key, 'hex'), production, demoOrigin,
    port: integer('PORT', 3000, 65535), workerPort: integer('WORKER_PORT', 3001, 65535),
    concurrency: integer('WORKER_CONCURRENCY', 4, 64), timeoutMs, leaseMs,
    maxAttempts: 5, retentionDays: integer('RETENTION_DAYS', 30, 365),
    rateLimit: integer('RATE_LIMIT_PER_MINUTE', 120, 10000), retryScale };
}
