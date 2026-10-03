// Review regressions for the Nominatim gate: state that survives restarts and
// sweeps, several processes sharing one count, long refusals, stalled bodies,
// request-equivalent cache keys, and stricter outline selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createGateStateStore,
  createNominatimGate,
  resolveNominatimSettings,
  PUBLIC_NOMINATIM_SEARCH,
} from '../../server/providers/regional/nominatimGate.js';
import { createNominatimCache } from '../../server/providers/regional/nominatimCache.js';
import {
  outlineBias,
  selectOutlineResult,
} from '../../server/providers/regional/outlineSelect.js';
import {
  createNominatimOutlineProvider,
  createNominatimSearchProvider,
  geocodeProxy,
} from '../../server/providers/regional/place.js';

const PUBLIC = { endpoint: PUBLIC_NOMINATIM_SEARCH, isPublic: true, dailyCap: 50 };
const LOCAL = { ...PUBLIC, isPublic: false };
const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-nominatim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const quick = { sleep: async () => {} };
const json = (value) => Response.json(value);
const square = (lon, lat, d) => [
  [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ],
];

function mount(options) {
  let handler;
  geocodeProxy(options).configureServer({
    middlewares: { use: (_route, fn) => (handler = fn) },
  });
  return (url) =>
    new Promise((resolve, reject) => {
      const res = {
        writableEnded: false,
        on() {},
        writeHead(status) {
          res.status = status;
        },
        end(body) {
          res.writableEnded = true;
          resolve({ status: res.status, body: JSON.parse(body) });
        },
      };
      Promise.resolve(
        handler(
          { method: 'GET', url, headers: {}, socket: { remoteAddress: `10.9.${Math.random()}` }, on() {} },
          res,
        ),
      ).catch(reject);
    });
}

test('the daily count survives cache sweeps and a restart of the real composition', async (t) => {
  const storageDir = tempDir(t);
  const fetchImpl = async () => json([]);
  const first = createNominatimGate({ settings: PUBLIC, fetchImpl, ...quick });
  const request = mount({ storageDir, gate: first });
  for (let i = 0; i < 3; i++)
    assert.equal((await request(`/?q=place-${i}`)).status, 200);
  assert.equal(first.stats().usedToday, 3);

  // A foreign file in the answers directory and a full sweep leave the
  // state alone and the stranger untouched.
  const answers = path.join(storageDir, 'answers');
  fs.writeFileSync(path.join(answers, 'notes.json'), '{}');
  await createNominatimCache({ dir: answers, sweepEvery: 1 }).sweep();
  assert.ok(fs.existsSync(path.join(answers, 'notes.json')));
  assert.ok(fs.existsSync(path.join(storageDir, 'state.json')));

  // Restart: a new gate composed on the same directory, which sweeps at start.
  const second = createNominatimGate({ settings: { ...PUBLIC, dailyCap: 4 }, fetchImpl, ...quick });
  const again = mount({ storageDir, gate: second });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(second.stats().usedToday, 3, 'the count came back');
  assert.equal((await again('/?q=place-new')).status, 200);
  const capped = await again('/?q=place-over');
  assert.equal(capped.status, 429, 'the cap still counts yesterday-restart usage');
  assert.equal(capped.body.code, 'NOMINATIM_DAILY_CAP');
});

test('a sweep removes expired and corrupt entries, never ones it could not read', async (t) => {
  const dir = tempDir(t);
  const file = (n) => path.join(dir, `${String(n).repeat(40)}.json`);
  const live = { key: 'k', payload: null, storedAt: 1, expiresAt: Date.now() + 60_000 };
  fs.writeFileSync(file(1), JSON.stringify(live));
  fs.writeFileSync(file(2), JSON.stringify({ ...live, expiresAt: 1 }));
  fs.writeFileSync(file(3), '{not json');
  const cache = createNominatimCache({ dir });
  // Reads failing (a busy disk, a test double) must not empty the cache.
  const fsp = (await import('node:fs/promises')).default;
  const readFile = t.mock.method(fsp, 'readFile', async () => {
    throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
  });
  await cache.sweep();
  assert.deepEqual([1, 2, 3].map((n) => fs.existsSync(file(n))), [true, true, true]);
  readFile.mock.restore();
  await cache.sweep();
  assert.deepEqual([1, 2, 3].map((n) => fs.existsSync(file(n))), [true, false, false]);
});

