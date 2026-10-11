import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftSearchPhrases,
  classifyAircraft,
  commonsThumbnailUrl,
  createAircraftWikidataSource,
  extractAircraftFacts,
  formatAircraftDossier,
  isAircraftEntity,
  normalizeAircraftType,
  summarizeAccidents,
} from './aircraftWikidata.js';

const item = (id) => ({
  mainsnak: { datavalue: { value: { id } } },
  rank: 'normal',
});
const qty = (amount, unit = 'Q11573', qualifiers) => ({
  mainsnak: {
    datavalue: {
      value: {
        amount: `+${amount}`,
        unit: unit === '1' ? '1' : `http://www.wikidata.org/entity/${unit}`,
      },
    },
  },
  rank: 'normal',
  ...(qualifiers ? { qualifiers } : {}),
});
const time = (iso) => ({
  mainsnak: { datavalue: { value: { time: `+${iso}T00:00:00Z` } } },
  rank: 'normal',
});

const A380 = {
  id: 'Q5830',
  labels: { en: { value: 'Airbus A380' } },
  claims: {
    P31: [item('Q15056993')],
    P279: [item('Q100')],
    P176: [item('Q67')],
    P516: [
      {
        ...item('Q9070485'),
        qualifiers: {
          P1114: [{ datavalue: { value: { amount: '+4', unit: '1' } } }],
        },
      },
    ],
    P2050: [qty(79.75)],
    P2043: [qty(72.72)],
    P2067: [qty(575, 'Q191118')],
    P1083: [qty(575, '1'), qty(853, '1')],
    P2217: [qty(903, 'Q180154')],
    P2073: [qty(15200, 'Q828224')],
    P606: [time('2005-04-27')],
    P729: [time('2007-10-25')],
    P1092: [qty(251, '1')],
  },
};

test('normalizeAircraftType trims noise and caps length', () => {
  assert.equal(normalizeAircraftType('  Boeing  737-8AS* '), 'Boeing 737-8AS');
  assert.equal(normalizeAircraftType(null), '');
  assert.equal(normalizeAircraftType('x'.repeat(200)).length, 80);
});

test('aircraftSearchPhrases drops variant suffixes progressively', () => {
  assert.deepEqual(aircraftSearchPhrases('Airbus A321 251NXSL'), [
    'Airbus A321 251NXSL',
    'Airbus A321',
  ]);
  assert.deepEqual(aircraftSearchPhrases('Boeing 737-8AS'), [
    'Boeing 737-8AS',
    'Boeing 737',
  ]);
  assert.deepEqual(aircraftSearchPhrases('B738'), ['B738']);
  assert.equal(aircraftSearchPhrases('A B C D E F').length, 3);
});

test('isAircraftEntity accepts aircraft families and rejects others', () => {
  assert.equal(isAircraftEntity(A380), true);
  assert.equal(
    isAircraftEntity({ claims: { P31: [item('Q3002150')] } }),
    false,
  );
  assert.equal(isAircraftEntity(null), false);
});

test('extractAircraftFacts reads claims, converts units and uses parents for gaps', () => {
  const parent = {
    id: 'Q100',
    claims: {
      P31: [item('Q15056993')],
      P2048: [qty(24.09)],
      P1092: [qty(9999, '1')],
    },
  };
  const facts = extractAircraftFacts(A380, [parent]);
  assert.equal(facts.label, 'Airbus A380');
  assert.deepEqual(facts.engines, [{ id: 'Q9070485', count: 4 }]);
  assert.equal(facts.wingspan.max, 79.75);
  assert.equal(facts.height.max, 24.09, 'height filled from the parent');
  assert.equal(facts.mass.max, 575_000);
  assert.equal(facts.mass.unit, 'kg');
  assert.deepEqual([facts.capacity.min, facts.capacity.max], [575, 853]);
  assert.equal(facts.firstFlight, 2005);
  assert.equal(facts.serviceEntry, 2007);
  assert.equal(facts.serviceRetirement, null);
  assert.equal(facts.produced.max, 251, 'production never inherited');
});

test('formatAircraftDossier produces labelled lines with engines and safety', () => {
  const facts = extractAircraftFacts(A380);
  const lines = formatAircraftDossier(
    facts,
    new Map([
      ['Q67', 'Airbus'],
      ['Q9070485', 'Engine Alliance GP7000'],
    ]),
    { accidents: 0, deaths: 0 },
  );
  const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.value]));
  assert.equal(byLabel.Model, 'Airbus A380');
  assert.equal(byLabel.Maker, 'Airbus');
  assert.equal(byLabel.Engines, '4 × Engine Alliance GP7000');
  assert.equal(byLabel.Wingspan, '79.8 m (262 ft)');
  assert.equal(byLabel['Gross weight'], '575 t (1,267,658 lb)');
  assert.equal(byLabel.Passengers, '575–853');
  assert.equal(byLabel.Cruise, '903 km/h (488 kt)');
  assert.equal(byLabel.Range, '15,200 km (8,207 nmi)');
  assert.equal(byLabel['First flight'], '2005');
  assert.equal(byLabel['In service'], '2007 – present');
  assert.equal(byLabel.Built, '251');
  assert.equal(byLabel.Safety, 'No fatal accidents linked on Wikidata');
  assert.equal(byLabel.Height, undefined, 'missing facts are omitted');
});

