import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { readSmnZip, SMN_ZIP_MAX_BYTES } from './smn-zip.js';
import {
  parseSmnStations,
  parseSmnObservations,
  selectSmnObservation,
  smnWeatherAtPoint,
} from './smn-model.js';
import { createSmnWeatherProvider } from './smn.js';
import { createRegionalBriefWeatherProvider } from './weather.js';
import { regionalBriefProxy } from './briefing.js';

// Synthetic rows in the public SMN formats; no downloaded database is bundled.
const stationLine = (
  name = 'POSADAS AERO',
  id = '87178',
  coords = '-27 23 -55 58',
) => `${name.padEnd(30)}${'MISIONES'.padEnd(37)}${coords} 125 ${id} SARP`;
const catalog = stationLine();
const row = (changes = {}) =>
  Object.values({
    name: 'Posadas',
    date: '15-octubre-2026',
    time: '03:00',
    condition: 'Cubierto con llovizna en la hora anterior',
    visibility: '2,5 km',
    temperature: '18.5',
    apparent: 'No se calcula',
    humidity: '92',
    wind: 'Sur  11',
    pressure: '998.5 /',
    ...changes,
  }).join(';');
const point = { latitude: -27.37, longitude: -55.9 };
const epoch = Date.parse('2026-10-15T06:00:00Z');
const parse = (text = row(), stations = parseSmnStations(catalog)) =>
  parseSmnObservations(text, stations);

function zip(text, name = 'estado_tiempo20261015.txt') {
  const data = Buffer.from(text, 'latin1');
  const compressed = deflateRawSync(data);
  const filename = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  header.copy(central, 10, 8, 26);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(header.length + filename.length + compressed.length, 16);
  return Buffer.concat([header, filename, compressed, central, filename, end]);
}

function fixtureFetch(calls) {
  return async (url, options) => {
    calls.push({ url, options });
    return new Response(
      url.endsWith('estaciones')
        ? zip(catalog, 'estaciones_smn.txt')
        : zip(row()),
    );
  };
}

test('SMN archive decodes Latin-1 and rejects wrong names, CRC, empty or oversized data', () => {
  const expected = /^estado_tiempo\d{8}\.txt$/;
  assert.equal(readSmnZip(zip('Iguazú;Nublado'), expected), 'Iguazú;Nublado');
  for (const invalid of [
    Buffer.from('<html>unavailable</html>'),
    zip('ok', '../wrong.txt'),
    zip(''),
    Buffer.alloc(SMN_ZIP_MAX_BYTES + 1),
    zip('a'.repeat(600_000)),
  ]) {
    assert.throws(() => readSmnZip(invalid, expected));
  }
  const badCrc = zip('test');
  badCrc.writeUInt32LE(0, 14);
  assert.throws(() => readSmnZip(badCrc, expected));
  // A lying size header still cannot bypass the decompression cap.
  const bomb = zip('a'.repeat(600_000));
  const central = bomb.readUInt32LE(bomb.length - 6);
  bomb.writeUInt32LE(10, 22);
  bomb.writeUInt32LE(10, central + 24);
  assert.throws(() => readSmnZip(bomb, expected));
});

test('station coordinates retain negative minutes and known IDs; malformed/duplicate IDs are dropped', () => {
  const [station] = parseSmnStations(`NOMBRE\n${catalog}\nERO`);
  assert.equal(station.id, '87178');
  assert.equal(station.longitude, -55 - 58 / 60);
  assert.equal(station.latitude, -27 - 23 / 60);
  assert.equal(parseSmnStations(`${catalog}\n${catalog}`).length, 0);
  assert.equal(
    parseSmnStations(stationLine('Bad', '12345', '-27 60 -55 58')).length,
    0,
  );
});

test('observations retain source clock, measured units and condition text without invented weather codes', () => {
  const observation = selectSmnObservation(parse(), point, epoch);
  assert.equal(observation.source, 'smn');
  assert.equal(observation.temperatureC, 18.5);
  assert.equal(observation.apparentTemperatureC, null);
  assert.equal(observation.reportedAt, '2026-10-15T03:00');
  assert.equal(observation.observedAt, null);
  assert.equal(observation.timeZone, null);
  assert.equal(observation.visibilityM, 2500);
  assert.equal(observation.windKph, 11);
  assert.equal(observation.windDirectionDeg, 180);
  assert.equal(observation.humidityPct, 92);
  assert.equal(observation.stationPressureHpa, 998.5);
  assert.equal(
    observation.conditionText,
    'Cubierto con llovizna en la hora anterior',
  );
  for (const key of ['weatherCode', 'precipitationMm', 'cloudCoverPct'])
    assert.equal(observation[key], null);
  assert.ok(
    observation.station.distanceKm > 6 && observation.station.distanceKm < 7,
  );
});

