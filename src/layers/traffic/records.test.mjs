// The road segments the Context panel and the analyst read from Traffic: one
// per drawn segment at its middle vertex, honest about simulated flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficAnalystRecords } from './records.js';
import { formatFact } from '../../data/entityContext.js';

const coords = [
  [-97.744, 30.267],
  [-97.743, 30.268],
  [-97.742, 30.269],
];

/** A two-way road is drawn as one road per direction over one geometry. */
function twoWay(type, flow = null) {
  const shared = coords.map((point) => point.slice());
  return [1, -1].map((oneway) => ({ coords: shared, type, oneway, flow }));
}

test('nothing while the layer is off', () => {
  assert.deepEqual(
    trafficAnalystRecords({ _enabled: false, _roads: twoWay('primary') }),
    [],
  );
});

test('keyless roads are listed as simulated, once per geometry', () => {
  const records = trafficAnalystRecords({
    _enabled: true,
    _liveMode: false,
    _roadSource: 'OpenStreetMap',
    _roads: [...twoWay('primary'), ...twoWay('motorway')],
  });
  assert.equal(records.length, 2);
  const [road] = records;
  assert.equal(road.name, 'Major road');
  assert.equal(road.roadType, 'primary');
  // The middle vertex, on the road.
  assert.equal(road.lat, 30.268);
  assert.equal(road.lon, -97.743);
  assert.equal(road.simulated, true);
  assert.equal(road.flow, null);
  assert.equal(road.flowPct, null);
  assert.equal(road.source, 'simulated-keyless');
  assert.equal(road.roads, 'OpenStreetMap');
  assert.ok(road.id);
  assert.equal(records[1].name, 'Motorway');
  assert.equal(
    trafficAnalystRecords(
      { _enabled: true, _roads: [...twoWay('primary'), ...twoWay('trunk')] },
      1,
    ).length,
    1,
  );
});

test('a segment card identifies simulated flow when the traffic service is unreachable', () => {
  const [road] = trafficAnalystRecords({
    _enabled: true,
    _liveMode: false,
    _flowStatusUnavailable: true,
    _roads: twoWay('primary'),
  });
  assert.equal(road.simulated, true);
  assert.equal(road.flow, null);
  assert.equal(
    formatFact('source', road.source).words?.text,
    'SIMULATED — traffic service unreachable',
  );
});

/** A road one way along a course, as its own geometry. */
const road = (course, type = 'primary', oneway = 1) => ({
  coords: course.map((point) => point.slice()),
  type,
  oneway,
});
const ends = [
  [-97.744, 30.267],
  [-97.74, 30.267],
];
const north = [ends[0], [-97.742, 30.268], ends[1]];
const south = [ends[0], [-97.742, 30.266], ends[1]];
const listed = (roads) =>
  trafficAnalystRecords({ _enabled: true, _liveMode: false, _roads: roads });

test('roads of one kind with the same ends but different courses are two segments', () => {
  const records = listed([road(north), road(south)]);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].id, records[1].id);
  assert.equal(records[0].lat, 30.268);
  assert.equal(records[1].lat, 30.266);
});

test('a road drawn once each way over reversed copies of its course is one segment', () => {
  const back = north.slice().reverse();
  const records = listed([road(north, 'primary', 1), road(back, 'primary', 1)]);
  assert.equal(records.length, 1);
  assert.equal(
    listed([road(back, 'primary', -1), road(north, 'primary', 1)])[0].id,
    records[0].id,
    'the same id whichever direction comes first',
  );
});

test('segments keep their order and ids when a reversed copy comes between them', () => {
  const back = north.slice().reverse();
  const forward = listed([road(north), road(back), road(south)]);
  assert.deepEqual(
    forward.map((record) => record.lat),
    [30.268, 30.266],
  );
  const again = listed([road(back), road(south), road(north)]);
  assert.deepEqual(
    again.map((record) => record.id),
    forward.map((record) => record.id),
  );
});

test('a road drawn each way with different flows lists the worse one, in either order', () => {
  const back = north.slice().reverse();
  const live = (roads) =>
    trafficAnalystRecords({ _enabled: true, _liveMode: true, _roads: roads });
  const free = { level: 1 };
  for (const [worse, expected] of [
    [{ level: 0.1 }, 'jam'],
    [{ level: 0.9, closure: true }, 'closed'],
  ]) {
    for (const roads of [
      [
        { ...road(north), flow: free },
        { ...road(back), flow: worse },
      ],
      [
        { ...road(back), flow: worse },
        { ...road(north), flow: free },
      ],
    ]) {
      const records = live(roads);
      assert.equal(records.length, 1);
      assert.equal(records[0].flow, expected);
      assert.equal(records[0].source, 'tomtom-live');
    }
  }
  const [matched] = live([
    { ...road(north), flow: null },
    { ...road(back), flow: { level: 0.5 } },
  ]);
  assert.equal(matched.simulated, false, 'live flow beats simulated');
  assert.equal(matched.flowPct, 50);
});

test('a segment stands at the same vertex whichever direction is listed', () => {
  const course = [ends[0], [-97.743, 30.268], [-97.741, 30.268], ends[1]];
  const back = course.slice().reverse();
  const [forward] = listed([road(course)]);
  const [reverse] = listed([road(back)]);
  assert.deepEqual(
    { lat: reverse.lat, lon: reverse.lon },
    { lat: forward.lat, lon: forward.lon },
  );
});

test('live flow names its congestion and source; unmatched roads stay simulated', () => {
  const state = {
    _enabled: true,
    _liveMode: true,
    _flowStale: false,
    _roads: [
      { coords, type: 'secondary', oneway: 1, flow: { level: 0.3 } },
      {
        coords: coords.map(([lon, lat]) => [lon + 0.01, lat]),
        type: 'tertiary',
        oneway: 1,
        flow: { level: 0.9, closure: true },
      },
      {
        coords: coords.map(([lon, lat]) => [lon + 0.02, lat]),
        type: 'residential',
        oneway: 1,
        flow: null,
      },
    ],
  };
  const [jam, closed, unmatched] = trafficAnalystRecords(state);
  assert.equal(jam.simulated, false);
  assert.equal(jam.source, 'tomtom-live');
  assert.equal(jam.flowPct, 30);
  assert.ok(['slow', 'jam'].includes(jam.flow));
  assert.equal(closed.flow, 'closed');
  assert.equal(unmatched.simulated, true);
  assert.equal(unmatched.source, 'simulated-unmatched');
  // Hidden uncovered roads are not drawn, so not listed.
  state._uncoveredMode = 'hide';
  assert.equal(trafficAnalystRecords(state).length, 2);
  state._flowStale = true;
  assert.equal(trafficAnalystRecords(state)[0].source, 'tomtom-cached');
});

test('a segment card says where its flow comes from in words it can translate', () => {
  for (const [code, english] of [
    ['tomtom-live', 'TomTom live flow'],
    ['tomtom-cached', 'TomTom flow from saved tiles'],
    ['simulated-unmatched', 'Simulated (no live flow on this road)'],
    ['simulated-keyless', 'Simulated (no TomTom key)'],
  ]) {
    const fact = formatFact('source', code);
    assert.equal(fact.value, english);
    assert.equal(fact.words.text, english, 'a catalog message, not raw text');
  }
});
