// Walks through the main delivery scenarios against a running API, worker and demo receiver.
// Usage: OPERATOR_KEY=wr_... npm run demo   (see docs/operations.md for the full setup)
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sign } from '../packages/core/src/signatures.js';

export interface DemoOptions {
  apiUrl: string;
  /** Demo receiver URL as reachable from this script (for its control routes). */
  receiverUrl: string;
  /** Receiver URL as reachable from the worker; defaults to `receiverUrl`. */
  endpointBaseUrl?: string;
  operatorKey: string;
  /** Maximum time to wait for each scenario to settle. */
  timeoutMs?: number;
}

export interface AttemptSummary {
  cycle: number;
  number: number;
  outcome: string;
  statusCode: number | null;
}

export interface DeliveryResult {
  deliveryId: string;
  state: string;
  cycle: number;
  attempts: AttemptSummary[];
}

export interface DemoResult {
  healthy: DeliveryResult;
  flaky: DeliveryResult;
  slow: DeliveryResult;
  exhausted: { beforeReplay: DeliveryResult; afterReplay: DeliveryResult };
  /** Status the receiver returned for a request whose body did not match its signature. */
  tamperedSignatureStatus: number;
  /** Deliveries that succeeded without a manual replay. */
  successfulDeliveries: number;
}

// Four deliveries polled once per second stay well below the default rate limit.
const POLL_INTERVAL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ScenarioSettings {
  failTimes?: number | 'always';
  failureMode?: 'error' | 'timeout';
}

interface Scenario {
  name: string;
  secret: string;
}

export async function runDemo(options: DemoOptions): Promise<DemoResult> {
  const runId = randomUUID().slice(0, 8);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const endpointBaseUrl = options.endpointBaseUrl ?? options.receiverUrl;

  const api = async <T>(method: string, path: string, token: string, body?: object) => {
    for (;;) {
      const response = await fetch(options.apiUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          'idempotency-key': randomUUID(), // only used by POST /v1/events
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      // Well-behaved clients wait for the rate limit window instead of failing.
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after') ?? 1);
        await sleep(seconds * 1000);
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `${method} ${path} failed with ${response.status}: ${await response.text()}`,
        );
      }
      return (await response.json()) as T;
    }
  };

  // 1. A project with separate keys for managing endpoints and publishing events.
  const project = await api<{ id: string }>('POST', '/v1/projects', options.operatorKey, {
    name: `Demo ${runId}`,
  });
  const keyFor = async (permission: 'manage' | 'publish') =>
    (
      await api<{ token: string }>('POST', `/v1/projects/${project.id}/keys`, options.operatorKey, {
        permission,
      })
    ).token;
  const manageKey = await keyFor('manage');
  const publishKey = await keyFor('publish');

  const configureReceiver = async (scenario: Scenario, settings: ScenarioSettings) => {
    const response = await fetch(`${options.receiverUrl}/_control/scenarios/${scenario.name}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: scenario.secret, ...settings }),
    });
    if (response.status !== 204) throw new Error(`Receiver rejected scenario ${scenario.name}`);
  };

  // 2. One endpoint per scenario, each subscribed to its own event type.
  const createScenario = async (label: string, settings: ScenarioSettings): Promise<Scenario> => {
    const name = `${label}-${runId}`;
    const endpoint = await api<{ secret: string }>('POST', '/v1/endpoints', manageKey, {
      url: `${endpointBaseUrl}/hooks/${name}`,
      eventTypes: [`demo.${label}`],
    });
    const scenario = { name, secret: endpoint.secret };
    await configureReceiver(scenario, settings);
    return scenario;
  };

  const publishTo = async (label: string): Promise<string> => {
    const published = await api<{ deliveryIds: string[] }>('POST', '/v1/events', publishKey, {
      type: `demo.${label}`,
      data: { scenario: label, runId },
    });
    const [deliveryId] = published.deliveryIds;
    if (!deliveryId) throw new Error(`No delivery was created for ${label}`);
    return deliveryId;
  };

  // Polls the delivery until it reaches the expected state instead of sleeping blindly.
  const waitForDelivery = async (
    deliveryId: string,
    done: (delivery: DeliveryResult) => boolean,
  ): Promise<DeliveryResult> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const delivery = await api<DeliveryResult & { id: string }>(
        'GET',
        `/v1/deliveries/${deliveryId}`,
        manageKey,
      );
      const result = {
        deliveryId: delivery.id,
        state: delivery.state,
        cycle: delivery.cycle,
        attempts: delivery.attempts.map(({ cycle, number, outcome, statusCode }) => ({
          cycle,
          number,
          outcome,
          statusCode,
        })),
      };
      if (done(result)) return result;
      if (Date.now() > deadline) {
        throw new Error(`Delivery ${deliveryId} did not settle; last state ${result.state}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  };
  const settled = (delivery: DeliveryResult) =>
    delivery.state === 'succeeded' || delivery.state === 'failed';

  const healthy = await createScenario('healthy', {});
  await createScenario('flaky', { failTimes: 2 });
  await createScenario('slow', { failTimes: 1, failureMode: 'timeout' });
  const broken = await createScenario('exhausted', { failTimes: 'always' });

  // 3. Publish all scenarios at once; the worker handles them concurrently.
  const [healthyId, flakyId, slowId, exhaustedId] = await Promise.all(
    ['healthy', 'flaky', 'slow', 'exhausted'].map(publishTo),
  );
  if (!healthyId || !flakyId || !slowId || !exhaustedId) throw new Error('Missing deliveries');

  const [healthyResult, flaky, slow, beforeReplay] = await Promise.all([
    waitForDelivery(healthyId, settled),
    waitForDelivery(flakyId, settled),
    waitForDelivery(slowId, settled),
    waitForDelivery(exhaustedId, settled),
  ]);

  // 4. The broken consumer is fixed, then the exhausted delivery is replayed.
  await configureReceiver(broken, {});
  await api('POST', `/v1/deliveries/${exhaustedId}/replay`, manageKey);
  const afterReplay = await waitForDelivery(
    exhaustedId,
    (delivery) => delivery.cycle === 2 && settled(delivery),
  );

  // 5. A body that does not match its signature is refused by the consumer.
  const tamperedSignatureStatus = await sendTamperedRequest(options.receiverUrl, healthy);

  return {
    healthy: healthyResult,
    flaky,
    slow,
    exhausted: { beforeReplay, afterReplay },
    tamperedSignatureStatus,
    successfulDeliveries: [healthyResult, flaky, slow].filter(
      (delivery) => delivery.state === 'succeeded',
    ).length,
  };
}