test('missing, out-of-range and malformed fields stay unknown; zero and calm are real observations', () => {
  for (const temperature of ['', 'No se calcula', 'true', '70'])
    assert.equal(parse(row({ temperature })).length, 0);
  for (const date of ['31-febrero-2026', '15-invalid-2026', '15-octubre-0026'])
    assert.equal(parse(row({ date })).length, 0);
  assert.equal(parse(row({ time: '24:00' })).length, 0);
  const [missing] = parse(
    row({
      wind: '-',
      humidity: '',
      visibility: '999 km',
      pressure: '',
      condition: 'Sin datos',
    }),
  );
  for (const key of [
    'windKph',
    'windDirectionDeg',
    'humidityPct',
    'visibilityM',
    'stationPressureHpa',
    'conditionText',
  ])
    assert.equal(missing[key], null);
  const [calm] = parse(
    row({ temperature: '0', wind: 'Calma', visibility: '0 km', humidity: '0' }),
  );
  assert.equal(calm.windKph, 0);
  assert.equal(calm.windDirectionDeg, null);
  assert.equal(calm.temperatureC, 0);
  assert.equal(calm.visibilityM, 0);
});

test('name matching preserves accents and separates airports from observatories; unknown/ambiguous names are skipped', () => {
  const stations = parseSmnStations(
    [
      stationLine('IGUAZU AERO', '87097'),
      stationLine('CORDOBA AERO', '87344'),
      stationLine('CORDOBA OBSERVATORIO', '87345'),
      stationLine('BUENOS AIRES OBSERVATORIO', '87585'),
    ].join('\n'),
  );
  const rows = parse(
    ['Iguazú', 'Córdoba', 'Córdoba Observatorio', 'Buenos Aires', 'Unknown']
      .map((name) => row({ name }))
      .join('\n'),
    stations,
  );
  assert.deepEqual(
    rows.map((r) => r.station.id),
    ['87097', '87344', '87345', '87585'],
  );
  assert.equal(
    parse(
      row(),
      parseSmnStations(`${catalog}\n${stationLine('POSADAS', '99999')}`),
    ).length,
    0,
  );
});

test('selection rejects distant, old and future source clocks and uses newest row from nearest usable station', () => {
  assert.equal(
    selectSmnObservation(parse(), { latitude: -28, longitude: -56 }, epoch),
    null,
  );
  assert.equal(
    selectSmnObservation(parse(row({ date: '14-octubre-2026' })), point, epoch),
    null,
  );
  assert.equal(
    selectSmnObservation(parse(row({ time: '06:10' })), point, epoch),
    null,
  );
  assert.equal(
    selectSmnObservation(parse(), point, epoch + 4 * 60 * 60_000),
    null,
  );
  const newest = selectSmnObservation(
    parse(`${row({ time: '02:00' })}\n${row({ time: '04:00' })}`),
    point,
    epoch,
  );
  assert.equal(newest.reportedAt, '2026-10-15T04:00');
  assert.ok(
    smnWeatherAtPoint(newest, { latitude: -27.38, longitude: -55.96 }, epoch)
      .station.distanceKm < newest.station.distanceKm,
  );
});

test('provider shares downloads across points, caches catalog for a day, and skips outside coverage', async () => {
  const calls = [];
  let time = epoch;
  const provider = createSmnWeatherProvider({
    fetchImpl: fixtureFetch(calls),
    now: () => time,
  });
  assert.equal(await provider({ latitude: 30, longitude: -97 }), null);
  assert.equal(calls.length, 0);
  const results = await Promise.all([
    provider(point),
    provider({ latitude: -27.38, longitude: -55.96 }),
  ]);
  assert.equal(calls.length, 2);
  assert.notEqual(results[0].station.distanceKm, results[1].station.distanceKm);
  assert.ok(
    calls.every(
      ({ options }) => options.redirect === 'error' && options.signal,
    ),
  );
  await provider(point);
  assert.equal(calls.length, 2);
  time += 5 * 60_000;
  await provider(point);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].url.endsWith('tiepre'));
});

