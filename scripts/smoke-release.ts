// Verifies container images end to end before they are published.
//
//   tsx scripts/smoke-release.ts [--build] [--tag ci] [--prefix ghcr.io/owner/webhook-relay]
//
// Two stacks are started from the same images:
//   demo:    compose.yaml (development settings); runs every demo scenario, which proves
//            migrations, bootstrap, signed delivery, retries, replay and signature checks.
//   release: deploy/compose/compose.release.yaml (production settings, file secrets); checks
//            readiness, bootstrap, publishing and that production mode rejects plain HTTP.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const exec = promisify(execFile);

const { values: args } = parseArgs({
  options: {
    build: { type: 'boolean', default: false },
    tag: { type: 'string', default: 'local' },
    prefix: { type: 'string', default: 'ghcr.io/luizpassos97/webhook-relay' },
  },
});
const apiImage = `${args.prefix}-api:${args.tag}`;
const workerImage = `${args.prefix}-worker:${args.tag}`;

// Host ports that do not collide with a development stack running on the defaults.
const DEMO_PORTS = { API_PORT: '13000', DEMO_RECEIVER_PORT: '14000', POSTGRES_PORT: '15432' };
const RELEASE_API_PORT = '13100';

function log(message: string): void {
  process.stdout.write(`[smoke] ${message}\n`);
}

async function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = {}) {
  const { stdout } = await exec(command, commandArgs, {
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Runs `docker compose` for one isolated project and tears it down afterwards. */
async function withStack(
  project: string,
  composeFile: string,
  env: NodeJS.ProcessEnv,
  check: (compose: (...commandArgs: string[]) => Promise<string>) => Promise<void>,
): Promise<void> {
  const compose = (...commandArgs: string[]) =>
    run('docker', ['compose', '-p', project, '-f', composeFile, ...commandArgs], env);

  try {
    log(`${project}: starting`);
    await compose('up', '--detach', '--wait', '--no-build', '--quiet-pull');
    await check(compose);
    log(`${project}: passed`);
  } catch (error) {
    const logs = await compose('logs', '--no-color', '--tail', '80').catch(() => '');
    process.stderr.write(`${logs}\n`);
    throw error;
  } finally {
    await compose('down', '--volumes', '--remove-orphans').catch(() => undefined);
  }
}

async function expectNonRoot(
  compose: (...commandArgs: string[]) => Promise<string>,
  service: string,
): Promise<void> {
  const uid = await compose('exec', '-T', service, 'id', '-u');
  if (uid === '0') throw new Error(`${service} runs as root`);
}

async function bootstrap(compose: (...commandArgs: string[]) => Promise<string>) {
  const output = await compose(
    'run',
    '--rm',
    '--no-deps',
    'api',
    'node',
    'dist/scripts/bootstrap.js',
  );
  const key = output.split('\n').at(-1) ?? '';
  if (!key.startsWith('wr_')) throw new Error('Bootstrap did not print an operator key');
  return key;
}

async function smokeDemo(): Promise<void> {
  const env = { ...DEMO_PORTS, API_IMAGE: apiImage, WORKER_IMAGE: workerImage };
  await withStack('relay-smoke-demo', 'compose.yaml', env, async (compose) => {
    await expectNonRoot(compose, 'api');
    await expectNonRoot(compose, 'worker');

    // Run the demo inside the stack, exactly as docs/operations.md documents it.
    // The script exits non-zero if any scenario behaves differently.
    const output = await compose(
      'run',
      '--rm',
      '--no-deps',
      '--env',
      `OPERATOR_KEY=${await bootstrap(compose)}`,
      '--env',
      'API_URL=http://api:3000',
      '--env',
      'DEMO_RECEIVER_URL=http://demo-receiver:4000',
      'api',
      'node',
      'dist/scripts/demo.js',
    );
    log(`demo output:\n${output}`);
  });
}

async function smokeRelease(): Promise<void> {
  const secrets = await mkdtemp(join(tmpdir(), 'relay-smoke-secrets-'));
  try {
    const password = randomBytes(24).toString('hex');
    const files = {
      postgres_password: password,
      database_url: `postgres://relay:${password}@postgres:5432/relay`,
      master_key: randomBytes(32).toString('hex'),
    };
    for (const [name, value] of Object.entries(files)) {
      const path = join(secrets, name);
      await writeFile(path, value);
      // Readable by the unprivileged container user; the directory itself stays private.
      await chmod(path, 0o444);
    }

    const env = {
      WEBHOOK_RELAY_IMAGE_PREFIX: args.prefix,
      WEBHOOK_RELAY_VERSION: args.tag,
      WEBHOOK_RELAY_SECRETS_DIR: secrets,
      API_PORT: RELEASE_API_PORT,
    };
    await withStack(
      'relay-smoke-release',
      'deploy/compose/compose.release.yaml',
      env,
      async (compose) => {
        await expectNonRoot(compose, 'api');
        await expectNonRoot(compose, 'worker');

        const apiUrl = `http://127.0.0.1:${RELEASE_API_PORT}`;
        const ready = await fetch(`${apiUrl}/health/ready`);
        if (!ready.ok) throw new Error(`API not ready: ${ready.status}`);

        const operatorKey = await bootstrap(compose);
        const post = async (path: string, token: string, body: object, headers = {}) => {
          const response = await fetch(apiUrl + path, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              ...headers,
            },
            body: JSON.stringify(body),
          });
          return {
            status: response.status,
            body: (await response.json()) as Record<string, string>,
          };
        };

        const project = await post('/v1/projects', operatorKey, { name: 'Smoke' });
        const projectId = project.body.id ?? '';
        const manage = await post(`/v1/projects/${projectId}/keys`, operatorKey, {
          permission: 'manage',
        });
        const publish = await post(`/v1/projects/${projectId}/keys`, operatorKey, {
          permission: 'publish',
        });
        const manageKey = manage.body.token ?? '';
        const publishKey = publish.body.token ?? '';

        // Production settings must refuse plain HTTP destinations, even the demo receiver.
        const insecure = await post('/v1/endpoints', manageKey, {
          url: 'http://demo-receiver:4000/hooks/smoke',
          eventTypes: ['smoke.test'],
        });
        if (insecure.status !== 400) throw new Error(`HTTP endpoint accepted: ${insecure.status}`);

        const endpoint = await post('/v1/endpoints', manageKey, {
          url: 'https://example.com/webhook-relay-smoke',
          eventTypes: ['smoke.test'],
        });
        if (endpoint.status !== 201) throw new Error(`Endpoint rejected: ${endpoint.status}`);

        const published = await post(
          '/v1/events',
          publishKey,
          { type: 'smoke.test', data: { ok: true } },
          { 'idempotency-key': 'smoke-1' },
        );
        if (published.status !== 202) throw new Error(`Publish failed: ${published.status}`);
        log('release: ready, bootstrapped, HTTP destination rejected, event accepted');
      },
    );
  } finally {
    await rm(secrets, { recursive: true, force: true });
  }
}

async function buildImages(): Promise<void> {
  for (const [target, image] of [
    ['api', apiImage],
    ['worker', workerImage],
  ] as const) {
    log(`building ${image}`);
    await run('docker', ['build', '--load', '--target', target, '--tag', image, '.']);
  }
}

if (args.build) await buildImages();
await smokeDemo();
await smokeRelease();
log('all checks passed');
