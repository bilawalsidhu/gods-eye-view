import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetroSource, WIKIDATA_SPARQL_ENDPOINT } from './source.js';

const uri = (id) => ({ value: `http://www.wikidata.org/entity/${id}` });
const lit = (value) => ({ value: String(value) });

const jsonResponse = (body, { ok = true, status = 200 } = {}) => {
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    headers: { get: (name) => (name === 'content-length' ? String(text.length) : null) },
    text: async () => text,
  };
};

const citiesBody = {
  results: {
    bindings: [
      { city: uri('Q90'), name: lit('Paris'), population: lit(2103778) },
      { city: uri('Q172455'), name: lit('Boulogne'), population: lit(119019) },
    ],
  },
};

function stationsBody(query) {
  const rows = [];
  if (query.includes('wd:Q90'))
    rows.push({ station: uri('Q1'), stationLabel: lit('Bastille'), coord: lit('Point(2.36 48.85)'), city: uri('Q90'), lineData: lit('Q50~FFCD00~Line 1') });
  return { results: { bindings: rows } };
}

function recordingFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const query = parsed.searchParams.get('query');
    calls.push({ url: parsed, query, init });
    return jsonResponse(query.includes('wikibase:box') ? citiesBody : stationsBody(query));
  };
  return { calls, fetchImpl };
}

test('queries WDQS directly and caches cities per snapped box', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const source = createMetroSource({ fetchImpl });
  const box = { west: 2.25, south: 48.8, east: 2.45, north: 48.9 };
  const cities = await source.getCitiesInView(box);
  assert.deepEqual(cities.map((c) => c.id), ['Q90', 'Q172455']);
  assert.equal(calls.length, 1);
  assert.equal(`${calls[0].url.origin}${calls[0].url.pathname}`, WIKIDATA_SPARQL_ENDPOINT);
  assert.equal(calls[0].url.searchParams.get('format'), 'json');
  assert.equal(calls[0].init.headers.Accept, 'application/sparql-results+json');
  assert.match(calls[0].init.headers['Api-User-Agent'], /GodsEyeView/);
  // A small pan inside the same snapped cell reuses the cached answer.
  await source.getCitiesInView({ ...box, west: 2.26 });
  assert.equal(calls.length, 1);
});

test('fetches stations once per city and caches empty answers', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const source = createMetroSource({ fetchImpl });
  assert.equal(source.peekStations('Q90'), undefined);
  const byCity = await source.fetchStations(['Q90', 'Q172455']);
  assert.equal(byCity.get('Q90').length, 1);
  assert.equal(source.peekStations('Q90')[0].name, 'Bastille');
  assert.deepEqual(source.peekStations('Q172455'), []);
  const again = await source.fetchStations(['Q90', 'Q172455']);
  assert.equal(again.size, 0);
  assert.equal(calls.length, 1);
});

test('expires cached stations after the TTL', async () => {
  const { calls, fetchImpl } = recordingFetch();
  let clock = 0;
  const source = createMetroSource({ fetchImpl, now: () => clock });
  await source.fetchStations(['Q90']);
  clock += 13 * 60 * 60 * 1000;
  assert.equal(source.peekStations('Q90'), undefined);
  await source.fetchStations(['Q90']);
  assert.equal(calls.length, 2);
});

test('surfaces HTTP errors and malformed bodies', async () => {
  const failing = createMetroSource({
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 429 }),
  });
  await assert.rejects(
    () => failing.getCitiesInView({ west: 2, south: 48, east: 3, north: 49 }),
    /rate limit/,
  );
  const malformed = createMetroSource({ fetchImpl: async () => jsonResponse({ nope: 1 }) });
  await assert.rejects(() => malformed.fetchStations(['Q90']), /Malformed/);
});

test('honors an already-aborted signal before fetching', async () => {
  let called = false;
  const source = createMetroSource({
    fetchImpl: async () => {
      called = true;
      return jsonResponse(citiesBody);
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    source.getCitiesInView({ west: 2, south: 48, east: 3, north: 49 }, { signal: controller.signal }),
  );
  assert.equal(called, false);
});
