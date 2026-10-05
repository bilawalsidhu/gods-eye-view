import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTE_STEPS_MAX,
  formatRouteDistance,
  formatRouteDuration,
  instructionFor,
  normalizeOsrmSteps,
  roadLabel,
} from './routeSteps.js';

test('instructions read like a navigator, one sentence per OSRM maneuver', () => {
  assert.equal(
    instructionFor({ type: 'depart', name: 'Kaivokatu' }),
    'Head out on Kaivokatu',
  );
  assert.equal(instructionFor({ type: 'depart' }), 'Head out');
  assert.equal(
    instructionFor({
      type: 'new name',
      modifier: 'straight',
      name: 'Simonkatu',
    }),
    'Continue onto Simonkatu',
  );
  assert.equal(
    instructionFor({
      type: 'end of road',
      modifier: 'left',
      name: 'Annankatu',
    }),
    'At the end of the road, turn left onto Annankatu',
  );
  assert.equal(
    instructionFor({ type: 'turn', modifier: 'right', name: 'Kansakoulukatu' }),
    'Turn right onto Kansakoulukatu',
  );
  assert.equal(
    instructionFor({
      type: 'turn',
      modifier: 'slight left',
      name: 'Ring I',
      ref: 'Kt 50',
    }),
    'Turn slightly left onto Ring I (Kt 50)',
  );
  assert.equal(
    instructionFor({ type: 'turn', modifier: 'uturn' }),
    'Make a U-turn',
  );
  assert.equal(
    instructionFor({
      type: 'roundabout',
      modifier: 'right',
      exit: 2,
      name: 'Malminrinne',
    }),
    'At the roundabout, take the 2nd exit onto Malminrinne',
  );
  assert.equal(
    instructionFor({ type: 'rotary', exit: 1 }),
    'At the roundabout, take the 1st exit',
  );
  assert.equal(
    instructionFor({ type: 'roundabout', exit: 11 }),
    'At the roundabout, take the 11th exit',
  );
  assert.equal(
    instructionFor({ type: 'fork', modifier: 'slight right', ref: 'E12' }),
    'Keep slightly right at the fork onto E12',
  );
  assert.equal(
    instructionFor({ type: 'off ramp', modifier: 'right', name: 'Turunväylä' }),
    'Take the exit on the right onto Turunväylä',
  );
  assert.equal(
    instructionFor({ type: 'on ramp', modifier: 'left' }),
    'Take the ramp on the left',
  );
  assert.equal(
    instructionFor({
      type: 'merge',
      modifier: 'slight left',
      name: 'Länsiväylä',
    }),
    'Merge slightly left onto Länsiväylä',
  );
  assert.equal(
    instructionFor({ type: 'arrive', modifier: 'right' }),
    'Arrive at your destination, on the right',
  );
  assert.equal(
    instructionFor({ type: 'arrive' }),
    'Arrive at your destination',
  );
  assert.equal(
    instructionFor({ type: 'made-up', name: 'X' }),
    'Continue onto X',
  );
  assert.equal(instructionFor(null), 'Continue');
});

test('road label prefers "Name (Ref)" and never repeats a ref already in the name', () => {
  assert.equal(roadLabel({ name: 'Ring I', ref: 'Kt 50' }), 'Ring I (Kt 50)');
  assert.equal(
    roadLabel({ name: 'E12 Turunväylä', ref: 'E12' }),
    'E12 Turunväylä',
  );
  assert.equal(roadLabel({ ref: 'E12' }), 'E12');
  assert.equal(roadLabel({}), '');
});

test('normalizeOsrmSteps flattens legs, folds roundabout exits, and drops steps without a location', () => {
  const route = {
    legs: [
      {
        steps: [
          {
            maneuver: { type: 'depart', location: [24.9384, 60.1699] },
            name: 'Kaivokatu',
            distance: 8.3,
            duration: 1.3,
          },
          {
            maneuver: {
              type: 'roundabout',
              modifier: 'right',
              exit: 2,
              location: [24.9313, 60.1675],
            },
            name: '',
            distance: 34.7,
            duration: 7.3,
          },
          {
            maneuver: {
              type: 'exit roundabout',
              modifier: 'slight right',
              exit: 2,
              location: [24.931, 60.1674],
            },
            name: 'Malminrinne',
            distance: 100.8,
            duration: 17.1,
          },
          {
            maneuver: { type: 'turn', modifier: 'left' },
            name: 'Nowhere',
            distance: 5,
            duration: 1,
          },
        ],
      },
      {
        steps: [
          {
            maneuver: {
              type: 'arrive',
              modifier: 'left',
              location: [24.6559, 60.2055],
            },
            name: 'Kirkkojärventie',
            distance: 0,
            duration: 0,
          },
        ],
      },
    ],
  };
  const { steps, truncated } = normalizeOsrmSteps(route);
  assert.equal(truncated, false, 'a short route is complete');
  assert.deepEqual(
    steps.map((s) => s.type),
    ['depart', 'roundabout', 'arrive'],
  );
  assert.equal(steps[1].distanceM, 136);
  assert.equal(steps[1].durationS, 24);
  assert.equal(
    steps[1].instruction,
    'At the roundabout, take the 2nd exit onto Malminrinne',
  );
  assert.deepEqual(
    steps.map((s) => s.index),
    [0, 1, 2],
  );
  assert.equal(steps[2].instruction, 'Arrive at your destination, on the left');
  assert.equal(steps[0].lon, 24.9384);
  assert.equal(steps[0].lat, 60.1699);
  assert.deepEqual(normalizeOsrmSteps(null), { steps: [], truncated: false });
  assert.deepEqual(normalizeOsrmSteps({ legs: [{ steps: null }] }), {
    steps: [],
    truncated: false,
  });
});

test('the step list is capped, and the cap is reported rather than hidden', () => {
  const many = Array.from({ length: ROUTE_STEPS_MAX + 50 }, (_, i) => ({
    maneuver: { type: 'turn', modifier: 'left', location: [i * 0.001, 0.5] },
    name: `Street ${i}`,
    distance: 10,
    duration: 2,
  }));
  const cut = normalizeOsrmSteps({ legs: [{ steps: many }] });
  assert.equal(cut.steps.length, ROUTE_STEPS_MAX);
  // The arrival step is among the ones dropped; a caller that is not told so
  // would present a route that simply stops in the middle of a road.
  assert.equal(cut.truncated, true);
  const exact = normalizeOsrmSteps({
    legs: [{ steps: many.slice(0, ROUTE_STEPS_MAX - 1) }],
  });
  assert.equal(exact.steps.length, ROUTE_STEPS_MAX - 1);
  assert.equal(exact.truncated, false, 'a route that fits is not cut');
});

test('distance and duration formatting', () => {
  assert.equal(formatRouteDistance(8), '8 m');
  assert.equal(formatRouteDistance(846), '850 m');
  assert.equal(formatRouteDistance(1234), '1.2 km');
  assert.equal(formatRouteDistance(21479), '21 km');
  assert.equal(formatRouteDistance(-1), '');
  assert.equal(formatRouteDuration(40), '40 s');
  assert.equal(formatRouteDuration(1478), '25 min');
  assert.equal(formatRouteDuration(3900), '1 h 5 min');
  assert.equal(formatRouteDuration(7200), '2 h');
  assert.equal(formatRouteDuration(NaN), '');
});
