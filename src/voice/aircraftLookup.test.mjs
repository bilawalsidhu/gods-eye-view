import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../tools/index.js';
import { createGevActionRunner } from './gevActions.js';
import { rankContactMatch, CONTACT_MATCH_TIER } from '../data/contactMatch.js';
import { LiveSourceError } from '../sources/live/contract.js';
import { lookupVoiceAircraft } from './aircraftLookup.js';

function fixture({
  records,
  freshness = 'current',
  coverage = 'global',
  error,
  refresh = true,
  loadedId = 'aaa111',
  track = true,
  onSnapshot,
  onRefresh,
} = {}) {
  const events = [];
  const rows = records || [
    {
      id: 'aaa111',
      callsign: 'UAL123',
      latitude: 30,
      longitude: -97,
      contactTimeMs: 1000,
    },
  ];
  const aircraft = {
    async getSnapshot(query, { signal }) {
      events.push(['feed', query]);
      await onSnapshot?.(signal);
      if (error) throw error;
      return {
        records: rows,
        source: 'stub',
        coverage,
        freshness,
        observedAtMs: 1000,
      };
    },
  };
  const catalog = composeCatalog({ tools: coreTools, services: { aircraft } });
  const module = {
    findByQuery(id) {
      events.push(['exact', id]);
      return loadedId
        ? { icao24: loadedId, callsign: 'UAL123', latitude: 30, longitude: -97 }
        : null;
    },
    trackById(id) {
      events.push(['track', id]);
      return track;
    },
  };
  const dataManager = {
    layers: new Map([['flights', { module }]]),
    isEnabled: () => true,
    getAll: () => [],
    setEnabled: async () => true,
    async refreshLayer(layerId, options) {
      events.push(['refresh', layerId]);
      await onRefresh?.(options.signal);
      return refresh;
    },
  };
  const dependencies = {
    loadCatalog: async () => ({
      lookupAircraft: (args, options) =>
        catalog.call('find_aircraft', args, options),
    }),
    dataManager,
    enable: async (id) => {
      events.push(['enable', id]);
      return { ok: true };
    },
    follow: async ({ query }, exactId) => {
      assert.equal(query, exactId);
      return { ok: module.trackById(exactId), tracking: track };
    },
    isCurrent: () => true,
  };
  return { events, dependencies, dataManager };
}

test('voice lookup finds feed aircraft absent from browser records without moving the map', async () => {
  const f = fixture({ loadedId: null });
  const out = await lookupVoiceAircraft(
    { query: 'ua 0123', lookupOnly: true },
    f.dependencies,
  );
  assert.equal(out.ok, true);
  assert.equal(out.tracking, false);
  assert.equal(out.data.rows[0].id, 'aaa111');
  assert.equal(out.data.feeds[0].source, 'stub');
  assert.equal(out.data.feeds[0].coverage, 'global');
  assert.equal(out.data.feeds[0].observed_at, new Date(1000).toISOString());
  assert.equal(out.data.view, null);
  assert.match(out.say, /Found/);
  assert.match(out.say, /stub/);
  assert.match(out.say, /1970-01-01T00:00:01.000Z/);
  assert.doesNotMatch(out.say, /tracking|following/i);
  assert.deepEqual(f.events, [['feed', {}]]);
  assert.equal(
    rankContactMatch({ query: 'ua 0123', callsign: 'UAL123' }),
    CONTACT_MATCH_TIER.CALLSIGN_EXACT,
  );
});

test('follow enables and refreshes before exact ICAO handoff', async () => {
  const f = fixture();
  const out = await lookupVoiceAircraft({ query: 'UA123' }, f.dependencies);
  assert.equal(out.ok, true);
  assert.deepEqual(f.events, [
    ['feed', {}],
    ['enable', 'flights'],
    ['refresh', 'flights'],
    ['exact', 'aaa111'],
    ['track', 'aaa111'],
  ]);
});

for (const [name, options] of [
  ['missing loaded target', { loadedId: null }],
  ['fuzzy impostor', { loadedId: 'bbb222' }],
  ['failed refresh', { refresh: false }],
  ['stale feed', { freshness: 'stale' }],
  ['unknown freshness', { freshness: 'unknown' }],
  ['regional no match', { coverage: 'regional Austin only', records: [] }],
  [
    'ambiguous',
    {
      records: ['aaa111', 'bbb222'].map((id) => ({
        id,
        callsign: 'UAL123',
        latitude: 30,
        longitude: -97,
      })),
    },
  ],
  ['failed feed', { error: new Error('cooldown') }],
]) {
  test(`${name} cannot report tracking success`, async () => {
    const f = fixture(options);
    const out = await lookupVoiceAircraft({ query: 'UA123' }, f.dependencies);
    assert.equal(out.ok, false);
    assert.equal(
      f.events.some(([event]) => event === 'track'),
      false,
    );
  });
}

for (const phase of ['onSnapshot', 'onRefresh']) {
  test(`cancellation during ${phase} prevents follow`, async () => {
    const abort = new AbortController();
    const f = fixture({ [phase]: () => abort.abort() });
    const out = await lookupVoiceAircraft(
      { query: 'UA123' },
      { ...f.dependencies, signal: abort.signal },
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /cancelled/);
    assert.equal(
      f.events.some(([event]) => event === 'track'),
      false,
    );
  });
}

