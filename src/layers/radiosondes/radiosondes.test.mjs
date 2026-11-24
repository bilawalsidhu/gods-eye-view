import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRadiosondesLayer,
  createSondeSource,
  describeSonde,
  mergeSondeFrames,
  normalizePrediction,
  normalizeSondeFrame,
  pruneSondes,
  sondeState,
  sondeTrackerUrl,
} from './index.js';

const NOW = Date.parse('2026-11-24T16:40:00Z');
const FRAME = {
  software_name: 'radiosonde_auto_rx',
  uploader_callsign: 'MF Aix-en-Provence',
  uploader_position: '43.52987,5.42475',
  uploader_antenna: '1/4 wave monopole',
  datetime: '2026-11-24T16:39:31.000000Z',
  manufacturer: 'Meteomodem',
  type: 'M20',
  serial: '608-2-00802',
  lat: 43.7012,
  lon: 7.29741,
  alt: 10479.73,
  temp: -53.6,
  humidity: 65.4,
  pressure: 250.22,
  vel_v: -14.43,
  vel_h: 38.01647,
  heading: 84.17243,
  frequency: 404.400625,
};

test('a frame keeps the balloon’s fields and drops the receiving station', () => {
  const row = normalizeSondeFrame(FRAME);
  assert.deepEqual(row, {
    serial: '608-2-00802',
    time: Date.parse('2026-11-24T16:39:31Z'),
    lat: 43.7012,
    lon: 7.29741,
    altM: 10479.73,
    climbMps: -14.43,
    speedMps: 38.01647,
    headingDeg: 84.17243,
    type: 'M20',
    manufacturer: 'Meteomodem',
    frequencyMhz: 404.400625,
    tempC: -53.6,
    humidityPct: 65.4,
    pressureHpa: 250.22,
  });
  assert.ok(!JSON.stringify(row).includes('Aix'));
  // Subtype wins over type; zoneless times are UTC.
  assert.equal(
    normalizeSondeFrame({
      ...FRAME,
      subtype: 'M20-x',
      datetime: '2026-11-24T16:39:31',
    }).type,
    'M20-x',
  );
  for (const bad of [
    null,
    { ...FRAME, serial: '' },
    { ...FRAME, serial: 'a b' },
    { ...FRAME, datetime: 'soon' },
    { ...FRAME, lat: 91 },
    { ...FRAME, lat: 0, lon: 0 },
  ])
    assert.equal(normalizeSondeFrame(bad), null);
});

test('the store keeps the newest frame per serial and ages old ones out', () => {
  const store = new Map();
  assert.equal(mergeSondeFrames(store, [FRAME, { ...FRAME, alt: 1 }]), 1);
  const newer = { ...FRAME, datetime: '2026-11-24T16:39:40Z', alt: 10300 };
  assert.equal(mergeSondeFrames(store, [newer, FRAME]), 1);
  assert.equal(store.get('608-2-00802').altM, 10300);
  mergeSondeFrames(store, [
    { ...FRAME, serial: 'OLD1', datetime: '2026-11-24T12:00:00Z' },
  ]);
  assert.equal(pruneSondes(store, NOW), 1);
  assert.deepEqual([...store.keys()], ['608-2-00802']);
});

test('states follow vertical speed and how long ago it was heard', () => {
  const row = normalizeSondeFrame(FRAME);
  assert.equal(sondeState(row, NOW), 'falling');
  assert.equal(sondeState({ ...row, climbMps: 5 }, NOW), 'rising');
  assert.equal(sondeState({ ...row, climbMps: 0.2 }, NOW), 'silent');
  assert.equal(sondeState(row, NOW + 16 * 60_000), 'silent');
});

test('predictions become a path and a landing point', () => {
  const prediction = normalizePrediction({
    vehicle: 'Y4532726',
    burst_altitude: 31000,
    descending: 1,
    data: JSON.stringify([
      { time: 1795530720, lat: 59.51, lon: 24.91, alt: 69.6 },
      { time: 1795530744, lat: 59.512, lon: 384.911, alt: 5.99 },
    ]),
  });
  assert.equal(prediction.serial, 'Y4532726');
  assert.equal(prediction.path.length, 2);
  assert.equal(prediction.path[1].lon, 24.911000000000001);
  assert.deepEqual(prediction.landing, {
    lat: 59.512,
    lon: 24.911000000000001,
    time: 1795530744000,
  });
  assert.equal(prediction.burstAltM, 31000);
  assert.equal(prediction.descending, true);
  assert.equal(normalizePrediction({ vehicle: 'X', data: '[' }), null);
  assert.equal(normalizePrediction({ vehicle: 'X', data: [] }), null);
  assert.equal(
    sondeTrackerUrl('608-2-00802'),
    'https://sondehub.org/608-2-00802',
  );
});

