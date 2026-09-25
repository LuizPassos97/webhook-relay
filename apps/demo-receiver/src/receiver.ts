import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { verify } from '../../../packages/core/src/signatures.js';

// A sample webhook consumer for the local demo. It shows what receivers must do (verify the
// signature and timestamp, deduplicate by event ID) and can simulate unreliable consumers.
// It is never part of a production installation: the control routes are unauthenticated.

export interface ScenarioConfig {
  /** Endpoint signing secret returned by the API when the endpoint was created. */
  secret: string;
  /** Number of valid requests to fail before accepting, or 'always'. */
  failTimes: number | 'always';
  /** How to fail: answer 503, or never answer so the sender times out. */
  failureMode: 'error' | 'timeout';
}

export interface ScenarioState {
  requests: number;
  rejected: number;
  failed: number;
  duplicates: number;
  /** Event IDs accepted, each listed once. */
  accepted: string[];
}

interface Scenario {
  config: ScenarioConfig;
  state: ScenarioState;
}

const MAX_BODY_BYTES = 128 * 1024;
const SCENARIO_NAME = '[A-Za-z0-9_-]{1,64}';
const HOOK_PATH = new RegExp(`^/hooks/(${SCENARIO_NAME})$`);
const CONTROL_PATH = new RegExp(`^/_control/scenarios/(${SCENARIO_NAME})$`);

export function createDemoReceiver(): Server {
  const scenarios = new Map<string, Scenario>();

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 400, { error: 'invalid_request' });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';
    const hook = HOOK_PATH.exec(url);
    const control = CONTROL_PATH.exec(url);

    if (hook?.[1] && request.method === 'POST') {
      receiveWebhook(hook[1], request.headers, await readBody(request), response);
    } else if (control?.[1] && request.method === 'PUT') {
      configure(control[1], await readBody(request), response);
    } else if (control?.[1] && request.method === 'GET') {
      const scenario = scenarios.get(control[1]);
      if (scenario) send(response, 200, scenario.state);
      else send(response, 404, { error: 'unknown_scenario' });
    } else {
      send(response, 404, { error: 'not_found' });
    }
  }

  function receiveWebhook(
    name: string,
    headers: IncomingMessage['headers'],
    body: Buffer,
    response: ServerResponse,
  ): void {
    const scenario = scenarios.get(name);
    if (!scenario) {
      send(response, 404, { error: 'unknown_scenario' });
      return;
    }
    const { config, state } = scenario;
    state.requests += 1;

    // Authenticate before doing anything else with the request.
    const valid = verify(
      body,
      Number(headers['x-webhook-timestamp']),
      String(headers['x-webhook-signature']),
      config.secret,
      Math.floor(Date.now() / 1000),
    );
    if (!valid) {
      state.rejected += 1;
      send(response, 401, { error: 'invalid_signature' });
      return;
    }

    if (config.failTimes === 'always' || state.failed < config.failTimes) {
      state.failed += 1;
      // In timeout mode the request is left open; the sender gives up after its deadline.
      if (config.failureMode === 'error') send(response, 503, { error: 'simulated_failure' });
      return;
    }

    // Consumers must deduplicate: the same event can arrive more than once.
    const eventId = String(headers['x-webhook-id']);
    if (state.accepted.includes(eventId)) state.duplicates += 1;
    else state.accepted.push(eventId);
    send(response, 200, { status: 'accepted' });
  }

  function configure(name: string, body: Buffer, response: ServerResponse): void {
    const input = JSON.parse(body.toString('utf8')) as Partial<ScenarioConfig>;
    const failTimes = input.failTimes ?? 0;
    const validFailTimes =
      failTimes === 'always' || (Number.isSafeInteger(failTimes) && failTimes >= 0);
    const failureMode = input.failureMode ?? 'error';

    if (
      typeof input.secret !== 'string' ||
      !validFailTimes ||
      !['error', 'timeout'].includes(failureMode)
    ) {
      send(response, 400, { error: 'invalid_scenario' });
      return;
    }

    scenarios.set(name, {
      config: { secret: input.secret, failTimes, failureMode },
      state: { requests: 0, rejected: 0, failed: 0, duplicates: 0, accepted: [] },
    });
    response.writeHead(204);
    response.end();
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
