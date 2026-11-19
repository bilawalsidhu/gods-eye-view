import test from 'node:test';
import assert from 'node:assert/strict';
import { createVesselSource } from './standalone.js';

const answering = (status, payload) => async () => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  json: async () => payload,
});

test('a vessels server with no AISStream key refuses as key-required, a down feed as unavailable', async () => {
  const keyless = createVesselSource({
    fetchImpl: answering(503, { status: 'missing-key' }),
  });
  await assert.rejects(keyless.getSnapshot(), {
    code: 'key-required',
    message: 'AISSTREAM_API_KEY not set',
  });
  const down = createVesselSource({
    fetchImpl: answering(503, { status: 'error' }),
  });
  await assert.rejects(down.getSnapshot(), {
    code: 'unavailable',
    message: 'feed down',
  });
});
