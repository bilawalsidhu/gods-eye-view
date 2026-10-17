import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isLocalMcpRequest, localMcpPlugin } from '../../server/mcp/plugin.js';

test('only direct loopback connections to this server are local', () => {
  const local = {
    remoteAddress: '127.0.0.1',
    localPort: 4173,
    host: 'localhost:4173',
  };
  assert.equal(isLocalMcpRequest(local), true);
  assert.equal(
    isLocalMcpRequest({ ...local, remoteAddress: '::1', host: '[::1]:4173' }),
    true,
  );
  assert.equal(
    isLocalMcpRequest({ ...local, origin: 'http://localhost:4173' }),
    true,
  );
  assert.equal(
    isLocalMcpRequest({ ...local, env: { PINOKIO_SHARE_LOCAL: 'false' } }),
    true,
  );
  for (const request of [
    { ...local, remoteAddress: '192.168.1.20' },
    { ...local, host: 'attacker.example:4173' },
    { ...local, host: 'localhost.attacker.example' },
    { ...local, host: '' },
    // Another local port, as the Host or as the page's origin.
    { ...local, host: 'localhost:9000' },
    { ...local, localPort: 80 },
    { ...local, origin: 'http://127.0.0.1:5173' },
    { ...local, origin: 'http://localhost:5173' },
    { ...local, origin: 'https://attacker.example' },
    { ...local, origin: 'null' },
    { ...local, origin: 'file:///tmp/page.html' },
    // Proxied or shared: not from this machine, whatever the socket says.
    { ...local, headers: { 'x-forwarded-for': '203.0.113.9' } },
    { ...local, headers: { forwarded: 'for=203.0.113.9' } },
    { ...local, headers: { 'cf-connecting-ip': '203.0.113.9' } },
    { ...local, env: { PINOKIO_SHARE_LOCAL: 'true' } },
    { ...local, env: { PINOKIO_SHARE_VAR: 'GEV_SHARE_URL' } },
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
  // A Host naming another local port, a page on another port, and a request
  // a proxy forwarded are all refused, and no server is made for them.
  assert.equal((await post({}, { Host: `localhost:${port + 1}` })).status, 403);
  assert.equal(
    (await post({}, { Origin: `http://localhost:${port + 1}` })).status,
    403,
  );
  assert.equal(
    (await post({}, { 'X-Forwarded-For': '203.0.113.9' })).status,
    403,
  );
  assert.deepEqual(created, [`http://localhost:${port}`]);
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

test('a client that stops sending its request body is answered with a timeout', async (t) => {
  let middleware;
  const plugin = localMcpPlugin({
    bodyTimeoutMs: 20,
    createServer: () => ({ handle: async () => null }),
  });
  plugin.configureServer({
    middlewares: { use: (path, handler) => (middleware = handler) },
  });
  const http = createServer((req, res) => middleware(req, res));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => http.close());
  const { port } = http.address();
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '100',
          Host: `localhost:${port}`,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
        request.destroy();
      },
    );
    request.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    // Part of the body, then nothing more.
    request.write('{"jsonrpc"');
  });
  assert.equal(status, 408);
});

test('panel requests cannot reach /mcp through a suffix the server routes to it', async (t) => {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [localMcpPlugin()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  await vite.listen();
  t.after(() => vite.close());
  const { port } = vite.httpServer.address();
  const rpc = (path, message) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(message);
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Host: `localhost:${port}`,
          },
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode, text }),
          );
        },
      );
      request.on('error', reject);
      request.end(body);
    });

  // The hazard is real: the server routes /mcp.json to the MCP endpoint.
  const direct = await rpc('/mcp.json', {
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
  });
  assert.equal(direct.status, 200);
  assert.deepEqual(JSON.parse(direct.text), {
    jsonrpc: '2.0',
    id: 1,
    result: {},
  });

  const page = JSON.parse(
    (
      await rpc('/mcp', {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'ui://gods-eye-view/globe' },
      })
    ).text,
  );
  const [, key] = page.result.contents[0].text.match(/"panelKey":"([^"]+)"/);
  const body = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
  ).toString('base64');
  for (const path of ['/mcp', '/mcp.json', '/MCP.json', '/mcp.anything']) {
    const answer = JSON.parse(
      (
        await rpc('/mcp', {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'panel_request',
            arguments: {
              key,
              path,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            },
          },
        })
      ).text,
    );
    assert.equal(answer.result.isError, true, path);
    assert.match(answer.result.content[0].text, /is not available/, path);
  }
});
