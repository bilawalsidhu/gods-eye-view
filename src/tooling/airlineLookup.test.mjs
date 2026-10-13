import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAirlines } from '../../server/providers/aircraft/enrichment.js';
import { createFlightSource } from '../sources/live/standalone.js';

test('airline lookup admits bounded operator identities and rejects malformed provider results', () => {
  assert.equal(parseAirlines({ response: 'unknown airline' }), null);
  assert.equal(parseAirlines({ response: [{ icao: '../etc' }] }), null);
  const rows = parseAirlines({
    response: Array.from({ length: 100 }, () => ({
      icao: 'BAW',
      iata: 'BA',
      name: 'British Airways',
    })),
  });
  assert.equal(rows.length, 20);
  assert.deepEqual(rows[0], {
    icao: 'BAW',
    iata: 'BA',
    name: 'British Airways',
  });
});

test('standalone flight source routes operator lookups through the existing same-origin enrichment boundary', async () => {
  const calls = [];
  const source = createFlightSource({
    fetchImpl: async (url, options) => {
      calls.push([url, options.signal]);
      return Response.json({
        found: true,
        airlines: [{ icao: 'BAW', iata: 'BA' }],
      });
    },
  });
  const controller = new AbortController();
  const response = await source.getEnrichment(
    { kind: 'airline', id: 'BA' },
    { signal: controller.signal },
  );
  assert.equal(response.airlines[0].icao, 'BAW');
  assert.deepEqual(calls, [['/api/adsbdb/airline/BA', controller.signal]]);
  await assert.rejects(source.getEnrichment({ kind: 'invalid', id: 'BA' }));
});
