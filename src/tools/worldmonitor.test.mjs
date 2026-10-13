import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createWorldMonitorClient,
  isLocalWorldMonitorAddress,
  worldMonitorProxy,
} from '../../server/providers/worldmonitor.js';
import { createLocalMcpServer } from '../../server/mcp/server.js';
import { standaloneVoiceTools } from '../../server/standalone/voiceTools.js';
import { worldMonitorTools } from './queries/worldmonitor.js';
import { composeCatalog } from './catalog.js';
import { createWorldMonitorService } from './worldmonitorService.js';

const observed = 1791712800000;
const headline = {
  title: 'United States fixture headline',
  source: 'Fixture News',
  link: 'https://news.example/article',
  publishedAt: observed,
};
const headlines = {
  countries: { US: { items: [headline] } },
  state: 'complete',
  feedTotal: 5,
  feedCached: 5,
  readAt: '2026-10-11T12:00:00.000Z',
};
const risk = {
  countryCode: 'US',
  countryName: 'United States',
  cii: {
    combinedScore: 38,
    computedAt: observed,
    trend: 'TREND_DIRECTION_STABLE',
    methodologyVersion: 'fixture',
  },
  advisoryLevel: '',
  sanctionsActive: false,
  sanctionsCount: 0,
  fetchedAt: observed,
  upstreamUnavailable: false,
};
const digest = {
  categories: { politics: { items: [headline] } },
  generatedAt: '2026-10-11T11:00:00.000Z',
  coverage: { state: 'stale', servedStale: true, staleAgeSeconds: 60 },
};

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('fixed local routes preserve provenance, stale coverage and server-only credentials', async (t) => {
  const calls = [];
  const base = await fixture(t, (req, res) => {
    calls.push({ path: req.url, headers: req.headers });
    json(
      res,
      req.url.includes('list-country-headlines')
        ? headlines
        : req.url.includes('get-country-risk')
          ? risk
          : digest,
    );
  });
  const client = createWorldMonitorClient({
    env: {
      WORLD_MONITOR_API_BASE: base,
      WORLD_MONITOR_API_KEY: 'fixture-operator',
      WORLD_MONITOR_LOCAL_TOKEN: 'fixture-transport',
    },
  });
  const brief = await client.getCountryBrief('us');
  assert.equal(brief.status, 'complete');
  assert.equal(brief.risk.score, 38);
  assert.equal(brief.risk.computedAt, new Date(observed).toISOString());
  assert.equal(brief.headlines[0].url, headline.link);
  const news = await client.getFeedDigest({ limit: 1 });
  assert.equal(news.status, 'stale');
  assert.equal(news.generatedAt, digest.generatedAt);
  assert.equal(news.coverage.servedStale, true);
  assert.equal(news.items[0].source, 'Fixture News');
  assert.deepEqual(
    calls.map((call) => call.path).sort(),
    [
      '/api/intelligence/v1/get-country-risk?country_code=US',
      '/api/news/v1/list-country-headlines?country_codes=US',
      '/api/news/v1/list-feed-digest?variant=full&lang=en',
    ].sort(),
  );
  for (const call of calls) {
    assert.equal(call.headers['x-worldmonitor-key'], 'fixture-operator');
    assert.equal(
      call.headers['x-worldmonitor-local-token'],
      'fixture-transport',
    );
  }
  assert.doesNotMatch(
    JSON.stringify({ brief, news }),
    /fixture-operator|fixture-transport|127\.0\.0\.1/,
  );
});

test('file secrets are trimmed and remain on the upstream request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gev-wm-secret-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'transport');
  await writeFile(file, ' fixture-file-token\n', { mode: 0o600 });
  let received;
  const base = await fixture(t, (req, res) => {
    received = req.headers['x-worldmonitor-local-token'];
    json(res, headlines);
  });
  const result = await createWorldMonitorClient({
    env: { WORLD_MONITOR_API_BASE: base, WORLD_MONITOR_LOCAL_TOKEN_FILE: file },
  }).getCountryHeadlines('US');
  assert.equal(received, 'fixture-file-token');
  assert.equal(result.status, 'complete');
  assert.doesNotMatch(
    JSON.stringify(result),
    /fixture-file-token|gev-wm-secret/,
  );
});

test('missing configuration and unavailable source caches never manufacture a zero risk', async (t) => {
  const missing = await createWorldMonitorClient({ env: {} }).getCountryBrief(
    'US',
  );
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.risk.score, null);
  assert.equal(missing.risk.sanctionsCount, null);
  const base = await fixture(t, (req, res) =>
    json(
      res,
      req.url.includes('headlines')
        ? { ...headlines, state: 'unavailable', countries: {} }
        : { ...risk, upstreamUnavailable: true, cii: undefined, fetchedAt: 0 },
    ),
  );
  const result = await createWorldMonitorClient({
    env: { WORLD_MONITOR_API_BASE: base },
  }).getCountryBrief('US');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.risk.score, null);
  assert.equal(result.risk.sanctionsActive, null);
  assert.equal(result.risk.computedAt, null);
});

