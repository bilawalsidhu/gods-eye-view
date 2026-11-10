// Area handles: the session store and the resolution ladder (bundled Natural
// Earth regions → bundled countries and states → the annotation outline
// ladder), with every rung mocked. Pins the clarification contract for
// ambiguous names and the fast cached path.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAreaStore, summarizeArea } from './areaStore.js';
import {
  AREA_CANDIDATE_ID_PATTERN,
  createAreaResolver,
  distinctAdminPlaces,
  isAreaCandidateId,
  MAX_AREA_CANDIDATE_ID_LENGTH,
  splitLevelWord,
} from './areaResolver.js';
import { pointInPreparedArea } from './areaGeometry.js';
import { findAdminCandidates } from './adminBoundaries.js';

const square = (w, s, e, n) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

const admin = (kind, name, country, box, extra = {}) => ({
  kind,
  name,
  country,
  source: 'natural-earth',
  polygons: [[square(...box)]],
  ...extra,
});
const GEORGIA_COUNTRY = admin(
  'country',
  'Georgia',
  'Georgia',
  [40, 41, 46.7, 43.6],
);
const GEORGIA_STATE = admin(
  'state',
  'Georgia',
  'United States of America',
  [-85.6, 30.4, -80.8, 35],
);
const PUNJAB_IN = admin('state', 'Punjab', 'India', [73.8, 29.5, 77, 32.5]);
const PUNJAB_PK = admin('state', 'Punjab', 'Pakistan', [69.3, 27.7, 73.7, 34]);
const TEXAS = admin(
  'state',
  'Texas',
  'United States of America',
  [-106, 26, -94, 36],
);

const BAGMATI = {
  ok: true,
  name: 'Bagmati Province',
  polygons: [[square(84.4, 26.9, 86.6, 28.4), square(85.3, 27.6, 85.4, 27.7)]],
  source: 'osm',
  rung: 'nominatim',
  adminName: 'Bagmati Province',
};

function makeResolver(overrides = {}) {
  const store = createAreaStore();
  const calls = { outline: [], natural: 0, admin: 0 };
  const resolver = createAreaResolver({
    store,
    findNaturalRegion: async (q) => {
      calls.natural += 1;
      return /alps/i.test(q)
        ? {
            name: 'Alps',
            kind: 'natural',
            polygons: [square(5, 44, 16, 48), square(17, 44, 18, 45)],
          }
        : null;
    },
    findAdminCandidates: async (q) => {
      calls.admin += 1;
      if (/^georgia$/i.test(q)) return [GEORGIA_STATE, GEORGIA_COUNTRY];
      if (/^georgia, united states/i.test(q)) return [GEORGIA_STATE];
      if (/^punjab$/i.test(q)) return [PUNJAB_PK, PUNJAB_IN];
      if (/^punjab, pakistan/i.test(q)) return [PUNJAB_PK];
      if (/^texas$/i.test(q)) return [TEXAS];
      return [];
    },
    resolveNamedOutline: async (q, options) => {
      calls.outline.push({ q, ...options, signal: undefined });
      if (/bagmati/i.test(q)) return BAGMATI;
      return {
        ok: false,
        code: 'AREA_NOT_FOUND',
        error: `No boundary found for "${q}".`,
      };
    },
    ...overrides,
  });
  return { store, resolver, calls };
}

