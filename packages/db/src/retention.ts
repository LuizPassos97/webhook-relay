import type { Pool } from 'pg';

/**
 * Deletes events older than the retention period whose deliveries are all finished.
 * Deliveries, attempts and replay audit rows are removed with them through ON DELETE CASCADE.
 *
 * Work is split into short transactions of at most `batchSize` events so cleanup never holds
 * many locks or blocks the delivery queue for long. Returns the total number of events deleted.
 */
export async function cleanupExpired(
  pool: Pool,
  retentionDays: number,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await deleteBatch(pool, retentionDays, batchSize);
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

async function deleteBatch(pool: Pool, retentionDays: number, batchSize: number): Promise<number> {
  // The deliveries of each candidate are locked before the final check. A concurrent replay
  // either commits first (and the event is kept because it is pending again) or waits and
  // then finds nothing to replay. SKIP LOCKED lets several workers clean up in parallel.
  const result = await pool.query(
    `WITH candidates AS (
       SELECT e.id FROM events AS e
       WHERE e.created_at < now() - make_interval(days => $1)
         AND NOT EXISTS (
           SELECT 1 FROM deliveries AS d
           WHERE d.event_id = e.id AND d.state IN ('pending', 'processing')
         )
       ORDER BY e.created_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     ),
     locked AS (
       SELECT d.event_id, d.state FROM deliveries AS d
       JOIN candidates AS c ON c.id = d.event_id
       FOR UPDATE OF d
     )
     DELETE FROM events AS e
     USING candidates AS c
     WHERE e.id = c.id
       AND NOT EXISTS (
         SELECT 1 FROM locked AS l
         WHERE l.event_id = e.id AND l.state IN ('pending', 'processing')
       )`,
    [retentionDays, batchSize],
  );
  return result.rowCount ?? 0;
}
