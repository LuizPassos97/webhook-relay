import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { sign } from '../../../packages/core/src/signatures.js';
import { resolveDestination, type PinnedDestination, type Resolver } from './destination-policy.js';

/** Maximum number of response body bytes kept for delivery diagnostics. */
export const RESPONSE_EXCERPT_BYTES = 2048;

export interface SendInput {
  url: string;
  /** Exact envelope bytes; they are signed and sent unchanged. */
  body: string;
  secret: string;
  eventId: string;
  deliveryId: string;
  /** Deadline for the whole attempt: DNS, connection, request and response. */
  timeoutMs: number;
  demoOrigin?: string;
  resolver?: Resolver;
}

export interface AttemptOutcome {
  kind: 'response' | 'network' | 'timeout' | 'rejected';
  status?: number;
  durationMs: number;
  excerpt?: string;
}

/**
 * Delivers one signed webhook request.
 *
 * Never throws: every failure is reported as an `AttemptOutcome` so the caller can
 * record it and decide whether to retry. Redirects are not followed, because a redirect
 * could point to a destination that never passed the network policy.
 */
export async function sendWebhook(input: SendInput): Promise<AttemptOutcome> {
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  const controller = new AbortController();

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<AttemptOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timeout', durationMs: elapsed() });
    }, input.timeoutMs);
  });

  const attempt = async (): Promise<AttemptOutcome> => {
    let destination: PinnedDestination;
    try {
      destination = await resolveDestination(input.url, input.resolver, input.demoOrigin);
    } catch {
      return { kind: 'rejected', durationMs: elapsed() };
    }

    if (controller.signal.aborted) {
      return { kind: 'timeout', durationMs: elapsed() };
    }
    return postToDestination(destination, input, controller.signal, elapsed);
  };

  try {
    return await Promise.race([attempt(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function postToDestination(
  destination: PinnedDestination,
  input: SendInput,
  signal: AbortSignal,
  elapsed: () => number,
): Promise<AttemptOutcome> {
  const body = Buffer.from(input.body);
  const timestamp = Math.floor(Date.now() / 1000);

  // Always answer with the address validated by the destination policy. The URL still
  // carries the hostname, so the Host header, SNI and certificate checks use the real name.
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: destination.address, family: destination.family }]);
    } else {
      callback(null, destination.address, destination.family);
    }
  };

  const send = destination.url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    const request = send(
      destination.url,
      {
        method: 'POST',
        signal,
        agent: false, // a fresh connection per attempt, so no socket is reused across destinations
        family: destination.family,
        lookup: pinnedLookup,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'x-webhook-id': input.eventId,
          'x-webhook-delivery-id': input.deliveryId,
          'x-webhook-timestamp': String(timestamp),
          'x-webhook-signature': sign(body, timestamp, input.secret),
        },
      },
      (response) => {
        readExcerpt(response).then(
          (text) => {
            resolve({
              kind: 'response',
              status: response.statusCode,
              durationMs: elapsed(),
              excerpt: sanitizeExcerpt(text, input.secret),
            });
          },
          () => {
            resolve({ kind: 'network', durationMs: elapsed() });
          },
        );
      },
    );

    request.on('error', () => {
      resolve({ kind: signal.aborted ? 'timeout' : 'network', durationMs: elapsed() });
    });
    request.end(body);
  });
}

/**
 * Reads at most RESPONSE_EXCERPT_BYTES of the response body and then closes the connection,
 * so a large or endless response cannot consume memory or keep the worker busy.
 */
function readExcerpt(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let captured = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    response.on('data', (chunk: Buffer) => {
      const remaining = RESPONSE_EXCERPT_BYTES - captured;
      const kept = chunk.subarray(0, Math.max(0, remaining));
      chunks.push(kept);
      captured += kept.length;

      if (captured >= RESPONSE_EXCERPT_BYTES) {
        finish();
        response.destroy();
      }
    });
    response.on('end', finish);
    response.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

/** Removes control characters (except newlines) and any echo of the signing secret. */
function sanitizeExcerpt(text: string, secret: string): string {
  const printable = Array.from(text)
    .filter((char) => char === '\n' || char.charCodeAt(0) >= 32)
    .join('');
  return printable.replaceAll(secret, '[redacted]');
}
