import { describe, expect, it } from 'vitest';
import { readConfig } from '../packages/core/src/config.js';

const valid = {
  DATABASE_URL: 'postgres://relay:local@localhost/relay',
  MASTER_KEY: 'a'.repeat(64),
};

describe('readConfig', () => {
  it('rejects missing connection and encryption credentials', () => {
    expect(() => readConfig({})).toThrow();
    expect(() => readConfig({ DATABASE_URL: valid.DATABASE_URL })).toThrow();
  });

  it('rejects a demo destination in production', () => {
    const env = { ...valid, NODE_ENV: 'production', DEMO_ORIGIN: 'http://demo-receiver:4000' };
    expect(() => readConfig(env)).toThrow();
  });

  it.each(['0', '-1', 'NaN', '100000', '1.5'])('rejects invalid concurrency %s', (value) => {
    expect(() => readConfig({ ...valid, WORKER_CONCURRENCY: value })).toThrow();
  });

  it('loads bounded defaults', () => {
    expect(readConfig(valid)).toMatchObject({
      concurrency: 4,
      timeoutMs: 5000,
      maxAttempts: 5,
      retentionDays: 30,
    });
  });
});
