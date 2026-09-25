// JSON schemas for request validation, response serialization and the OpenAPI document.
// Every object sets additionalProperties: false, so unknown request fields are rejected and
// response serialization drops anything not listed here (for example stored secrets).

const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const eventType = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
} as const;

export const errorResponse = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const;

const errorResponses = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  413: errorResponse,
  429: errorResponse,
} as const;

export const idParams = {
  type: 'object',
  properties: { id: uuid },
  required: ['id'],
  additionalProperties: false,
} as const;

// Projects and keys (operator only)

export const createProjectSchema = {
  tags: ['projects'],
  body: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
    required: ['name'],
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: { id: uuid, name: { type: 'string' }, createdAt: dateTime },
      required: ['id', 'name', 'createdAt'],
      additionalProperties: false,
    },
    ...errorResponses,
  },
} as const;

export const createKeySchema = {
  tags: ['projects'],
  params: idParams,
  body: {
    type: 'object',
    properties: { permission: { type: 'string', enum: ['publish', 'manage'] } },
    required: ['permission'],
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      description: 'The token is returned only once.',
      properties: {
        id: uuid,
        projectId: uuid,
        permission: { type: 'string' },
        token: { type: 'string' },
      },
      required: ['id', 'projectId', 'permission', 'token'],
      additionalProperties: false,
    },
    ...errorResponses,
  },
} as const;

// Endpoints

const endpointSummary = {
  type: 'object',
  properties: {
    id: uuid,
    url: { type: 'string' },
    eventTypes: { type: 'array', items: { type: 'string' } },
    createdAt: dateTime,
  },
  required: ['id', 'url', 'eventTypes', 'createdAt'],
  additionalProperties: false,
} as const;

export const createEndpointSchema = {
  tags: ['endpoints'],
  body: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 2048 },
      eventTypes: { type: 'array', items: eventType, minItems: 1, maxItems: 50, uniqueItems: true },
    },
    required: ['url', 'eventTypes'],
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      description: 'The signing secret is returned only once.',
      properties: {
        id: uuid,
        url: { type: 'string' },
        eventTypes: { type: 'array', items: { type: 'string' } },
        secret: { type: 'string' },
      },
      required: ['id', 'url', 'eventTypes', 'secret'],
      additionalProperties: false,
    },
    ...errorResponses,
  },
} as const;

export const listEndpointsSchema = {
  tags: ['endpoints'],
  querystring: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      cursor: uuid,
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        items: { type: 'array', items: endpointSummary },
        nextCursor: { type: ['string', 'null'] },
      },
      required: ['items', 'nextCursor'],
      additionalProperties: false,
    },
    ...errorResponses,
  },
} as const;

// Events

const deliverySummary = {
  type: 'object',
  properties: {
    id: uuid,
    endpointId: uuid,
    state: { type: 'string', enum: ['pending', 'processing', 'succeeded', 'failed'] },
    cycle: { type: 'integer' },
    attemptCount: { type: 'integer' },
    nextAttemptAt: dateTime,
    completedAt: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['id', 'endpointId', 'state', 'cycle', 'attemptCount', 'nextAttemptAt', 'completedAt'],
  additionalProperties: false,
} as const;

export const publishEventSchema = {
  tags: ['events'],
  headers: {
    type: 'object',
    properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 } },
    required: ['idempotency-key'],
  },
  body: {
    type: 'object',
    properties: {
      type: eventType,
      data: { type: 'object', description: 'Any JSON object up to 64 KiB.' },
    },
    required: ['type', 'data'],
    additionalProperties: false,
  },
  response: {
    202: {
      type: 'object',
      properties: { eventId: uuid, deliveryIds: { type: 'array', items: uuid } },
      required: ['eventId', 'deliveryIds'],
      additionalProperties: false,
    },
    ...errorResponses,
  },
} as const;

export const getEventSchema = {
  tags: ['events'],
  params: idParams,
  response: {
    200: {
      type: 'object',
      properties: {
        id: uuid,
        type: { type: 'string' },
        createdAt: dateTime,
        data: { type: 'object', additionalProperties: true },
        deliveries: { type: 'array', items: deliverySummary },
      },
      required: ['id', 'type', 'createdAt', 'data', 'deliveries'],
      additionalProperties: false,
    },
    ...errorResponses,
  },
} as const;

// Deliveries

const attempt = {
  type: 'object',
  properties: {
    id: uuid,
    cycle: { type: 'integer' },
    number: { type: 'integer' },
    startedAt: dateTime,
    finishedAt: { type: ['string', 'null'], format: 'date-time' },
    outcome: { type: 'string' },
    statusCode: { type: ['integer', 'null'] },
    durationMs: { type: ['integer', 'null'] },
    responseExcerpt: { type: ['string', 'null'] },
  },
  required: ['id', 'cycle', 'number', 'startedAt', 'outcome'],
  additionalProperties: false,
} as const;

export const getDeliverySchema = {
  tags: ['deliveries'],
  params: idParams,
  response: {
    200: {
      type: 'object',
      properties: {
        ...deliverySummary.properties,
        eventId: uuid,
        attempts: { type: 'array', items: attempt },
      },
      required: [...deliverySummary.required, 'eventId', 'attempts'],
      additionalProperties: false,
    },
    ...errorResponses,
  },
} as const;

export const replayDeliverySchema = {
  tags: ['deliveries'],
  params: idParams,
  response: {
    202: {
      type: 'object',
      properties: { deliveryId: uuid, cycle: { type: 'integer' } },
      required: ['deliveryId', 'cycle'],
      additionalProperties: false,
    },
    ...errorResponses,
  },
} as const;
