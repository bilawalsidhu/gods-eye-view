import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { isLocalMcpRequest, localMcpPlugin } from '../../server/mcp/plugin.js';

test('only loopback connections with loopback hosts and origins are local', () => {
  const local = { remoteAddress: '127.0.0.1', host: 'localhost:4173' };
  assert.equal(isLocalMcpRequest(local), true);
  assert.equal(
    isLocalMcpRequest({ ...local, remoteAddress: '::1', host: '[::1]:4173' }),
    true,
  );
  assert.equal(
    isLocalMcpRequest({ ...local, origin: 'http://127.0.0.1:5173' }),
    true,
  );
  for (const request of [
    { ...local, remoteAddress: '192.168.1.20' },
    { ...local, host: 'attacker.example:4173' },
    { ...local, host: 'localhost.attacker.example' },
    { ...local, host: '' },
    { ...local, origin: 'https://attacker.example' },
    { ...local, origin: 'null' },
    { ...local, origin: 'file:///tmp/page.html' },
  ])
    assert.equal(isLocalMcpRequest(request), false, JSON.stringify(request));
});

test('the /mcp route answers local MCP requests and refuses others', async (t) => {
  let middleware;
  const created = [];
  const plugin = localMcpPlugin({
    createServer: ({ apiBase }) => {
      created.push(apiBase);
      return {
        handle: async (message) =>
          message.id === undefined
            ? null
            : { jsonrpc: '2.0', id: message.id, result: { apiBase } },
      };
    },
  });
  plugin.configureServer({
    middlewares: { use: (path, handler) => (middleware = handler) },
  });
  const http = createServer((req, res) => middleware(req, res));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => http.close());
  const { port } = http.address();
  const send = (method, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method,
          headers: {
            'Content-Type': 'application/json',
            Host: `localhost:${port}`,
            ...headers,
          },
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              json: () => JSON.parse(text),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
      );
    });
  const post = (body, headers) => send('POST', body, headers);

  const ok = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    jsonrpc: '2.0',
    id: 1,
    result: { apiBase: `http://localhost:${port}` },
  });
  assert.equal(
    (await post({ jsonrpc: '2.0', method: 'notifications/initialized' }))
      .status,
    202,
  );
  await post({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(created, [`http://localhost:${port}`]);

  const foreign = await post(
    { jsonrpc: '2.0', id: 3, method: 'ping' },
    { Origin: 'https://attacker.example' },
  );
  assert.equal(foreign.status, 403);
  assert.deepEqual(await foreign.json(), {
    error: 'The MCP server only accepts local requests',
  });
  assert.equal((await post({}, { Host: 'attacker.example' })).status, 403);
  assert.equal(
    (await post({}, { Host: `localhost.attacker.example:${port}` })).status,
    403,
  );
  assert.equal((await post('x'.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        headers: { Host: `localhost:${port}` },
      })
    ).status,
    405,
  );
});

test('a client that disconnects cancels its tool call', async (t) => {
  let middleware;
  let seen;
  const started = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const plugin = localMcpPlugin({
    createServer: () => ({
      handle: (message, { signal }) => {
        seen = signal;
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        started.resolve();
        return new Promise(() => {});
      },
    }),
  });
  plugin.configureServer({
    middlewares: { use: (path, handler) => (middleware = handler) },
  });
  const http = createServer((req, res) => middleware(req, res));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => http.close());
  const { port } = http.address();
  const request = httpRequest({
    host: '127.0.0.1',
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: `localhost:${port}`,
    },
  });
  request.on('error', () => {});
  request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }));
  await started.promise;
  assert.equal(seen.aborted, false);
  request.destroy();
  await aborted.promise;
  assert.equal(seen.aborted, true);
});
