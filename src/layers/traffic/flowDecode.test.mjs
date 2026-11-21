import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import { decodeFlowTile } from './flowDecode.js';
import { flowSegmentsToRoads, isDrivableFlowSegment } from './roadModes.js';

/**
 * One "Traffic flow" layer; each feature is a two-point line carrying the
 * given properties (string, number or boolean values).
 */
function flowTile(features) {
  const keys = [];
  const values = [];
  const tags = features.map((props) =>
    Object.entries(props).flatMap(([key, value]) => {
      if (!keys.includes(key)) keys.push(key);
      values.push(value);
      return [keys.indexOf(key), values.length - 1];
    }),
  );
  const writer = new PbfWriter();
  writer.writeMessage(
    3,
    (_, layer) => {
      layer.writeVarintField(15, 2);
      layer.writeStringField(1, 'Traffic flow');
      layer.writeVarintField(5, 4096);
      for (const key of keys) layer.writeStringField(3, key);
      for (const value of values)
        layer.writeMessage(
          4,
          (_, out) => {
            if (typeof value === 'string') out.writeStringField(1, value);
            else if (typeof value === 'boolean')
              out.writeBooleanField(7, value);
            else out.writeDoubleField(3, value);
          },
          null,
        );
      tags.forEach((featureTags, i) =>
        layer.writeMessage(
          2,
          (_, feature) => {
            feature.writeVarintField(3, 2);
            feature.writePackedVarint(2, featureTags);
            // MoveTo (100, 100 + i), LineTo +200 east.
            feature.writePackedVarint(4, [9, 200, 200 + 2 * i, 10, 400, 0]);
          },
          null,
        ),
      );
    },
    null,
  );
  return writer.finish();
}
const decode = (features) => decodeFlowTile(flowTile(features), 12, 935, 1686);

test('TomTom Maps flow features decode as before', () => {
  const [segment] = decode([
    {
      traffic_level: 0.6,
      road_type: 'Major road',
      road_category: 'primary',
      traffic_road_coverage: 'full',
    },
  ]);
  assert.equal(segment.trafficLevel, 0.6);
  assert.equal(segment.roadType, 'Major road');
  assert.equal(segment.roadCategory, 'primary');
  assert.equal(segment.coverage, 'full');
  // A TomTom Maps line with no coverage tag still reports none.
  assert.equal(
    decode([{ traffic_level: 1, road_type: 'Motorway' }])[0].coverage,
    null,
  );
});

test('Orbis flow features decode into the TomTom Maps road vocabulary', () => {
  const segments = decode([
    { relative_speed: 0.42, road_category: 'motorway' },
    { relative_speed: 0.9, road_category: 'trunk_link' },
    {
      relative_speed: 0.7,
      road_category: 'street',
      road_subcategory: 'residential',
      left_hand_traffic: true,
    },
    { relative_speed: 1.4, road_category: 'tertiary' },
    { road_category: 'secondary', road_closure: true },
  ]);
  assert.deepEqual(
    segments.map((s) => [s.roadType, s.roadCategory, s.trafficLevel]),
    [
      ['Motorway', 'motorway', 0.42],
      ['International road', 'trunk', 0.9],
      ['Local road', 'street', 0.7],
      ['Connecting road', 'tertiary', 1], // clamped like traffic_level
      ['Secondary road', 'secondary', 0], // closures need no speed
    ],
  );
  assert.equal(segments[2].roadSubcategory, 'residential');
  assert.equal(segments[2].leftHandTraffic, true);
  assert.equal(segments[4].closure, true);
  // Orbis draws one line per travel direction.
  assert.ok(segments.every((s) => s.coverage === 'one_side'));
  assert.ok(segments.every(isDrivableFlowSegment));
  assert.deepEqual(
    flowSegmentsToRoads(segments).map((road) => [road.type, road.oneway]),
    [
      ['motorway', 1],
      ['trunk', 1],
      ['residential', 1],
      ['tertiary', 1],
      ['secondary', 1],
    ],
  );
});

test('Orbis service roads, tracks and speedless lines never become traffic', () => {
  const segments = decode([
    { relative_speed: 0.5, road_category: 'service' },
    { relative_speed: 0.5, road_category: 'track' },
    { relative_speed: 0.5 },
    { road_category: 'primary' }, // no speed and not closed: nothing to draw
  ]);
  assert.deepEqual(
    segments.map((s) => [s.roadType, s.roadCategory]),
    [
      ['', 'service'],
      ['', 'track'],
      ['', null],
    ],
  );
  assert.equal(segments.filter(isDrivableFlowSegment).length, 0);
});