test('processes sharing state reserve public spacing and cap atomically', async (t) => {
  const dir = tempDir(t);
  const module = new URL('../../server/providers/regional/nominatimGate.js', import.meta.url).href;
  const run = (file, dailyCap) => {
    const script = `
    const { createGateStateStore } = await import(${JSON.stringify(module)});
    const store = createGateStateStore({ file: ${JSON.stringify(file)} });
    console.log(JSON.stringify(store.reserve('2026-09-29', {
      now: 1000,
      dailyCap: ${dailyCap},
      minSpacingMs: 1100,
      latestStartAt: 10000,
    })));
  `;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('exit', (code) =>
        code === 0
          ? resolve(JSON.parse(stdout))
          : reject(new Error(`exit ${code}: ${stderr}`)),
      );
    });
  };

  const spacedFile = path.join(dir, 'spaced.json');
  const reservations = await Promise.all([
    run(spacedFile, 3),
    run(spacedFile, 3),
    run(spacedFile, 3),
  ]);
  assert.deepEqual(
    reservations.map((result) => result.status),
    ['reserved', 'reserved', 'reserved'],
  );
  assert.deepEqual(
    reservations.map((result) => result.startAt).sort((a, b) => a - b),
    [1000, 2100, 3200],
  );
  assert.equal(createGateStateStore({ file: spacedFile }).count('2026-09-29'), 3);

  const cappedFile = path.join(dir, 'capped.json');
  const capped = await Promise.all([run(cappedFile, 1), run(cappedFile, 1)]);
  assert.deepEqual(
    capped.map((result) => result.status).sort(),
    ['cap', 'reserved'],
  );
  assert.equal(createGateStateStore({ file: cappedFile }).count('2026-09-29'), 1);
});

test('independent public gates sharing state enforce spacing and cap', async (t) => {
  const dir = tempDir(t);
  const starts = [];
  const fetchImpl = async () => {
    starts.push(Date.now());
    return json([]);
  };
  const file = path.join(dir, 'spacing.json');
  const make = (options = {}) =>
    createNominatimGate({
      settings: PUBLIC,
      fetchImpl,
      usage: createGateStateStore({ file: options.file || file }),
      minSpacingMs: options.minSpacingMs || 40,
    });
  await Promise.all([
    createNominatimSearchProvider({ gate: make() })('one', null),
    createNominatimSearchProvider({ gate: make() })('two', null),
  ]);
  starts.sort((a, b) => a - b);
  assert.ok(starts[1] - starts[0] >= 35, `${starts[1] - starts[0]}ms apart`);

  const capFile = path.join(dir, 'cap.json');
  let sent = 0;
  const capGate = () =>
    createNominatimGate({
      settings: { ...PUBLIC, dailyCap: 1 },
      fetchImpl: async () => {
        sent += 1;
        return json([]);
      },
      usage: createGateStateStore({ file: capFile }),
      minSpacingMs: 1,
    });
  const results = await Promise.allSettled([
    createNominatimSearchProvider({ gate: capGate() })('three', null),
    createNominatimSearchProvider({ gate: capGate() })('four', null),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.code,
    'NOMINATIM_DAILY_CAP',
  );
  assert.equal(sent, 1);
});

test('a persistence failure is reported and never lowers the count', (t) => {
  const dir = tempDir(t);
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const errors = [];
  const store = createGateStateStore({
    file: path.join(blocker, 'state.json'),
    onError: (error) => errors.push(error),
  });
  store.increment('2026-09-29');
  store.increment('2026-09-29');
  assert.equal(store.count('2026-09-29'), 2);
  assert.equal(store.status().persisted, false);
  assert.ok(store.status().error);
  assert.equal(errors.length, 1, 'reported once, not per request');
});

test('parseable but invalid public usage state fails closed', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      day: '2026-09-30',
      count: '50',
      pausedUntil: '9999999999999',
    }),
  );
  let sent = 0;
  const gate = createNominatimGate({
    settings: PUBLIC,
    fetchImpl: async () => {
      sent += 1;
      return json([]);
    },
    usage: createGateStateStore({ file, onError: () => {} }),
    ...quick,
  });
  await assert.rejects(
    gate.requestJson((endpoint) => `${endpoint}?q=x`),
    { code: 'NOMINATIM_STATE_UNAVAILABLE' },
  );
  assert.equal(sent, 0);

  fs.writeFileSync(
    file,
    JSON.stringify({ day: '2026-09-30', count: 1, pausedUntil: 0 }),
  );
  const migrated = createGateStateStore({ file });
  assert.equal(
    migrated.reserve('2026-09-30', {
      now: 1000,
      dailyCap: 50,
      minSpacingMs: 1100,
    }).status,
    'reserved',
    'the original state format without nextStartAt remains supported',
  );
});

