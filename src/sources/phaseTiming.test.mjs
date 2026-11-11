import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkTrace, recordWorkSlice } from './phaseTiming.js';

test('unsupported DEV does not create a recorder and absent recording is inert', () => {
  assert.equal(createWorkTrace(), null);
  assert.doesNotThrow(() => recordWorkSlice(null, 'unused', 0));
});

test('work intervals preserve raw endpoints and fail closed on bounded-record loss', () => {
  const trace = { slices: [], dropped: 0 };
  recordWorkSlice(trace, 'ground-step', 100, 123);
  assert.deepEqual(trace.slices[0], {
    phase: 'ground-step',
    start: 100,
    end: 123,
  });
  for (let i = 1; i <= 16; i += 1)
    recordWorkSlice(trace, 'ground-step', 200 + i, 201 + i);
  assert.equal(trace.slices.length, 16);
  assert.equal(trace.dropped, 1);
  assert.deepEqual(trace.slices[0], {
    phase: 'ground-step',
    start: 100,
    end: 123,
  });

  const detail = { index: 0, clampStart: 2, clampEnd: 3 };
  const nested = { slices: [], dropped: 0 };
  recordWorkSlice(nested, 'ground-step', 1, 4, detail);
  assert.deepEqual(nested.slices[0], {
    phase: 'ground-step',
    start: 1,
    end: 4,
    detail,
  });

  const unavailable = { slices: Object.freeze([]), dropped: 0 };
  assert.doesNotThrow(() =>
    recordWorkSlice(unavailable, 'ground-step', 1, 2, detail),
  );
  assert.equal(unavailable.dropped, 1);
});
