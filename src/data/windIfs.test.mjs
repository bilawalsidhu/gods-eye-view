import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ifsObjectUrls,
  parseIfsIndex,
  ifsWindRanges,
  nearestIfsStep,
  selectLatestIfsCycle,
  fetchIfsWind,
} from '../../server/providers/wind/ifs.js';
import { nearestGfsStep } from '../../server/providers/wind/catalog.js';
test('IFS inventory selects only 10 m components and distinct index suffix', () => {
  const urls = ifsObjectUrls({ date: '20260915', hour: 6, step: 9 });
  assert.match(urls.index, /9h-oper-fc\.index$/);
  assert.equal(urls.index.includes('.grib2.index'), false);
  assert.deepEqual(
    ifsWindRanges(
      parseIfsIndex(
        '{"param":"10u","_offset":20,"_length":10}\n{"param":"10v","_offset":40,"_length":15}',
      ),
    ),
    { u: { start: 20, end: 29 }, v: { start: 40, end: 54 } },
  );
  assert.deepEqual(selectLatestIfsCycle(Date.UTC(2026, 8, 15, 4)), {
    date: '20260914',
    hour: 18,
  });
  assert.equal(nearestIfsStep(8, 6), 9);
  assert.equal(nearestIfsStep(200, 6), 144);
  assert.equal(nearestIfsStep(151, 0), 150);
  assert.equal(nearestGfsStep(8.2), 8);
});

test('IFS 2t and msl companions use the same issue/valid object as 10u and 10v', async () => {
  const entries = ['10u', '10v', '2t', 'msl'].map((param, i) => ({
    param,
    _offset: i * 2,
    _length: 2,
  }));
  for (const overlay of ['none', 'temperature', 'pressure']) {
    const calls = [];
    const result = await fetchIfsWind({
      overlay,
      targetDx: 90,
      now: () => Date.UTC(2026, 8, 15, 14),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('.index'))
          return new Response(
            entries.map((entry) => JSON.stringify(entry)).join('\n'),
          );
        const start = Number(/bytes=(\d+)-/.exec(options.headers.Range)[1]);
        return new Response(Uint8Array.of(start, 0), { status: 206 });
      },
      decodeImpl: async (bytes) => ({
        ni: 4,
        nj: 3,
        lo1: 0,
        la1: 90,
        di: 90,
        dj: 90,
        values: new Float64Array(12).fill(
          bytes[0] === 4 ? 283.15 : bytes[0] === 6 ? 100000 : bytes[0],
        ),
        units: bytes[0] === 4 ? 'K' : bytes[0] === 6 ? 'Pa' : 'm/s',
      }),
    });
    assert.equal(calls.length, overlay === 'none' ? 3 : 4);
    assert.equal(new Set(calls.slice(1).map((c) => c.url)).size, 1);
    assert.ok(calls.every((c) => c.options.redirect === 'error'));
    assert.ok(calls[0].url.endsWith('-9h-oper-fc.index'));
    assert.equal(result.cycle.runIso, '2026-09-15T06:00:00.000Z');
    assert.equal(result.cycle.validIso, '2026-09-15T15:00:00.000Z');
    if (overlay === 'none') assert.equal(result.scalar, undefined);
    else
      assert.ok(
        Math.abs(
          result.grid.scalar[0] - (overlay === 'temperature' ? 10 : 1000),
        ) < 0.0001,
      );
  }
  assert.throws(
    () =>
      ifsWindRanges(
        parseIfsIndex(
          entries
            .slice(0, 2)
            .map((entry) => JSON.stringify(entry))
            .join('\n'),
        ),
        { overlay: 'pressure' },
      ),
    /missing msl/,
  );
});

test('IFS optional pressure refusal preserves same-cycle wind', async () => {
  const entries = ['10u', '10v', 'msl'].map((param, i) => ({
    param,
    _offset: i * 2,
    _length: 2,
  }));
  const result = await fetchIfsWind({
    overlay: 'pressure',
    targetDx: 90,
    now: () => Date.UTC(2026, 8, 15, 14),
    fetchImpl: async (url, options) => {
      if (url.endsWith('.index'))
        return new Response(
          entries.map((entry) => JSON.stringify(entry)).join('\n'),
        );
      const start = Number(/bytes=(\d+)-/.exec(options.headers.Range)[1]);
      if (start === 4) return new Response('Unavailable', { status: 503 });
      return new Response(Uint8Array.of(start, 0), { status: 206 });
    },
    decodeImpl: async (bytes) => ({
      ni: 4,
      nj: 3,
      lo1: 0,
      la1: 90,
      di: 90,
      dj: 90,
      values: new Float64Array(12).fill(bytes[0]),
    }),
  });
  assert.equal(result.scalarError, 'Mean sea level pressure field unavailable');
  assert.equal(result.grid.scalar, undefined);
  assert.deepEqual([...result.grid.v], Array(12).fill(2));
  assert.equal(result.cycle.validIso, '2026-09-15T15:00:00.000Z');
});