test('a long Retry-After is honoured in full and survives a restart', async (t) => {
  const file = path.join(tempDir(t), 'state.json');
  let clock = Date.UTC(2026, 8, 29, 12);
  const now = () => clock;
  const refused = createNominatimGate({
    settings: PUBLIC,
    fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '86400' } }),
    usage: createGateStateStore({ file }),
    now,
    ...quick,
  });
  await assert.rejects(createNominatimSearchProvider({ gate: refused })('x', null), {
    code: 'NOMINATIM_REFUSED',
  });
  const calls = [];
  const restarted = createNominatimGate({
    settings: PUBLIC,
    fetchImpl: async (url) => {
      calls.push(url);
      return json([]);
    },
    usage: createGateStateStore({ file }),
    now,
    ...quick,
  });
  const search = createNominatimSearchProvider({ gate: restarted });
  clock += 7 * 3_600_000; // past the old six-hour ceiling
  await assert.rejects(search('y', null), (error) => {
    assert.equal(error.code, 'NOMINATIM_PAUSED');
    assert.equal(error.retryAfterMs, 17 * 3_600_000);
    return true;
  });
  assert.equal(calls.length, 0);
  clock += 17 * 3_600_000 + 1000;
  await search('y', null);
  assert.equal(calls.length, 1);
});

test('an operator refusal pauses only the endpoint that refused', async () => {
  let active = {
    endpoint: 'https://a.example.test/search',
    isPublic: false,
    dailyCap: 50,
  };
  const calls = [];
  const gate = createNominatimGate({
    settings: () => active,
    fetchImpl: async (url) => {
      calls.push(new URL(url).host);
      return calls.length === 1
        ? new Response('', {
            status: 429,
            headers: { 'Retry-After': '60' },
          })
        : json([]);
    },
    ...quick,
  });
  const request = () => gate.requestJson((endpoint) => `${endpoint}?q=x`);
  await assert.rejects(request(), { code: 'NOMINATIM_REFUSED' });
  active = { ...active, endpoint: 'https://b.example.test/search' };
  assert.deepEqual(await request(), []);
  active = { ...active, endpoint: 'https://a.example.test/search' };
  await assert.rejects(request(), { code: 'NOMINATIM_PAUSED' });
  assert.deepEqual(calls, ['a.example.test', 'b.example.test']);
});

test('a stalled body times out instead of holding the shared queue', async () => {
  let cancelled = 0;
  const stalled = (signal) => {
    const body = new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel: () => {
        cancelled += 1;
      },
    });
    signal.addEventListener('abort', () => body.cancel().catch(() => {}));
    return new Response(body, { status: 200 });
  };
  let n = 0;
  const gate = createNominatimGate({
    settings: { ...PUBLIC, isPublic: false },
    fetchImpl: async (_url, { signal }) => (++n <= 2 ? stalled(signal) : json([])),
    timeoutMs: 150,
  });
  const search = createNominatimSearchProvider({ gate });
  const started = Date.now();
  await assert.rejects(search('stall', null), { code: 'NOMINATIM_TRANSPORT' });
  assert.ok(Date.now() - started < 3000);
  assert.ok(cancelled >= 1, 'the body read was cancelled');
});

