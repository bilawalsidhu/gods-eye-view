import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPINE_OVERLAY_COHORT_LIMIT,
  ALPINE_OVERLAY_MAX_DISTANCE_M,
  ALPINE_OVERLAY_SOURCE_ID,
  MARKER_MAX_PX,
  MARKER_MIN_PX,
  OFFLINE_ACCENT,
  UNMEASURED_ACCENT,
  createStationOverlayEntry,
  mapAnalystRecord,
  selectOverlayCohort,
  stationLabel,
  stationMarker,
} from './model.js';
import { parameterView } from './parameters.js';
import { alpineStationRecord } from './records.js';
import { SLF_NETWORK_ID } from './networks.js';

const NOW = Date.UTC(2026, 9, 9, 12, 0);
const station = (overrides = {}) =>
  alpineStationRecord({
    networkId: SLF_NETWORK_ID,
    code: 'DAV2',
    label: 'Bärentälli',
    lat: 46.6988,
    lon: 9.8194,
    elevationM: 2558,
    region: 'GR',
    measuredAt: new Date(NOW - 10 * 60_000).toISOString(),
    windSpeedMs: 6,
    windDirDeg: 270,
    airTempC: -3.5,
    snowDepthCm: 42,
    ...overrides,
  });

test('three marker states are kept apart because they mean different things', () => {
  // Collapsing them would assert readings a station never made.
  const wind = parameterView('wind');
  const withValue = stationMarker(station(), wind, { now: NOW });
  assert.equal(withValue.state, 'value');
  assert.equal(withValue.band.id, 'moderate');
  assert.notEqual(withValue.accent, UNMEASURED_ACCENT);

  const pressure = parameterView('pressure');
  const unmeasured = stationMarker(station(), pressure, { now: NOW });
  assert.equal(unmeasured.state, 'unmeasured', 'IMIS carries no barometer');
  assert.equal(unmeasured.accent, UNMEASURED_ACCENT);
  assert.equal(unmeasured.value, null);

  const silent = stationMarker(
    station({
      measuredAt: null,
      windSpeedMs: null,
      windDirDeg: null,
      airTempC: null,
      snowDepthCm: null,
    }),
    wind,
    { now: NOW },
  );
  assert.equal(silent.state, 'offline');
  assert.equal(silent.accent, OFFLINE_ACCENT);
});

test('a reading too old to present draws as offline, not as a value', () => {
  const marker = stationMarker(
    station({ measuredAt: new Date(NOW - 7 * 24 * 60 * 60_000).toISOString() }),
    parameterView('wind'),
    { now: NOW },
  );
  assert.equal(marker.state, 'offline');
  assert.equal(marker.value, null, 'a stale reading is not shown as current');
});

test('a measured zero draws as a value, with the quiet band colour', () => {
  const marker = stationMarker(
    station({ snowDepthCm: 0 }),
    parameterView('snow'),
    { now: NOW },
  );
  assert.equal(marker.state, 'value');
  assert.equal(marker.value, 0);
  assert.equal(marker.band.id, 'bare');
  assert.notEqual(marker.accent, OFFLINE_ACCENT, 'bare ground is not offline');
});

test('marker size stays within its stated bounds for every view', () => {
  for (const id of ['wind', 'temperature', 'snow', 'precipitation', 'pressure']) {
    const view = parameterView(id);
    for (const value of [-100, -1, 0, 1, 50, 5000]) {
      const marker = stationMarker(
        station({ [view.field]: value }),
        view,
        { now: NOW },
      );
      assert.ok(
        marker.pixelSize >= MARKER_MIN_PX && marker.pixelSize <= MARKER_MAX_PX,
        `${id}(${value}) = ${marker.pixelSize}`,
      );
    }
  }
});

test('the ambient label is the reading alone, with wind carrying its bearing', () => {
  // One card per station buried the map at Alpine zoom; the reading is what
  // the map is for and the rest belongs on the rail card.
  const wind = parameterView('wind');
  const marker = stationMarker(station(), wind, { now: NOW });
  assert.equal(stationLabel(station(), wind, marker), '22 km/h W');
  const temperature = parameterView('temperature');
  assert.equal(
    stationLabel(
      station(),
      temperature,
      stationMarker(station(), temperature, { now: NOW }),
    ),
    '-3.5 °C',
  );
  assert.ok(!stationLabel(station(), wind, marker).includes('Bärentälli'));
});

test('a station with nothing to say gets no label at all', () => {
  const wind = parameterView('wind');
  for (const marker of [
    { state: 'offline', value: null },
    { state: 'unmeasured', value: null },
  ])
    assert.equal(stationLabel(station(), wind, marker), null);
});

test('an overlay entry is a non-interactive label bounded by distance', () => {
  // Station selection is the rail list, which can also reach a station the
  // camera is not pointed at.
  const entry = createStationOverlayEntry({
    station: station(),
    position: { x: 1, y: 2, z: 3 },
    title: '22 km/h W',
    accent: '#ffe066',
    prominence: 0.5,
  });
  assert.equal(entry.id, `${SLF_NETWORK_ID}:DAV2`);
  assert.equal(entry.source, ALPINE_OVERLAY_SOURCE_ID);
  assert.equal(entry.variant, 'label');
  assert.equal(entry.interactive, false);
  assert.equal(entry.maxDistance, ALPINE_OVERLAY_MAX_DISTANCE_M);
  assert.equal(entry.priority, 500);
  assert.equal(entry.horizonCull, true);
});

test('the cohort keeps the most remarkable readings and is hard bounded', () => {
  const entries = Array.from({ length: 500 }, (_, index) => ({
    id: `s${String(index).padStart(3, '0')}`,
    priority: index,
  }));
  const cohort = selectOverlayCohort(entries);
  assert.equal(cohort.length, ALPINE_OVERLAY_COHORT_LIMIT);
  assert.equal(cohort[0].id, 's499', 'the most remarkable wins');
  assert.equal(
    selectOverlayCohort(entries, 10_000).length,
    ALPINE_OVERLAY_COHORT_LIMIT,
    'a caller cannot raise the ceiling',
  );
  assert.deepEqual(selectOverlayCohort(entries, 0), []);
  assert.deepEqual(selectOverlayCohort(null), []);
  // Equal priority falls back to identity, so the cohort is stable per poll.
  const tied = [
    { id: 'b', priority: 1 },
    { id: 'a', priority: 1 },
  ];
  assert.deepEqual(
    selectOverlayCohort(tied).map((entry) => entry.id),
    ['a', 'b'],
  );
});

test('an analyst record carries plain values and an epoch-ms time', () => {
  // Every other analyst time field is epoch milliseconds; the ISO string the
  // record keeps is for display.
  const record = mapAnalystRecord(station());
  assert.equal(record.id, `${SLF_NETWORK_ID}:DAV2`);
  assert.equal(record.name, 'Bärentälli');
  assert.equal(record.network, SLF_NETWORK_ID);
  assert.equal(record.country, 'CH');
  assert.equal(record.measuredAtMs, NOW - 10 * 60_000);
  assert.equal(record.pressureQffHpa, null, 'absent stays null, never NaN');
  assert.equal(
    JSON.parse(JSON.stringify(record)).measuredAtMs,
    record.measuredAtMs,
    'the record is JSON-safe',
  );
  const silent = mapAnalystRecord(station({ measuredAt: null }));
  assert.equal(silent.measuredAtMs, null);
});