test('actual action runner dispatches lookupOnly to feed lookup', async () => {
  const f = fixture({ loadedId: null });
  const runner = createGevActionRunner({
    viewer: { canvas: { addEventListener() {}, removeEventListener() {} } },
    dataManager: f.dataManager,
    toolCatalog: f.dependencies.loadCatalog,
  });
  const out = await runner('track_entity', {
    query: 'UA123',
    lookupOnly: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.tracking, false);
  assert.deepEqual(f.events, [['feed', {}]]);
  runner.dispose();
});

for (const track of [true, false]) {
  test(`actual runner follows exact ID and reports trackById=${track}`, async () => {
    const f = fixture({ track });
    const runner = createGevActionRunner({
      viewer: { canvas: { addEventListener() {}, removeEventListener() {} } },
      dataManager: f.dataManager,
      styleManager: { runImmediateNavigation: (_noun, navigate) => navigate() },
      toolCatalog: f.dependencies.loadCatalog,
    });
    const out = await runner('track_entity', { query: 'UA123' });
    assert.equal(out.ok, track, JSON.stringify(out));
    assert.equal(out.tracking, track);
    assert.deepEqual(
      f.events.filter(([event]) => event === 'track'),
      [['track', 'aaa111']],
      JSON.stringify(out),
    );
    assert.equal(out.lookup.tracking, false);
    runner.dispose();
  });
}

test('provider cooldown is returned without retries', async () => {
  const f = fixture({
    error: new LiveSourceError('limited', 'cooldown', { retryAfterMs: 60_000 }),
  });
  const out = await lookupVoiceAircraft({ query: 'UA123' }, f.dependencies);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'retry_later');
  assert.equal(out.retryAfterSeconds, 60);
  assert.deepEqual(f.events, [['feed', {}]]);
});

test('regional lookup names coverage and never claims a global absence', async () => {
  const f = fixture({ records: [], coverage: 'regional Austin only' });
  const out = await lookupVoiceAircraft(
    { query: 'UA123', lookupOnly: true },
    f.dependencies,
  );
  assert.equal(out.tracking, false);
  assert.match(out.say, /regional Austin only/);
});

test('resetConversation aborts pending provider work and prevents success', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    onSnapshot: (signal) =>
      new Promise((resolve, reject) => {
        entered();
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const runner = createGevActionRunner({
    viewer: { canvas: { addEventListener() {}, removeEventListener() {} } },
    dataManager: f.dataManager,
    toolCatalog: f.dependencies.loadCatalog,
  });
  const pending = runner('track_entity', { query: 'UA123' });
  await started;
  runner.resetConversation();
  const out = await pending;
  assert.equal(out.ok, false);
  assert.match(out.error, /cancelled/);
  assert.equal(
    f.events.some(([event]) => event === 'track'),
    false,
  );
  runner.dispose();
});

test('lookupOnly without feed services never falls back to map following', async () => {
  const f = fixture();
  const runner = createGevActionRunner({
    viewer: { canvas: { addEventListener() {}, removeEventListener() {} } },
    dataManager: f.dataManager,
  });
  const out = await runner('track_entity', {
    query: 'UAL123',
    lookupOnly: true,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /unavailable/);
  assert.deepEqual(f.events, []);
  runner.dispose();
});

test('production follow rechecks exact identity immediately before tracking', async () => {
  const f = fixture();
  let reads = 0;
  f.dataManager.layers.get('flights').module.findByQuery = () => ({
    icao24: ++reads === 1 ? 'aaa111' : 'bbb222',
  });
  const runner = createGevActionRunner({
    viewer: { canvas: { addEventListener() {}, removeEventListener() {} } },
    dataManager: f.dataManager,
    styleManager: { runImmediateNavigation: (_noun, navigate) => navigate() },
    toolCatalog: f.dependencies.loadCatalog,
  });
  const out = await runner('track_entity', { query: 'UA123' });
  assert.equal(out.ok, false);
  assert.equal(out.tracking, false);
  assert.equal(reads, 2);
  assert.equal(
    f.events.some(([event]) => event === 'track'),
    false,
  );
  runner.dispose();
});

test('an old individual observation cannot be followed from a current snapshot', async () => {
  const f = fixture({
    records: [
      {
        id: 'aaa111',
        callsign: 'UAL123',
        latitude: 30,
        longitude: -97,
        contactTimeMs: -200_000,
      },
    ],
  });
  const out = await lookupVoiceAircraft({ query: 'UA123' }, f.dependencies);
  assert.equal(out.ok, false);
  assert.match(out.error, /stale/);
  assert.equal(
    f.events.some(([event]) => event === 'track'),
    false,
  );
});

test('invalid long identity is rejected before querying a provider', async () => {
  const f = fixture();
  const out = await lookupVoiceAircraft(
    { query: 'A'.repeat(200), lookupOnly: true },
    f.dependencies,
  );
  assert.equal(out.ok, false);
  assert.deepEqual(f.events, []);
});

for (const args of [
  { query: 'Ever Given', layerId: 'ais-live-vessels' },
  { query: 'ISS', layerId: 'satellites' },
  { query: 'Ever Given' },
  { query: 'ISS' },
  { query: 'UA123', layerId: 'ais-live-vessels' },
  { query: 'aaa111', layerId: 'satellites' },
]) {
  test(`lookupOnly refuses non-aircraft target ${JSON.stringify(args)} before loading feeds`, async () => {
    const f = fixture();
    let catalogLoads = 0;
    const runner = createGevActionRunner({
      viewer: { canvas: { addEventListener() {}, removeEventListener() {} } },
      dataManager: f.dataManager,
      toolCatalog: async () => {
        catalogLoads++;
        return f.dependencies.loadCatalog();
      },
    });
    const out = await runner('track_entity', { ...args, lookupOnly: true });
    assert.equal(out.ok, false);
    assert.equal(out.tracking, false);
    assert.match(
      out.error,
      /lookupOnly supports aircraft flight numbers or ICAO identifiers only/,
    );
    assert.match(out.say, /analyst_query.*loaded layers/);
    assert.equal(catalogLoads, 0);
    assert.deepEqual(f.events, []);
    runner.dispose();
  });
      }