test('healthy empty country matches and a failed risk section remain distinguishable', async (t) => {
  const base = await fixture(t, (req, res) =>
    req.url.includes('headlines')
      ? json(res, { ...headlines, countries: {} })
      : json(res, { error: 'private diagnostic' }, 503),
  );
  const client = createWorldMonitorClient({
    env: { WORLD_MONITOR_API_BASE: base },
  });
  const news = await client.getCountryHeadlines('JP');
  assert.equal(news.status, 'complete');
  assert.deepEqual(news.headlines, []);
  const brief = await client.getCountryBrief('JP');
  assert.equal(brief.status, 'partial');
  assert.equal(brief.risk.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(brief), /private diagnostic/);
});

test('redirects, error bodies, malformed bodies and oversize streams fail without forwarding credentials', async (t) => {
  let sinkCalls = 0;
  const destination = await fixture(t, (_req, res) => {
    sinkCalls++;
    json(res, headlines);
  });
  for (const mode of ['redirect', 'unauthorized', 'malformed', 'oversized']) {
    const base = await fixture(t, (_req, res) => {
      if (mode === 'redirect') {
        res.writeHead(307, { Location: destination });
        res.end();
      } else if (mode === 'unauthorized')
        json(res, { error: 'fixture-secret-must-stay-private' }, 401);
      else if (mode === 'malformed')
        json(res, { countries: {}, state: 'invented' });
      else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(' '.repeat(2 * 1024 * 1024 + 1));
      }
    });
    const result = await createWorldMonitorClient({
      env: {
        WORLD_MONITOR_API_BASE: base,
        WORLD_MONITOR_API_KEY: 'fixture-secret-must-stay-private',
      },
    }).getCountryHeadlines('US');
    assert.equal(result.status, 'unavailable', mode);
    assert.doesNotMatch(
      JSON.stringify(result),
      /fixture-secret-must-stay-private/,
    );
  }
  assert.equal(sinkCalls, 0);
});

test('local address policy excludes public, metadata and malformed configuration', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.2',
    '172.16.0.1',
    '192.168.1.2',
    '::1',
    'fd12::1',
  ])
    assert.equal(isLocalWorldMonitorAddress(address), true, address);
  for (const address of [
    '8.8.8.8',
    '169.254.169.254',
    '172.15.0.1',
    '0.0.0.0',
    'fe80::1',
    '2001:4860:4860::8888',
  ])
    assert.equal(isLocalWorldMonitorAddress(address), false, address);
  for (const base of [
    'https://8.8.8.8',
    'http://127.0.0.1/api',
    'http://user:secret@localhost',
    'file:///tmp/x',
    'http://localhost?url=http://bad',
  ]) {
    const result = await createWorldMonitorClient({
      env: { WORLD_MONITOR_API_BASE: base },
    }).getCountryHeadlines('US');
    assert.equal(result.status, 'unavailable');
  }
});