test('classifyAircraft maps Wikidata class labels to broad categories', () => {
  const kind = (...labels) => classifyAircraft(labels);
  assert.deepEqual(
    kind('wide-body airliner with 2 jet engines', 'commercial aviation'),
    {
      category: 'Commercial airliner',
      detail: 'wide-body airliner with 2 jet engines',
    },
  );
  assert.deepEqual(kind('helicopter', 'utility helicopter'), {
    category: 'Helicopter',
    detail: 'utility helicopter',
  });
  assert.equal(
    kind('utility helicopter', 'military aviation').category,
    'Military helicopter',
  );
  assert.equal(
    kind('twin-turboprop airliner', 'regional airliner').category,
    'Regional airliner',
  );
  assert.deepEqual(kind('fourth-generation fighter', 'interceptor'), {
    category: 'Military aircraft',
    detail: 'fourth-generation fighter',
  });
  assert.equal(
    kind('double-deck aircraft', 'airliner', 'cargo aircraft').detail,
    null,
    'redundant detail is dropped',
  );
  assert.equal(kind('business jet').category, 'Business aircraft');
  assert.equal(
    kind('land-based utility aircraft', 'monoplane').category,
    'Light / utility aircraft',
  );
  assert.deepEqual(kind('flying boat'), {
    category: 'Flying boat',
    detail: null,
  });
  assert.equal(classifyAircraft([null]), null);
});

test('type and class come from P279/P366, including the parent family', () => {
  const variant = {
    id: 'Q3278675',
    labels: { en: { value: 'Airbus A321' } },
    claims: {
      P31: [item('Q15056993')],
      P279: [item('Q6475')],
      P366: [item('Q210932')],
    },
  };
  const family = {
    id: 'Q6475',
    claims: { P31: [item('Q15056993')], P279: [item('Q842262')] },
  };
  const facts = extractAircraftFacts(variant, [family]);
  assert.deepEqual(facts.classes, ['Q210932', 'Q842262']);
  const lines = formatAircraftDossier(
    facts,
    new Map([
      ['Q210932', 'airliner'],
      ['Q842262', 'narrow-body airliner'],
    ]),
  );
  assert.deepEqual(lines.slice(0, 3), [
    { label: 'Model', value: 'Airbus A321' },
    { label: 'Type', value: 'Commercial airliner' },
    { label: 'Class', value: 'narrow-body airliner' },
  ]);
});

test('photo, origin, designation and operators are read and formatted', () => {
  const entity = {
    id: 'Q182027',
    labels: { en: { value: 'Lockheed C-130 Hercules' } },
    claims: {
      P31: [item('Q15056993')],
      P18: [
        {
          mainsnak: { datavalue: { value: 'C-130 Hercules.jpg' } },
          rank: 'normal',
        },
      ],
      P495: [item('Q30')],
      P798: [
        { mainsnak: { datavalue: { value: 'C-130' } }, rank: 'normal' },
        { mainsnak: { datavalue: { value: 'C-130' } }, rank: 'normal' },
        { mainsnak: { datavalue: { value: 'EC-130' } }, rank: 'normal' },
      ],
      P137: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'].map(item),
    },
  };
  const facts = extractAircraftFacts(entity);
  assert.equal(facts.image, 'C-130 Hercules.jpg');
  const labels = new Map([
    ['Q30', 'United States'],
    ['Q1', 'USAF'],
    ['Q2', 'RAF'],
    ['Q3', 'RAAF'],
    ['Q4', 'RCAF'],
  ]);
  const byLabel = Object.fromEntries(
    formatAircraftDossier(facts, labels).map((l) => [l.label, l.value]),
  );
  assert.equal(byLabel.Origin, 'United States');
  assert.equal(byLabel.Designation, 'C-130, EC-130');
  assert.equal(byLabel.Operators, 'USAF, RAF, RAAF, RCAF +2 more');
  assert.equal(
    commonsThumbnailUrl('File:C-130 Hercules.jpg'),
    'https://commons.wikimedia.org/wiki/Special:FilePath/C-130_Hercules.jpg?width=320',
  );
  assert.equal(commonsThumbnailUrl(''), null);
});

