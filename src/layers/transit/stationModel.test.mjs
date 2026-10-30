import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRANSIT_STATION_RANK_LOCAL,
  TRANSIT_STATION_RANK_PRINCIPAL,
  TRANSIT_STATION_SEGMENT_COLORS,
  TRANSIT_STATION_UNKNOWN_COLOR,
  TRANSIT_STATIONS_OVERLAY_SOURCE_ID,
  normalizeTransitStationPayload,
  selectTransitStationOverlayCohort,
  transitStationClass,
  transitStationSegmentColor,
  transitStationSegmentKey,
  transitStationSegments,
} from './stationModel.js';

test('a proxy payload is normalized into station rows coloured by rail segment', () => {
  const normalized = normalizeTransitStationPayload({
    total: 3,
    stations: [
      {
        id: 'a',
        name: 'Paris Gare du Nord',
        shortCode: 'PV',
        uic: '87747006',
        lon: 2.3553,
        lat: 48.8809,
        segment: 'a',
      },
      {
        id: 'b',
        name: 'Lyon Part-Dieu',
        lon: 4.8557,
        lat: 45.7608,
        segment: 'C',
      },
      // No coordinates: one unusable station is not evidence the payload is
      // broken, so it is skipped rather than refusing the whole snapshot.
      { id: 'c', name: 'Nowhere' },
      // A duplicate id is skipped.
      { id: 'a', name: 'Duplicate', lon: 1, lat: 1 },
    ],
  });
  assert.equal(normalized.total, 3);
  assert.equal(normalized.stations.length, 2);
  const [first, second] = normalized.stations;
  assert.equal(first.name, 'Paris Gare du Nord');
  assert.equal(first.shortCode, 'PV');
  assert.equal(first.uic, '87747006');
  assert.equal(first.segment, 'A');
  assert.equal(first.color, transitStationSegmentColor('A'));
  assert.equal(second.segment, 'C');
});

test('a structurally broken payload is refused so the last good one is kept', () => {
  assert.equal(normalizeTransitStationPayload(null), null);
  assert.equal(normalizeTransitStationPayload({}), null);
  assert.equal(normalizeTransitStationPayload({ stations: {} }), null);
});

test('the label cohort is bounded and keeps a stable identity', () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    id: `station-${String(index).padStart(3, '0')}`,
  }));
  const cohort = selectTransitStationOverlayCohort(entries);
  assert.equal(cohort.length, 48);
  assert.deepEqual(
    cohort.map((entry) => entry.id),
    cohort.map((entry) => entry.id).slice().sort(),
  );
  assert.equal(selectTransitStationOverlayCohort(entries, 0).length, 0);
  assert.equal(selectTransitStationOverlayCohort(null).length, 0);
});

test('the station overlay lives under the Transit row own source id', () => {
  assert.equal(TRANSIT_STATIONS_OVERLAY_SOURCE_ID, 'transit-stations');
});


test('a station with a short code is a principal station in its segment colour', () => {
  const classification = transitStationClass({ segment: 'A', shortCode: 'PV' });
  assert.equal(classification.rank, TRANSIT_STATION_RANK_PRINCIPAL);
  assert.equal(classification.segment, 'A');
  assert.equal(classification.id, 'principal:A');
  // The principal station keeps its segment's palette colour.
  assert.equal(classification.color, TRANSIT_STATION_SEGMENT_COLORS.A);
});

test('a station without a short code is a local station in the muted segment colour', () => {
  const classification = transitStationClass({ segment: 'A', shortCode: null });
  assert.equal(classification.rank, TRANSIT_STATION_RANK_LOCAL);
  assert.equal(classification.id, 'local:A');
  // The local station keeps the segment's hue, muted: same family, quieter.
  assert.notEqual(classification.color, TRANSIT_STATION_SEGMENT_COLORS.A);
  // The muted colour sits CLOSER to the neutral grey than the segment
  // colour does, on every channel: same hue family, quieter.
  const muted = [1, 3, 5].map((i) =>
    Number.parseInt(classification.color.slice(i, i + 2), 16),
  );
  const base = [1, 3, 5].map((i) =>
    Number.parseInt(TRANSIT_STATION_SEGMENT_COLORS.A.slice(i, i + 2), 16),
  );
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(
      Math.abs(muted[channel] - 0xad) < Math.abs(base[channel] - 0xad),
      `channel ${channel} is muted towards the neutral grey`,
    );
  }
});