test('the store keeps geometry local and summarizes without coordinates', () => {
  const store = createAreaStore({ maxEntries: 2 });
  const a = store.put({
    geometry: [[square(0, 0, 1, 1)]],
    name: 'A',
    source: 'drawn',
    level: 'drawn',
  });
  const b = store.put({
    geometry: [[square(2, 2, 3, 3)]],
    name: 'B',
    source: 'us-census',
    sourceId: 'place:1',
  });
  assert.equal(b.areaId, 'place:1');
  assert.equal(b.source, 'us-census');
  store.get(a.areaId); // A is now the most recently used
  store.put({ geometry: [[square(4, 4, 5, 5)]], name: 'C', source: 'osm' });
  assert.equal(store.has('place:1'), false, 'least recently used evicted');
  assert.ok(store.get(a.areaId));
  const summary = summarizeArea(a);
  assert.deepEqual(
    Object.keys(summary).sort(),
    [
      'areaId',
      'areaKm2',
      'bbox',
      'holes',
      'level',
      'name',
      'parts',
      'source',
    ].sort(),
  );
  assert.equal(JSON.stringify(summary).includes('geometry'), false);
  assert.equal(
    store.put({
      geometry: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
      name: 'bad',
    }),
    null,
  );
});

test('query aliases have their own LRU bound even for one stable area', () => {
  const store = createAreaStore({ maxEntries: 2, maxQueryEntries: 3 });
  const area = store.put({
    geometry: [[square(0, 0, 1, 1)]],
    name: 'Stable',
    source: 'osm',
    sourceId: 'osm:stable',
  });
  for (let i = 0; i < 50; i += 1)
    store.rememberQuery(`alias-${i}`, area.areaId);
  assert.equal(store.recallQuery('alias-0'), null, 'old aliases are evicted');
  assert.equal(store.recallQuery('alias-46'), null, 'the bound is independent');
  assert.equal(store.recallQuery('alias-47')?.areaId, area.areaId);
  assert.equal(store.recallQuery('alias-49')?.areaId, area.areaId);
  assert.equal(store.size, 1, 'alias churn does not evict the area record');
});

test('a stable source keeps one handle when stored again', () => {
  const store = createAreaStore();
  for (let i = 0; i < 2; i += 1)
    store.put({
      geometry: [[square(0, 0, 1, 1)]],
      name: 'X',
      source: 'natural-earth',
      sourceId: 'ne:state:x',
    });
  assert.equal(store.size, 1);
});

test('a named natural region resolves offline with every part', async () => {
  const { resolver, calls } = makeResolver();
  const result = await resolver.resolve({ query: 'the Alps' });
  assert.equal(result.ok, true);
  assert.equal(result.record.source, 'natural-earth');
  assert.equal(result.record.parts, 2);
  assert.equal(calls.outline.length, 0, 'no lookup');
  assert.ok(result.ms < 300);
});

test('a bundled state resolves by name with no lookup', async () => {
  const { resolver, calls } = makeResolver();
  const result = await resolver.resolve({ query: 'Texas' });
  assert.equal(result.ok, true);
  assert.equal(result.rung, 'bundled');
  assert.equal(result.record.level, 'admin1');
  assert.equal(result.record.source, 'natural-earth');
  assert.equal(result.record.meta.country, 'United States of America');
  assert.equal(calls.outline.length, 0);
});

test('Bagmati goes to the outline ladder and keeps its hole', async () => {
  const { resolver, calls } = makeResolver();
  const result = await resolver.resolve({ query: 'Bagmati province' });
  assert.equal(result.ok, true);
  assert.equal(result.rung, 'nominatim');
  assert.equal(result.record.source, 'osm');
  assert.equal(result.record.level, 'admin1', 'the level word is kept');
  assert.equal(result.record.holes, 1);
  assert.equal(pointInPreparedArea(result.record.prepared, 27.2, 85), true);
  assert.equal(
    pointInPreparedArea(result.record.prepared, 27.65, 85.35),
    false,
    'inside the hole',
  );
  assert.equal(calls.outline[0].levelHint, 'admin1');
});

