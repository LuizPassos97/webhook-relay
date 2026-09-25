import { describe, expect, it } from 'vitest';
import {
  MAX_EVENT_DATA_BYTES,
  buildEnvelope,
  canonicalJson,
  contentHash,
  validateEventInput,
  validateIdempotencyKey,
} from '../packages/core/src/events.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    const left = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } });
    const right = canonicalJson({ a: { c: null, d: [3, { y: 2, z: 1 }] }, b: 1 });

    expect(left).toBe(right);
    expect(left).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});

describe('contentHash', () => {
  it('ignores key order but distinguishes event types and data', () => {
    const hash = contentHash({ type: 'order.created', data: { id: 1, total: 10 } });

    expect(contentHash({ type: 'order.created', data: { total: 10, id: 1 } })).toBe(hash);
    expect(contentHash({ type: 'order.updated', data: { id: 1, total: 10 } })).not.toBe(hash);
    expect(contentHash({ type: 'order.created', data: { id: 2, total: 10 } })).not.toBe(hash);
  });
});

describe('buildEnvelope', () => {
  it('produces a stable envelope with a fixed field order', () => {
    const envelope = buildEnvelope({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'order.created',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      data: { id: 1 },
    });

    expect(envelope).toBe(
      '{"id":"00000000-0000-4000-8000-000000000001","type":"order.created",' +
        '"createdAt":"2026-01-01T00:00:00.000Z","data":{"id":1}}',
    );
  });
});

describe('validateEventInput', () => {
  it('accepts a typed JSON object', () => {
    expect(() => {
      validateEventInput({ type: 'order.created', data: { id: 1 } });
    }).not.toThrow();
  });

  it.each(['', ' order', 'order created', 'a'.repeat(129)])('rejects event type %j', (type) => {
    expect(() => {
      validateEventInput({ type, data: {} });
    }).toThrow(expect.objectContaining({ status: 400 }));
  });

  it.each([null, [], 'text', 42])('rejects non-object data %j', (data) => {
    expect(() => {
      validateEventInput({ type: 'order.created', data });
    }).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('rejects data larger than 64 KiB', () => {
    const data = { blob: 'x'.repeat(MAX_EVENT_DATA_BYTES) };
    expect(() => {
      validateEventInput({ type: 'order.created', data });
    }).toThrow(expect.objectContaining({ status: 413 }));
  });
});

describe('validateIdempotencyKey', () => {
  it.each(['', 'a'.repeat(256), 'has\nnewline'])('rejects %j', (key) => {
    expect(() => {
      validateIdempotencyKey(key);
    }).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('accepts printable keys up to 255 characters', () => {
    expect(() => {
      validateIdempotencyKey('order-123:attempt/1');
    }).not.toThrow();
  });
});
