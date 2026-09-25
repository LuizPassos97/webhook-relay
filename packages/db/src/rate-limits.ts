import type { Pool } from 'pg';

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window ends; used for the Retry-After header. */
  retryAfterSeconds: number;
}

/**
 * Counts one request against a fixed one-minute window shared by every API process.
 *
 * A single atomic upsert both resets an expired window and increments the counter,
 * so concurrent requests on different processes cannot exceed the limit together.
 * There is exactly one row per subject, which keeps the table bounded without cleanup.
 */
export async function consumeRateLimit(
  pool: Pool,
  subject: string,
  limitPerMinute: number,
): Promise<RateLimitDecision> {
  const result = await pool.query<{ count: number; retry_after: number }>(
    `INSERT INTO rate_windows AS current (subject, window_start, count)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (subject) DO UPDATE SET
       count = CASE
         WHEN current.window_start = excluded.window_start THEN current.count + 1
         ELSE 1
       END,
       window_start = excluded.window_start
     RETURNING count,
       ceil(extract(epoch FROM window_start + interval '1 minute' - now()))::int AS retry_after`,
    [subject],
  );

  const row = result.rows[0];
  if (!row) throw new Error('Rate limit upsert returned no row');

  return {
    allowed: row.count <= limitPerMinute,
    retryAfterSeconds: Math.max(1, row.retry_after),
  };
}
