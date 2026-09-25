/** Result of one delivery attempt, as reported by the HTTP transport. */
export interface AttemptOutcome {
  /**
   * - response: the destination answered (any status)
   * - network: DNS, connection or protocol failure
   * - timeout: the whole attempt exceeded its deadline
   * - rejected: the destination violates the network policy
   */
  kind: 'response' | 'network' | 'timeout' | 'rejected';
  status?: number;
  durationMs: number;
  excerpt?: string;
}

export type Classification = 'success' | 'retry' | 'failed';

export type NextStep =
  { state: 'succeeded' } | { state: 'failed' } | { state: 'pending'; delayMs: number };

export interface RetryPolicy {
  maxAttempts: number;
  /** Multiplier for retry delays; below 1 only in demos and tests. */
  retryScale: number;
  random: () => number;
}

const MINUTE_MS = 60_000;

/** Delays after the 1st, 2nd, 3rd and 4th failed attempt. */
const RETRY_DELAYS_MS = [1, 5, 30, 120].map((minutes) => minutes * MINUTE_MS);

/** Spread retries by ±20% so failed deliveries do not all come back at the same moment. */
const JITTER_RATIO = 0.2;

/**
 * Decides whether an outcome is final.
 * Only transient conditions are retried: network errors, timeouts, 408, 429 and 5xx.
 * Other 4xx responses and redirects will not change by retrying, so they fail immediately.
 */
export function classifyOutcome(outcome: AttemptOutcome): Classification {
  if (outcome.kind === 'network' || outcome.kind === 'timeout') return 'retry';
  if (outcome.kind === 'rejected') return 'failed';

  const status = outcome.status ?? 0;
  if (status >= 200 && status < 300) return 'success';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'failed';
}

/** Delay before the next attempt, given how many attempts have failed so far (1-based). */
export function retryDelay(failedAttempts: number, random: () => number): number {
  const index = Math.min(Math.max(failedAttempts, 1), RETRY_DELAYS_MS.length) - 1;
  const base = RETRY_DELAYS_MS[index] ?? MINUTE_MS;
  const jitter = 1 - JITTER_RATIO + 2 * JITTER_RATIO * random();
  return Math.round(base * jitter);
}

/** Combines classification, the attempt limit and backoff into the delivery's next state. */
export function decideNextStep(
  outcome: AttemptOutcome,
  attemptNumber: number,
  policy: RetryPolicy,
): NextStep {
  const classification = classifyOutcome(outcome);
  if (classification === 'success') return { state: 'succeeded' };
  if (classification === 'failed' || attemptNumber >= policy.maxAttempts) {
    return { state: 'failed' };
  }

  const delayMs = Math.round(retryDelay(attemptNumber, policy.random) * policy.retryScale);
  return { state: 'pending', delayMs };
}
