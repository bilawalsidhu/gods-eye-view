import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSpeedCameraQuery,
  normalizeSpeedCameraNode,
  parseMaxspeedKph,
  snapSpeedCameraBox,
  boxContains,
  validateSpeedCameraSnapshot,
  normalizeDirection,
} from './records.js';

test('normalizeSpeedCameraNode keeps tagged nodes with coordinates', () => {
  const record = normalizeSpeedCameraNode({
    type: 'node',
    id: 21475863,
    lat: -27.5973715,
    lon: 152.8353603,
    tags: {
      highway: 'speed_camera',
      maxspeed: '100',
      direction: '205',
      ref: '726532001',
    },
  });
  assert.deepEqual(record, {
    id: 'speed-camera:21475863',
    osmId: 21475863,
    latitude: -27.5973715,
    longitude: 152.8353603,
    directionDeg: 205,
    maxspeedKph: 100,
    enforcement: null,
    operator: null,
    ref: '726532001',
    lastVerified: null,
    source: null,
  });
});

test('normalizeSpeedCameraNode drops foreign and unusable elements', () => {
  assert.equal(normalizeSpeedCameraNode(null), null);
  assert.equal(
    normalizeSpeedCameraNode({
      type: 'node',
      id: 1,
      lat: 0,
      lon: 0,
      tags: { highway: 'surveillance' },
    }),
    null,
  );
  assert.equal(
    normalizeSpeedCameraNode({
      type: 'way',
      id: 2,
      lat: 0,
      lon: 0,
      tags: { highway: 'speed_camera' },
    }),
    null,
  );
  assert.equal(
    normalizeSpeedCameraNode({
      type: 'node',
      id: 3,
      lat: 91,
      lon: 0,
      tags: { highway: 'speed_camera' },
    }),
    null,
  );
  assert.equal(
    normalizeSpeedCameraNode({
      type: 'node',
      id: 4,
      lat: 0,
      lon: 0,
      tags: {},
    }),
    null,
  );
});

test('parseMaxspeedKph reads km/h, mph and rejects junk', () => {
  assert.equal(parseMaxspeedKph('100'), 100);
  assert.equal(parseMaxspeedKph(' 60 '), 60);
  assert.equal(parseMaxspeedKph('60mph'), 97);
  assert.equal(parseMaxspeedKph('30 mph'), 48);
  assert.equal(parseMaxspeedKph('walk'), null);
  assert.equal(parseMaxspeedKph('none'), null);
  assert.equal(parseMaxspeedKph(''), null);
  assert.equal(parseMaxspeedKph(null), null);
  assert.equal(parseMaxspeedKph('0'), null);
});

test('normalizeDirection parses numeric bearings only', () => {
  assert.equal(normalizeDirection('205'), 205);
  assert.equal(normalizeDirection(359.5), 359.5);
  assert.equal(normalizeDirection(360), 0);
  assert.equal(normalizeDirection(-10), null);
  assert.equal(normalizeDirection('NE'), null);
  assert.equal(normalizeDirection(''), null);
});

test('buildSpeedCameraQuery pins the query shape', () => {
  assert.equal(
    buildSpeedCameraQuery(-27.7, 152.8, -27.2, 153.3),
    '[out:json][timeout:20];node["highway"="speed_camera"]' +
      '(-27.7,152.8,-27.2,153.3);out body 1500;',
  );
});

test('snapSpeedCameraBox snaps outward and clamps', () => {
  const box = snapSpeedCameraBox({
    south: -27.513,
    west: 152.987,
    north: -27.489,
    east: 153.011,
  });
  assert.ok(Math.abs(box.south - -27.55) < 1e-9);
  assert.ok(Math.abs(box.west - 152.95) < 1e-9);
  assert.ok(Math.abs(box.north - -27.45) < 1e-9);
  assert.ok(Math.abs(box.east - 153.05) < 1e-9);
  const clamped = snapSpeedCameraBox({
    south: -90.02,
    west: -180.02,
    north: -89.9,
    east: -179.9,
  });
  assert.equal(clamped.south, -90);
  assert.equal(clamped.west, -180);
});

test('boxContains accepts nested boxes and rejects overhang', () => {
  const outer = { south: -28, west: 152, north: -27, east: 153 };
  assert.equal(
    boxContains(outer, { south: -27.5, west: 152.5, north: -27.2, east: 152.8 }),
    true,
  );
  assert.equal(
    boxContains(outer, { south: -28.5, west: 152.5, north: -27.2, east: 152.8 }),
    false,
  );
  assert.equal(boxContains(null, outer), false);
});

test('validateSpeedCameraSnapshot rejects malformed payloads', () => {
  assert.throws(
    () => validateSpeedCameraSnapshot({ records: [] }),
    TypeError,
  );
  assert.throws(
    () => validateSpeedCameraSnapshot({ records: 'x', stale: false, saturated: false }),
    TypeError,
  );
  assert.throws(
    () =>
      validateSpeedCameraSnapshot({
        records: [{ id: 'a', latitude: 91, longitude: 0 }],
        stale: false,
        saturated: false,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      validateSpeedCameraSnapshot({
        records: [
          { id: 'a', latitude: 1, longitude: 1 },
          { id: 'a', latitude: 2, longitude: 2 },
        ],
        stale: false,
        saturated: false,
      }),
    TypeError,
  );
  const ok = {
    records: [
      {
        id: 'speed-camera:1',
        latitude: -27.5,
        longitude: 152.9,
        directionDeg: 205,
        maxspeedKph: 100,
      },
    ],
    stale: false,
    saturated: false,
  };
  assert.equal(validateSpeedCameraSnapshot(ok), ok);
});
