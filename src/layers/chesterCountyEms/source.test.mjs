import test from 'node:test';
import assert from 'node:assert/strict';
import { createChesterCountyEmsSource } from './source.js';
const details = {
  incidentNumber: 'F26000001',
  observedAt: Date.now(),
  units: [
    { unit: 'MEDIC01', status: 'On Scene', entered: '11-03-2026 10:05:00' },
  ],
};
test('unit details use only the local incident-id endpoint and forward cancellation', async () => {
  let url, signal;
  const source = createChesterCountyEmsSource({
    fetchImpl: async (input, options) => {
      url = input;
      signal = options.signal;
      return Response.json(details);
    },
  });
  const controller = new AbortController();
  assert.deepEqual(
    await source.getIncidentDetails('ems:F26000001', {
      signal: controller.signal,
    }),
    details,
  );
  assert.equal(url, '/api/chester-county-ems/details?incident=ems%3AF26000001');
  controller.abort();
  assert.equal(signal.aborted, true);
});
test('malformed, oversized, mismatched and failed unit replies are refused', async () => {
  for (const response of [
    () => new Response('', { status: 502 }),
    () => new Response('x', { headers: { 'content-length': '999999' } }),
    () => Response.json({ ...details, incidentNumber: 'F26000002' }),
    () => Response.json({ ...details, units: [{}] }),
    () =>
      Response.json({
        ...details,
        units: Array.from({ length: 129 }, () => details.units[0]),
      }),
  ])
    await assert.rejects(
      createChesterCountyEmsSource({
        fetchImpl: async () => response(),
      }).getIncidentDetails('ems:F26000001'),
    );
});
