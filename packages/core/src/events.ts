import { createHash } from 'node:crypto';
import { badRequest, payloadTooLarge } from './errors.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface EventInput {
  type: string;
  data: JsonObject;
}

export interface EventEnvelope extends EventInput {
  id: string;
  createdAt: Date;
}

export const MAX_EVENT_DATA_BYTES = 64 * 1024;

// Dot/colon/underscore/hyphen separated names such as "order.created" or "invoice:paid".
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Printable ASCII only, so keys are safe to log and compare byte for byte.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/**
 * Validates a publish request body. `data` is typed as unknown because it
 * comes straight from a client; after this call it is known to be a JSON object.
 */
export function validateEventInput(input: {
  type: string;
  data: unknown;
}): asserts input is EventInput {
  if (!EVENT_TYPE_PATTERN.test(input.type)) {
    throw badRequest('Event type must be 1-128 letters, digits or ". _ : -"');
  }
  if (typeof input.data !== 'object' || input.data === null || Array.isArray(input.data)) {
    throw badRequest('Event data must be a JSON object');
  }
  if (Buffer.byteLength(JSON.stringify(input.data)) > MAX_EVENT_DATA_BYTES) {
    throw payloadTooLarge('Event data must not exceed 64 KiB');
  }
}

export function validateIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw badRequest('Idempotency-Key must be 1-255 printable ASCII characters');
  }
}

/**
 * Serializes JSON with object keys sorted at every level, so logically equal
 * documents produce identical text regardless of the client's key order.
 */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Digest used to decide whether a repeated idempotent request carries the same content. */
export function contentHash(input: EventInput): string {
  const canonical = canonicalJson({ type: input.type, data: input.data });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Builds the JSON body sent to every destination. It is stored as-is, so each
 * retry and replay signs and sends exactly the same bytes.
 */
export function buildEnvelope(event: EventEnvelope): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    createdAt: event.createdAt.toISOString(),
    data: event.data,
  });
}