test('cache keys are request-equivalent: a miss for "Paris???" never answers "Paris"', async () => {
  const calls = [];
  const gate = createNominatimGate({
    settings: LOCAL,
    fetchImpl: async (url) => {
      calls.push(new URL(url).searchParams.get('q'));
      return json(calls.length === 1 ? [] : [{ lat: '48.85', lon: '2.35', display_name: 'Paris, France', name: 'Paris', addresstype: 'city' }]);
    },
    ...quick,
  });
  const search = createNominatimSearchProvider({ gate });
  assert.equal((await search('Paris???', null)).status, 'ZERO_RESULTS');
  assert.equal((await search('Paris', null)).status, 'OK');
  assert.deepEqual(calls, ['Paris???', 'Paris']);
  // Whitespace-only differences are the same upstream request.
  assert.equal((await search('  Paris ', null)).cached, true);
});

test('a malformed answer is a failure, not a cached "no result"', async () => {
  let shape = { error: 'Unexpected' };
  let calls = 0;
  const gate = createNominatimGate({
    settings: LOCAL,
    fetchImpl: async () => {
      calls += 1;
      return json(shape);
    },
    ...quick,
  });
  const outline = createNominatimOutlineProvider({ gate });
  const search = createNominatimSearchProvider({ gate });
  await assert.rejects(outline({ query: 'Zilker Park', kind: 'landmark' }), { code: 'NOMINATIM_MALFORMED' });
  await assert.rejects(search('Zilker Park', null), { code: 'NOMINATIM_MALFORMED' });
  shape = [];
  assert.equal((await outline({ query: 'Zilker Park', kind: 'landmark' })).status, 'ZERO_RESULTS');
  assert.equal(calls, 3, 'the malformed answers were not cached');
});

test('cache entries are namespaced by endpoint', async () => {
  const cache = createNominatimCache();
  const hits = [];
  const gateFor = (endpoint) =>
    createNominatimGate({
      settings: { endpoint, isPublic: false, dailyCap: 50 },
      fetchImpl: async (url) => {
        hits.push(new URL(url).host);
        return json([]);
      },
    });
  await createNominatimSearchProvider({ gate: gateFor('https://a.example.test/search'), cache })('x', null);
  await createNominatimSearchProvider({ gate: gateFor('https://b.example.test/search'), cache })('x', null);
  assert.deepEqual(hits, ['a.example.test', 'b.example.test']);
});

test('public-host detection ignores a trailing DNS dot', () => {
  assert.equal(
    resolveNominatimSettings({ NOMINATIM_URL: 'https://nominatim.openstreetmap.org./search' }).isPublic,
    true,
  );
});

test('missing coordinates are no bias, never (0, 0)', () => {
  for (const [lat, lon] of [
    [null, null],
    ['', ''],
    [undefined, 2],
    [48.8, null],
  ])
    assert.equal(outlineBias('city', lat, lon), null, `${lat},${lon}`);
  assert.ok(outlineBias('city', 0, 0), 'a real (0, 0) is still a position');
});

const boundary = (extra) => ({
  category: 'boundary',
  type: 'administrative',
  lat: '1',
  lon: '1',
  geojson: { type: 'Polygon', coordinates: square(1, 1, 0.1) },
  ...extra,
});

