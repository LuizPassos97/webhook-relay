import { describe, expect, it } from 'vitest';
import {
  classifyOutcome,
  decideNextStep,
  retryDelay,
  type AttemptOutcome,
} from '../packages/core/src/retry-policy.js';

const response = (status: number): AttemptOutcome => ({ kind: 'response', status, durationMs: 1 });

describe('classifyOutcome', () => {
  it.each([200, 201, 204, 299])('treats %i as success', (status) => {
    expect(classifyOutcome(response(status))).toBe('success');
  });

  it.each([408, 429, 500, 502, 503, 504])('retries %i', (status) => {
    expect(classifyOutcome(response(status))).toBe('retry');
  });

  it.each([301, 302, 307, 400, 401, 403, 404, 410, 422])('fails permanently on %i', (status) => {
    expect(classifyOutcome(response(status))).toBe('failed');
  });

  it('retries network errors and timeouts but not policy rejections', () => {
    expect(classifyOutcome({ kind: 'network', durationMs: 1 })).toBe('retry');
    expect(classifyOutcome({ kind: 'timeout', durationMs: 1 })).toBe('retry');
    expect(classifyOutcome({ kind: 'rejected', durationMs: 1 })).toBe('failed');
  });
});

describe('retryDelay', () => {
  const minute = 60_000;

  it('follows the 1, 5, 30 and 120 minute schedule with ±20% jitter', () => {
    expect(retryDelay(1, () => 0.5)).toBe(1 * minute);
    expect(retryDelay(2, () => 0.5)).toBe(5 * minute);
    expect(retryDelay(3, () => 0.5)).toBe(30 * minute);
    expect(retryDelay(4, () => 0.5)).toBe(120 * minute);

    expect(retryDelay(1, () => 0)).toBe(0.8 * minute);
    expect(retryDelay(1, () => 1)).toBe(1.2 * minute);
  });

  it('keeps using the last interval for later attempts', () => {
    expect(retryDelay(9, () => 0.5)).toBe(120 * minute);
  });
});

describe('decideNextStep', () => {
  const policy = { maxAttempts: 5, retryScale: 1, random: () => 0.5 };

  it('completes on success and fails on permanent errors', () => {
    expect(decideNextStep(response(200), 1, policy)).toEqual({ state: 'succeeded' });
    expect(decideNextStep(response(404), 1, policy)).toEqual({ state: 'failed' });
  });

  it('schedules a retry until the last attempt, then fails', () => {
    expect(decideNextStep(response(503), 1, policy)).toEqual({ state: 'pending', delayMs: 60_000 });
    expect(decideNextStep(response(503), 4, policy)).toMatchObject({ state: 'pending' });
    expect(decideNextStep(response(503), 5, policy)).toEqual({ state: 'failed' });
  });

  it('scales retry delays for demos and tests', () => {
    expect(decideNextStep(response(503), 1, { ...policy, retryScale: 0.001 })).toEqual({
      state: 'pending',
      delayMs: 60,
    });
  });
});
