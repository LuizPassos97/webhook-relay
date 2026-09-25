import { createDemoReceiver } from './receiver.js';

const port = Number(process.env.DEMO_RECEIVER_PORT ?? 4000);
// Loopback by default; the Compose demo sets HOST=0.0.0.0 on its private network.
const host = process.env.HOST ?? '127.0.0.1';

const server = createDemoReceiver();
server.listen(port, host, () => {
  process.stdout.write(`Demo receiver listening on http://${host}:${port}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.closeAllConnections();
    server.close();
  });
}