test('deadlines and caller cancellation stop acquisition; invalid arguments never dispatch', async (t) => {
  let calls = 0;
  const base = await fixture(t, () => {
    calls++;
  });
  const client = createWorldMonitorClient({
    env: { WORLD_MONITOR_API_BASE: base },
    timeoutMs: 30,
  });
  assert.equal((await client.getCountryHeadlines('US')).status, 'unavailable');
  await assert.rejects(
    client.getCountryHeadlines('US&url=https://bad'),
    /two-letter/,
  );
  await assert.rejects(
    client.getFeedDigest({ variant: 'https://bad' }),
    /Invalid digest/,
  );
  await assert.rejects(client.getFeedDigest({ limit: 101 }), /Invalid digest/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.getCountryHeadlines('US', { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('local UI route rejects foreign origins, forwarding and arbitrary query inputs', async (t) => {
  let requests = 0;
  const plugin = worldMonitorProxy({
    env: {},
    client: {
      getCountryHeadlines: async (country) => {
        requests++;
        return { status: 'complete', countryCode: country, headlines: [] };
      },
    },
  });
  let middleware;
  plugin.configureServer({
    middlewares: {
      use: (path, handler) => {
        assert.equal(path, '/api/worldmonitor');
        middleware = handler;
      },
    },
  });
  const base = await fixture(t, (req, res) => {
    req.url = req.url.slice('/api/worldmonitor'.length);
    void middleware(req, res);
  });
  const path = `${base}/api/worldmonitor/country-headlines?country=US`;
  assert.equal((await fetch(path)).status, 200);
  assert.equal(
    (await fetch(path, { headers: { Origin: 'https://foreign.example' } }))
      .status,
    403,
  );
  assert.equal(
    (await fetch(path, { headers: { 'X-Forwarded-For': '127.0.0.1' } })).status,
    403,
  );
  assert.equal((await fetch(`${path}&url=https://bad`)).status, 400);
  assert.equal((await fetch(path, { method: 'POST' })).status, 405);
  assert.equal(requests, 1);
});

test('MCP and voice expose the same three tools while preserving GEV UI resources', async () => {
  const called = [];
  const server = createLocalMcpServer({
    apiBase: 'http://127.0.0.1:4173',
    fetchImpl: async (url, init) => {
      called.push({ url: String(url), init });
      return Response.json(
        {
          status: 'unavailable',
          source: 'World Monitor (local)',
          headlines: [],
          reason: 'World Monitor is not configured',
        },
        { status: 503 },
      );
    },
  });
  const list = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  const voiceNames = new Set(standaloneVoiceTools().map((tool) => tool.name));
  for (const tool of worldMonitorTools) {
    assert.ok(list.result.tools.some((entry) => entry.name === tool.name));
    assert.ok(voiceNames.has(tool.name));
  }
  assert.ok(
    list.result.tools.some((entry) => entry.name === 'get_cctv_snapshot'),
  );
  const resources = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'resources/list',
  });
  assert.ok(
    resources.result.resources.some(
      (resource) => resource.uri === 'ui://gods-eye-view/globe',
    ),
  );
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'world_monitor_country_headlines',
      arguments: { country: 'US' },
    },
  });
  assert.equal(response.result.structuredContent.status, 'unavailable');
  assert.equal(
    called[0].url,
    'http://127.0.0.1:4173/api/worldmonitor/country-headlines?country=US',
  );
  assert.equal(called[0].init.redirect, 'error');
  assert.equal(called[0].init.headers, undefined);
  const invalid = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'world_monitor_country_headlines',
      arguments: { country: 'US', url: 'http://bad' },
    },
  });
  assert.equal(invalid.result.isError, true);
  assert.equal(called.length, 1);
});

test('portable service and catalog return structured facts without requiring a model', async () => {
  const catalog = composeCatalog({
    tools: worldMonitorTools,
    services: {
      worldmonitor: createWorldMonitorService({
        fetchImpl: async () =>
          Response.json({
            status: 'partial',
            summary: 'Fixture facts',
            risk: { score: null },
            headlines: [],
          }),
      }),
    },
  });
  const result = await catalog.call('world_monitor_country_brief', {
    country: 'GB',
  });
  assert.equal(result.summary, 'Fixture facts');
  assert.equal(result.data.risk.score, null);
});

test('invalid or oversized secret files fail before making an upstream request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gev-wm-secret-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'oversized');
  await writeFile(file, 'x'.repeat(16 * 1024 + 1));
  let calls = 0;
  const base = await fixture(t, (_req, res) => {
    calls++;
    json(res, headlines);
  });
  for (const filename of [file, directory, join(directory, 'missing')]) {
    const result = await createWorldMonitorClient({
      env: {
        WORLD_MONITOR_API_BASE: base,
        WORLD_MONITOR_API_KEY_FILE: filename,
      },
    }).getCountryHeadlines('US');
    assert.equal(result.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(result), /gev-wm-secret-invalid/);
  }
  assert.equal(calls, 0);
});

test('locally resolved hostnames work and malformed rows cannot look like healthy empty coverage', async (t) => {
  let calls = 0;
  const base = await fixture(t, (req, res) => {
    calls++;
    json(
      res,
      req.url.includes('headlines')
        ? { ...headlines, countries: { US: { items: [{ title: 5 }] } } }
        : {
            ...digest,
            coverage: { state: 'complete' },
            categories: { politics: { items: [{ title: null }] } },
          },
    );
  });
  const client = createWorldMonitorClient({
    env: { WORLD_MONITOR_API_BASE: base.replace('127.0.0.1', 'localhost') },
  });
  assert.equal((await client.getCountryHeadlines('US')).status, 'unavailable');
  assert.equal((await client.getFeedDigest()).status, 'unavailable');
  assert.equal(calls, 2);
});

test('Vite installation does not return Connect as a post-configuration hook', () => {
  const plugin = worldMonitorProxy({ env: {} });
  const connectApp = () => {
    throw new Error('Connect must not run as a post-hook');
  };
  const server = { middlewares: { use: () => connectApp } };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
});