test('administrative boundaries must be at the asked level', () => {
  const county = boundary({
    name: 'Travis County',
    addresstype: 'county',
    place_rank: 12,
  });
  const city = boundary({
    name: 'Austin',
    addresstype: 'city',
    place_rank: 16,
  });
  const state = boundary({
    name: 'Texas',
    addresstype: 'state',
    place_rank: 8,
  });
  assert.equal(
    selectOutlineResult([state], { kind: 'city', query: 'Texas' }).outline,
    null,
  );
  assert.equal(
    selectOutlineResult([city], { kind: 'admin', query: 'Austin' }).outline,
    null,
  );
  assert.equal(
    selectOutlineResult(
      [boundary({ name: 'Travis', addresstype: 'county', place_rank: 12 })],
      { kind: 'city', query: 'Travis' },
    ).outline,
    null,
  );
  assert.equal(
    selectOutlineResult(
      [boundary({ name: 'Austin', addresstype: 'city', place_rank: 12 })],
      { kind: 'admin', query: 'Austin' },
    ).outline,
    null,
  );
  assert.equal(
    selectOutlineResult([state], { kind: 'neighborhood', query: 'Texas' })
      .outline,
    null,
  );
  assert.ok(
    selectOutlineResult([county], { kind: 'admin', query: 'Travis County' })
      .outline,
  );
  assert.ok(
    selectOutlineResult([boundary({ name: 'Somewhere', place_rank: 16 })], {
      kind: 'city',
      query: 'Somewhere',
    }).outline,
  );
  assert.ok(
    selectOutlineResult(
      [
        boundary({
          name: 'Somewhere',
          addresstype: 'locality',
          place_rank: 16,
        }),
      ],
      { kind: 'city', query: 'Somewhere' },
    ).outline,
  );
  assert.equal(
    selectOutlineResult([boundary({ name: 'Somewhere' })], { kind: 'city', query: 'Somewhere' }).outline,
    null,
    'no level evidence at all',
  );
  // An unsuitable early boundary does not block a suitable later one.
  const picked = selectOutlineResult([state, boundary({ name: 'Texas', addresstype: 'city', osm_type: 'relation', osm_id: 9 })], {
    kind: 'city',
    query: 'Texas',
  });
  assert.equal(picked.outline.osm, 'relation/9');
});

test('admin identity comes only from unambiguous evidence on the selected row', () => {
  for (const [name, addresstype, adminLevel] of [
    ['Nepal', 'country', 'country'],
    ['Bagmati Province', 'province', 'admin1'],
    ['Province of Bagmati', 'province', 'admin1'],
    ['Texas', 'state', 'admin1'],
    ['Travis County', 'county', 'admin2'],
    ['County of Travis', 'county', 'admin2'],
    ['Kathmandu District', 'state_district', 'admin2'],
  ]) {
    const { outline } = selectOutlineResult([boundary({ name, addresstype })], {
      kind: 'admin',
      query: name,
    });
    assert.equal(outline.adminArea, name);
    assert.equal(outline.adminLevel, adminLevel);
  }

  for (const row of [
    boundary({ name: 'Northern Region', addresstype: 'region', place_rank: 8 }),
    boundary({
      name: 'Central District',
      addresstype: 'district',
      place_rank: 10,
    }),
    boundary({ name: 'Mystery Province', place_rank: 8 }),
    boundary({ name: 'Example State', addresstype: 'county' }),
    boundary({ name: 'County of Example', addresstype: 'state' }),
    boundary({ name: 'Province of Example', addresstype: 'county' }),
    boundary({ name: 'Example County', addresstype: 'state' }),
    boundary({ name: 'Example Province', addresstype: 'county' }),
    boundary({ name: 'County of Example Province', addresstype: 'county' }),
  ]) {
    const { outline } = selectOutlineResult([row], {
      kind: 'admin',
      query: row.name,
    });
    assert.ok(outline, row.name);
    assert.equal(outline.adminArea, undefined, row.name);
    assert.equal(outline.adminLevel, undefined, row.name);
  }

  const retired = selectOutlineResult(
    [boundary({ name: 'Bagmati Zone', addresstype: 'state' })],
    { kind: 'admin', query: 'Bagmati Zone' },
  ).outline;
  assert.equal(retired.adminArea, 'Bagmati Zone');
  assert.equal(retired.adminLevel, undefined);

  const retiredPrefix = selectOutlineResult(
    [boundary({ name: 'Zone of Bagmati', addresstype: 'state' })],
    { kind: 'admin', query: 'Zone of Bagmati' },
  ).outline;
  assert.equal(retiredPrefix.adminArea, 'Zone of Bagmati');
  assert.equal(retiredPrefix.adminLevel, undefined);
});

