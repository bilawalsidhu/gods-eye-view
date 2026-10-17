import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindSource } from './source.js';
const manifest = {
  model: 'gfs',
  grid: { nx: 2, ny: 1, lo1: 0, la1: 90, dx: 180, dy: 180 },
  gridUrl: '/api/wind/grid/gfs-test.bin?model=gfs',
};
const response = (value) =>
  new Response(
    typeof value === 'object' && !(value instanceof ArrayBuffer)
      ? JSON.stringify(value)
      : value,
  );
test('wind source splits a bounded field and preserves unavailable responses', async () => {
  const source = createWindSource({
    fetchImpl: async (url) =>
      response(
        url.includes('manifest')
          ? manifest
          : Float32Array.from([1, 2, 3, 4]).buffer,
      ),
  });
  const field = await source.getSnapshot();
  assert.deepEqual([...field.u], [1, 2]);
  assert.deepEqual([...field.v], [3, 4]);
  const unavailable = createWindSource({
    fetchImpl: async () => response({ unavailable: true }),
  });
  assert.equal((await unavailable.getSnapshot()).unavailable, true);
});
test('wind source rejects foreign URLs, excessive grids and non-finite values', async () => {
  for (const bad of [
    { ...manifest, gridUrl: 'https://example.com/exfil' },
    { ...manifest, grid: { ...manifest.grid, nx: 1e9 } },
  ]) {
    let calls = 0;
    const source = createWindSource({
      fetchImpl: async () => {
        calls++;
        return response(bad);
      },
    });
    await assert.rejects(source.getSnapshot(), /Malformed/);
    assert.equal(calls, 1);
  }
  const source = createWindSource({
    fetchImpl: async (url) =>
      response(
        url.includes('manifest')
          ? manifest
          : Float32Array.from([NaN, 2, 3, 4]).buffer,
      ),
  });
  await assert.rejects(source.getSnapshot(), /Malformed/);
});
test('wind source timeout aborts the underlying fetch', async () => {
  const source = createWindSource({
    timeoutMs: 5,
    fetchImpl: (_, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  });
  await assert.rejects(source.getSnapshot(), /timed out/);
});

test('wind source requests optional companions and splits exact U/V/scalar byte regions', async () => {
  for (const [overlay, units, level, expected] of [
    ['temperature', '°C', '2 m above ground', [-5, 25]],
    ['pressure', 'hPa', 'mean sea level', [995, 1025]],
  ]) {
    const scalar = { kind: overlay, units, level };
    const variant = {
      ...manifest,
      overlay,
      scalar,
      gridUrl: `/api/wind/grid/gfs-test-${overlay}.bin?model=gfs&overlay=${overlay}`,
    };
    const calls = [];
    const source = createWindSource({
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return response(
          url.includes('/manifest?')
            ? variant
            : Float32Array.from([1, 2, 3, 4, ...expected]).buffer,
        );
      },
    });
    const field = await source.getSnapshot({ overlay });
    assert.equal(
      calls[0].url,
      `/api/wind/manifest?model=gfs&overlay=${overlay}`,
    );
    assert.equal(calls[1].url, variant.gridUrl);
    assert.ok(calls.every((call) => call.options.redirect === 'error'));
    assert.deepEqual([...field.u], [1, 2]);
    assert.deepEqual([...field.v], [3, 4]);
    assert.deepEqual([...field.scalar.values], expected);
    assert.equal(field.scalar.units, units);
    assert.equal(field.scalar.level, level);
  }
});

test('wind source rejects scalar contract mismatches before fetching a grid', async () => {
  const base = {
    ...manifest,
    overlay: 'temperature',
    scalar: { kind: 'temperature', units: '°C', level: '2 m above ground' },
    gridUrl:
      '/api/wind/grid/gfs-test-temperature.bin?model=gfs&overlay=temperature',
  };
  for (const bad of [
    { ...base, overlay: 'pressure' },
    { ...base, scalar: { ...base.scalar, units: 'K' } },
    { ...base, scalar: { ...base.scalar, level: 'surface' } },
    { ...base, scalar: undefined },
    {
      ...base,
      gridUrl: base.gridUrl.replace('overlay=temperature', 'overlay=pressure'),
    },
    { ...base, gridUrl: `https://example.com${base.gridUrl}` },
  ]) {
    let calls = 0;
    const source = createWindSource({
      fetchImpl: async () => {
        calls++;
        return response(bad);
      },
    });
    await assert.rejects(
      source.getSnapshot({ overlay: 'temperature' }),
      /Malformed/,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const source = createWindSource({
    fetchImpl: async () => {
      calls++;
      return response(base);
    },
  });
  await assert.rejects(source.getSnapshot({ overlay: 'humidity' }), /Unknown/);
  assert.equal(calls, 0);
  await assert.rejects(
    source.getSnapshot(),
    /Malformed/,
    'wind-only does not accept an unsolicited scalar',
  );
});

test('wind source bounds optional scalar length and rejects non-finite scalar values', async () => {
  const variant = {
    ...manifest,
    overlay: 'pressure',
    scalar: { kind: 'pressure', units: 'hPa', level: 'mean sea level' },
    gridUrl: '/api/wind/grid/gfs-test-pressure.bin?model=gfs&overlay=pressure',
  };
  for (const values of [
    [1, 2, 3, 4],
    [1, 2, 3, 4, 1000, 1001, 1002],
    [1, 2, 3, 4, NaN, 1000],
  ]) {
    const source = createWindSource({
      fetchImpl: async (url) =>
        response(
          url.includes('manifest') ? variant : Float32Array.from(values).buffer,
        ),
    });
    await assert.rejects(
      source.getSnapshot({ overlay: 'pressure' }),
      /Malformed|budget/,
    );
  }
});

test('cancelling an optional scalar stream cancels the active grid body', async () => {
  const variant = {
    ...manifest,
    overlay: 'pressure',
    scalar: { kind: 'pressure', units: 'hPa', level: 'mean sea level' },
    gridUrl: '/api/wind/grid/gfs-test-pressure.bin?model=gfs&overlay=pressure',
  };
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  const source = createWindSource({
    fetchImpl: async (url) => {
      if (url.includes('manifest')) return response(variant);
      return new Response(
        new ReadableStream({
          start() {
            started();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  const controller = new AbortController();
  const result = source.getSnapshot({
    overlay: 'pressure',
    signal: controller.signal,
  });
  await ready;
  await Promise.resolve();
  controller.abort(new Error('overlay changed'));
  await assert.rejects(result, /overlay changed/);
  assert.equal(cancelled, true);
});

test('wind source retains usable wind when the requested scalar is unavailable', async () => {
  for (const overlay of ['temperature', 'pressure']) {
    const partial = {
      ...manifest,
      overlay,
      scalarError:
        overlay === 'temperature'
          ? 'Temperature field unavailable'
          : 'Mean sea level pressure field unavailable',
      gridUrl: `/api/wind/grid/gfs-test-${overlay}-wind-only.bin?model=gfs&overlay=${overlay}`,
    };
    const source = createWindSource({
      fetchImpl: async (url) =>
        response(
          url.includes('manifest')
            ? partial
            : Float32Array.from([1, 2, 3, 4]).buffer,
        ),
    });
    const result = await source.getSnapshot({ overlay });
    assert.equal(result.scalar, undefined);
    assert.equal(result.scalarError, partial.scalarError);
    assert.deepEqual([...result.u], [1, 2]);
    assert.deepEqual([...result.v], [3, 4]);
  }
});
