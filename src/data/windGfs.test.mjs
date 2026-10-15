import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gfsObjectKey,
  selectLatestGfsCycle,
} from '../../server/providers/wind/catalog.js';
import {
  parseGfsIdx,
  windMessageRanges,
  fetchRange,
  fetchGfsWind,
  loadOptionalScalar,
} from '../../server/providers/wind/gfs.js';
test('catalog and index helpers', async () => {
  assert.equal(
    gfsObjectKey({ date: '20260914', hour: 6, forecastHour: 3 }),
    'gfs.20260914/06/atmos/gfs.t06z.pgrb2.0p25.f003',
  );
  assert.deepEqual(selectLatestGfsCycle(Date.UTC(2026, 8, 15, 4)), {
    date: '20260914',
    hour: 18,
  });
  const p = parseGfsIdx(
    '1:10:d=x:UGRD:10 m above ground:anl:\n2:20:d=x:VGRD:10 m above ground:anl:\n3:30:d=x:X:y:z',
  );
  assert.deepEqual(windMessageRanges(p), {
    u: { start: 10, end: 19 },
    v: { start: 20, end: 29 },
  });
  const b = await fetchRange({
    url: 'x',
    start: 0,
    end: 2,
    fetchImpl: async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  });
  assert.deepEqual([...b], [1, 2, 3]);
  assert.throws(() => windMessageRanges({ messages: p.messages.slice(0, 1) }));
});

test('wind range fetch rejects invalid offsets and caps chunked bodies', async () => {
  await assert.rejects(
    fetchRange({ url: 'x', start: -1, end: 2 }),
    /range too large/,
  );
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(10));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchRange({
      url: 'x',
      start: 0,
      end: 2,
      fetchImpl: async () => new Response(body, { status: 206 }),
    }),
    /budget/,
  );
  assert.equal(cancelled, true);
});

const WEATHER_IDX = [
  '1:0:d=2026091506:UGRD:10 m above ground:6 hour fcst:',
  '2:2:d=2026091506:VGRD:10 m above ground:6 hour fcst:',
  '3:4:d=2026091506:TMP:850 mb:6 hour fcst:',
  '4:6:d=2026091506:TMP:2 m above ground:6 hour fcst:',
  '5:8:d=2026091506:PRMSL:mean sea level:6 hour fcst:',
  '6:10:d=2026091506:HGT:surface:6 hour fcst:',
].join('\n');

test('GFS overlays select exact levels from the same issue and forecast object', async () => {
  assert.deepEqual(
    windMessageRanges(parseGfsIdx(WEATHER_IDX), { overlay: 'temperature' })
      .scalar,
    { start: 6, end: 7 },
  );
  assert.deepEqual(
    windMessageRanges(parseGfsIdx(WEATHER_IDX), { overlay: 'pressure' }).scalar,
    { start: 8, end: 9 },
  );
  for (const overlay of ['none', 'temperature', 'pressure']) {
    const calls = [];
    const result = await fetchGfsWind({
      overlay,
      targetDx: 90,
      now: () => Date.UTC(2026, 8, 15, 12),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('.idx')) return new Response(WEATHER_IDX);
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
          bytes[0] === 6 ? 293.15 : bytes[0] === 8 ? 101325 : bytes[0],
        ),
        units: bytes[0] === 6 ? 'K' : bytes[0] === 8 ? 'Pa' : 'm/s',
      }),
    });
    assert.equal(calls.length, overlay === 'none' ? 3 : 4);
    assert.equal(new Set(calls.slice(1).map((c) => c.url)).size, 1);
    assert.ok(calls.every((c) => c.options.redirect === 'error'));
    assert.ok(calls[0].url.endsWith('.f006.idx'));
    assert.equal(result.cycle.validIso, '2026-09-15T12:00:00.000Z');
    if (overlay === 'none') assert.equal(result.scalar, undefined);
    else
      assert.ok(
        Math.abs(
          result.grid.scalar[0] - (overlay === 'temperature' ? 20 : 1013.25),
        ) < 0.0001,
      );
  }
  assert.throws(
    () =>
      windMessageRanges(
        parseGfsIdx(WEATHER_IDX.replace('TMP:2 m above ground', 'TMP:surface')),
        { overlay: 'temperature' },
      ),
    /missing TMP/,
  );
});

test('GFS preserves wind when its optional temperature is missing or malformed', async () => {
  for (const failure of ['missing', 'fetch', 'decode', 'geometry', 'units']) {
    const result = await fetchGfsWind({
      overlay: 'temperature',
      targetDx: 90,
      now: () => Date.UTC(2026, 8, 15, 12),
      fetchImpl: async (url, options) => {
        if (url.endsWith('.idx'))
          return new Response(
            failure === 'missing'
              ? WEATHER_IDX.replace('TMP:2 m above ground', 'TMP:surface')
              : WEATHER_IDX,
          );
        const start = Number(/bytes=(\d+)-/.exec(options.headers.Range)[1]);
        if (start === 6 && failure === 'fetch')
          throw new Error('private provider failure');
        return new Response(Uint8Array.of(start, 0), { status: 206 });
      },
      decodeImpl: async (bytes) => {
        if (bytes[0] === 6 && failure === 'decode')
          throw new Error('bad message');
        return {
          ni: 4,
          nj: 3,
          lo1: bytes[0] === 6 && failure === 'geometry' ? 90 : 0,
          la1: 90,
          di: 90,
          dj: 90,
          values: new Float64Array(12).fill(bytes[0] === 6 ? 293.15 : bytes[0]),
          units: bytes[0] === 6 && failure !== 'units' ? 'K' : 'm/s',
        };
      },
    });
    assert.equal(result.scalar, undefined);
    assert.equal(result.grid.scalar, undefined);
    assert.equal(result.scalarError, 'Temperature field unavailable');
    assert.deepEqual([...result.grid.v], Array(12).fill(2));
    assert.equal(result.cycle.validIso, '2026-09-15T12:00:00.000Z');
  }
});

test('optional scalar timeout cancels only its own fetch and honors parent cancellation', async () => {
  const parent = new AbortController();
  let active;
  const value = await loadOptionalScalar({
    range: { start: 0, end: 1 },
    url: 'https://fixed.test/field',
    timeoutMs: 5,
    signal: parent.signal,
    decodeImpl: () => {
      throw new Error('not reached');
    },
    fetchImpl: (_, { signal }) => {
      active = signal;
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    },
  });
  assert.equal(value, undefined);
  assert.equal(active.aborted, true);
  assert.equal(parent.signal.aborted, false);
  parent.abort();
  let calls = 0;
  assert.equal(
    await loadOptionalScalar({
      range: { start: 0, end: 1 },
      url: 'x',
      signal: parent.signal,
      fetchImpl: () => {
        calls++;
      },
      decodeImpl: () => {},
    }),
    undefined,
  );
  assert.equal(calls, 0);
});
