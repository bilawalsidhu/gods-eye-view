import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOsrmSteps, ROUTE_STEPS_MAX } from './routeSteps.js';
const step = (type) => ({
  maneuver: { type, location: [10, 20] },
  distance: 10,
  duration: 1,
});
test('exact-cap routes remain complete and boundary exits retain their distance', () => {
  const steps = Array.from({ length: ROUTE_STEPS_MAX }, () => step('turn'));
  assert.equal(normalizeOsrmSteps({ legs: [{ steps }] }).truncated, false);
  assert.equal(
    normalizeOsrmSteps({ legs: [{ steps: [...steps, step('turn')] }] })
      .truncated,
    true,
  );
  steps[steps.length - 1] = step('roundabout');
  const result = normalizeOsrmSteps({
    legs: [{ steps: [...steps, step('exit roundabout')] }],
  });
  assert.equal(result.truncated, false);
  assert.equal(result.steps.length, ROUTE_STEPS_MAX);
  assert.equal(result.steps.at(-1).distanceM, 20);
});
