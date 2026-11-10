import test from 'node:test';
import assert from 'node:assert/strict';
import { createCivilFlightLayer } from './index.js';
import { createFlightState } from './state.js';
import { createEnrichment } from './enrichment.js';
import { createTracking } from './tracking.js';
import { LiveSourceError } from '../../sources/live/contract.js';

function services() {
  const names = [
    'picking',
    'sprites',
    'trails',
    'aircraftPresentation',
    'camera',
    'militaryRegistry',
    'labels',
    'groundFloor',
    'meshFloor',
    'geoid',
    'focus',
    'readout',
    'context',
    'render',
    'recession',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, {}])),
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
  };
}

/** The services enrichment reads: which hexes are military or a TR-3B. */
function enrichServices({ military = [], tr3b = [] } = {}) {
  return {
    militaryRegistry: { isMilitaryIcao: (id) => military.includes(id) },
    aircraftPresentation: { isTr3b: (id) => tr3b.includes(id) },
  };
}

test('constructing independent flight layers performs no source request and isolates selection', () => {
  let requests = 0;
  const source = {
    label: 'Fixture aircraft',
    getSnapshot() {
      requests++;
    },
  };
  const first = createCivilFlightLayer({ source, services: services() });
  const second = createCivilFlightLayer({ source, services: services() });
  first.testing._armFlightTrackingRestoreForTest('abc123');
  assert.equal(first.testing._pendingFlightTrackingRestoreForTest(), 'abc123');
  assert.equal(second.testing._pendingFlightTrackingRestoreForTest(), null);
  first.testing._setFlightTrackingRefreshOutcomeForTest({ ids: ['abc123'] });
  assert.notEqual(first.testing, second.testing);
  assert.equal(first.getStats().source, 'Fixture aircraft');
  assert.equal(requests, 0);
});

test('a layer without a source fails before touching the viewer', () => {
  const layer = createCivilFlightLayer({ services: services() });
  assert.throws(() => layer.init({}), /snapshot source/);
});

test('flight state owns distinct mutable records, scratch objects and floor samplers', () => {
  const first = createFlightState({ services: services() });
  const second = createFlightState({ services: services() });
  for (const key of [
    'records',
    'feed',
    '_billboards',
    '_positionHistory',
    '_displayFloorState',
    '_groundSnap',
    '_scratchCarto',
    '_models',
    'lifetime',
  ]) {
    assert.notEqual(first[key], second[key], key);
  }
  assert.notEqual(first.records.data, second.records.data);
  assert.notEqual(first.records.missingPolls, second.records.missingPolls);
  assert.notEqual(first.records.geoidNCache, second.records.geoidNCache);
  assert.notEqual(
    first.feed._activeUpdateControllers,
    second.feed._activeUpdateControllers,
  );
});

