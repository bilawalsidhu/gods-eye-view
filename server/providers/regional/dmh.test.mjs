import test from 'node:test';
import assert from 'node:assert/strict';
import { createDmhObservationSource, normalizeDmhStations } from './dmh.js';
import { regionalBriefProxy } from './briefing.js';

const NOW = Date.UTC(2026, 9, 15, 6);
const point = { latitude: -25.3, longitude: -57.6 };
const station = (id = 1, latitude = -25.3, stamp = NOW - 600_000) => ({
  metadatos: {
    id,
    codigo: String(id),
    nombre: `Station ${id}`,
    estado: 'activo',
    latitud: latitude,
    longitud: -57.6,
  },
  ultima_observacion: {
    fecha: { utc: new Date(stamp).toISOString() },
    temperatura_aire: { valor: 0, unidad_medida: '°C' },
    humedad_relativa: { valor: 70, unidad_medida: '%' },
    velocidad_viento: { valor: 2.5, unidad_medida: 'm/s' },
    direccion_viento: { valor: 0, unidad_medida: '°' },
    precipitacion: { valor: 12, unidad_medida: 'mm' },
  },
});
const feed = (...rows) => ({
  actualizado: { utc: new Date(NOW).toISOString() },
  estaciones: Object.fromEntries(rows.map((row, i) => [i, row])),
});

test('DMH validates units, missing values and bounds while preserving real zero observations', () => {
  const good = station();
  const [row] = normalizeDmhStations(feed(good));
  assert.equal(row.temperatureC, 0);
  assert.equal(row.windKph, 9);
  assert.equal(row.windDirectionDeg, 0);
  assert.equal(row.humidityPct, 70);
  assert.equal(row.observedAt, '2026-10-15T05:50:00.000Z');
  assert.equal(row.source, 'DMH / DINAC');
  assert.equal(
    row.precipitationMm,
    undefined,
    'unknown accumulation interval must not become hourly precipitation',
  );
  for (const invalid of [null, '', false, -9999, 1000]) {
    good.ultima_observacion.temperatura_aire.valor = invalid;
    assert.equal(normalizeDmhStations(feed(good))[0].temperatureC, null);
  }
  good.ultima_observacion.velocidad_viento.unidad_medida = 'km/h';
  assert.equal(normalizeDmhStations(feed(good))[0].windKph, null);
  good.metadatos.latitud = null;
  assert.deepEqual(normalizeDmhStations(feed(good)), []);
  good.metadatos.latitud = -25;
  good.ultima_observacion.fecha.utc = '2026-10-15T05:50:00';
  assert.deepEqual(normalizeDmhStations(feed(good)), []);
  assert.throws(
    () => normalizeDmhStations({ error: 'offline' }),
    /invalid_dmh/,
  );
});

test('nearest recent station wins; inactive, old, future and distant readings are excluded', async () => {
  const inactive = station(2);
  inactive.metadatos.estado = 'inactivo';
  const source = createDmhObservationSource({
    now: () => NOW,
    fetchJson: async () =>
      feed(
        station(1, -25.3, NOW - 91 * 60000),
        inactive,
        station(3, -25.31, NOW + 6 * 60000),
        station(4, -25.4),
        station(5, -25.5),
      ),
  });
  const result = await source.getObservation(point);
  assert.equal(result.status, 'ready');
  assert.equal(result.observation.stationId, '4');
  assert.ok(
    result.observation.distanceM > 11000 &&
      result.observation.distanceM < 11200,
  );
  const distant = await source.getObservation({
    latitude: -26.5,
    longitude: -57.6,
  });
  assert.deepEqual(distant, { status: 'no-recent-station', observation: null });
});

