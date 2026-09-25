import type { Pool } from 'pg';
import type { Config } from '../../../packages/core/src/config.js';
import type { Resolver } from '../../../packages/core/src/destination-policy.js';
import { errorMessage, type Logger } from '../../../packages/core/src/logger.js';
import { decideNextStep } from '../../../packages/core/src/retry-policy.js';
import { decryptSecret } from '../../../packages/core/src/secrets.js';
import {
  claimDeliveries,
  finishAttempt,
  recoverExpiredLeases,
  type ClaimedDelivery,
} from '../../../packages/db/src/deliveries.js';
import { sendWebhook } from './http-transport.js';

export interface WorkerDependencies {
  pool: Pool;
  config: Config;
  logger: Logger;
  random?: () => number;
  resolver?: Resolver;
}

export interface WorkerHandle {
  /** Stops claiming new work and waits for in-flight deliveries to finish. */
  stop(): Promise<void>;
}

/**
 * Sends one claimed delivery and records the result.
 *
 * Never throws. If something unexpected fails (for example the secret cannot be decrypted),
 * the error is logged and the lease is left to expire, so recovery counts the attempt
 * and the delivery is retried or failed like any other interrupted attempt.
 */
export async function processClaim(
  deps: WorkerDependencies,
  claim: ClaimedDelivery,
): Promise<void> {
  const context = {
    deliveryId: claim.id,
    eventId: claim.eventId,
    cycle: claim.cycle,
    attempt: claim.attemptNumber,
  };

  try {
    const outcome = await sendWebhook({
      url: claim.url,
      body: claim.body,
      secret: decryptSecret(claim.encryptedSecret, deps.config.masterKey),
      eventId: claim.eventId,
      deliveryId: claim.id,
      timeoutMs: deps.config.timeoutMs,
      demoOrigin: deps.config.demoOrigin,
      resolver: deps.resolver,
    });

    const next = decideNextStep(outcome, claim.attemptNumber, {
      maxAttempts: deps.config.maxAttempts,
      retryScale: deps.config.retryScale,
      random: deps.random ?? Math.random,
    });
    const recorded = await finishAttempt(deps.pool, claim, outcome, next);

    deps.logger.info('Delivery attempt finished', {
      ...context,
      outcome: outcome.kind,
      status: outcome.status,
      durationMs: outcome.durationMs,
      nextState: next.state,
      // False means the lease expired first; another worker owns the delivery now.
      recorded,
    });
  } catch (error) {
    deps.logger.error('Delivery attempt failed unexpectedly', {
      ...context,
      error: errorMessage(error),
    });
  }
}

/** Runs one recovery-claim-send cycle and waits for it to finish. Returns the number claimed. */
export async function runBatch(deps: WorkerDependencies): Promise<number> {
  await recoverExpiredLeases(deps.pool, deps.config.maxAttempts);
  const claims = await claimDeliveries(deps.pool, deps.config.concurrency, deps.config.leaseMs);
  await Promise.all(claims.map((claim) => processClaim(deps, claim)));
  return claims.length;
}

/**
 * Continuously delivers webhooks with at most `config.concurrency` requests in flight.
 *
 * Instead of waiting for a whole batch, the loop claims work whenever a slot frees up,
 * so one slow destination does not hold back the others. HTTP requests are async I/O,
 * so a single process handles them concurrently without worker threads.
 */
export function startWorker(deps: WorkerDependencies): WorkerHandle {
  const { concurrency, leaseMs, pollIntervalMs } = deps.config;
  const inFlight = new Set<Promise<void>>();
  const shutdown = new AbortController();
  let wakeUp: (() => void) | undefined;

  // Sleeps until the poll interval passes, a slot frees up or shutdown starts.
  const idle = () =>
    new Promise<void>((resolve) => {
      if (shutdown.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, pollIntervalMs);
      function done() {
        clearTimeout(timer);
        wakeUp = undefined;
        resolve();
      }
      wakeUp = done;
    });

  const loop = (async () => {
    while (!shutdown.signal.aborted) {
      let claimed = 0;
      const freeSlots = concurrency - inFlight.size;

      if (freeSlots > 0) {
        try {
          await recoverExpiredLeases(deps.pool, deps.config.maxAttempts);
          const claims = await claimDeliveries(deps.pool, freeSlots, leaseMs);
          claimed = claims.length;

          for (const claim of claims) {
            const task = processClaim(deps, claim).finally(() => {
              inFlight.delete(task);
              wakeUp?.();
            });
            inFlight.add(task);
          }
        } catch (error) {
          // Usually a temporary database problem; try again after the poll interval.
          deps.logger.error('Claiming deliveries failed', { error: errorMessage(error) });
        }
      }

      if (claimed === 0 || inFlight.size >= concurrency) {
        await idle();
      }
    }
  })();

  return {
    async stop() {
      shutdown.abort();
      wakeUp?.();
      await loop;

      // Every attempt ends within the delivery timeout, which is at most half the lease.
      // If draining still takes too long, the leases expire and another worker recovers them.
      const drainDeadlineMs = Math.floor(leaseMs * 0.75);
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, drainDeadlineMs);
      });

      const result = await Promise.race([Promise.all(inFlight), deadline]);
      clearTimeout(timer);
      if (result === 'timeout') {
        deps.logger.error('Shutdown deadline reached with deliveries in flight', {
          inFlight: inFlight.size,
        });
      }
    },
  };
}
