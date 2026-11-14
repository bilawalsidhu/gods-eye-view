import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraLabelPolicy,
  detectionLabelVisibleAtAltitude,
  limitCameraLabelCandidates,
} from './detectionPolicy.js';

test('camera names hide beyond city zoom and tighten independently of other labels', () => {
  assert.equal(detectionLabelVisibleAtAltitude('CAM', 29999), true);
  for (const height of [30000, 100000, 1500000, NaN, undefined])
    assert.equal(detectionLabelVisibleAtAltitude('CAM', height), false);
  assert.equal(cameraLabelPolicy(500).limit, 17);
  assert.equal(cameraLabelPolicy(5000).limit, 15);
  assert.equal(cameraLabelPolicy(15000).limit, 12);
  assert.equal(cameraLabelPolicy(30000).limit, 0);
  for (const type of ['AIR', 'SAT', 'VESSEL', 'QUAKE'])
    assert.equal(detectionLabelVisibleAtAltitude(type, 1500000), true);
});

test('dense camera callouts have their own stable, spaced budget and release it on zoom out', () => {
  const cameras = Array.from({ length: 40 }, (_, i) => ({
    type: 'CAM',
    key: `camera-${i}`,
    screenX: (i % 8) * 220,
    screenY: Math.floor(i / 8) * 220,
    centerDistance: i,
  }));
  const air = { type: 'AIR', key: 'aircraft' };
  const input = [...cameras, air];
  for (const [height, count] of [
    [500, 17],
    [7500, 15],
    [20000, 12],
    [30000, 0],
  ]) {
    const admitted = limitCameraLabelCandidates(input, height);
    assert.equal(admitted.filter((c) => c.type === 'CAM').length, count);
    assert.ok(admitted.includes(air));
  }
  const stable = limitCameraLabelCandidates(
    input,
    7500,
    new Set(['camera-39']),
  );
  assert.ok(
    stable.includes(cameras[39]),
    'an incumbent remains through a density reduction',
  );
  assert.deepEqual(
    limitCameraLabelCandidates([...input].reverse(), 7500)
      .filter((c) => c.type === 'CAM')
      .map((c) => c.key)
      .sort(),
    limitCameraLabelCandidates(input, 7500)
      .filter((c) => c.type === 'CAM')
      .map((c) => c.key)
      .sort(),
  );
  const overlap = cameras
    .slice(0, 3)
    .map((c) => ({ ...c, screenX: 100, screenY: 100 }));
  assert.equal(limitCameraLabelCandidates(overlap, 2500).length, 1);
  assert.equal(limitCameraLabelCandidates([air], 1000000)[0], air);
});