test('a legacy bundled zone is never stored as the requested current province', async () => {
  const legacy = admin(
    'state',
    'Bagmati Zone',
    'Nepal',
    [84.645, 27.357, 86.055, 28.335],
  );
  const { store, resolver } = makeResolver({
    findAdminCandidates: async () => [legacy],
  });
  const result = await resolver.resolve({ query: 'Bagmati province' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AREA_IDENTITY_UNVERIFIED');
  assert.equal(result.record, undefined);
  assert.equal(store.size, 0);
  const repeated = await resolver.resolve({ query: 'Bagmati province' });
  assert.equal(repeated.code, 'AREA_IDENTITY_UNVERIFIED');
  assert.equal(repeated.cached, false);
  assert.equal(store.size, 0);
});

test('legacy zone identity cannot escape through view choice or candidate memory', async () => {
  const nepal = admin(
    'state',
    'Bagmati Zone',
    'Nepal',
    [84.645, 27.357, 86.055, 28.335],
  );
  const namesake = admin(
    'state',
    'Bagmati Zone',
    'Elsewhere',
    [10, 10, 11, 11],
  );
  const { store, resolver } = makeResolver({
    findAdminCandidates: async () => [nepal, namesake],
    viewCenter: () => ({ lat: 27.7, lon: 85.3 }),
  });
  const result = await resolver.resolve({ query: 'Bagmati province' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AREA_IDENTITY_UNVERIFIED');
  assert.equal(result.needsClarification, undefined);
  assert.equal(result.candidates, undefined);
  assert.equal(store.size, 0);
  assert.equal(
    (await resolver.resolve({ candidateId: 'ne:state:nepal-bagmati-zone' }))
      .code,
    'UNKNOWN_CANDIDATE',
  );
  assert.equal(store.size, 0);
});

test('a repeat is answered from the store without a lookup', async () => {
  const { resolver, calls } = makeResolver();
  await resolver.resolve({ query: 'Bagmati' });
  const again = await resolver.resolve({ query: 'bagmati' });
  assert.equal(again.ok, true);
  assert.equal(again.cached, true);
  assert.equal(calls.outline.length, 1);
});

test('an ambiguous name asks instead of guessing, and the choice resolves', async () => {
  const { resolver, calls } = makeResolver();
  const result = await resolver.resolve({ query: 'Georgia' });
  assert.equal(result.ok, false);
  assert.equal(result.needsClarification, true);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0], {
    candidateId: 'ne:state:united-states-of-america-georgia',
    name: 'Georgia',
    level: 'admin1',
    country: 'United States of America',
  });
  assert.equal(result.candidates[1].level, 'country');
  assert.equal(calls.outline.length, 0, 'no lookup spent on a question');
  const chosen = await resolver.resolve({
    candidateId: result.candidates[0].candidateId,
  });
  assert.equal(chosen.ok, true);
  assert.equal(chosen.record.meta.country, 'United States of America');
});

test('an already-aborted clarification choice does not persist page state', async () => {
  const { store, resolver } = makeResolver();
  const result = await resolver.resolve({ query: 'Georgia' });
  const controller = new AbortController();
  controller.abort();
  const chosen = await resolver.resolve(
    { candidateId: result.candidates[0].candidateId },
    { signal: controller.signal },
  );
  assert.equal(chosen.code, 'CANCELLED');
  assert.equal(chosen.cancelled, true);
  assert.equal(store.size, 0);
});

test('candidate IDs accept every emitted choice and reject malformed or oversized input', async () => {
  const { store, resolver } = makeResolver();
  const result = await resolver.resolve({ query: 'Georgia' });
  const grammar = new RegExp(AREA_CANDIDATE_ID_PATTERN, 'u');
  for (const choice of result.candidates) {
    assert.ok(choice.candidateId.length <= MAX_AREA_CANDIDATE_ID_LENGTH);
    assert.match(choice.candidateId, grammar);
    assert.equal(isAreaCandidateId(choice.candidateId), true);
    assert.equal(
      (await resolver.resolve({ candidateId: choice.candidateId })).ok,
      true,
    );
  }
  assert.equal(result.candidates[0].candidateId.length, 41);

  store.put({
    geometry: [[square(0, 0, 1, 1)]],
    name: 'Not a candidate',
    source: 'osm',
    sourceId: 'area-1',
  });
  for (const bad of [
    'area-1',
    'ne:state:bad slug',
    'ne:state:../../etc',
    'ne:state:!!!',
    'ne:state:a_b',
    'ne:planet:earth',
    `ne:state:${'a'.repeat(MAX_AREA_CANDIDATE_ID_LENGTH)}`,
  ]) {
    const rejected = await resolver.resolve({ candidateId: bad });
    assert.equal(rejected.code, 'BAD_CANDIDATE');
  }
});

test('long bundled names produce bounded, distinct candidate handles', async () => {
  const name = 'A'.repeat(70);
  const candidates = [
    admin('state', name, `B${'b'.repeat(70)}`, [0, 0, 1, 1]),
    admin('state', name, `C${'c'.repeat(70)}`, [2, 2, 3, 3]),
  ];
  const { resolver } = makeResolver({
    findAdminCandidates: async () => candidates,
  });
  const result = await resolver.resolve({ query: name });
  assert.equal(result.needsClarification, true);
  assert.equal(
    new Set(result.candidates.map((choice) => choice.candidateId)).size,
    2,
  );
  for (const choice of result.candidates) {
    assert.equal(isAreaCandidateId(choice.candidateId), true);
    assert.ok(choice.candidateId.length <= MAX_AREA_CANDIDATE_ID_LENGTH);
    assert.equal(
      (await resolver.resolve({ candidateId: choice.candidateId })).ok,
      true,
    );
  }
});

test('within or level settles an ambiguous name', async () => {
  const { resolver } = makeResolver();
  const state = await resolver.resolve({
    query: 'Georgia',
    within: 'United States',
  });
  assert.equal(state.ok, true);
  assert.equal(state.record.level, 'admin1');
  const country = await resolver.resolve({
    query: 'Georgia',
    level: 'country',
  });
  assert.equal(country.ok, true);
  assert.equal(country.record.level, 'country');
  const both = await resolver.resolve({ query: 'Punjab', level: 'admin1' });
  assert.equal(both.needsClarification, true, 'both Punjabs are admin1');
  const pk = await resolver.resolve({ query: 'Punjab', within: 'Pakistan' });
  assert.equal(pk.record.meta.country, 'Pakistan');
});

test('the view settles an ambiguous name only when it is inside one of them', async () => {
  const { resolver } = makeResolver({
    viewCenter: () => ({ lat: 31, lon: 75.5 }),
  });
  const result = await resolver.resolve({ query: 'Punjab' });
  assert.equal(result.ok, true);
  assert.equal(result.record.meta.country, 'India');
  const away = makeResolver({ viewCenter: () => ({ lat: 0, lon: 0 }) });
  const asked = await away.resolver.resolve({ query: 'Punjab' });
  assert.equal(asked.needsClarification, true);
  // A choice the view made is not remembered for the name.
  let view = { lat: 31, lon: 75.5 };
  const moving = makeResolver({ viewCenter: () => view });
  await moving.resolver.resolve({ query: 'Punjab' });
  view = { lat: 31, lon: 71 };
  const again = await moving.resolver.resolve({ query: 'Punjab' });
  assert.equal(again.record.meta.country, 'Pakistan');
});

test('a qualifier skips the natural-region pack, which cannot check it', async () => {
  const { resolver, calls } = makeResolver();
  await resolver.resolve({ query: 'the Alps', within: 'Austria' });
  assert.equal(calls.natural, 0);
  assert.equal(calls.outline.length, 1);
});

test('the area just stored survives eviction even when every other area is pinned', () => {
  const store = createAreaStore({ maxEntries: 2, isPinned: () => true });
  for (let i = 0; i < 3; i += 1)
    store.put({
      geometry: [[square(i, 0, i + 0.5, 0.5)]],
      name: `A${i}`,
      source: 'drawn',
    });
  const last = store.put({
    geometry: [[square(9, 0, 9.5, 0.5)]],
    name: 'new',
    source: 'drawn',
  });
  assert.ok(store.get(last.areaId), 'the new handle is usable');
});

test('a country stands for its same-named state; namesakes abroad are rivals', () => {
  const mexico = admin('country', 'Mexico', 'Mexico', [-118, 14, -86, 33]);
  const state = admin(
    'state',
    'State of Mexico',
    'Mexico',
    [-100, 18, -98, 20],
  );
  assert.deepEqual(distinctAdminPlaces([state, mexico]), [mexico]);
  assert.equal(distinctAdminPlaces([PUNJAB_IN, PUNJAB_PK]).length, 2);
});

test('bundled candidates: shared prominent names list every unit, minor ones none', async () => {
  const names = async (q) =>
    (await findAdminCandidates(q)).map((a) => `${a.kind}:${a.country}`);
  assert.deepEqual((await names('Punjab')).sort(), [
    'state:India',
    'state:Pakistan',
  ]);
  assert.deepEqual((await names('Georgia')).sort(), [
    'country:Georgia',
    'state:United States of America',
  ]);
  assert.deepEqual(await names('Punjab, India'), ['state:India']);
  assert.deepEqual(await names('Kent'), [], 'minor units are the geocoder’s');
});

test('an outline ladder refusal passes through with its code', async () => {
  const { resolver } = makeResolver();
  const miss = await resolver.resolve({ query: 'Nowhere Province' });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, 'AREA_NOT_FOUND');
  const down = makeResolver({
    resolveNamedOutline: async () => ({
      ok: false,
      code: 'AREA_UNAVAILABLE',
      error: 'No outline source can trace it here.',
    }),
  });
  const failed = await down.resolver.resolve({ query: 'Kathmandu' });
  assert.equal(failed.code, 'AREA_UNAVAILABLE');
});

test('an approximate outline is stored and labelled as such', async () => {
  const { resolver } = makeResolver({
    resolveNamedOutline: async () => ({
      ok: true,
      name: 'Mission',
      polygons: [[square(0, 0, 0.01, 0.01)]],
      source: 'osm',
      rung: 'overpass',
      approximate: true,
      basis: 'buffer sized to the place',
    }),
  });
  const result = await resolver.resolve({ query: 'the Mission' });
  assert.equal(result.record.approximate, true);
  assert.equal(result.record.source, 'approximate');
  assert.equal(result.record.meta.basis, 'buffer sized to the place');
});

test('a slow lookup times out but keeps filling the cache', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { resolver } = makeResolver({
    resolveNamedOutline: async () => {
      await gate;
      return BAGMATI;
    },
  });
  const first = await resolver.resolve({ query: 'Bagmati' }, { budgetMs: 20 });
  assert.equal(first.code, 'AREA_TIMEOUT');
  release();
  await new Promise((r) => setTimeout(r, 10));
  const second = await resolver.resolve({ query: 'Bagmati' }, { budgetMs: 20 });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
});

