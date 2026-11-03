import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWebCad, easternTime } from './chesterCountyEms/parser.js';
import { createChesterCountyFeed, WEBCAD_URL } from './chesterCountyEms.js';

const header = [
  'Incident No.',
  'Incident Type',
  'Incident Location',
  'Municipality',
  'Dispatch Time',
  'Station',
];
const row = [
  'F26000001',
  'TEST &amp; ONLY',
  'EXAMPLE RD & TEST ST',
  'Example Township',
  '11-03-2026 10:00:00',
  '01',
];
const tr = (cells) => `<tr>${cells.map((s) => `<td>${s}</td>`).join('')}</tr>`;
const page = (rows = [row]) =>
  `Last Updated 11/3/2026&nbsp;10:00:00 AM <b>Fire Incidents</b><table>${tr(header)}</table><b>EMS Incidents</b><table>${tr(header)}${rows.map(tr).join('')}</table><b>Traffic Incidents</b><table>${tr([...header.slice(0, 5), 'Agency'])}</table>`;
test('decoded incident rows, decoded text, leading-zero stations, valid empty snapshot', () => {
  const s = parseWebCad(page());
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].type, 'TEST & ONLY');
  assert.equal(s.rows[0].station, '01');
  assert.equal(s.observedAt, Date.parse('2026-11-03T15:00:00Z'));
  assert.deepEqual(parseWebCad(page([])).rows, []);
});
test('refuses missing table, changed schema, partial rows and duplicate ids', () => {
  for (const html of [
    '<html>maintenance</html>',
    page().replace('EMS Incidents', 'Other'),
    page().replaceAll('Dispatch Time', 'Time'),
    page([row.slice(0, 5)]),
    page([row, row]),
  ])
    assert.throws(() => parseWebCad(html));
});
test('Eastern clock uses seasonal offsets and rejects impossible dates', () => {
  assert.equal(
    easternTime('07-01-2026 12:00:00'),
    Date.parse('2026-07-01T16:00:00Z'),
  );
  assert.equal(
    easternTime('01-01-2026 12:00:00'),
    Date.parse('2026-01-01T17:00:00Z'),
  );
  assert.throws(() => easternTime('02-30-2026 10:00:00'));
  assert.throws(() => easternTime('03-08-2026 02:30:00'));
});
test('shared cache, failed refresh stale, recovery empty clears, no faster retry', async () => {
  let clock = easternTime('11-03-2026 10:00:00');
  let count = 0,
    fail = false,
    empty = false;
  const feed = createChesterCountyFeed({
    resolveLocation: async () => ({
      lat: 40,
      lon: -75.7,
      kind: 'intersection',
      approximate: true,
    }),
    now: () => clock,
    fetchImpl: async (url) => {
      count++;
      if (fail) throw new Error('network');
      return new Response(
        url === WEBCAD_URL
          ? page(empty ? [] : [row])
          : JSON.stringify({ features: [] }),
      );
    },
  });
  const [a, b] = await Promise.all([feed(), feed()]);
  assert.equal(count, 1);
  assert.deepEqual(a, b);
  assert.equal(a.stale, false);
  assert.deepEqual(a.rows[0].mapPosition, {
    lon: -75.7,
    lat: 40,
    kind: 'intersection',
    approximate: true,
  });
  await feed();
  assert.equal(count, 1);
  clock += 60000;
  fail = true;
  assert.equal((await feed()).stale, true);
  assert.equal((await feed()).stale, true);
  assert.equal(count, 2);
  clock += 60000;
  fail = false;
  empty = true;
  assert.deepEqual((await feed()).rows, []);
});
test('unmatched location preserves report list without inventing positions', async () => {
  const feed = createChesterCountyFeed({
    resolveLocation: async () => null,
    fetchImpl: async (url) => {
      if (url !== WEBCAD_URL) throw new Error('GIS down');
      return new Response(page());
    },
  });
  const s = await feed();
  assert.deepEqual(s.locationCoverage, {
    matched: 0,
    unmatched: 1,
    unavailable: 0,
  });
  assert.equal(s.rows[0].mapPosition, null);
});
test('cold failure is throttled and oversized responses are refused', async () => {
  let count = 0;
  const feed = createChesterCountyFeed({
    resolveLocation: async () => ({
      lat: 40,
      lon: -75.7,
      kind: 'intersection',
      approximate: true,
    }),
    fetchImpl: async () => {
      count++;
      return new Response('x', { headers: { 'content-length': '999999' } });
    },
  });
  await assert.rejects(feed());
  await assert.rejects(feed());
  assert.equal(count, 1);
});

test('Vite registration returns no post-hook and fixed route rejects input before fetching', async () => {
  const { chesterCountyEmsProxy } = await import('./chesterCountyEms.js');
  let handler,
    calls = 0;
  const plugin = chesterCountyEmsProxy({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected fetch');
    },
  });
  const server = {
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/chester-county-ems');
        handler = callback;
        return () => {
          throw new Error('middleware is not a Vite post-hook');
        };
      },
    },
  };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
  for (const [url, method, code] of [
    ['/', 'POST', 405],
    ['/?url=https://example.com', 'GET', 400],
  ]) {
    const res = { setHeader() {}, end() {} };
    await handler({ url, method }, res, () => assert.fail('unexpected next'));
    assert.equal(res.statusCode, code);
  }
  assert.equal(calls, 0);
});

test('fire, EMS and traffic preserve category even when incident numbers overlap', () => {
  const html = page()
    .replace(
      '<b>Fire Incidents</b><table>' + tr(header),
      '<b>Fire Incidents</b><table>' + tr(header) + tr(row),
    )
    .replace(
      '<b>Traffic Incidents</b><table>' + tr([...header.slice(0, 5), 'Agency']),
      '<b>Traffic Incidents</b><table>' +
        tr([...header.slice(0, 5), 'Agency']) +
        tr(['P26000001', ...row.slice(1)]),
    );
  const result = parseWebCad(html);
  assert.deepEqual(
    result.rows.map((r) => r.category),
    ['fire', 'ems', 'traffic'],
  );
  assert.equal(new Set(result.rows.map((r) => r.id)).size, 3);
});

test('transient WebCAD failure retries once, without multiplying shared refreshes', async () => {
  let calls = 0;
  const feed = createChesterCountyFeed({
    resolveLocation: async () => null,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 503 })
        : new Response(page());
    },
  });
  const [a, b] = await Promise.all([feed(), feed()]);
  assert.equal(calls, 2);
  assert.deepEqual(a, b);
  assert.deepEqual(a.locationCoverage, {
    matched: 0,
    unmatched: 1,
    unavailable: 0,
  });
});
test('location resolver failure preserves fresh incident feed and identifies GIS errors', async () => {
  const feed = createChesterCountyFeed({
    fetchImpl: async () => new Response(page()),
    resolveLocation: async () => {
      throw new Error('GIS timeout');
    },
  });
  const s = await feed();
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].locationStatus, 'unavailable');
  assert.deepEqual(s.locationCoverage, {
    matched: 0,
    unmatched: 0,
    unavailable: 1,
  });
});
test('WebCAD rate limiting is not retried inside the shared cooldown', async () => {
  let calls = 0;
  const feed = createChesterCountyFeed({
    fetchImpl: async () => {
      calls++;
      return new Response('', { status: 429 });
    },
  });
  await assert.rejects(feed());
  await assert.rejects(feed());
  assert.equal(calls, 1);
});