test('admin identity validates the full name before display truncation', () => {
  const longValidName = `Province of ${'Example '.repeat(24)}`.trim();
  const valid = selectOutlineResult(
    [boundary({ name: longValidName, addresstype: 'province' })],
    { kind: 'admin', query: longValidName },
  ).outline;
  assert.equal(valid.adminArea, longValidName.slice(0, 160));
  assert.equal(valid.adminLevel, 'admin1');

  const longContradictoryName = `${'Very Long Administrative Name '.repeat(7)}County`;
  assert.ok(longContradictoryName.length > 160);
  const contradictory = selectOutlineResult(
    [boundary({ name: longContradictoryName, addresstype: 'state' })],
    { kind: 'admin', query: longContradictoryName },
  ).outline;
  assert.ok(contradictory);
  assert.equal(contradictory.adminArea, undefined);
  assert.equal(contradictory.adminLevel, undefined);
});

test('non-administrative outline kinds never manufacture admin identity', () => {
  const city = selectOutlineResult(
    [boundary({ name: 'County of Austin', addresstype: 'city', place_rank: 16 })],
    { kind: 'city', query: 'County of Austin' },
  ).outline;
  const park = selectOutlineResult(
    [
      {
        category: 'leisure',
        type: 'park',
        name: 'Zilker Park',
        lat: '1',
        lon: '1',
        geojson: { type: 'Polygon', coordinates: square(1, 1, 0.01) },
      },
    ],
    { kind: 'landmark', query: 'Zilker Park' },
  ).outline;
  for (const outline of [city, park]) {
    assert.equal(outline.adminArea, undefined);
    assert.equal(outline.adminLevel, undefined);
  }
});

test('building asks need building evidence', () => {
  const park = { category: 'tourism', type: 'theme_park', name: 'Big Top', lat: '1', lon: '1', geojson: { type: 'Polygon', coordinates: square(1, 1, 0.0001) } };
  const camp = { ...park, type: 'camp_site' };
  const campus = { ...park, category: 'amenity', type: 'university' };
  for (const row of [park, camp, campus])
    assert.equal(selectOutlineResult([row], { kind: 'building', query: 'Big Top' }).outline, null, row.type);
  const hugeOffice = { ...park, category: 'office', type: 'government', geojson: { type: 'Polygon', coordinates: square(1, 1, 0.01) } };
  assert.equal(selectOutlineResult([hugeOffice], { kind: 'building', query: 'Big Top' }).outline, null);
  const office = { ...hugeOffice, geojson: { type: 'Polygon', coordinates: square(1, 1, 0.001) } };
  assert.ok(selectOutlineResult([office], { kind: 'building', query: 'Big Top' }).outline);
  const hall = { ...hugeOffice, category: 'building', type: 'yes' };
  assert.ok(selectOutlineResult([hall], { kind: 'building', query: 'Big Top' }).outline);
});

test('names match on whole words', () => {
  const row = (name) => ({ category: 'leisure', type: 'park', name, lat: '1', lon: '1', geojson: { type: 'Polygon', coordinates: square(1, 1, 0.01) } });
  assert.equal(selectOutlineResult([row('Yorkshire Park')], { kind: 'landmark', query: 'York' }).outline, null);
  assert.ok(selectOutlineResult([row('York Park')], { kind: 'landmark', query: 'York' }).outline);
  assert.ok(selectOutlineResult([row('Zilker Metropolitan Park')], { kind: 'landmark', query: 'Zilker Park' }).outline);
  assert.ok(
    selectOutlineResult([{ ...row('新宿御苑'), namedetails: { name: '新宿御苑' } }], { kind: 'landmark', query: '新宿御苑' }).outline,
  );
});