async function sendTamperedRequest(receiverUrl: string, scenario: Scenario): Promise<number> {
  const timestamp = Math.floor(Date.now() / 1000);
  const original = Buffer.from('{"id":"tampered","data":{"amount":1}}');
  const altered = Buffer.from('{"id":"tampered","data":{"amount":1000}}');
  const response = await fetch(`${receiverUrl}/hooks/${scenario.name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-id': 'tampered',
      'x-webhook-timestamp': String(timestamp),
      'x-webhook-signature': sign(original, timestamp, scenario.secret),
    },
    body: altered,
  });
  return response.status;
}

function describeDelivery(label: string, delivery: DeliveryResult): string {
  const attempts = delivery.attempts
    .map((attempt) => (attempt.statusCode === null ? attempt.outcome : String(attempt.statusCode)))
    .join(', ');
  return `${label.padEnd(24)} ${delivery.state.padEnd(10)} cycle ${delivery.cycle}  attempts: ${attempts}`;
}

async function main(): Promise<void> {
  const operatorKey = process.env.OPERATOR_KEY;
  if (!operatorKey) {
    throw new Error('Set OPERATOR_KEY to the key printed by `npm run bootstrap`');
  }

  const result = await runDemo({
    apiUrl: process.env.API_URL ?? 'http://localhost:3000',
    receiverUrl: process.env.DEMO_RECEIVER_URL ?? 'http://localhost:4000',
    endpointBaseUrl: process.env.DEMO_ENDPOINT_BASE_URL,
    operatorKey,
  });

  const lines = [
    describeDelivery('healthy consumer', result.healthy),
    describeDelivery('fails twice', result.flaky),
    describeDelivery('times out once', result.slow),
    describeDelivery('always fails', result.exhausted.beforeReplay),
    describeDelivery('after fix and replay', result.exhausted.afterReplay),
    `altered body rejected by consumer with HTTP ${result.tamperedSignatureStatus}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  const problems = findProblems(result);
  if (problems.length > 0) {
    process.stderr.write(`Demo did not behave as expected:\n- ${problems.join('\n- ')}\n`);
    process.exitCode = 1;
  }
}

/** Compares the demo outcome with the documented behavior. */
export function findProblems(result: DemoResult): string[] {
  const problems: string[] = [];
  const statuses = (delivery: DeliveryResult) => delivery.attempts.map((a) => a.statusCode);

  if (result.healthy.state !== 'succeeded') problems.push('healthy consumer did not succeed');
  if (statuses(result.flaky).join() !== '503,503,200') {
    problems.push('flaky consumer did not succeed on the third attempt');
  }
  if (result.slow.attempts.map((a) => a.outcome).join() !== 'timeout,response') {
    problems.push('slow consumer did not succeed after one timeout');
  }
  if (result.exhausted.beforeReplay.state !== 'failed') {
    problems.push('broken consumer did not exhaust its attempts');
  }
  if (result.exhausted.afterReplay.state !== 'succeeded') {
    problems.push('replay did not succeed');
  }
  if (result.tamperedSignatureStatus !== 401) problems.push('altered body was not rejected');
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
