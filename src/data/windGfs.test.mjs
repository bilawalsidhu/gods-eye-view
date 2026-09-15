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
