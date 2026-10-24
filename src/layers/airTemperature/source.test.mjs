import test from 'node:test';
import assert from 'node:assert/strict';
import { createAirTemperatureSource } from './source.js';
import { manifest } from './fixtures.mjs';
import { install } from '../../data/airTemperatureProxy.fixtures.mjs';

test('source decodes the real provider binary in signed little-endian Celsius', async () => {
  // Given
  const server = install();
  const source = createAirTemperatureSource({
    fetchImpl: async (url) => {
      const response = await server.request(url);
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  // When
  const snapshot = await source.getSnapshot();
  // Then
  assert.deepEqual(
    [...snapshot.scalar.values].map((v) => Math.round(v * 100)),
    [-1234, 0, 600, 4567],
  );
  assert.equal(snapshot.scalar.units, '°C');
  assert.equal(snapshot.cycle.forecastHour, 6);
});

for (const patch of [
  { schemaVersion: 2 },
  { units: 'K' },
  { model: 'ifs' },
  { gridUrl: 'https://example.com/grid.bin' },
  { gridUrl: '/api/air-temperature/grid/../secret.bin' },
  { grid: { ...manifest.grid, nx: 1e9 } },
  { grid: { ...manifest.grid, scale: 1 } },
  { grid: { ...manifest.grid, dy: -180 } },
  { cycle: { ...manifest.cycle, forecastHour: 6 } },
])
  test(`source refuses an invalid manifest before requesting its grid: ${JSON.stringify(patch)}`, async () => {
    // Given
    const urls = [];
    const source = createAirTemperatureSource({
      fetchImpl: async (url) => {
        urls.push(url);
        return Response.json({ ...manifest, ...patch });
      },
    });
    // When / Then
    await assert.rejects(source.getSnapshot(), /Malformed/);
    assert.equal(urls.length, 1);
  });

test('source refuses a truncated binary', async () => {
  // Given
  const source = createAirTemperatureSource({
    fetchImpl: async (url) =>
      url.endsWith('/manifest')
        ? Response.json(manifest)
        : new Response(new Uint8Array(6)),
  });
  // When / Then
  await assert.rejects(source.getSnapshot(), /Malformed/);
});

test('unavailable source preserves the provider status without a grid request', async () => {
  // Given
  const source = createAirTemperatureSource({
    fetchImpl: async () =>
      Response.json({
        ...manifest,
        unavailable: true,
        stale: true,
        reason: 'Air temperature upstream unavailable',
      }),
  });
  // When
  const result = await source.getSnapshot();
  // Then
  assert.equal(result.unavailable, true);
  assert.equal(result.scalar, undefined);
});

test('caller cancellation reaches the active fetch', async () => {
  // Given
  const caller = new AbortController();
  let active;
  const source = createAirTemperatureSource({
    fetchImpl: (_, { signal }) => {
      active = signal;
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  // When
  const pending = source.getSnapshot({ signal: caller.signal });
  caller.abort();
  // Then
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(active.aborted, true);
});
