import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { createLocalMcpServer } from '../../server/mcp/server.js';
import { createApiFetch } from '../../server/mcp/services.js';
import { parseArgs, serveStdio } from '../../server/mcp/stdio.js';
import { coreTools, toolsForSurface } from './index.js';

const usgs = {
  type: 'FeatureCollection',
  features: [
    {
      id: 'us1',
      geometry: { type: 'Point', coordinates: [121.5, 24, 10] },
      properties: { mag: 5.1, place: 'near Hualien', time: 1767229200000 },
    },
  ],
};

test('relative API requests resolve against the configured base', async () => {
  const seen = [];
  const apiFetch = createApiFetch({
    apiBase: 'http://127.0.0.1:5000',
    fetchImpl: async (url) => seen.push(String(url)),
  });
  await apiFetch('/api/launches');
  await apiFetch('https://earthquake.usgs.gov/feed.geojson');
  assert.deepEqual(seen, [
    'http://127.0.0.1:5000/api/launches',
    'https://earthquake.usgs.gov/feed.geojson',
  ]);
  assert.throws(
    () => createApiFetch({ apiBase: 'file:///etc' }),
    /http\(s\) URL/,
  );
});

test('the stdio server answers newline-delimited requests using only its data sources', async () => {
  const contacted = [];
  const server = createLocalMcpServer({
    apiBase: 'http://127.0.0.1:5000',
    fetchImpl: async (url) => {
      contacted.push(new URL(url).origin);
      return Response.json(usgs);
    },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => (written += chunk));
  const served = serveStdio(server, { input, output });
  input.write(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n',
  );
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n\n');
  input.write('not json\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  input.end(
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_earthquakes","arguments":{}}}\n',
  );
  await served;
  const responses = written
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(responses.length, 4);
  assert.equal(byId.get(1).result.serverInfo.name, 'gods-eye-view');
  assert.equal(byId.get(null).error.code, -32700);
  // Every Core tool's services are composed locally.
  assert.deepEqual(
    byId.get(2).result.tools.map((tool) => tool.name),
    toolsForSurface(coreTools, 'mcp').map((tool) => tool.name),
  );
  assert.equal(
    byId.get(3).result.content[0].text,
    '1 earthquake of M2.5+ in the last 24 hours worldwide; strongest M5.1 near Hualien.',
  );
  // The earthquake feed is fetched directly; nothing else was contacted.
  assert.deepEqual(contacted, ['https://earthquake.usgs.gov']);
});

test('command-line arguments are strict', () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs(['--api-base', 'http://localhost:5173']), {
    apiBase: 'http://localhost:5173',
  });
  assert.throws(() => parseArgs(['--port', '1']), /Unknown argument/);
});

test('the stdio log names methods, tools and resources but never arguments', async () => {
  const { describeRequest } = await import('../../server/mcp/stdio.js');
  assert.equal(describeRequest({ method: 'tools/list' }), 'tools/list');
  assert.equal(
    describeRequest({
      method: 'tools/call',
      params: { name: 'get_weather', arguments: { location: { place: 'x' } } },
    }),
    'tools/call get_weather',
  );
  assert.equal(
    describeRequest({ method: 'resources/read', params: { uri: 'ui://a/b' } }),
    'resources/read ui://a/b',
  );
  assert.equal(describeRequest({ result: {} }), null);
});

test('a failed tool call is logged with its reason', async () => {
  const server = {
    handle: async (message) => ({
      jsonrpc: '2.0',
      id: message.id,
      result: { isError: true, content: [{ type: 'text', text: 'bad area' }] },
    }),
  };
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const logged = [];
  const served = serveStdio(server, {
    input,
    output,
    log: (line) => logged.push(line),
  });
  input.end(
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"show_in_gods_eye_view"}}\n',
  );
  await served;
  assert.deepEqual(logged, [
    'tools/call show_in_gods_eye_view',
    '   tools/call show_in_gods_eye_view failed: bad area',
  ]);
});
