import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import * as net from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { CdpClient } from '../../browser/cdpClient';

/**
 * Robustness of the CDP protocol client (P2-BUG-11): a malformed frame must
 * never crash the message handler, a transport error must never leave
 * in-flight requests hanging, and a failed handshake must reject connect().
 */

async function startServer(): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('unexpected server address');
  }
  return { server, port: address.port };
}

async function stop(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('P2-BUG-11: a malformed frame is ignored and the protocol continues', async () => {
  const { server, port } = await startServer();
  const connection = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
  const client = new CdpClient();
  await client.connect(`ws://127.0.0.1:${port}`);
  const clientSocket = await connection;

  clientSocket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    clientSocket.send(JSON.stringify({ id: message.id, result: { ok: true } }));
  });

  // The malformed frame arrives before the request's response — without the
  // parse guard this throws inside the EventEmitter handler.
  clientSocket.send('this is not json {{{');
  const result = await client.send('Runtime.evaluate', { expression: '1+1' });
  assert.deepEqual(result, { ok: true });
  assert.equal(client.isConnected, true);

  await client.disconnect();
  await stop(server);
});

test('P2-BUG-11: a transport error rejects in-flight requests instead of hanging', async () => {
  const { server, port } = await startServer();
  const connection = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
  const client = new CdpClient();
  await client.connect(`ws://127.0.0.1:${port}`);
  const clientSocket = await connection;

  let resolved = false;
  const pending = client.send('Page.captureScreenshot', {}).then(
    () => {
      resolved = true;
    },
    (err: unknown) => err
  );

  // Abrupt transport loss (RST): the error must fail the in-flight request
  // immediately — a caller can never hang on a request whose response will
  // never come.
  clientSocket.terminate();
  const err = await pending;
  assert.equal(resolved, false, 'the in-flight request must reject, never resolve');
  assert.ok(err instanceof Error, 'the waiter receives the transport error');

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.isConnected, false, 'the client marks itself disconnected');
  await assert.rejects(
    () => client.send('Runtime.evaluate', {}),
    /not connected/i,
    'further sends fail fast once the transport is gone'
  );
  await stop(server);
});

test('P2-BUG-11: a failed handshake rejects connect()', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;

  const client = new CdpClient();
  await assert.rejects(() => client.connect(`ws://127.0.0.1:${address.port}`));
  assert.equal(client.isConnected, false);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});