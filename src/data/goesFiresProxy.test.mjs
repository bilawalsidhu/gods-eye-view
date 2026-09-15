import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildListUrl,
  dayOfYear,
  goesFiresProxy,
  latestGranuleKey,
  listPrefix,
} from '../../server/providers/goes-fires.js';
import { writeGoesFireGranule } from './goesFireFixture.mjs';

const GRANULE_KEY =
  'ABI-L2-FDCF/2026/257/00/OR_ABI-L2-FDCF-M6_G19_s20262570000215_e20262570009524_c20262570009585.nc';

const listXml = (...keys) =>
  `<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('')}</ListBucketResult>`;

/** Capture the middleware the provider registers, without opening a server. */
function captureHandler(proxy) {
  let handler = null;
  proxy.configureServer({
    middlewares: {
      use(_route, registered) {
        handler = registered;
      },
    },
  });
  return handler;
}

function fakeResponse() {
  const res = { statusCode: null, body: null };
  res.writeHead = (status) => {
    res.statusCode = status;
  };
  res.end = (payload) => {
    res.body = JSON.parse(payload);
  };
  return res;
}

/** Run one endpoint test inside an isolated working directory (the disk cache). */
async function withIsolatedCwd(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goes-fires-cwd-'));
  const previous = process.cwd();
  const previousSatellites = process.env.GOES_FIRE_SATELLITES;
  const warnings = console.warn;
  console.warn = () => {};
  process.chdir(directory);
  try {
    return await run(directory);
  } finally {
    process.chdir(previous);
    if (previousSatellites === undefined)
      delete process.env.GOES_FIRE_SATELLITES;
    else process.env.GOES_FIRE_SATELLITES = previousSatellites;
    console.warn = warnings;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('the S3 list prefix uses the UTC day-of-year and hour', () => {
  const date = new Date(Date.UTC(2026, 8, 14, 5));
  assert.equal(dayOfYear(date), 257);
  assert.equal(listPrefix(date), 'ABI-L2-FDCF/2026/257/05/');
  assert.equal(
    buildListUrl('noaa-goes19', date),
    'https://noaa-goes19.s3.amazonaws.com/?list-type=2&prefix=ABI-L2-FDCF/2026/257/05/&max-keys=1000',
  );
  // New Year's Day is day 1, not day 0.
  assert.equal(dayOfYear(new Date(Date.UTC(2026, 0, 1))), 1);
});

test('the newest granule is listed, and empty hours walk backwards', async () => {
  const older = 'ABI-L2-FDCF/2026/257/03/older.nc';
  const newest = 'ABI-L2-FDCF/2026/257/04/newest.nc';
  const requests = [];
  const key = await latestGranuleKey(
    'noaa-goes19',
    Date.UTC(2026, 8, 14, 4, 30),
    async (url) => {
      requests.push(url);
      return {
        ok: true,
        text: async () =>
          url.includes('/04/') ? listXml(older, newest) : listXml(older),
      };
    },
  );
  assert.equal(key, newest, 'the last key in the listing wins');
  assert.equal(requests.length, 1);

  // An empty hour falls back to the previous one.
  const walked = await latestGranuleKey(
    'noaa-goes19',
    Date.UTC(2026, 8, 14, 4, 30),
    async (url) => ({
      ok: true,
      text: async () => (url.includes('/04/') ? listXml() : listXml(older)),
    }),
  );
  assert.equal(walked, older);

  // Nothing within the lookback window is an explicit miss, not a stale key.
  const missing = await latestGranuleKey(
    'noaa-goes19',
    Date.UTC(2026, 8, 14, 4, 30),
    async () => ({ ok: true, text: async () => listXml() }),
  );
  assert.equal(missing, null);
});

test('the endpoint serves FIRMS-shaped rows decoded from a real granule', async () => {
  await withIsolatedCwd(async (directory) => {
    const granule = path.join(directory, 'granule.nc');
    await writeGoesFireGranule(granule);
    const bytes = await fs.readFile(granule);
    process.env.GOES_FIRE_SATELLITES = 'goes19';

    const requests = [];
    const proxy = goesFiresProxy({
      fetchImpl: async (url) => {
        requests.push(url);
        if (url.includes('list-type=2'))
          return { ok: true, text: async () => listXml(GRANULE_KEY) };
        return {
          ok: true,
          arrayBuffer: async () => Uint8Array.from(bytes).buffer,
        };
      },
    });
    const handler = captureHandler(proxy);

    const res = fakeResponse();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stale, false);
    assert.equal(res.body.ttlMs, 600_000);
    assert.equal(res.body.count, 2);
    assert.deepEqual(res.body.sources, [
      { source: 'GOES-19', count: 2, ok: true },
    ]);

    const [first, second] = res.body.fires;
    assert.equal(first.frp, 10.5);
    assert.equal(first.confidence, 'h');
    assert.equal(first.daynight, 'N');
    assert.equal(first.acqDate, '2026-09-14');
    assert.equal(first.acqTime, '0000');
    assert.equal(first.satellite, 'GOES-19');
    assert.equal(first.instrument, 'ABI');
    assert.ok(Number.isFinite(first.lat) && Number.isFinite(first.lon));
    // DQF 2 is the low tier, and that pixel is a daytime detection.
    assert.equal(second.confidence, 'l');
    assert.equal(second.daynight, 'D');

    // Within the TTL the cached snapshot is served without touching the network.
    const before = requests.length;
    const cached = fakeResponse();
    await handler({}, cached);
    assert.equal(cached.statusCode, 200);
    assert.equal(requests.length, before);
  });
});

test('one failing satellite degrades to partial success', async () => {
  await withIsolatedCwd(async (directory) => {
    const granule = path.join(directory, 'granule.nc');
    await writeGoesFireGranule(granule);
    const bytes = await fs.readFile(granule);
    process.env.GOES_FIRE_SATELLITES = 'goes19,goes18';

    const proxy = goesFiresProxy({
      fetchImpl: async (url) => {
        if (url.includes('noaa-goes18'))
          return { ok: false, status: 500, text: async () => '' };
        if (url.includes('list-type=2'))
          return { ok: true, text: async () => listXml(GRANULE_KEY) };
        return {
          ok: true,
          arrayBuffer: async () => Uint8Array.from(bytes).buffer,
        };
      },
    });

    const res = fakeResponse();
    await captureHandler(proxy)({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, 2);
    assert.deepEqual(res.body.sources, [
      { source: 'GOES-19', count: 2, ok: true },
      { source: 'GOES-18', count: 0, ok: false },
    ]);
  });
});

test('a total upstream failure without cache reports 502 instead of an empty layer', async () => {
  await withIsolatedCwd(async () => {
    process.env.GOES_FIRE_SATELLITES = 'goes19';
    const proxy = goesFiresProxy({
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
    });
    const res = fakeResponse();
    await captureHandler(proxy)({}, res);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { error: 'goes fires fetch failed' });
  });
});
