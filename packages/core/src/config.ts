import { readFileSync } from 'node:fs';

export interface Config {
  databaseUrl: string;
  masterKey: Buffer;
  production: boolean;
  demoOrigin?: string;
  port: number;
  workerPort: number;
  concurrency: number;
  timeoutMs: number;
  leaseMs: number;
  maxAttempts: number;
  retentionDays: number;
  rateLimit: number;
  retryScale: number;
  /** How long an idle worker waits before looking for due deliveries again. */
  pollIntervalMs: number;
}

const MAX_ATTEMPTS = 5;

// The demo receiver is the only plain-HTTP, private-network destination we allow,
// so its origin is restricted to well-known local hostnames.
const DEMO_ORIGIN_PATTERN = /^http:\/\/(demo-receiver|localhost|127\.0\.0\.1):[0-9]+$/;

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const production = env.NODE_ENV === 'production';

  const databaseUrl = readDatabaseUrl(env);

  const masterKey = readSecret(env, 'MASTER_KEY');
  if (!masterKey || !/^[a-f0-9]{64}$/i.test(masterKey)) {
    throw new Error('MASTER_KEY must contain 32 bytes encoded as hexadecimal');
  }

  const demoOrigin = env.DEMO_ORIGIN;
  if (demoOrigin && (production || !DEMO_ORIGIN_PATTERN.test(demoOrigin))) {
    throw new Error('Unsafe demo origin');
  }

  const timeoutMs = readInteger(env, 'DELIVERY_TIMEOUT_MS', 5000, 30000);
  const leaseMs = readInteger(env, 'LEASE_MS', 30000, 300000);
  // A worker must be able to finish (or give up on) a request well before
  // another worker may take over the same delivery.
  if (leaseMs < timeoutMs * 2) {
    throw new Error('LEASE_MS must be at least twice the delivery timeout');
  }

  // RETRY_SCALE shortens retry delays for tests and demos; production always uses real delays.
  const retryScale = Number(env.RETRY_SCALE ?? 1);
  const validRetryScale = Number.isFinite(retryScale) && retryScale > 0 && retryScale <= 1;
  if (!validRetryScale || (production && retryScale !== 1)) {
    throw new Error('Invalid retry scale');
  }

  return {
    databaseUrl,
    masterKey: Buffer.from(masterKey, 'hex'),
    production,
    demoOrigin,
    port: readInteger(env, 'PORT', 3000, 65535),
    workerPort: readInteger(env, 'WORKER_PORT', 3001, 65535),
    concurrency: readInteger(env, 'WORKER_CONCURRENCY', 4, 64),
    timeoutMs,
    leaseMs,
    maxAttempts: MAX_ATTEMPTS,
    retentionDays: readInteger(env, 'RETENTION_DAYS', 30, 365),
    rateLimit: readInteger(env, 'RATE_LIMIT_PER_MINUTE', 120, 10000),
    retryScale,
    pollIntervalMs: readInteger(env, 'WORKER_POLL_MS', 1000, 60000),
  };
}

/**
 * Reads and validates the database URL from `DATABASE_URL_FILE` or `DATABASE_URL`.
 * Used by the services and by maintenance scripts that need no other settings.
 */
export function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = readSecret(env, 'DATABASE_URL');
  if (!databaseUrl || !isPostgresUrl(databaseUrl)) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  return databaseUrl;
}

/**
 * Reads a sensitive value either from `<NAME>_FILE` (Docker secrets) or from `<NAME>`.
 * The file variant takes precedence so secrets do not have to live in the environment.
 */
function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath) {
    return readFileSync(filePath, 'utf8').trim();
  }
  return env[name];
}

function isPostgresUrl(value: string): boolean {
  try {
    return /^postgres(ql)?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Reads a positive integer setting, falling back to a default and enforcing an upper bound. */
function readInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
