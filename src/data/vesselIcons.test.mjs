import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  vesselIconFamily,
  vesselIconSvg,
  vesselIconScale,
  vesselMotionCourse,
} from './vesselIcons.js';

test('moving vessels point along COG even when heading disagrees', () => {
  assert.equal(
    vesselMotionCourse({ speed: 10.2, course: 36, heading: 275 }),
    36,
  );
  assert.equal(
    vesselMotionCourse({ speed: 4.9, course: 222.1, heading: 64 }),
    222.1,
  );
  assert.equal(vesselMotionCourse({ speed: 1, course: 0, heading: 180 }), 0);
  assert.equal(vesselMotionCourse({ speed: 0, course: 36, heading: 275 }), 275);
  assert.equal(vesselMotionCourse({ speed: 10, course: 360, heading: 90 }), 90);
  assert.equal(
    vesselMotionCourse({ speed: 10, course: 270, heading: 511 }),
    270,
  );
  assert.equal(
    vesselMotionCourse({ speed: 0, course: null, heading: null }),
    null,
  );
});

test('zoom scaling stays bounded, continuous and larger for tankers', () => {
  const heights = [
    0, 2_000, 10_000, 100_000, 1_000_000, 5_000_000, 20_000_000, 100_000_000,
  ];
  const sizes = heights.map((height) => vesselIconScale('Cargo', height) * 64);
  assert.deepEqual(sizes, [44, 44, 40, 32, 24, 18, 14, 14]);
  for (const height of heights) {
    assert.ok(
      vesselIconScale('Tanker', height) > vesselIconScale('Cargo', height),
    );
  }
  for (const height of heights.slice(1, -1)) {
    assert.ok(
      Math.abs(
        vesselIconScale('Cargo', height - 1) -
          vesselIconScale('Cargo', height + 1),
      ) < 0.001,
    );
  }
  assert.equal(
    vesselIconScale('Cargo', NaN),
    vesselIconScale('Cargo', 100_000),
  );
});

test('reported numeric and descriptive AIS types choose matching silhouettes', () => {
  for (const [code, text, family] of [
    ['71', 'Container Ship', 'cargo'],
    ['84', 'Crude Oil Tanker', 'tanker'],
    ['62', 'Passenger/Ferry', 'passenger'],
    ['30', 'Fishing', 'fishing'],
    ['36', 'Sailing', 'sailing'],
    ['37', 'Yacht', 'pleasure'],
    ['52', 'Tug', 'service'],
    ['51', 'SAR', 'service'],
    ['35', 'Military', 'military'],
  ]) {
    assert.equal(vesselIconFamily(code), family);
    assert.equal(vesselIconFamily(text), family);
  }
  for (const missing of ['', undefined, '0', '40', '99', 'unreported'])
    assert.equal(vesselIconFamily(missing), 'unknown');
});

test('same-colored and selected vessels retain distinct family silhouettes', () => {
  assert.notEqual(vesselIconSvg('71'), vesselIconSvg('0'));
  assert.notEqual(vesselIconSvg('71', true), vesselIconSvg('84', true));
  assert.match(vesselIconSvg('84', true), /stroke="#ffffff"/);
  assert.match(vesselIconSvg('84', true), /fill="#ffb347"/);
  assert.match(vesselIconSvg('84'), /fill="#ffb347"/);
  assert.doesNotMatch(vesselIconSvg('<script>alert(1)</script>'), /<script>/);
});
