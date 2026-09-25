import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig, readDatabaseUrl } from '../packages/core/src/config.js';

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

  it('reads secrets from files, as provided by Docker secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-secrets-'));
    try {
      await writeFile(join(directory, 'database-url'), `${valid.DATABASE_URL}\n`);
      await writeFile(join(directory, 'master-key'), `${'b'.repeat(64)}\n`);

      const config = readConfig({
        DATABASE_URL_FILE: join(directory, 'database-url'),
        MASTER_KEY_FILE: join(directory, 'master-key'),
      });

      expect(config.databaseUrl).toBe(valid.DATABASE_URL);
      expect(config.masterKey).toEqual(Buffer.alloc(32, 0xbb));
      expect(readDatabaseUrl({ DATABASE_URL_FILE: join(directory, 'database-url') })).toBe(
        valid.DATABASE_URL,
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('rejects a missing or invalid database URL for scripts', () => {
    expect(() => readDatabaseUrl({})).toThrow('DATABASE_URL');
    expect(() => readDatabaseUrl({ DATABASE_URL: 'mysql://x' })).toThrow('DATABASE_URL');
  });
});
