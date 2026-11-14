import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInpeFires } from './inpeQueimadas.js';
import { INPE_10MIN_URL } from '../../src/data/inpeQueimadasCsv.js';

const NOW = Date.UTC(2026, 9, 29, 21, 0);
const name = (iso) =>
  `focos_10min_${iso.slice(0, 10).replace(/-/g, '')}_${iso.slice(11, 13)}${iso.slice(14, 16)}.csv`;
const csv = (...rows) => ['lat,lon,satelite,data', ...rows].join('\n');

/** A fake INPE: a listing plus files, counting every request it answers. */
function fakeInpe(files, { failing = new Set() } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, userAgent: init?.headers?.['User-Agent'] });
    if (url === INPE_10MIN_URL) {
      const links = Object.keys(files)
        .map((file) => `<a href="${file}">${file}</a>`)
        .join('\n');
      return new Response(`<html>${links}</html>`);
    }
    const file = url.slice(INPE_10MIN_URL.length);
    if (failing.has(file) || !(file in files))
      return new Response('Not Found', { status: 404 });
    return new Response(files[file]);
  };
  return { fetchImpl, requests };
}

const quiet = { warn() {} };

test('a refresh reads the 30-hour lookback and keeps the trailing 24 hours by pass time', async () => {
  const files = {
    // Inside the lookback; carries one pass 26 h old (dropped) and one 2 h old.
    [name('2026-10-29T18:50')]: csv(
      '-10.1,-50.1,NOAA-20,2026-10-28 19:00:00',
      '-10.2,-50.2,NOAA-20,2026-10-29 19:00:00',
    ),
    // Outside the 30-hour lookback: never requested.
    [name('2026-10-28T12:00')]: csv('-10.3,-50.3,GOES-19,2026-10-29 20:00:00'),
  };
  const { fetchImpl, requests } = fakeInpe(files);
  const inpe = createInpeFires({ fetchImpl, now: () => NOW, log: quiet });
  const result = await inpe.refresh();
  assert.equal(result.at, NOW);
  assert.deepEqual(
    result.fires.map((fire) => fire.lat),
    [-10.2],
  );
  assert.deepEqual(result.sources, [
    { source: 'INPE_QUEIMADAS', count: 1, ok: true },
  ]);
  assert.deepEqual(
    requests.map((request) => request.url),
    [INPE_10MIN_URL, INPE_10MIN_URL + name('2026-10-29T18:50')],
  );
  assert.ok(
    requests.every((request) => /gods-eye-view/.test(request.userAgent)),
    'every request identifies the app',
  );
});

test('each file is downloaded once; a later refresh asks only for the listing and new files', async () => {
  const files = {
    [name('2026-10-29T20:40')]: csv('-1,-51,NOAA-21,2026-10-29 20:00:00'),
  };
  const { fetchImpl, requests } = fakeInpe(files);
  let now = NOW;
  const inpe = createInpeFires({ fetchImpl, now: () => now, log: quiet });
  await inpe.refresh();
  files[name('2026-10-29T20:50')] = csv('-2,-52,GOES-19,2026-10-29 20:45:00');
  now += 10 * 60_000;
  requests.length = 0;
  const second = await inpe.refresh();
  assert.deepEqual(
    requests.map((request) => request.url),
    [INPE_10MIN_URL, INPE_10MIN_URL + name('2026-10-29T20:50')],
  );
  assert.equal(second.fires.length, 2);
  assert.equal(inpe.fileCount(), 2);
});

test('a file that fails is reported and retried, and files leave once they age out', async () => {
  const flaky = name('2026-10-29T20:30');
  const files = {
    [name('2026-10-29T20:20')]: csv('-3,-53,NOAA-20,2026-10-29 20:10:00'),
    [flaky]: csv('-4,-54,NOAA-20,2026-10-29 20:15:00'),
  };
  const failing = new Set([flaky]);
  const { fetchImpl, requests } = fakeInpe(files, { failing });
  let now = NOW;
  const inpe = createInpeFires({ fetchImpl, now: () => now, log: quiet });
  const first = await inpe.refresh();
  assert.equal(first.fires.length, 1);
  assert.equal(first.sources[0].ok, false, 'a missing file is not silent');

  failing.clear();
  requests.length = 0;
  const second = await inpe.refresh();
  assert.deepEqual(
    requests.map((request) => request.url),
    [INPE_10MIN_URL, INPE_10MIN_URL + flaky],
  );
  assert.equal(second.fires.length, 2);
  assert.equal(second.sources[0].ok, true);

  now += 31 * 3600_000;
  await inpe.refresh();
  assert.equal(inpe.fileCount(), 0, 'files past the lookback are dropped');
});

test('a refresh throws when the listing fails or no file can be read, so the proxy serves its cache', async () => {
  const down = createInpeFires({
    fetchImpl: async () => new Response('busy', { status: 503 }),
    now: () => NOW,
    log: quiet,
  });
  await assert.rejects(down.refresh(), /HTTP 503/);

  const only = name('2026-10-29T20:30');
  const { fetchImpl } = fakeInpe({ [only]: '<html>moved</html>' });
  const broken = createInpeFires({ fetchImpl, now: () => NOW, log: quiet });
  await assert.rejects(broken.refresh(), /every INPE file failed/);
});

test('an empty lookback is no fires rather than a failure', async () => {
  const { fetchImpl } = fakeInpe({});
  const inpe = createInpeFires({ fetchImpl, now: () => NOW, log: quiet });
  const result = await inpe.refresh();
  assert.deepEqual(result.fires, []);
  assert.deepEqual(result.sources, [
    { source: 'INPE_QUEIMADAS', count: 0, ok: true },
  ]);
});

test('a populated cache survives an HTTP 200 listing without CSV links', async () => {
  const file = name('2026-10-29T20:40');
  const source = fakeInpe({
    [file]: csv('-1,-51,NOAA-21,2026-10-29 20:00:00'),
  });
  let maintenance = false;
  const fetchImpl = (url, init) =>
    maintenance && url === INPE_10MIN_URL
      ? Promise.resolve(new Response('<html>INPE maintenance</html>'))
      : source.fetchImpl(url, init);
  const inpe = createInpeFires({ fetchImpl, now: () => NOW, log: quiet });

  assert.equal((await inpe.refresh()).fires.length, 1);
  assert.equal(inpe.fileCount(), 1);

  // A proxy that treats this successful HTTP response as an empty listing
  // would wipe the file cache and replace its last-good snapshot with zero.
  maintenance = true;
  await assert.rejects(inpe.refresh(), /listing unexpectedly empty/);
  assert.equal(inpe.fileCount(), 1, 'keep cached files for a later retry');

  maintenance = false;
  source.requests.length = 0;
  const recovered = await inpe.refresh();
  assert.equal(recovered.fires.length, 1);
  assert.deepEqual(
    source.requests.map((request) => request.url),
    [INPE_10MIN_URL],
    'recovery should reuse the cached CSV, not download it again',
  );
});
