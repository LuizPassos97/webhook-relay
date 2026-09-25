import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sign } from '../packages/core/src/signatures.js';

// The consumer example in the README is copied into real applications, so it is tested
// exactly as written against the signatures the worker produces.

type IsAuthentic = (
  rawBody: Buffer,
  headers: Record<string, string>,
  secret: string,
  now?: number,
) => boolean;

let directory: string;
let isAuthentic: IsAuthentic;

beforeAll(async () => {
  const readme = await readFile('README.md', 'utf8');
  const example = /```js\n([\s\S]*?export function isAuthentic[\s\S]*?)```/.exec(readme)?.[1];
  if (!example) throw new Error('README signature example not found');

  directory = await mkdtemp(join(tmpdir(), 'readme-example-'));
  const file = join(directory, 'verify.mjs');
  await writeFile(file, example);
  ({ isAuthentic } = (await import(pathToFileURL(file).href)) as { isAuthentic: IsAuthentic });
});

afterAll(async () => {
  await rm(directory, { recursive: true });
});

const secret = 'whsec_example';
const body = Buffer.from('{"id":"evt_1","type":"order.created","data":{}}');
const now = 1_800_000_000;

function headersFor(signedBody: Buffer, timestamp = now) {
  return {
    'x-webhook-timestamp': String(timestamp),
    'x-webhook-signature': sign(signedBody, timestamp, secret),
  };
}

it('accepts a request signed by the worker', () => {
  expect(isAuthentic(body, headersFor(body), secret, now)).toBe(true);
});

it('rejects altered bodies, wrong secrets, stale timestamps and malformed signatures', () => {
  expect(isAuthentic(Buffer.from('{}'), headersFor(body), secret, now)).toBe(false);
  expect(isAuthentic(body, headersFor(body), 'whsec_other', now)).toBe(false);
  expect(isAuthentic(body, headersFor(body, now - 301), secret, now)).toBe(false);
  expect(
    isAuthentic(
      body,
      { 'x-webhook-timestamp': String(now), 'x-webhook-signature': 'zz' },
      secret,
      now,
    ),
  ).toBe(false);
});