test('a cancelled caller returns at once without cancelling the shared lookup', async () => {
  const { resolver } = makeResolver();
  const controller = new AbortController();
  controller.abort();
  const result = await resolver.resolve(
    { query: 'Bagmati' },
    { signal: controller.signal },
  );
  assert.equal(result.code, 'CANCELLED');
  await new Promise((r) => setTimeout(r, 5));
  const again = await resolver.resolve({ query: 'Bagmati' });
  assert.equal(again.ok, true);
});

test('distinct area lookups are hard-bounded while same-key callers still coalesce', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { resolver } = makeResolver({
    maxInFlight: 1,
    resolveNamedOutline: async (query) => {
      calls += 1;
      await gate;
      return { ...BAGMATI, name: query };
    },
  });
  const first = resolver.resolve({ query: 'First Area' });
  const joined = resolver.resolve({ query: 'First Area' });
  const refused = await resolver.resolve({ query: 'Second Area' });
  assert.equal(refused.code, 'AREA_BUSY');
  release();
  const [a, b] = await Promise.all([first, joined]);
  assert.equal(calls, 1, 'the same key shares the one live provider lookup');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test("settled lookups leave no listener on the caller's signal", async () => {
  const { resolver } = makeResolver();
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {
    if (args[0] === 'abort') added += 1;
    return add(...args);
  };
  controller.signal.removeEventListener = (...args) => {
    if (args[0] === 'abort') removed += 1;
    return remove(...args);
  };
  for (const query of ['Texas', 'Bagmati', 'Nowhere at all'])
    await resolver.resolve({ query }, { signal: controller.signal });
  assert.ok(added > 0, 'the lookups listened while running');
  assert.equal(removed, added, 'every listener is detached once settled');

  const aborted = AbortSignal.abort();
  let attached = 0;
  aborted.addEventListener = () => {
    attached += 1;
  };
  const late = await resolver.resolve(
    { query: 'Punjab, Pakistan' },
    { signal: aborted },
  );
  assert.equal(late.code, 'CANCELLED');
  assert.equal(attached, 0, 'an aborted signal gets no listener');
});

test('resolver disposal aborts provider lifetime and prevents late store/cache writes', async () => {
  let release;
  let providerSignal;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { resolver, store } = makeResolver({
    resolveNamedOutline: async (_query, { signal }) => {
      providerSignal = signal;
      await gate; // Deliberately ignores abort until it returns.
      return BAGMATI;
    },
  });
  const pending = resolver.resolve({ query: 'Late Area' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolver.dispose();
  assert.equal(providerSignal.aborted, true);
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(store.size, 0, 'late provider data never reaches the store');
  const after = await resolver.resolve({ query: 'Late Area' });
  assert.equal(after.code, 'CANCELLED');
});

test('level words map to area levels', () => {
  assert.deepEqual(splitLevelWord('Bagmati Province'), {
    bare: 'bagmati',
    level: 'admin1',
  });
  assert.deepEqual(splitLevelWord('Kathmandu'), {
    bare: 'kathmandu',
    level: null,
  });
});

test('non-Latin names are distinct keys: 東京 then 大阪 looks up both', async () => {
  const asked = [];
  const { resolver } = makeResolver({
    resolveNamedOutline: async (q) => {
      asked.push(q);
      return { ...BAGMATI, name: q };
    },
  });
  const first = await resolver.resolve({ query: '東京' });
  const second = await resolver.resolve({ query: '大阪' });
  assert.notEqual(first.record.areaId, second.record.areaId);
  assert.equal(second.cached, false, 'not the cached Tokyo');
  assert.deepEqual(asked, ['東京', '大阪']);
  // The same name with a different `within` is a different question.
  await resolver.resolve({ query: '東京', within: '日本' });
  assert.equal(asked.length, 3);
  assert.equal((await resolver.resolve({ query: '東京' })).cached, true);
});

test('a name that normalizes to nothing is never cached or shared', async () => {
  let calls = 0;
  const { resolver } = makeResolver({
    resolveNamedOutline: async () => {
      calls += 1;
      return BAGMATI;
    },
  });
  await resolver.resolve({ query: '!!!' });
  await resolver.resolve({ query: '???' });
  assert.equal(calls, 2, 'two punctuation-only asks are two lookups');
});

test('a natural region never hides a country or state of the same name', async () => {
  const desert = {
    name: 'Punjab',
    kind: 'natural',
    polygons: [square(70, 28, 76, 33)],
  };
  const { resolver } = makeResolver({
    findNaturalRegion: async (q) => (/^punjab$/i.test(q) ? desert : null),
  });
  const bare = await resolver.resolve({ query: 'Punjab' });
  assert.equal(bare.ok, false);
  assert.equal(bare.code, 'AMBIGUOUS_AREA', 'the two states are asked about');
  const natural = await resolver.resolve({ query: 'Punjab', level: 'natural' });
  assert.equal(natural.ok, true);
  assert.equal(natural.record.level, 'natural', 'asked for, the region wins');
});

test('same-named states in one country get their own candidate and area', async () => {
  const wa = admin(
    'state',
    'Washington',
    'United States of America',
    [-124, 45.5, -117, 49],
    { regionCode: 'WA' },
  );
  const dc = admin(
    'state',
    'Washington',
    'United States of America',
    [-77.2, 38.8, -76.9, 39],
    { regionCode: 'DC' },
  );
  const { resolver } = makeResolver({
    findAdminCandidates: async (q) => (/^washington$/i.test(q) ? [wa, dc] : []),
  });
  const asked = await resolver.resolve({ query: 'Washington' });
  assert.equal(asked.code, 'AMBIGUOUS_AREA');
  const ids = asked.candidates.map((c) => c.candidateId);
  assert.equal(new Set(ids).size, 2, `distinct ids: ${ids.join(', ')}`);
  assert.deepEqual(
    asked.candidates.map((c) => c.region),
    ['WA', 'DC'],
    'the choices can be told apart',
  );
  const picked = await Promise.all(
    ids.map((candidateId) => resolver.resolve({ candidateId })),
  );
  assert.ok(picked.every((p) => p.ok));
  assert.notEqual(
    picked[0].record.areaId,
    picked[1].record.areaId,
    'two areas, not one overwritten',
  );
  assert.equal(
    pointInPreparedArea(picked[0].record.prepared, 47, -120),
    true,
    'Washington State',
  );
  assert.equal(
    pointInPreparedArea(picked[1].record.prepared, 38.9, -77),
    true,
    'District of Columbia',
  );
});

test('a bundled name mismatch falls through to the outline ladder', async () => {
  const azad = admin('state', 'Azad Kashmir', 'Pakistan', [73, 33, 75, 35.5]);
  const kashmir = {
    ok: true,
    name: 'Kashmir',
    polygons: [[square(73, 32, 80, 37)]],
    source: 'osm',
    rung: 'nominatim',
  };
  let outlineOk = true;
  const { resolver } = makeResolver({
    findAdminCandidates: async (q) => (/^kashmir$/i.test(q) ? [azad] : []),
    resolveNamedOutline: async () =>
      outlineOk
        ? kashmir
        : { ok: false, code: 'AREA_NOT_FOUND', error: 'none' },
  });
  const found = await resolver.resolve({ query: 'Kashmir' });
  assert.equal(found.ok, true, found.error);
  assert.equal(found.record.name, 'Kashmir');
  outlineOk = false;
  const { resolver: offline } = makeResolver({
    findAdminCandidates: async () => [azad],
    resolveNamedOutline: async () => ({
      ok: false,
      code: 'AREA_NOT_FOUND',
      error: 'none',
    }),
  });
  const refused = await offline.resolve({ query: 'Kashmir' });
  assert.equal(
    refused.code,
    'AREA_IDENTITY_MISMATCH',
    'the bundled refusal is kept',
  );
});

test('a view-picked outline answer is not reused for the same name elsewhere', async () => {
  let view = { lat: 39.8, lon: -89.6 }; // Springfield, Illinois
  const springfield = (center) => ({
    ok: true,
    name:
      center.lon < -80 ? 'Springfield, Illinois' : 'Springfield, Massachusetts',
    polygons: [
      [
        square(
          center.lon - 0.1,
          center.lat - 0.1,
          center.lon + 0.1,
          center.lat + 0.1,
        ),
      ],
    ],
    source: 'osm',
    rung: 'nominatim',
  });
  const { resolver } = makeResolver({
    viewCenter: () => view,
    resolveNamedOutline: async () => springfield(view),
  });
  const illinois = await resolver.resolve({ query: 'Springfield' });
  assert.equal(illinois.record.name, 'Springfield, Illinois');
  const again = await resolver.resolve({ query: 'Springfield' });
  assert.equal(again.cached, true, 'the same view still reuses it');
  view = { lat: 42.1, lon: -72.6 }; // Springfield, Massachusetts
  const massachusetts = await resolver.resolve({ query: 'Springfield' });
  assert.equal(massachusetts.cached, false);
  assert.equal(massachusetts.record.name, 'Springfield, Massachusetts');
});

test('a name spoken without accents matches its accented unit, Latin letters only', async () => {
  const quebec = admin('state', 'Québec', 'Canada', [-79.8, 45, -57.1, 62.6]);
  const cordobaAr = admin(
    'state',
    'Córdoba',
    'Argentina',
    [-65.8, -35, -61.8, -29.5],
  );
  const cordobaEs = admin('state', 'Córdoba', 'Spain', [-5.6, 37.2, -4, 38.7]);
  const thai = admin('state', 'ป่าย', 'Thailand', [98, 19, 99, 20]);
  const { resolver } = makeResolver({
    findAdminCandidates: async (q) =>
      /^quebec$/i.test(q)
        ? [quebec]
        : /^cordoba$/i.test(q)
          ? [cordobaAr, cordobaEs]
          : q === 'ปาย'
            ? [thai]
            : [],
  });
  const qc = await resolver.resolve({ query: 'Quebec' });
  assert.equal(qc.ok, true, qc.error);
  assert.equal(qc.record.name, 'Québec');
  const cordoba = await resolver.resolve({ query: 'Cordoba' });
  assert.equal(cordoba.code, 'AMBIGUOUS_AREA', 'both Córdobas are asked about');
  assert.equal(cordoba.candidates.length, 2);
  const tone = await resolver.resolve({ query: 'ปาย' });
  assert.equal(tone.ok, false, 'a Thai tone mark still tells names apart');
});

test('a natural name for two distant places is asked about, and the choice resolves', async () => {
  const azores = {
    name: 'Flores',
    featurecla: 'Island',
    polygons: [square(-31.3, 39.4, -31.1, 39.5)],
    areaKm2: 140,
    center: { lat: 39.45, lon: -31.2 },
  };
  const indonesia = {
    name: 'Flores',
    featurecla: 'Island',
    polygons: [square(119.8, -8.9, 123, -8.1)],
    areaKm2: 14000,
    center: { lat: -8.5, lon: 121.4 },
  };
  const { resolver } = makeResolver({
    findNaturalRegion: async (q) =>
      /^flores$/i.test(q)
        ? {
            name: 'Flores',
            kind: 'natural',
            polygons: indonesia.polygons,
            places: [indonesia, azores],
          }
        : null,
  });
  const asked = await resolver.resolve({ query: 'Flores' });
  assert.equal(asked.code, 'AMBIGUOUS_AREA');
  assert.equal(asked.candidates.length, 2);
  assert.ok(asked.candidates.every((c) => c.level === 'natural' && c.region));
  const picked = await resolver.resolve({
    candidateId: asked.candidates[1].candidateId,
  });
  assert.equal(picked.ok, true, picked.error);
  assert.equal(picked.record.level, 'natural');
  assert.equal(
    pointInPreparedArea(picked.record.prepared, 39.45, -31.2),
    true,
    'the Azores Flores',
  );
});

test('a natural feature in several parts is stored whole', async () => {
  const north = square(33.7, 2.4, 44.2, 15.4);
  const south = square(28.9, -15.6, 35.8, 2.4);
  const { resolver } = makeResolver({
    findNaturalRegion: async (q) =>
      /rift/i.test(q)
        ? {
            name: 'Great Rift Valley',
            kind: 'natural',
            polygons: [north],
            places: [
              {
                name: 'Great Rift Valley',
                featurecla: 'Valley',
                polygons: [north, south],
                areaKm2: 2,
                center: { lat: 0, lon: 36 },
              },
            ],
          }
        : null,
  });
  const rift = await resolver.resolve({ query: 'Great Rift Valley' });
  assert.equal(rift.ok, true);
  assert.equal(
    pointInPreparedArea(rift.record.prepared, -10, 33),
    true,
    'the southern part counts',
  );
});