test('speeds and weights are split by role qualifiers and units', () => {
  const role = (id, qualifier = 'P3831') => ({
    [qualifier]: [{ datavalue: { value: { id } } }],
  });
  const facts = extractAircraftFacts({
    id: 'Q1',
    labels: { en: { value: 'Test jet' } },
    claims: {
      P31: [item('Q15056993')],
      P2052: [
        qty(2, 'Q160669'),
        qty(1.2, 'Q160669'),
        qty(2120, 'Q180154', role('Q11830539')),
        qty(419, 'Q128822', role('Q11830531', 'P1013')),
        qty(361, 'Q128822', role('Q2063640')),
        qty(1970, 'Q22673229', role('Q1141401')),
      ],
      P2067: [
        qty(16900, 'Q11570', role('Q6753082')),
        qty(61000, 'Q11570', role('Q938476')),
        qty(61, 'Q11570', role('Q938476')),
        qty(55000, 'Q11570'),
      ],
      P4519: [qty(20000, 'Q11570'), qty(7000, 'Q11570', role('Q113189684'))],
      P6510: [qty(185, 'Q180154')],
      P2112: [qty(1320, 'Q857027')],
      P2109: [qty(1600, 'Q2276380')],
    },
  });
  const byLabel = Object.fromEntries(
    formatAircraftDossier(facts).map((l) => [l.label, l.value]),
  );
  assert.equal(byLabel['Max speed'], '2,120 km/h (1,145 kt) · Mach 1.2–2');
  assert.equal(byLabel['Never exceed'], '776 km/h (419 kt)');
  assert.equal(byLabel.Cruise, '669 km/h (361 kt)');
  assert.equal(byLabel['Stall speed'], '185 km/h (100 kt)');
  assert.equal(byLabel['Climb rate'], '10.0 m/s (1,970 ft/min)');
  assert.equal(byLabel['Gross weight'], '61.0 t (134,482 lb)', 'MTOW wins');
  assert.equal(byLabel['Empty weight'], '16.9 t (37,258 lb)');
  assert.equal(byLabel.Payload, '20.0 t (44,092 lb)');
  assert.equal(byLabel['Bomb load'], '7.0 t (15,432 lb)');
  assert.equal(byLabel['Wing area'], '123 m² (1,320 ft²)');
  assert.equal(byLabel.Power, '1,193 kW (1,600 hp)');
});

test('summarizeAccidents counts hits and sums deaths', () => {
  const crash = (deaths) => ({ claims: { P1120: [qty(deaths, '1')] } });
  assert.deepEqual(summarizeAccidents([crash(10), crash(5)], 3), {
    accidents: 3,
    deaths: 15,
  });
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(log) {
  return async (url) => {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    log.push(
      params.get('action') +
        ':' +
        (params.get('list') || params.get('ids') || params.get('gsrsearch')),
    );
    assert.equal(params.get('origin'), '*');
    if (parsed.hostname === 'en.wikipedia.org')
      return jsonResponse({
        query: {
          pages: [
            {
              title: 'List of A380 accidents',
              index: 1,
              pageprops: { wikibase_item: 'Q9' },
            },
            {
              title: 'Airbus A380',
              index: 2,
              pageprops: { wikibase_item: 'Q5830' },
            },
          ],
        },
      });
    if (params.get('list') === 'search')
      return jsonResponse({
        query: { searchinfo: { totalhits: 0 }, search: [] },
      });
    const ids = params.get('ids').split('|');
    const entities = {};
    for (const id of ids) {
      if (id === 'Q5830') entities[id] = A380;
      else if (id === 'Q67')
        entities[id] = { labels: { en: { value: 'Airbus' } } };
      else if (id === 'Q9070485')
        entities[id] = { labels: { en: { value: 'GP7000' } } };
      else entities[id] = { id, claims: {} };
    }
    return jsonResponse({ entities });
  };
}

test('source resolves a type through Wikipedia and caches the dossier', async () => {
  const log = [];
  const source = createAircraftWikidataSource({ fetchImpl: fakeFetch(log) });
  const result = await source.lookup('Airbus A380 841');
  assert.equal(result.id, 'Q5830');
  assert.equal(result.title, 'Airbus A380');
  assert.ok(
    result.lines.some((l) => l.label === 'Engines' && l.value === '4 × GP7000'),
  );
  assert.ok(result.lines.some((l) => l.label === 'Safety'));
  const calls = log.length;
  assert.equal(await source.lookup('airbus a380 841'), result);
  assert.equal(log.length, calls, 'second lookup served from cache');
});

test('source resolves null when nothing matches and rejects on HTTP errors', async () => {
  const empty = createAircraftWikidataSource({
    fetchImpl: async () => jsonResponse({ query: { pages: [] } }),
  });
  assert.equal(await empty.lookup('Zzz'), null);
  const failing = createAircraftWikidataSource({
    fetchImpl: async () => jsonResponse({}, 500),
  });
  await assert.rejects(failing.lookup('Boeing 737'), /HTTP 500/);
});

test('source honours caller cancellation', async () => {
  const source = createAircraftWikidataSource({
    fetchImpl: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(jsonResponse({ query: { pages: [] } })), 20),
      ),
  });
  const controller = new AbortController();
  const pending = source.lookup('Boeing 737', { signal: controller.signal });
  controller.abort(new Error('gone'));
  await assert.rejects(pending, /gone/);
});
