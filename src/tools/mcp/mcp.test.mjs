import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, defineTool, ToolError } from '../catalog.js';
import {
  createMcpHttpHandler,
  createMcpServer,
  MCP_PROTOCOL_VERSIONS,
  toMcpTools,
} from './index.js';

const tool = (name, run) =>
  defineTool({
    name,
    title: 'Count',
    description: 'Counts things.',
    inputSchema: {
      type: 'object',
      properties: { n: { type: 'integer' } },
      additionalProperties: false,
    },
    run,
  });
const catalog = composeCatalog({
  tools: [
    tool('count', async ({ n = 1 }) => ({
      summary: `${n} things.`,
      data: { n },
    })),
    tool('busy', async () => {
      throw new ToolError('retry_later', 'Upstream is busy', {
        retryAfterSeconds: 10,
      });
    }),
    tool('crash', async () => {
      throw new Error('database password is hunter2');
    }),
  ],
});
const server = createMcpServer({
  catalog,
  name: 'test',
  version: '1.0.0',
  instructions: 'Be brief.',
});
const request = (method, params, id = 1) =>
  server.handle({ jsonrpc: '2.0', id, method, params });

test('initialize negotiates a supported protocol version', async () => {
  const known = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.deepEqual(known.result, {
    protocolVersion: '2025-06-18',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'test', version: '1.0.0' },
    instructions: 'Be brief.',
  });
  const unknown = await request('initialize', {
    protocolVersion: '1999-01-01',
  });
  assert.equal(unknown.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
  assert.deepEqual((await request('ping')).result, {});
});

test('notifications and client responses get no reply', async () => {
  assert.equal(
    await server.handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
    null,
  );
  assert.equal(
    await server.handle({ jsonrpc: '2.0', id: 9, result: {} }),
    null,
  );
});

test('invalid messages and unknown methods are JSON-RPC errors', async () => {
  assert.equal(
    (await server.handle({ id: 1, method: 'ping' })).error.code,
    -32600,
  );
  assert.equal(
    (await server.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).error
      .code,
    -32600,
  );
  assert.equal(
    (await server.handle({ jsonrpc: '2.0', id: 1 })).error.code,
    -32600,
  );
  assert.equal((await request('tools/remove')).error.code, -32601);
  assert.equal((await request('toString')).error.code, -32601);
  assert.equal((await request('tools/list', [])).error.code, -32602);
  assert.equal(
    (await request('tools/call', { name: 'missing' })).error.code,
    -32602,
  );
});

test('tools are listed with titles, schemas and annotations, with surface overrides', async () => {
  const { tools } = (await request('tools/list')).result;
  assert.deepEqual(tools[0], {
    name: 'count',
    title: 'Count',
    description: 'Counts things.',
    inputSchema: {
      type: 'object',
      properties: { n: { type: 'integer' } },
      additionalProperties: false,
    },
    annotations: { title: 'Count', readOnlyHint: true },
  });
  const [custom] = toMcpTools(catalog, {
    descriptions: { count: { description: 'Counts for this surface.' } },
    decorate: (definition, source) => ({
      _meta: { kind: source.kind, seen: definition.name },
    }),
  });
  assert.equal(custom.description, 'Counts for this surface.');
  assert.deepEqual(custom._meta, { kind: 'query', seen: 'count' });
});

test('tool results carry text and structured content; failures stay generic', async () => {
  assert.deepEqual(
    (await request('tools/call', { name: 'count', arguments: { n: 3 } }))
      .result,
    {
      content: [
        { type: 'text', text: '3 things.' },
        { type: 'text', text: '{"n":3}' },
      ],
      structuredContent: { n: 3 },
      isError: false,
    },
  );
  assert.deepEqual((await request('tools/call', { name: 'busy' })).result, {
    content: [{ type: 'text', text: 'Upstream is busy' }],
    structuredContent: { error: 'retry_later', retry_after_seconds: 10 },
    isError: true,
  });
  const invalid = (
    await request('tools/call', { name: 'count', arguments: { n: 'x' } })
  ).result;
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error, 'invalid_arguments');
  const crash = (await request('tools/call', { name: 'crash' })).result;
  assert.equal(crash.isError, true);
  assert.equal(JSON.stringify(crash).includes('hunter2'), false);
});

