import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createJsonLogger, errorMessage } from '../packages/core/src/logger.js';

describe('createJsonLogger', () => {
  it('writes one JSON object per line with level, time and fields', () => {
    const stream = new PassThrough();
    const logger = createJsonLogger(stream);

    logger.info('Delivery attempt finished', { deliveryId: 'd1', status: 200 });
    logger.error('Claiming deliveries failed');

    const lines = String(stream.read())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(
      lines.map(({ time, ...rest }) => ({ ...rest, hasTime: typeof time === 'string' })),
    ).toEqual([
      {
        level: 'info',
        msg: 'Delivery attempt finished',
        deliveryId: 'd1',
        status: 200,
        hasTime: true,
      },
      { level: 'error', msg: 'Claiming deliveries failed', hasTime: true },
    ]);
  });
});

describe('errorMessage', () => {
  it('extracts messages from errors and stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });
});