test('DMH coalesces its bounded feed, caches three minutes and backs off outages without returning old values', async () => {
  let clock = NOW,
    calls = 0,
    broken = false;
  const source = createDmhObservationSource({
    now: () => clock,
    fetchJson: async (url, options) => {
      calls++;
      assert.equal(url, 'https://www.meteorologia.gov.py/emas/data.json');
      assert.equal(options.redirect, 'error');
      assert.equal(options.maxBytes, 2 * 1024 * 1024);
      assert.equal(options.timeoutMs, 9000);
      if (broken) throw new Error('upstream details');
      return feed(station());
    },
  });
  assert.equal(
    (await source.getObservation({ latitude: 40, longitude: -74 })).status,
    'outside-coverage',
  );
  assert.equal(calls, 0);
  const results = await Promise.all([
    source.getObservation(point),
    source.getObservation(point),
  ]);
  assert.equal(calls, 1);
  assert.equal(results[0].observation.stationName, 'Station 1');
  clock += 179999;
  await source.getObservation(point);
  assert.equal(calls, 1);
  clock++;
  broken = true;
  assert.deepEqual(await source.getObservation(point), {
    status: 'unavailable',
    observation: null,
  });
  await source.getObservation(point);
  assert.equal(calls, 2);
  broken = false;
  clock += 30000;
  assert.equal((await source.getObservation(point)).status, 'ready');
  assert.equal(calls, 3);
  clock += 90 * 60000;
  assert.equal(
    (await source.getObservation(point)).status,
    'no-recent-station',
    'portal refresh cannot make an old observation current',
  );
});

function install(options, hook = 'configureServer') {
  let handler;
  regionalBriefProxy(options)[hook]({
    middlewares: {
      use(path, cb) {
        assert.equal(path, '/api/regional-brief');
        handler = cb;
      },
    },
  });
  return async (latitude = point.latitude) => {
    const response = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler(
      {
        method: 'GET',
        url: `/?latitude=${latitude}&longitude=-57.6`,
        socket: { remoteAddress: 'dmh-test' },
      },
      response,
    );
    return response;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: DMH enriches a brief without replacing the model and stale cache cannot revive readings`, async (t) => {
    let clock = NOW,
      fail = false;
    t.mock.method(Date, 'now', () => clock);
    const observation = {
      ...normalizeDmhStations(feed(station(1, -25.3, NOW - 89 * 60000)))[0],
      distanceM: 0,
    };
    const model = { temperatureC: 24, weatherCode: 3, cloudCoverPct: 80 };
    const request = install(
      {
        placeProvider: async () => (fail ? null : { country: 'Paraguay' }),
        weatherProvider: async () => (fail ? null : model),
        newsProvider: async () => ({ status: 'unavailable', articles: [] }),
        dmhProvider: async () =>
          fail
            ? { status: 'unavailable', observation: null }
            : { status: 'ready', observation },
      },
      hook,
    );
    const fresh = await request();
    assert.equal(fresh.status, 200);
    assert.deepEqual(fresh.body.weather, model);
    assert.equal(fresh.body.stationObservation.temperatureC, 0);
    const nearby = await request(-25.31);
    assert.ok(
      nearby.body.stationObservation.distanceM > 1000,
      'cell cache distance uses the requested point',
    );
    clock += 2 * 60000;
    const expired = await request();
    assert.equal(expired.body.status, 'cached');
    assert.equal(expired.body.stationObservation, null);
    clock += 4 * 60000;
    fail = true;
    const stale = await request();
    assert.equal(stale.body.status, 'stale');
    assert.equal(stale.body.stationObservation, null);
  });
}

test('an unavailable DMH feed leaves global weather usable; a station can stand alone', async () => {
  const model = { temperatureC: 24 };
  const defaults = {
    placeProvider: async () => null,
    newsProvider: async () => ({ status: 'unavailable', articles: [] }),
  };
  const fallback = await install({
    ...defaults,
    weatherProvider: async () => model,
    dmhProvider: async () => {
      throw new Error('offline');
    },
  })();
  assert.equal(fallback.status, 200);
  assert.deepEqual(fallback.body.weather, model);
  assert.equal(fallback.body.stationObservationStatus, 'unavailable');
  const observation = {
    ...normalizeDmhStations(feed(station(1, -25.3, Date.now())))[0],
    distanceM: 0,
  };
  const only = await install({
    ...defaults,
    weatherProvider: async () => null,
    dmhProvider: async () => ({ status: 'ready', observation }),
  })();
  assert.equal(only.status, 200);
  assert.equal(only.body.weather, null);
  assert.equal(only.body.stationObservation.stationId, '1');
});
