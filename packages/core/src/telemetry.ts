import {
  ROOT_CONTEXT,
  metrics,
  trace,
  TraceFlags,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type Tracer,
  type UpDownCounter,
} from '@opentelemetry/api';

// Metric attributes are deliberately limited to small, fixed sets of values (route, method,
// status, outcome). Project or event IDs would create an unbounded number of time series,
// and payloads must never leave the process through telemetry.

const INSTRUMENTATION_NAME = 'webhook-relay';

export type Shutdown = () => Promise<void>;

export interface TelemetryConfig {
  serviceName: string;
  /** OTLP/HTTP collector URL. Telemetry is disabled when absent. */
  otlpEndpoint?: string;
}

/**
 * Starts OpenTelemetry export to an OTLP collector when one is configured.
 * Without an endpoint the API stays a no-op, so nothing is sent anywhere by default.
 * Call it before creating metric instruments; the SDK is loaded only when needed.
 */
export async function startTelemetry(config: TelemetryConfig): Promise<Shutdown> {
  if (!config.otlpEndpoint) {
    return () => Promise.resolve();
  }

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/sdk-metrics'),
  ]);

  const base = config.otlpEndpoint.replace(/\/$/, '');
  const sdk = new NodeSDK({
    serviceName: config.serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
        exportIntervalMillis: 10_000,
      }),
    ],
  });
  sdk.start();
  return () => sdk.shutdown();
}

export function tracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_NAME);
}

function defaultMeter(): Meter {
  return metrics.getMeter(INSTRUMENTATION_NAME);
}

export interface ApiMetrics {
  requestDuration: Histogram;
}

export function createApiMetrics(meter: Meter = defaultMeter()): ApiMetrics {
  return {
    requestDuration: meter.createHistogram('webhook.api.request.duration', {
      description: 'Time to handle an API request',
      unit: 'ms',
    }),
  };
}

export interface DeliveryMetrics {
  attempts: Counter;
  attemptDuration: Histogram;
  inFlight: UpDownCounter;
}

export function createDeliveryMetrics(meter: Meter = defaultMeter()): DeliveryMetrics {
  return {
    attempts: meter.createCounter('webhook.delivery.attempts', {
      description: 'Delivery attempts by outcome and resulting delivery state',
    }),
    attemptDuration: meter.createHistogram('webhook.delivery.attempt.duration', {
      description: 'Time from sending a webhook to receiving its outcome',
      unit: 'ms',
    }),
    inFlight: meter.createUpDownCounter('webhook.worker.in_flight', {
      description: 'Deliveries currently being sent by this worker',
    }),
  };
}

/**
 * Reports how long the oldest due delivery has been waiting. A growing value means workers
 * cannot keep up. `readAge` returns null when nothing is due.
 */
export function observeQueueAge(meter: Meter, readAge: () => Promise<number | null>): void {
  const gauge = meter.createObservableGauge('webhook.queue.age', {
    description: 'Age of the oldest delivery that is due but not yet claimed',
    unit: 's',
  });
  gauge.addCallback(async (result) => {
    try {
      result.observe((await readAge()) ?? 0);
    } catch {
      // Skip this observation when the database is unavailable; readiness reports that.
    }
  });
}

const TRACE_PARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Serializes a span as a W3C `traceparent` value so another process can continue its trace. */
export function formatTraceParent(span: Span): string | undefined {
  const context = span.spanContext();
  if (!trace.isSpanContextValid(context)) return undefined;
  const flags = context.traceFlags.toString(16).padStart(2, '0');
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

/** Parses a W3C `traceparent` value; returns the root context when it is missing or invalid. */
export function contextFromTraceParent(value: string | null | undefined): Context {
  const match = TRACE_PARENT_PATTERN.exec(value ?? '');
  if (!match) return ROOT_CONTEXT;

  const [, traceId = '', spanId = '', flags = '00'] = match;
  const spanContext = {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16) & TraceFlags.SAMPLED,
    isRemote: true,
  };
  if (!trace.isSpanContextValid(spanContext)) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, spanContext);
}