test('the card reads the balloon’s numbers and its predicted landing', () => {
  const row = normalizeSondeFrame(FRAME);
  const { title, details } = describeSonde(row, {
    nowMs: NOW,
    prediction: {
      landing: {
        lat: 43.6,
        lon: 7.4,
        time: Date.parse('2026-11-24T17:05:00Z'),
      },
    },
  });
  assert.equal(title, 'Radiosonde 608-2-00802');
  assert.deepEqual(details, [
    'Altitude 10.5 km',
    'Falling 14.4 m/s',
    'Drifting 137 km/h',
    'Temperature -53.6 °C',
    'Humidity 65%',
    'Pressure 250 hPa',
    'Meteomodem · M20 · 404.401 MHz',
    'Last heard 16:39 UTC',
    'Predicted landing 17:05 UTC',
  ]);
});

test('the source reads the local mirror and its predictions', async () => {
  const urls = [];
  const source = createSondeSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return url.endsWith('/latest')
        ? Response.json({ rows: [], live: true, fetchedAt: 9 })
        : Response.json({ serial: 'A', prediction: null });
    },
  });
  assert.deepEqual(await source.getSnapshot(), {
    rows: [],
    live: true,
    fetchedAt: 9,
  });
  assert.equal(await source.getPrediction('A b'), null);
  assert.deepEqual(urls, [
    '/api/sondehub/latest',
    '/api/sondehub/prediction?serial=A%20b',
  ]);
  const down = createSondeSource({
    fetchImpl: async () => Response.json({}, { status: 502 }),
  });
  await assert.rejects(down.getSnapshot(), /SondeHub HTTP 502/);
});

function fakeScene() {
  const sets = new Map();
  const make = (spec) => {
    const set = {
      spec,
      items: [],
      show: spec.show,
      set(items) {
        this.items = items;
      },
      upsert(items) {
        for (const item of items) {
          const i = this.items.findIndex(({ id }) => id === item.id);
          if (i >= 0) this.items[i] = item;
        }
      },
      clear() {
        this.items = [];
      },
      dispose() {
        this.disposed = true;
      },
    };
    sets.set(spec.id, set);
    return set;
  };
  return {
    sets,
    drawOf: () => ({ icons: make, lines: make }),
    frameOf: () => ({ requestRender() {} }),
  };
}

function overlayRecorder() {
  const calls = [];
  return {
    calls,
    setEntries: (sourceId, entries) => calls.push({ sourceId, entries }),
    setVisible() {},
  };
}

test('the layer draws sondes at altitude, and a selection its card and forecast', async () => {
  const scene = fakeScene();
  const overlay = overlayRecorder();
  let onClick = null;
  const rows = [
    normalizeSondeFrame(FRAME),
    normalizeSondeFrame({
      ...FRAME,
      serial: 'Y1',
      vel_v: 5,
      alt: null,
    }),
  ];
  const layer = createRadiosondesLayer({
    source: {
      getSnapshot: async () => ({ rows, live: true, fetchedAt: NOW }),
      getPrediction: async (serial) => ({
        serial,
        path: [
          {
            lat: 43.7,
            lon: 7.3,
            altM: 9000,
            time: Date.parse('2026-11-24T16:40:00Z'),
          },
          {
            lat: 43.6,
            lon: 7.4,
            altM: 0,
            time: Date.parse('2026-11-24T17:05:00Z'),
          },
        ],
        landing: {
          lat: 43.6,
          lon: 7.4,
          time: Date.parse('2026-11-24T17:05:00Z'),
        },
      }),
    },
    overlayHost: overlay,
    picking: {
      resolvePickId: (hit) => hit.id,
      isOwnedByOtherLayer: () => false,
      registerPickOwner() {},
      unregisterPickOwner() {},
    },
    input: () => ({
      onClick(fn) {
        onClick = fn;
        return () => {
          onClick = null;
        };
      },
    }),
    now: () => NOW,
    ...scene,
  });
  layer.init({});
  layer.enable();
  assert.equal(await layer.update(), true);
  const markers = scene.sets.get('radiosondes:markers');
  assert.equal(markers.items.length, 2);
  const falling = markers.items.find(
    ({ id }) => id === 'radiosonde:608-2-00802',
  );
  assert.equal(falling.height, 'absolute');
  assert.equal(
    markers.items.find(({ id }) => id === 'radiosonde:Y1').height,
    'clampGround',
  );
  assert.deepEqual(layer.getStats().states, {
    rising: 1,
    falling: 1,
    silent: 0,
  });

  onClick({ topHit: { id: 'radiosonde:608-2-00802' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const card = overlay.calls.at(-1).entries[0];
  assert.equal(card.title, 'Radiosonde 608-2-00802');
  assert.ok(card.details.includes('Predicted landing 17:05 UTC'));
  const path = scene.sets.get('radiosondes:prediction').items;
  assert.equal(path.length, 1);
  assert.equal(path[0].positions.length, 3);
  assert.equal(scene.sets.get('radiosondes:landing').items.length, 1);

  // Clicking empty globe clears the selection and its forecast.
  onClick({ topHit: null });
  assert.deepEqual(overlay.calls.at(-1).entries, []);
  assert.equal(scene.sets.get('radiosondes:prediction').items.length, 0);

  const records = layer.getAnalystRecords();
  assert.equal(records.length, 2);
  assert.equal(records[0].key, 'radiosonde:608-2-00802');
  layer.destroy();
  assert.equal(markers.disposed, true);
});
