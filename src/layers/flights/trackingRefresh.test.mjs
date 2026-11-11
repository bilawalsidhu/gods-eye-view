import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracking } from './tracking.js';

function handoff(update) {
  return createTracking({
    flightState: {
      enabled: true,
    },
    services: Object.fromEntries(
      [
        'context',
        'aircraftPresentation',
        'geoid',
        'groundFloor',
        'focus',
        'militaryRegistry',
        'readout',
        'selection',
      ].map((name) => [name, {}]),
    ),
    parts: {},
    layer: { update },
  });
}

test('a military-off refresh owns cancellation when flights are disabled before it settles', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (error) => errors.push(error));
  let reject,
    calls = 0;
  const tracking = handoff(() => {
    calls++;
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  });
  tracking._onMilitaryActiveChange(false);
  assert.equal(calls, 1);
  reject(new DOMException('Flights update aborted', 'AbortError'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
});

test('unexpected military-off refresh failures remain visible instead of being swallowed', async (t) => {
  const error = new Error('fixture update failure');
  const errors = [];
  t.mock.method(console, 'error', (value) => errors.push(value));
  handoff(async () => {
    throw error;
  })._onMilitaryActiveChange(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [error]);
});
