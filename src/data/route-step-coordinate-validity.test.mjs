import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOsrmSteps } from './routeSteps.js';
test('bad upstream step coordinates never invent a location', () => {
  const positions = [
    [181, 30],
    [0, 91],
    [NaN, 0],
    [0, Infinity],
    [0],
    null,
    [0, 0],
    [-97, 30],
  ];
  const route = {
    legs: [
      {
        steps: positions.map((location) => ({
          maneuver: { type: 'turn', modifier: 'left', location },
          distance: 10,
          duration: 1,
        })),
      },
    ],
  };
  const result = normalizeOsrmSteps(route);
  assert.deepEqual(
    result.steps.map(({ lon, lat }) => [lon, lat]),
    [
      [0, 0],
      [-97, 30],
    ],
  );
  assert.deepEqual(
    result.steps.map((s) => s.index),
    [0, 1],
  );
});
