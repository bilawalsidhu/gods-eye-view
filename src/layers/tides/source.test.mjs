import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoaaTideSource, normalizeTidePayload } from './source.js';

const payload = {
  schemaVersion: 1,
  station: '9413745',
  predictions: [
    { time: '2026-10-01T10:21:00.000Z', height: 1.073, type: 'H' },
    { time: '2026-10-01T14:08:00.000Z', height: 0.893, type: 'L' },
  ],
};

test('the source asks the local proxy and returns sorted turning points', async () => {
  const calls = [];
  const source = createNoaaTideSource({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const result = await source.getPredictions({
    stationId: '9413745',
    beginMs: Date.parse('2026-10-01T00:00:00Z'),
    endMs: Date.parse('2026-10-03T00:00:00Z'),
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/api\/tides\?station=9413745&begin=2026-10-01T00/);
  assert.deepEqual(result.turns.map((t) => t.type), ['H', 'L']);
});

test('malformed or mismatched payloads are rejected', () => {
  assert.throws(() => normalizeTidePayload(payload, '9414290'));
  assert.throws(() =>
    normalizeTidePayload(
      { ...payload, predictions: [...payload.predictions].reverse() },
      '9413745',
    ),
  );
  assert.throws(() =>
    normalizeTidePayload(
      {
        ...payload,
        predictions: [payload.predictions[0], { time: 'x', height: 1, type: 'H' }],
      },
      '9413745',
    ),
  );
});

test('bad requests never reach the network', async () => {
  const source = createNoaaTideSource({
    fetchImpl: () => assert.fail('fetched'),
  });
  await assert.rejects(
    source.getPredictions({ stationId: '../x', beginMs: 0, endMs: 1 }),
    TypeError,
  );
  await assert.rejects(
    source.getPredictions({ stationId: '9413745', beginMs: 2, endMs: 1 }),
    TypeError,
  );
});
