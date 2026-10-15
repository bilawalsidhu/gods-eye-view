import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { filterTrailing24h, parseFirmsCsv } from './firmsCsv.js';
import net from 'node:net';
import {
  describeFetchError,
  fetchFirms,
  fetchIpv4,
} from '../../server/providers/firms.js';

const config = fs.readFileSync(new URL('../../server/providers/firms.js', import.meta.url), 'utf8');
const start = config.indexOf('  async function refreshUpstream(key) {');
assert.notEqual(start, -1, 'FIRMS refresh function exists');
const end = config.indexOf('\n  }', start);
assert.notEqual(end, -1, 'FIRMS refresh function closes');
const refreshSource = config.slice(start, end + 4);
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT'];
const NOW = Date.UTC(2026, 8, 11, 12);
const recent = { acqDate: '2026-09-11', acqTime: '1100' };

// Exercise the production refresh without opening a server or using a MAP_KEY.
// Inject only its upstream, clock and filter dependencies; keep its aggregation
// and source-status code intact, including failures while consuming records.
function createRefresh(fetchSource, filter = filterTrailing24h) {
  return new Function('SOURCES', 'fetchSource', 'filterTrailing24h', 'describeFetchError', 'Date', 'console',
    `return (${refreshSource});`)(SOURCES, fetchSource, filter, describeFetchError, { now: () => NOW }, { warn() {} });
}

test('FIRMS retains large sources in order and filters expired rows', async () => {
  const header = 'latitude,longitude,acq_date,acq_time,confidence,frp\n';
  const large = parseFirmsCsv(header + '1,2,2026-09-11,1100,n,4\n'.repeat(200_000));
  const expired = { ...recent, acqDate: '2026-09-09' };
  const last = { ...recent, marker: 'last' };
  const calls = [];
  let active = 0;
  const refresh = createRefresh(async (key, source) => {
    assert.equal(active++, 0, 'sources must be fetched sequentially');
    calls.push(source);
    await Promise.resolve();
    active--;
    return source === SOURCES[0] ? [...large, expired] : source === SOURCES[1] ? [last] : [];
  });
  const result = await refresh('fixture');
  assert.deepEqual(calls, SOURCES);
  assert.equal(result.fires.length, 200_001);
  assert.equal(result.fires[0], large[0]);
  assert.equal(result.fires[199_999], large.at(-1));
  assert.equal(result.fires.at(-1), last);
  assert.deepEqual(result.sources, SOURCES.map((source, index) => ({
    source, count: [200_000, 1, 0, 0][index], ok: true,
  })));
});

test('FIRMS keeps successful sources when another upstream fails', async () => {
  const result = await createRefresh(async (key, source) => {
    if (source === SOURCES[1]) throw new Error('upstream unavailable');
    return [recent];
  })('fixture');
  assert.equal(result.fires.length, 3);
  assert.deepEqual(result.sources, SOURCES.map((source, index) => ({
    source, count: index === 1 ? 0 : 1, ok: index !== 1,
  })));
});

test('FIRMS reports one failure if consuming a source throws before append', async () => {
  const failing = [];
  const result = await createRefresh(async (key, source) => source === SOURCES[0] ? failing : [recent],
    (records, now) => {
      if (records !== failing) return filterTrailing24h(records, now);
      // Fault injection for aggregation; ordinary parsed CSV returns an array.
      return { length: 1, [Symbol.iterator]() { throw new Error('aggregation failed'); } };
    })('fixture');
  assert.equal(result.fires.length, 3);
  assert.deepEqual(result.sources, SOURCES.map((source, index) => ({
    source, count: index === 0 ? 0 : 1, ok: index !== 0,
  })));
});

test('FIRMS distinguishes all-source failure from successful empty sources', async () => {
  await assert.rejects(createRefresh(async () => { throw new Error('upstream unavailable'); })('fixture'),
    /all FIRMS sources failed/);
  const result = await createRefresh(async () => [])('fixture');
  assert.deepEqual(result.fires, []);
  assert.deepEqual(result.sources, SOURCES.map(source => ({ source, count: 0, ok: true })));
});

