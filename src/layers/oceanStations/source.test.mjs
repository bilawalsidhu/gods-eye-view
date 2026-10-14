import test from 'node:test';
import assert from 'node:assert/strict';
import { createOceanStationsSource } from './source.js';

test('createOceanStationsSource fetches and validates snapshot', async () => {
  const mockStations = [
    { id: '41002', lat: 31.759, lon: -74.836, waveHeightM: 2.1, waterTempC: 24.1 },
  ];
  const source = createOceanStationsSource({
    fetchImpl: async (url) => {
      assert.equal(url, '/api/ocean-stations/latest');
      return {
        ok: true,
        status: 200,
        json: async () => ({ stations: mockStations }),
      };
    },
  });

  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].id, '41002');
  assert.equal(snapshot[0].waveHeightM, 2.1);
});

test('createOceanStationsSource throws on HTTP error or malformed response', async () => {
  const httpErrSource = createOceanStationsSource({
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  await assert.rejects(() => httpErrSource.getSnapshot(), /Ocean stations HTTP 502/);

  const malformedSource = createOceanStationsSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ notStations: true }),
    }),
  });
  await assert.rejects(() => malformedSource.getSnapshot(), /Malformed ocean stations response/);
});