test('the HTTP transport accepts one JSON message per POST', async () => {
  const handle = createMcpHttpHandler(server);
  const post = (body, headers = {}) =>
    handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  const ok = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/json');
  assert.deepEqual(await ok.json(), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(
    (await post({ jsonrpc: '2.0', method: 'notifications/initialized' }))
      .status,
    202,
  );
  const parse = await post('{');
  assert.equal(parse.status, 400);
  assert.equal((await parse.json()).error.code, -32700);
  assert.equal(
    (await post({}, { 'MCP-Protocol-Version': '1999-01-01' })).status,
    400,
  );
  assert.equal((await post({}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('x'.repeat(1024 * 1024 + 1))).status, 413);
  // A streamed body without Content-Length stops being read past the limit.
  let produced = 0;
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const body = new ReadableStream({
    pull(controller) {
      if (produced >= 8 * 1024 * 1024) return controller.close();
      produced += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const streamed = await handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    }),
  );
  assert.equal(streamed.status, 413);
  assert.ok(produced <= 1024 * 1024 + 4 * chunk.byteLength, `read ${produced}`);
  const get = await handle(new Request('http://localhost/mcp'));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
});

test('resources are listed and read, and tools name their UI resource', async () => {
  const shown = defineTool({
    name: 'show',
    title: 'Show',
    description: 'Shows something in a view.',
    inputSchema: { type: 'object', properties: {} },
    ui: { resourceUri: 'ui://fixture/view' },
    run: async () => ({ summary: 'shown', data: {} }),
  });
  const withUi = createMcpServer({
    catalog: composeCatalog({ tools: [shown] }),
    name: 'fixture',
    version: '1',
    resources: [
      {
        uri: 'ui://fixture/view',
        name: 'view',
        mimeType: 'text/html;profile=mcp-app',
        text: '<!doctype html><p>view</p>',
        _meta: { ui: { csp: { frameDomains: ['https://a.example'] } } },
      },
    ],
  });
  const call = async (method, params) =>
    (await withUi.handle({ jsonrpc: '2.0', id: 1, method, params })).result ??
    (await withUi.handle({ jsonrpc: '2.0', id: 1, method, params })).error;
  assert.deepEqual((await call('initialize', {})).capabilities, {
    tools: { listChanged: false },
    resources: { listChanged: false },
  });
  assert.deepEqual((await call('tools/list')).tools[0]._meta, {
    ui: { resourceUri: 'ui://fixture/view' },
    'ui/resourceUri': 'ui://fixture/view',
  });
  assert.deepEqual((await call('resources/list')).resources, [
    {
      uri: 'ui://fixture/view',
      name: 'view',
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { csp: { frameDomains: ['https://a.example'] } } },
    },
  ]);
  assert.deepEqual(
    (await call('resources/read', { uri: 'ui://fixture/view' })).contents,
    [
      {
        uri: 'ui://fixture/view',
        mimeType: 'text/html;profile=mcp-app',
        text: '<!doctype html><p>view</p>',
        _meta: { ui: { csp: { frameDomains: ['https://a.example'] } } },
      },
    ],
  );
  assert.equal(
    (await call('resources/read', { uri: 'ui://fixture/other' })).code,
    -32002,
  );
  // A server without resources does not advertise them.
  assert.equal(
    (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
      .result.capabilities.resources,
    undefined,
  );
  assert.throws(
    () =>
      defineTool({
        name: 'bad',
        title: 'Bad',
        description: 'Points at a web page.',
        inputSchema: { type: 'object' },
        ui: { resourceUri: 'https://a.example' },
        run: async () => ({ summary: '', data: {} }),
      }),
    /ui:\/\/ URI/,
  );
  assert.throws(
    () =>
      defineTool({
        name: 'bad',
        title: 'Bad',
        description: 'Visible to nobody.',
        inputSchema: { type: 'object' },
        ui: { visibility: ['user'] },
        run: async () => ({ summary: '', data: {} }),
      }),
    /visibility/,
  );
});

test('a tool only an app may call says so, and answers it without JSON text', async () => {
  const loader = defineTool({
    name: 'load',
    title: 'Load',
    description: 'Loads a file for the view.',
    inputSchema: { type: 'object', properties: {} },
    ui: { visibility: ['app'] },
    run: async () => ({ summary: 'loaded', data: { body: 'abc' } }),
  });
  const appServer = createMcpServer({
    catalog: composeCatalog({ tools: [loader] }),
    name: 'fixture',
    version: '1',
  });
  const call = async (method, params) =>
    (await appServer.handle({ jsonrpc: '2.0', id: 1, method, params })).result;
  assert.deepEqual((await call('tools/list')).tools[0]._meta, {
    ui: { visibility: ['app'] },
  });
  const result = await call('tools/call', { name: 'load', arguments: {} });
  assert.deepEqual(result.content, [{ type: 'text', text: 'loaded' }]);
  assert.deepEqual(result.structuredContent, { body: 'abc' });
});
