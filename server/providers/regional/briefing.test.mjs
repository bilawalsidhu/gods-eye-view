import test from 'node:test';
import assert from 'node:assert/strict';
import { regionalBriefProxy } from './briefing.js';
import { createDmhObservationSource } from './dmh.js';
import { isSmnCoveragePoint } from './smn.js';
import { selectSmnObservation } from './smn-model.js';
import { createRegionalBriefWeatherProvider } from './weather.js';

const NOW = Date.UTC(2026, 9, 17, 12);
const point = { latitude: -25.3, longitude: -57.61 };
const near = { latitude: -25.3, longitude: -57.59 };
const smn = (id, at = point, stamp = NOW - 3 * 3600_000) => ({
  source: 'smn',
  kind: 'station-observation',
  sourceUrl: 'https://www.smn.gob.ar/descarga-de-datos',
  station: { ...at, id, name: `SMN ${id}` },
  reportedAt: new Date(stamp).toISOString().slice(0, 16),
  observedAt: null,
  timeZone: null,
  temperatureC: 18,
});
const dmh = (id, at = point, stamp = NOW - 600_000) => ({
  metadatos: {
    codigo: id,
    nombre: `DMH ${id}`,
    estado: 'activo',
    latitud: at.latitude,
    longitud: at.longitude,
  },
  ultima_observacion: {
    fecha: { utc: new Date(stamp).toISOString() },
    temperatura_aire: { valor: 0, unidad_medida: '°C' },
  },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const unavailableNews = { status: 'unavailable', articles: [] };

function setup(t, changes = {}, hook = 'configureServer') {
  const state = {
    now: NOW,
    smn: [smn('west'), smn('east', near)],
    dmh: [dmh('west'), dmh('east', near)],
    place: { country: 'Fixture' },
    news: unavailableNews,
    model: { temperatureC: 25, weatherCode: 0 },
    ...changes,
  };
  t.mock.method(Date, 'now', () => state.now);
  const calls = { place: 0, news: 0, model: 0, dmh: 0, smn: 0 };
  const source = createDmhObservationSource({
    now: () => state.now,
    fetchJson: async () => {
      calls.dmh++;
      if (state.failDmh) throw Error('DMH unavailable');
      return {
        estaciones: Object.fromEntries(state.dmh.map((row, i) => [i, row])),
      };
    },
  });
  let handler;
  regionalBriefProxy({
    placeProvider: async () => {
      calls.place++;
      if (state.failPlace) throw Error('place unavailable');
      return state.place;
    },
    newsProvider: async () => {
      calls.news++;
      if (state.newsGate) await state.newsGate.promise;
      if (state.failNews) throw Error('news unavailable');
      return state.news;
    },
    dmhProvider: source.getObservation,
    weatherProvider: createRegionalBriefWeatherProvider({
      smnProvider: async (at) => {
        calls.smn++;
        if (state.failSmn) throw Error('SMN unavailable');
        return isSmnCoveragePoint(at)
          ? selectSmnObservation(state.smn, at, state.now)
          : null;
      },
      modelProvider: async () => {
        calls.model++;
        if (state.modelGate) await state.modelGate.promise;
        return state.model;
      },
    }),
  })[hook]({
    middlewares: {
      use: (_, route) => {
        handler = route;
      },
    },
  });
  const request = async (at = point) => {
    const result = {};
    await handler(
      {
        method: 'GET',
        url: `?latitude=${at.latitude}&longitude=${at.longitude}`,
        headers: {},
        socket: { remoteAddress: 'integration-test' },
      },
      {
        writeHead(code, headers) {
          result.code = code;
          result.headers = headers;
        },
        end(body) {
          result.body = JSON.parse(body);
        },
      },
    );
    return result;
  };
  return { state, calls, request };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: overlap preserves both sources and reselects both stations in one cell`, async (t) => {
    const { request, calls } = setup(t, {}, hook);
    const first = await request();
    const second = await request(near);
    for (const [response, id] of [
      [first, 'west'],
      [second, 'east'],
    ]) {
      assert.equal(response.code, 200);
      assert.equal(response.headers['Cache-Control'], 'no-store');
      assert.equal(response.body.weather.station.id, id);
      assert.equal(response.body.stationObservation.stationId, id);
      assert.equal(response.body.weather.temperatureC, 18);
      assert.equal(response.body.stationObservation.temperatureC, 0);
      assert.equal(response.body.weather.observedAt, null);
      assert.equal(response.body.weather.timeZone, null);
      assert.ok(response.body.stationObservation.observedAt.endsWith('Z'));
    }
    assert.equal(second.body.status, 'cached');
    assert.deepEqual(calls, { place: 1, news: 1, model: 0, dmh: 1, smn: 2 });
  });
}

test('coalesced requests share regional acquisition but select each exact point independently', async (t) => {
  const gate = deferred();
  const { request, calls } = setup(t, { newsGate: gate });
  const west = request();
  const east = request(near);
  gate.resolve();
  const results = await Promise.all([west, east]);
  assert.equal(results[0].body.weather.station.id, 'west');
  assert.equal(results[1].body.weather.station.id, 'east');
  assert.equal(results[1].body.stationObservation.stationId, 'east');
  assert.equal(results[1].headers['X-Regional-Brief'], 'INFLIGHT');
  assert.equal(calls.news, 1);
  assert.equal(calls.dmh, 1);
});

for (const [source, inside, outside] of [
  [
    'dmh',
    { latitude: -28.29, longitude: -58 },
    { latitude: -28.31, longitude: -58 },
  ],
  [
    'dmh',
    { latitude: -25, longitude: -53.71 },
    { latitude: -25, longitude: -53.69 },
  ],
  [
    'smn',
    { latitude: -21.01, longitude: -60 },
    { latitude: -20.99, longitude: -60 },
  ],
  [
    'smn',
    { latitude: -25, longitude: -52.01 },
    { latitude: -25, longitude: -51.99 },
  ],
]) {
  for (const insideFirst of [true, false]) {
    test(`${source} prefilter at ${JSON.stringify(inside)} is exact on cache hits (${insideFirst ? 'inside' : 'outside'} first)`, async (t) => {
      const { request, calls } = setup(t, {
        smn: [smn('edge', inside)],
        dmh: [dmh('edge', inside)],
      });
      const responses = [];
      for (const at of insideFirst ? [inside, outside] : [outside, inside])
        responses.push(await request(at));
      const [included, excluded] = insideFirst
        ? responses
        : responses.reverse();
      if (source === 'dmh') {
        assert.equal(included.body.stationObservation.stationId, 'edge');
        assert.equal(excluded.body.stationObservation, null);
        assert.equal(
          excluded.body.stationObservationStatus,
          'outside-coverage',
        );
      } else {
        assert.equal(included.body.weather.source, 'smn');
        assert.equal(excluded.body.weather.source, 'open-meteo');
        assert.equal(excluded.body.weather.station, undefined);
      }
      assert.equal(calls.place, 1);
      assert.equal(calls.news, 1);
    });
  }
}

test('an unavailable seed cannot suppress a coalesced station-only result across the DMH boundary', async (t) => {
  const inside = { latitude: -28.29, longitude: -58 };
  const outside = { latitude: -28.31, longitude: -58 };
  const gate = deferred();
  const { request } = setup(t, {
    place: null,
    model: null,
    smn: [],
    dmh: [dmh('edge', inside)],
    newsGate: gate,
  });
  const first = request(outside);
  const second = request(inside);
  gate.resolve();
  const [none, station] = await Promise.all([first, second]);
  assert.equal(none.code, 503);
  assert.equal(station.code, 200);
  assert.equal(station.body.stationObservation.stationId, 'edge');
  assert.equal(station.body.weather, null);
});

test('DMH expires and refreshes from its own feed while the regional cell remains cached', async (t) => {
  const { state, request, calls } = setup(t, {
    dmh: [dmh('old', point, NOW - 89 * 60_000)],
  });
  assert.equal((await request()).body.stationObservation.stationId, 'old');
  state.now += 2 * 60_000;
  assert.equal((await request()).body.stationObservation, null);
  assert.equal(calls.dmh, 1);
  state.dmh = [dmh('new', point, state.now)];
  state.now += 60_000;
  assert.equal((await request()).body.stationObservation.stationId, 'new');
  assert.equal(calls.dmh, 2);
  assert.equal(calls.news, 1);
});

test('SMN expiry falls back to the model while independent DMH remains available', async (t) => {
  const { state, request, calls } = setup(t, {
    smn: [smn('old', point, NOW - 6 * 3600_000 + 60_000)],
  });
  assert.equal((await request()).body.weather.source, 'smn');
  state.now += 2 * 60_000;
  const fallback = (await request()).body;
  assert.equal(fallback.weather.source, 'open-meteo');
  assert.equal(fallback.weather.temperatureC, 25);
  assert.equal(fallback.weather.station, undefined);
  assert.equal(fallback.stationObservation.temperatureC, 0);
  assert.equal(calls.model, 1);
});

test('concurrent fallback calls share a model and retain it when stations return', async (t) => {
  const { state, request, calls } = setup(t);
  await request();
  state.smn = [];
  state.modelGate = deferred();
  const first = request();
  const second = request(near);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.model, 1);
  state.modelGate.resolve();
  for (const response of await Promise.all([first, second]))
    assert.equal(response.body.weather.source, 'open-meteo');
  state.smn = [smn('return')];
  assert.equal((await request()).body.weather.source, 'smn');
  state.smn = [];
  assert.equal((await request()).body.weather.temperatureC, 25);
  assert.equal(calls.model, 1);
  state.now += 6 * 60_000;
  state.failSmn = true;
  state.failDmh = true;
  state.place = null;
  state.model = null;
  const stale = (await request()).body;
  assert.equal(stale.status, 'stale');
  assert.equal(stale.weather.source, 'open-meteo');
  assert.equal(stale.weather.temperatureC, 25);
  assert.equal(stale.stationObservation, null);
});

test('DMH failures do not suppress SMN and stale regional fallback cannot revive either source', async (t) => {
  const { state, request } = setup(t);
  await request();
  state.now += 3 * 60_000;
  state.failDmh = true;
  const partial = (await request()).body;
  assert.equal(partial.weather.source, 'smn');
  assert.equal(partial.stationObservation, null);
  assert.equal(partial.stationObservationStatus, 'unavailable');
  state.now += 3 * 60_000;
  state.failSmn = true;
  state.model = null;
  state.place = null;
  const stale = (await request()).body;
  assert.equal(stale.status, 'stale');
  assert.equal(stale.weather, null);
  assert.equal(stale.stationObservation, null);
});

test('distant, stale and future observations cannot win inside overlapping boxes', async (t) => {
  const far = { latitude: -26.3, longitude: -57.6 };
  const { request } = setup(t, {
    smn: [
      smn('far', far),
      smn('old', point, NOW - 7 * 3600_000),
      smn('future', point, NOW + 6 * 60_000),
    ],
    dmh: [
      dmh('far', far),
      dmh('old', point, NOW - 91 * 60_000),
      dmh('future', point, NOW + 6 * 60_000),
    ],
  });
  const result = (await request()).body;
  assert.equal(result.weather.source, 'open-meteo');
  assert.equal(result.stationObservation, null);
});

test('rejected place and news providers cannot discard available station sources', async (t) => {
  const { request } = setup(t, { failPlace: true, failNews: true });
  const result = await request();
  assert.equal(result.code, 200);
  assert.equal(result.body.weather.source, 'smn');
  assert.equal(result.body.stationObservation.stationId, 'west');
  assert.equal(result.body.newsStatus, 'unavailable');
  assert.equal(result.body.placeStatus, 'unavailable');
});

test('observations expiring while news loads are revalidated before the first response', async (t) => {
  const gate = deferred();
  const { state, request } = setup(t, {
    smn: [smn('old', point, NOW - 6 * 3600_000 + 60_000)],
    dmh: [dmh('old', point, NOW - 89 * 60_000)],
    newsGate: gate,
  });
  const pending = request();
  await new Promise((resolve) => setImmediate(resolve));
  state.now += 2 * 60_000;
  gate.resolve();
  const result = (await pending).body;
  assert.equal(result.weather.source, 'open-meteo');
  assert.equal(result.stationObservation, null);
});