test('an empty or blank short code counts as no short code', () => {
  for (const shortCode of ['', '   ', null, undefined]) {
    assert.equal(
      transitStationClass({ segment: 'B', shortCode }).rank,
      TRANSIT_STATION_RANK_LOCAL,
    );
  }
});

test('an unnamed segment falls into the other class and keeps the neutral colour', () => {
  const classification = transitStationClass({ segment: null, shortCode: 'XX' });
  assert.equal(classification.segment, 'other');
  assert.equal(classification.id, 'principal:other');
  assert.equal(classification.color, TRANSIT_STATION_UNKNOWN_COLOR);
  const local = transitStationClass({ segment: null });
  assert.equal(local.id, 'local:other');
  assert.notEqual(local.color, TRANSIT_STATION_UNKNOWN_COLOR);
});

test('a segment letter the palette does not name is treated as unnamed', () => {
  assert.equal(transitStationSegmentKey('Z'), 'other');
  assert.equal(transitStationSegmentKey(' c '), 'C');
  assert.equal(transitStationClass({ segment: 'Z' }).id, 'local:other');
});

test('a station in several rail segments takes its first segment', () => {
  // The catalogue publishes segment_drg as a semicolon-separated list: a
  // station that belongs to more than one rail network lists several. The
  // first one is its primary segment, so it keeps that segment's colour
  // instead of falling through to the neutral 'other' grey.
  assert.equal(transitStationSegmentKey('A;B;A'), 'A');
  assert.equal(transitStationSegmentKey('B;C'), 'B');
  assert.equal(transitStationSegmentKey('A;A'), 'A');
  assert.equal(transitStationSegmentKey('B;B'), 'B');
  assert.equal(transitStationSegmentKey('A;B'), 'A');
  assert.equal(transitStationSegmentKey('B;A'), 'B');
  // A list whose first entry is unknown still resolves to a named one.
  assert.equal(transitStationSegmentKey('Z;A'), 'A');
  // A list with nothing the palette names stays unnamed.
  assert.equal(transitStationSegmentKey('Z;Y'), 'other');
  assert.equal(transitStationSegmentKey(';'), 'other');
  // The class and the row colour agree with the same resolution.
  const classification = transitStationClass({
    segment: 'A;B;A',
    shortCode: 'PNO',
  });
  assert.equal(classification.segment, 'A');
  assert.equal(classification.id, 'principal:A');
  assert.equal(classification.color, TRANSIT_STATION_SEGMENT_COLORS.A);
  assert.equal(transitStationSegmentColor('A;B;A'), TRANSIT_STATION_SEGMENT_COLORS.A);
});

test('the legend counts the very classes the map colours from', () => {
  const stations = [
    { segment: 'A', shortCode: 'PV' },
    { segment: 'A', shortCode: 'PV' },
    { segment: 'A' },
    { segment: 'B', shortCode: 'BC' },
    { segment: null },
  ];
  const entries = transitStationSegments(stations);
  const counts = Object.fromEntries(entries.map((entry) => [entry.id, entry.count]));
  assert.deepEqual(counts, {
    'principal:A': 2,
    'local:A': 1,
    'principal:B': 1,
    'local:other': 1,
  });
  // Every legend colour is the class colour the map draws, and the counts
  // add up to the stations drawn.
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const station of stations) {
    const classification = transitStationClass(station);
    assert.equal(byId.get(classification.id).color, classification.color);
  }
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(total, stations.length);
});

test('the legend labels name the rank and the segment plainly', () => {
  const entries = transitStationSegments([
    { segment: 'A', shortCode: 'PV' },
    { segment: 'A' },
  ]);
  assert.equal(entries[0].label, 'Principal station ({segment})');
  assert.equal(entries[0].segmentLabel, 'Segment A');
  assert.equal(entries[1].label, 'Local station ({segment})');
});
