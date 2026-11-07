import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCmrPages } from './catalog.js';
const item = (id) => ({
  meta: { 'concept-id': id },
  umm: {
    TemporalExtent: {
      RangeDateTime: { BeginningDateTime: '2026-09-18T12:00:00Z' },
    },
  },
});
test('discarded rows do not turn a full CMR page into a final page', async () => {
  let calls = 0;
  const result = await fetchCmrPages({
    product: 'S30',
    url: 'fixture',
    fetchImpl: async () => {
      calls++;
      const items =
        calls === 1
          ? Array.from({ length: 200 }, (_, i) =>
              i === 0 ? {} : item(String(i)),
            )
          : [item('last')];
      return Response.json(
        { hits: 201, items },
        { headers: { 'CMR-Search-After': `cursor-${calls}` } },
      );
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.granules.length, 200);
  assert.equal(result.granules.at(-1).id, 'last');
  assert.equal(result.truncated, false);
});
test('a non-page-multiple limit never returns more admitted records than its budget', async () => {
  let calls = 0;
  const result = await fetchCmrPages({
    product: 'S30',
    url: 'fixture',
    maxRecords: 250,
    fetchImpl: async () => {
      calls++;
      return Response.json(
        {
          hits: 1000,
          items: Array.from({ length: 200 }, (_, i) => item(`${calls}:${i}`)),
        },
        { headers: { 'CMR-Search-After': `cursor-${calls}` } },
      );
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.granules.length, 250);
  assert.equal(result.truncated, true);
});
test('valid records dropped by the cap mark the result truncated even when every hit was read', async () => {
  let calls = 0;
  const result = await fetchCmrPages({
    product: 'S30',
    url: 'fixture',
    maxRecords: 250,
    fetchImpl: async () => {
      calls++;
      return Response.json(
        {
          hits: 400,
          items: Array.from({ length: 200 }, (_, i) => item(`${calls}:${i}`)),
        },
        { headers: { 'CMR-Search-After': `cursor-${calls}` } },
      );
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.granules.length, 250);
  assert.equal(result.truncated, true);
});
test('malformed rows discarded under the cap leave a fully examined result untruncated', async () => {
  let calls = 0;
  const result = await fetchCmrPages({
    product: 'S30',
    url: 'fixture',
    maxRecords: 250,
    fetchImpl: async () => {
      calls++;
      const items = Array.from({ length: 200 }, (_, i) =>
        calls === 2 && i >= 50 ? {} : item(`${calls}:${i}`),
      );
      return Response.json(
        { hits: 400, items },
        { headers: { 'CMR-Search-After': `cursor-${calls}` } },
      );
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.granules.length, 250);
  assert.equal(result.truncated, false);
});