test('aborted enrichment cannot write into a later lifecycle or decrement its active count', async () => {
  let resolve;
  let signal;
  const source = {
    getEnrichment(query, options) {
      signal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  const flightState = createFlightState({ source, services: services() });
  const enrichment = createEnrichment({
    flightState,
    services: enrichServices(),
    parts: {},
  });
  let writes = 0;
  enrichment._enqueueEnrich(
    'test',
    { kind: 'type', id: 'abc123' },
    () => writes++,
  );
  await Promise.resolve();
  assert.equal(flightState._enrichActive, 1);
  flightState.lifetime.abort();
  flightState.lifetime = new AbortController();
  flightState._enrichActive = 0;
  resolve({ found: true });
  await new Promise((done) => setImmediate(done));
  assert.equal(signal.aborted, true);
  assert.equal(writes, 0);
  assert.equal(flightState._enrichActive, 0);
});

test('a synchronous enrichment failure stays bounded and releases its slot', async () => {
  const flightState = createFlightState({
    services: services(),
    source: {
      getEnrichment() {
        throw new Error('fixture failure');
      },
    },
  });
  const enrichment = createEnrichment({
    flightState,
    services: enrichServices(),
    parts: {},
  });
  assert.doesNotThrow(() =>
    enrichment._enqueueEnrich('test', {}, () => assert.fail()),
  );
  await new Promise((done) => setImmediate(done));
  assert.equal(flightState._enrichActive, 0);
});

test('voice context reads a track that rounds to north as 0°, not 360°', () => {
  const tracking = createTracking({
    flightState: {
      feed: { _lastSource: 'Fixture aircraft' },
      records: { data: new Map() },
    },
    services: services(),
    parts: {
      queries: {
        _describeFlight: () => ({ track: 359.6, altitudeM: 9000 }),
        _contactLabel: () => 'AAL1',
      },
    },
    layer: {},
  });
  assert.equal(
    tracking._contextSubjectMetadata('abc123').properties.heading,
    '0°',
  );
});

test('the tracked plane’s photo is asked once per hex and lands on its record', async () => {
  const queries = [];
  let answer = {
    found: true,
    src: 'https://t.plnspttrs.net/33043/1745410_822dfe330c_280.jpg',
    width: 420,
    height: 280,
    photographer: 'Jan Seler',
    link: 'https://www.planespotters.net/photo/1745410/x?utm_source=api',
  };
  const flightState = createFlightState({
    services: services(),
    source: {
      async getEnrichment(query) {
        queries.push(query);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  });
  const enrichment = createEnrichment({
    flightState,
    services: enrichServices(),
    parts: {},
  });
  flightState.records.data.set('a0f1bb', { callsign: 'AAL1' });
  flightState._trackedIcao = 'a0f1bb';
  flightState._trackedEntity = {};
  enrichment._requestPhotoEnrichment('A0F1BB');
  enrichment._requestPhotoEnrichment('a0f1bb');
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(queries, [{ kind: 'photo', id: 'a0f1bb' }]);
  assert.deepEqual(flightState.records.data.get('a0f1bb').photo, {
    src: answer.src,
    width: 420,
    height: 280,
    photographer: 'Jan Seler',
    link: answer.link,
  });

  // A failure is not asked again within its cool-down.
  answer = new Error('outage');
  flightState.records.data.set('abc123', {});
  enrichment._requestPhotoEnrichment('abc123');
  await new Promise((done) => setTimeout(done, 300));
  enrichment._requestPhotoEnrichment('abc123');
  await new Promise((done) => setImmediate(done));
  assert.equal(queries.length, 2);
  assert.equal(flightState.records.data.get('abc123').photo, undefined);
  enrichment._requestPhotoEnrichment('not-hex');
  assert.equal(queries.length, 2);
  flightState.lifetime.abort();
});

test('a military aircraft or a converted TR-3B is never looked up for a photo', async () => {
  const queries = [];
  const flightState = createFlightState({
    services: services(),
    source: {
      async getEnrichment(query) {
        queries.push(query);
        return { found: false };
      },
    },
  });
  const enrichment = createEnrichment({
    flightState,
    services: enrichServices({ military: ['ae1234'], tr3b: ['a0f1bb'] }),
    parts: {},
  });
  for (const id of ['ae1234', 'a0f1bb']) {
    flightState.records.data.set(id, {});
    enrichment._requestPhotoEnrichment(id);
  }
  enrichment._requestPhotoEnrichment('AE1234');
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(queries, []);
  assert.equal(flightState._enrichSeen.size, 0);
  flightState.lifetime.abort();
});

test('a photo answer in the upstream shape or a server’s cached shape lands checked', async () => {
  const SRC = 'https://t.plnspttrs.net/33043/1745410_822dfe330c_280.jpg';
  const LINK = 'https://www.planespotters.net/photo/1745410/x?utm_source=api';
  const answers = {
    a0f1bb: {
      photos: [
        {
          thumbnail_large: { src: SRC, size: { width: 420, height: 280 } },
          link: LINK,
          photographer: 'Jan Seler',
        },
      ],
    },
    abc123: {
      found: true,
      thumbnail: { src: SRC, width: 420, height: 280 },
      photographer: 'Jan Seler',
      link: LINK,
    },
    def456: {
      found: true,
      thumbnail: { src: 'https://evil.example/a.jpg', width: 1, height: 1 },
      photographer: 'Jan Seler',
      link: LINK,
    },
    fed789: { photos: [] },
  };
  const flightState = createFlightState({
    services: services(),
    source: { getEnrichment: async ({ id }) => answers[id] },
  });
  const enrichment = createEnrichment({
    flightState,
    services: enrichServices(),
    parts: {},
  });
  const ids = Object.keys(answers);
  for (const id of ids) flightState.records.data.set(id, {});
  for (const id of ids) {
    enrichment._requestPhotoEnrichment(id);
    // One dispatch per drip gap.
    await new Promise((done) => setTimeout(done, 250));
  }
  const photo = {
    src: SRC,
    width: 420,
    height: 280,
    photographer: 'Jan Seler',
    link: LINK,
  };
  assert.deepEqual(flightState.records.data.get('a0f1bb').photo, photo);
  assert.deepEqual(flightState.records.data.get('abc123').photo, photo);
  assert.equal(flightState.records.data.get('def456').photo, undefined);
  assert.equal(flightState.records.data.get('fed789').photo, undefined);
  flightState.lifetime.abort();
});

/** An enrichment queue over `answer(query)` with a hand-driven clock. */
function enrichmentClock(t, answer) {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const queries = [];
  const flightState = createFlightState({
    services: services(),
    source: {
      getEnrichment(query) {
        queries.push(query.id);
        return answer(query);
      },
    },
  });
  const enrichment = createEnrichment({
    flightState,
    services: enrichServices(),
    parts: { tracking: { _updateTrackedLabelModel() {} } },
  });
  const settle = () => new Promise((done) => setImmediate(done));
  const advance = (ms) => {
    now += ms;
  };
  return { flightState, enrichment, queries, settle, advance };
}

test('a failed lookup is asked again only after its cool-down', async (t) => {
  let fail = true;
  const { flightState, enrichment, queries, settle, advance } = enrichmentClock(
    t,
    async () => {
      if (fail) throw new Error('503');
      return { found: true, typeCode: 'A321' };
    },
  );
  flightState.records.data.set('a0f1bb', {});
  enrichment._requestTypeEnrichment('a0f1bb');
  await settle();
  assert.deepEqual(queries, ['a0f1bb']);
  advance(59_000);
  enrichment._requestTypeEnrichment('a0f1bb');
  await settle();
  assert.deepEqual(queries, ['a0f1bb'], 'not within the cool-down');
  fail = false;
  advance(1_000);
  enrichment._requestTypeEnrichment('a0f1bb');
  await settle();
  assert.deepEqual(queries, ['a0f1bb', 'a0f1bb'], 'asked again after it');
  assert.equal(flightState.records.data.get('a0f1bb').typeCode, 'A321');
  advance(120_000);
  enrichment._requestTypeEnrichment('a0f1bb');
  await settle();
  assert.equal(queries.length, 2, 'an answer is final');
  assert.equal(flightState._enrichActive, 0);
  flightState.lifetime.abort();
});

test('a synchronous source failure cools down like a rejected one', async (t) => {
  const { flightState, enrichment, queries, settle, advance } = enrichmentClock(
    t,
    () => {
      throw new Error('boom');
    },
  );
  enrichment._requestPhotoEnrichment('a0f1bb');
  await settle();
  advance(60_000);
  enrichment._requestPhotoEnrichment('a0f1bb');
  await settle();
  assert.deepEqual(queries, ['a0f1bb', 'a0f1bb']);
  flightState.lifetime.abort();
});

test('a "not found" answer is never asked again', async (t) => {
  const { flightState, enrichment, queries, settle, advance } = enrichmentClock(
    t,
    async ({ kind }) => (kind === 'photo' ? { photos: [] } : { found: false }),
  );
  enrichment._requestTypeEnrichment('a0f1bb');
  await settle();
  advance(1_000); // past the dispatch drip
  enrichment._requestPhotoEnrichment('a0f1bb');
  await settle();
  assert.equal(queries.length, 2);
  advance(3_600_000);
  enrichment._requestTypeEnrichment('a0f1bb');
  enrichment._requestPhotoEnrichment('a0f1bb');
  await settle();
  assert.equal(queries.length, 2);
  assert.equal(flightState._enrichRetryAfter.size, 0);
  flightState.lifetime.abort();
});

test('a lookup cut off by the layer’s teardown schedules no retry', async (t) => {
  let release;
  const { flightState, enrichment, settle } = enrichmentClock(
    t,
    (query) =>
      new Promise((_resolve, reject) => {
        release = () => reject(new DOMException('aborted', 'AbortError'));
      }),
  );
  enrichment._requestTypeEnrichment('a0f1bb');
  await settle();
  flightState.lifetime.abort();
  release();
  await settle();
  assert.equal(flightState._enrichRetryAfter.size, 0);
  assert.equal(flightState._enrichSeen.has('t:a0f1bb'), true);
});

test('a permanent refusal is final; a timeout, rate limit, outage or authorization refusal cools down', async (t) => {
  const errors = {
    aaaaa1: new LiveSourceError('denied', 'adsbdb HTTP 404', { status: 404 }),
    aaaaa2: new LiveSourceError('unsupported', 'Enrichment unavailable'),
    aaaaa3: new LiveSourceError('limited', 'adsbdb rate limited', {
      status: 429,
    }),
    aaaaa4: new LiveSourceError('unavailable', 'adsbdb HTTP 503', {
      status: 503,
    }),
    aaaaa5: new LiveSourceError('unavailable', 'adsbdb HTTP 408', {
      status: 408,
    }),
    aaaaa6: new Error('network'),
    aaaaa7: new LiveSourceError('denied', 'Unauthorized', { status: 401 }),
    aaaaa8: new LiveSourceError('denied', 'Forbidden', { status: 403 }),
  };
  const { flightState, enrichment, queries, settle, advance } = enrichmentClock(
    t,
    async ({ id }) => {
      throw errors[id];
    },
  );
  const ids = Object.keys(errors);
  for (const id of ids) {
    enrichment._requestTypeEnrichment(id);
    await settle();
    advance(1_000); // past the dispatch drip
  }
  assert.deepEqual(queries, ids);
  advance(60_000);
  for (const id of ids) {
    enrichment._requestTypeEnrichment(id);
    await settle();
    advance(1_000);
  }
  assert.deepEqual(
    queries.slice(ids.length),
    ['aaaaa3', 'aaaaa4', 'aaaaa5', 'aaaaa6', 'aaaaa7', 'aaaaa8'],
    'a 404 and an unsupported lookup are never asked again',
  );
  assert.equal(flightState._enrichSeen.has('t:aaaaa1'), true);
  assert.equal(flightState._enrichRetryAfter.has('t:aaaaa1'), false);
  flightState.lifetime.abort();
});

test('a route answer for a callsign the plane no longer flies is dropped', async (t) => {
  const pending = [];
  const { flightState, enrichment, settle, advance } = enrichmentClock(
    t,
    (query) => new Promise((resolve) => pending.push({ query, resolve })),
  );
  const meta = { callsign: 'UAL9' };
  flightState.records.data.set('a0f1bb', meta);
  enrichment._requestRouteEnrichment('a0f1bb');
  await settle();
  meta.callsign = 'UAL10'; // the next poll's callsign
  advance(1_000);
  enrichment._requestRouteEnrichment('a0f1bb');
  await settle();
  assert.deepEqual(
    pending.map(({ query }) => query.id),
    ['UAL9', 'UAL10'],
  );
  const route = (code) => ({
    found: true,
    airline: `${code} Air`,
    origin: { code: `${code}O` },
    destination: { code: `${code}D` },
  });
  pending[0].resolve(route('OLD'));
  await settle();
  assert.equal(meta.route, undefined, 'the late UAL9 answer is ignored');
  assert.equal(meta.airline, undefined);
  pending[1].resolve(route('NEW'));
  await settle();
  assert.deepEqual(meta.route, {
    origin: { code: 'NEWO' },
    destination: { code: 'NEWD' },
  });
  assert.equal(meta.routeCallsign, 'UAL10');
  flightState.lifetime.abort();
});