// #68: Node's network-family auto-selection gives each address a short attempt
// timeout, abandons a slow IPv4 handshake for an unreachable IPv6 address, and
// reports only `fetch failed`. This is the shape Node 24 throws for it.
function addressSelectionFailure() {
  const v4 = Object.assign(new Error('connect ETIMEDOUT 198.118.194.34:443'), { code: 'ETIMEDOUT' });
  const v6 = Object.assign(new Error('connect ENETUNREACH 2001:4d0:241a:40c0::34:443'), { code: 'ENETUNREACH' });
  const cause = Object.assign(new AggregateError([v4, v6]), { code: 'ETIMEDOUT' });
  return new TypeError('fetch failed', { cause });
}
// Node 26's fetch wraps the same AggregateError in a ConnectTimeoutError.
function wrappedAddressSelectionFailure() {
  const inner = addressSelectionFailure().cause;
  const cause = Object.assign(new Error('Connect Timeout Error (attempted addresses: 198.118.194.34:443, 2001:4d0:241a:40c0::34:443, timeout: 10000ms)'),
    { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT', cause: inner });
  return new TypeError('fetch failed', { cause });
}
const URL_WITH_KEY = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/SECRET/VIIRS_SNPP_NRT/world/2';

test('FIRMS failures log the socket cause, never the keyed URL', () => {
  const described = describeFetchError(addressSelectionFailure());
  assert.equal(described,
    'fetch failed (connect ETIMEDOUT 198.118.194.34:443; connect ENETUNREACH 2001:4d0:241a:40c0::34:443)');
  assert.ok(!described.includes('SECRET'));
  assert.equal(describeFetchError(wrappedAddressSelectionFailure()), described, 'Node 26 reports the same attempts');
  const single = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) });
  assert.equal(describeFetchError(single), 'fetch failed (getaddrinfo ENOTFOUND x)');
  assert.equal(describeFetchError(new Error('HTTP 503')), 'HTTP 503');
});

test('FIRMS retries once over IPv4 when every address fails to connect', async () => {
  for (const shape of [addressSelectionFailure, wrappedAddressSelectionFailure]) {
    const retried = [];
    await fetchFirms(URL_WITH_KEY, {}, {
      fetchImpl: async () => { throw shape(); },
      fetchIpv4Impl: async (url) => { retried.push(url); return new Response('csv'); },
      warn() {},
    });
    assert.deepEqual(retried, [URL_WITH_KEY], `${shape.name} is retried`);
  }
  const signal = new AbortController().signal;
  const ok = new Response('csv');
  const retried = [];
  const warnings = [];
  const response = await fetchFirms(URL_WITH_KEY, { signal }, {
    fetchImpl: async () => { throw addressSelectionFailure(); },
    fetchIpv4Impl: async (url, options) => { retried.push([url, options]); return ok; },
    warn: (message) => warnings.push(message),
  });
  assert.equal(response, ok);
  assert.deepEqual(retried, [[URL_WITH_KEY, { signal }]], 'one retry, same URL and deadline');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ETIMEDOUT 198\.118\.194\.34:443; .*ENETUNREACH .* retrying over IPv4/);
  assert.ok(!warnings[0].includes('SECRET'));

  const failure = new Error('connect ETIMEDOUT 198.118.194.34:443');
  await assert.rejects(fetchFirms(URL_WITH_KEY, {}, {
    fetchImpl: async () => { throw addressSelectionFailure(); },
    fetchIpv4Impl: async () => { throw failure; },
    warn() {},
  }), (err) => err === failure, 'a failed retry reports its own error');
});

test('FIRMS does not retry anything but an address-selection failure', async () => {
  const deps = (fetchImpl) => ({
    fetchImpl,
    fetchIpv4Impl: async () => assert.fail('must not retry'),
    warn: () => assert.fail('must not warn'),
  });
  const serverError = new Response('down', { status: 503 });
  assert.equal(await fetchFirms(URL_WITH_KEY, {}, deps(async () => serverError)), serverError);
  for (const thrown of [
    new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) }),
    new TypeError('fetch failed', { cause: new AggregateError([]) }),
    new TypeError('fetch failed'),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
  ]) {
    await assert.rejects(fetchFirms(URL_WITH_KEY, {}, deps(async () => { throw thrown; })), (err) => err === thrown);
  }
  const controller = new AbortController();
  controller.abort();
  const aborted = addressSelectionFailure();
  await assert.rejects(fetchFirms(URL_WITH_KEY, { signal: controller.signal },
    deps(async () => { throw aborted; })), (err) => err === aborted, 'an expired deadline is not retried');
});

test('the IPv4 retry connects to an IPv4 address only', async (t) => {
  // `localhost` resolves to both ::1 and 127.0.0.1. Listen on both with the
  // same port and record which one the retry reaches; the TLS handshake then
  // fails against a plain socket, which is fine — only the connection matters.
  const reached = [];
  const listen = (host, port) => new Promise((resolve, reject) => {
    const server = net.createServer((socket) => { reached.push(host); socket.destroy(); });
    server.once('error', reject).listen(port, host, () => resolve(server));
  });
  const v4 = await listen('127.0.0.1', 0);
  t.after(() => v4.close());
  const { port } = v4.address();
  let v6 = null;
  try {
    v6 = await listen('::1', port);
    t.after(() => v6.close());
  } catch {
    // No IPv6 loopback on this host; the IPv4 assertion still holds.
  }
  await assert.rejects(fetchIpv4(`https://localhost:${port}/`, { signal: AbortSignal.timeout(5_000) }));
  assert.deepEqual(reached, ['127.0.0.1']);
});