test('HTTP, malformed archives, oversized bodies and stalled bodies fail quietly with retry cooldown', async () => {
  for (const response of [
    () => new Response('', { status: 403 }),
    () => new Response('<html>error</html>'),
    () => new Response(new Uint8Array(SMN_ZIP_MAX_BYTES + 1)),
  ]) {
    let calls = 0;
    let time = epoch;
    const provider = createSmnWeatherProvider({
      now: () => time,
      fetchImpl: async () => {
        calls++;
        return response();
      },
    });
    assert.equal(await provider(point), null);
    assert.equal(await provider(point), null);
    assert.equal(calls, 2);
    time += 60_000;
    assert.equal(await provider(point), null);
    assert.equal(calls, 4);
  }
  let cancelled = 0;
  const provider = createSmnWeatherProvider({
    now: () => epoch,
    timeoutMs: 15,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      ),
  });
  assert.equal(await provider(point), null);
  assert.equal(cancelled, 2);
});

test('failed refresh clears old observations and model fallback is identified and not mixed with station fields', async () => {
  let time = epoch;
  let failed = false;
  const fetchImpl = fixtureFetch([]);
  const smnProvider = createSmnWeatherProvider({
    now: () => time,
    fetchImpl: (...args) =>
      failed ? Promise.reject(new Error('offline')) : fetchImpl(...args),
  });
  let modelCalls = 0;
  const provider = createRegionalBriefWeatherProvider({
    smnProvider,
    modelProvider: async () => {
      modelCalls++;
      return { temperatureC: 21, weatherCode: 0 };
    },
  });
  assert.equal((await provider(point)).source, 'smn');
  assert.equal(modelCalls, 0);
  failed = true;
  time += 5 * 60_000;
  const fallback = await provider(point);
  assert.equal(fallback.source, 'open-meteo');
  assert.equal(fallback.kind, 'model');
  assert.equal(fallback.station, undefined);
  assert.equal(fallback.weatherCode, 0);
  assert.equal(
    await createRegionalBriefWeatherProvider({
      smnProvider: async () => {
        throw new Error('offline');
      },
      modelProvider: async () => null,
    })(point),
    null,
  );
});

test('regional cache keeps station queries distinct and refreshes observations expiring inside its TTL', async (t) => {
  let time = epoch + 3 * 60 * 60_000 - 60_000;
  t.mock.method(Date, 'now', () => time);
  let calls = 0;
  let handler;
  regionalBriefProxy({
    placeProvider: async () => null,
    weatherProvider: async (query) => {
      calls++;
      return (
        selectSmnObservation(parse(), query, time) || {
          temperatureC: 20,
          source: 'open-meteo',
        }
      );
    },
  }).configureServer({
    middlewares: {
      use: (_, route) => {
        handler = route;
      },
    },
  });
  const request = async (longitude) => {
    let result;
    await handler(
      {
        method: 'GET',
        url: `?latitude=-27.37&longitude=${longitude}`,
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      },
      {
        writeHead() {},
        end(body) {
          result = JSON.parse(body);
        },
      },
    );
    return result;
  };
  const first = await request(-55.9);
  assert.equal((await request(-55.9)).status, 'cached');
  assert.equal(calls, 1);
  const second = await request(-55.91);
  assert.equal(calls, 2);
  assert.notEqual(
    first.weather.station.distanceKm,
    second.weather.station.distanceKm,
  );
  time += 2 * 60_000; // Still inside the cell TTL, but the observation expired.
  assert.equal((await request(-55.91)).weather.source, 'open-meteo');
  assert.equal(calls, 3);
});

test('closest station is selected independently of file order and unavailable closer rows', () => {
  const stations = parseSmnStations(
    `${catalog}\n${stationLine('NEARBY AERO', '99999', '-27 22 -55 54')}`,
  );
  const observations = parse(`${row()}\n${row({ name: 'Nearby' })}`, stations);
  assert.equal(
    selectSmnObservation(observations, point, epoch).station.id,
    '99999',
  );
  const oldNearby = parse(
    `${row()}\n${row({ name: 'Nearby', date: '14-octubre-2026' })}`,
    stations,
  );
  assert.equal(
    selectSmnObservation(oldNearby, point, epoch).station.id,
    '87178',
  );
});
