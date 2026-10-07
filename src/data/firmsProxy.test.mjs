import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { filterTrailing24h, parseFirmsCsv } from './firmsCsv.js';

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
  return new Function('SOURCES', 'fetchSource', 'filterTrailing24h', 'Date', 'console',
    `return (${refreshSource});`)(SOURCES, fetchSource, filter, { now: () => NOW }, { warn() {} });
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

// ── Conditional requests ─────────────────────────────────────────────────────
// The served set shrinks between polls as detections age past 24 h, so a tag
// over the filtered rows would change on nearly every 10-minute poll (measured
// 3/3 on a live 207k-row snapshot). The tag therefore names the cached
// snapshot; a client holding it applies the same trailing window itself.

async function startFirmsProxy() {
  const { firmsProxy } = await import('../../server/providers/firms.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-firms-proxy-'));
  const priorCwd = process.cwd();
  process.chdir(directory); // the disk cache lands in the temp dir, never the repo
  let handler;
  try {
    firmsProxy().configureServer({ middlewares: { use(prefix, fn) { handler = fn; } } });
  } finally {
    process.chdir(priorCwd);
  }
  return (headers = {}) => new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status, head = {}) {
        this.status = status;
        this.headers = Object.fromEntries(Object.entries(head).map(([k, v]) => [k.toLowerCase(), v]));
        this.headersSent = true;
      },
      end(body = '') { resolve({ status: this.status, headers: this.headers, body: String(body) }); },
    };
    handler({ url: '', headers }, res);
  });
}

function withFirmsWorld(run) {
  return async () => {
    const priorFetch = globalThis.fetch;
    const priorNow = Date.now;
    const priorKey = process.env.FIRMS_MAP_KEY;
    const priorWarn = console.warn;
    const world = { clock: Date.UTC(2026, 8, 11, 12), upstreamDown: false, upstreamCalls: 0 };
    Date.now = () => world.clock;
    console.warn = () => {};
    process.env.FIRMS_MAP_KEY = 'fixture-key';
    globalThis.fetch = async () => {
      world.upstreamCalls++;
      if (world.upstreamDown) throw new Error('upstream unavailable');
      // One fresh detection and one that ages out at 12:05Z.
      return new Response('latitude,longitude,acq_date,acq_time,confidence,frp\n' +
        '1,2,2026-09-11,1100,n,4\n3,4,2026-09-10,1205,h,9\n');
    };
    try {
      await run(world, await startFirmsProxy());
    } finally {
      globalThis.fetch = priorFetch;
      Date.now = priorNow;
      console.warn = priorWarn;
      if (priorKey === undefined) delete process.env.FIRMS_MAP_KEY;
      else process.env.FIRMS_MAP_KEY = priorKey;
    }
  };
}

test('a snapshot carries a validator, and a client holding it gets an empty 304', withFirmsWorld(async (world, request) => {
  const first = await request();
  assert.equal(first.status, 200);
  const tag = first.headers.etag;
  assert.match(tag ?? '', /^W\/".+"$/, 'a weak validator naming the snapshot');
  assert.equal(JSON.parse(first.body).count, 8, 'four sources × two detections');

  const again = await request({ 'if-none-match': tag });
  assert.equal(again.status, 304);
  assert.equal(again.body, '', 'no body: the client already holds these rows');
  assert.equal(again.headers.etag, tag);
  assert.equal(world.upstreamCalls, 4, 'answered from cache, never upstream');
}));

test('the validator names the snapshot, not the rows the trailing window keeps', withFirmsWorld(async (world, request) => {
  const first = await request();
  world.clock += 10 * 60_000; // 12:10Z: the 12:05Z detections have aged out
  const later = await request();
  assert.equal(JSON.parse(later.body).count, 4, 'the server still applies the window');
  assert.equal(later.headers.etag, first.headers.etag, 'same snapshot, same validator');
  assert.equal((await request({ 'if-none-match': first.headers.etag })).status, 304);
}));

test('a stale fallback is a different snapshot than the fresh one it replaces', withFirmsWorld(async (world, request) => {
  const fresh = await request();
  world.clock += 31 * 60_000; // past the 30 min TTL
  world.upstreamDown = true;
  const stale = await request({ 'if-none-match': fresh.headers.etag });
  assert.equal(stale.status, 200, 'the stale flag changed, so the client must hear it');
  assert.equal(JSON.parse(stale.body).stale, true);
  assert.notEqual(stale.headers.etag, fresh.headers.etag);
  assert.equal((await request({ 'if-none-match': stale.headers.etag })).status, 304);
}));

test('a mismatched or absent validator always gets the full snapshot', withFirmsWorld(async (world, request) => {
  await request();
  for (const headers of [{}, { 'if-none-match': 'W/"firms-0-f"' }, { 'if-none-match': '*' }]) {
    const response = await request(headers);
    assert.equal(response.status, 200, JSON.stringify(headers));
    assert.equal(JSON.parse(response.body).count, 8);
  }
}));
