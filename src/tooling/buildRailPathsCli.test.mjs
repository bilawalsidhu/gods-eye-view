// The pack build's download and command line: https on every hop, a byte
// cap and a time limit; the redirect target recorded as the source; the
// output folder the server reads; `--no-schedule` refused for a feed named
// only through its schedule pack; and exit code 2 when a feed fails. No test
// here touches the network: downloads are a stubbed fetch, builds read a
// local zip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEED_FAILED_EXIT_CODE,
  buildRefusal,
  downloadStatic,
  packSource,
  parseBuildArgs,
} from '../../scripts/build-rail-paths.mjs';
import { getRegisteredRailFeed } from '../data/railFeeds.js';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/build-rail-paths.mjs', import.meta.url),
);

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-rail-cli-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A fetch stub answering each URL from `answers`, recording each call. */
function stubFetch(t, answers) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    const answer = answers(url, init);
    return typeof answer === 'function' ? answer() : answer;
  });
  return calls;
}

const redirect = (location, status = 302) =>
  new Response(null, { status, headers: { location } });

test('a download follows https redirects hop by hop and records where it ended', async (t) => {
  const dir = await tempDir(t);
  const calls = stubFetch(t, (url) =>
    url === 'https://example.test/gtfs.zip'
      ? redirect('https://cdn.example.test/files/gtfs.zip')
      : new Response('zip bytes', {
          status: 200,
          headers: { 'last-modified': 'Thu, 05 Nov 2026 10:00:00 GMT' },
        }),
  );
  const dest = path.join(dir, 'gtfs.zip');
  const got = await downloadStatic('https://example.test/gtfs.zip', dest, {
    'Digitraffic-User': 'GodsEyeView/RailLayer',
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://example.test/gtfs.zip',
      'https://cdn.example.test/files/gtfs.zip',
    ],
  );
  for (const { init } of calls) {
    assert.equal(init.redirect, 'manual');
    assert.match(init.headers['User-Agent'], /gods-eye-view-rail-paths/);
    assert.equal(init.headers['Digitraffic-User'], 'GodsEyeView/RailLayer');
  }
  assert.equal(got.finalUrl, 'https://cdn.example.test/files/gtfs.zip');
  assert.equal(got.lastModified, 'Thu, 05 Nov 2026 10:00:00 GMT');
  assert.equal(got.bytes, 9);
  assert.equal(await readFile(dest, 'utf8'), 'zip bytes');
  // The packs record the URL the file came from, not the one first asked.
  const feed = getRegisteredRailFeed('mbta-rail');
  assert.deepEqual(packSource(feed, got), {
    url: 'https://cdn.example.test/files/gtfs.zip',
    lastModified: 'Thu, 05 Nov 2026 10:00:00 GMT',
  });
  assert.deepEqual(
    packSource(feed, {
      file: '/tmp/x.zip',
      localName: 'x.zip',
      lastModified: 'Wed, 04 Nov 2026 10:00:00 GMT',
    }),
    {
      url: feed.staticGtfsUrl,
      file: 'x.zip',
      lastModified: 'Wed, 04 Nov 2026 10:00:00 GMT',
    },
  );
});

test('a download is https only: plain http is refused before it is asked', async (t) => {
  const dir = await tempDir(t);
  const calls = stubFetch(t, () =>
    redirect('http://example.test/gtfs.zip', 301),
  );
  await assert.rejects(
    downloadStatic('https://example.test/gtfs.zip', path.join(dir, 'a.zip')),
    /refusing non-https URL http:\/\/example\.test\/gtfs\.zip/,
  );
  assert.equal(calls.length, 1, 'the http hop is never contacted');
  await assert.rejects(
    downloadStatic('http://example.test/gtfs.zip', path.join(dir, 'b.zip')),
    /refusing non-https/,
  );
  assert.equal(calls.length, 1);
});

test('a download stops at the redirect limit', async (t) => {
  const dir = await tempDir(t);
  let n = 0;
  const calls = stubFetch(t, () => redirect(`https://example.test/${++n}`));
  await assert.rejects(
    downloadStatic('https://example.test/0', path.join(dir, 'a.zip')),
    /too many redirects/,
  );
  assert.equal(calls.length, 6, 'the first ask and five redirects');
});

test('a download over the byte cap is refused, declared or streamed', async (t) => {
  const dir = await tempDir(t);
  stubFetch(
    t,
    (url) => () =>
      url.endsWith('declared')
        ? new Response('x'.repeat(10), {
            status: 200,
            headers: { 'content-length': '2000' },
          })
        : new Response(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < 4; i += 1)
                  controller.enqueue(new Uint8Array(400));
                controller.close();
              },
            }),
            { status: 200 },
          ),
  );
  await assert.rejects(
    downloadStatic(
      'https://example.test/declared',
      path.join(dir, 'a.zip'),
      null,
      { maxBytes: 1000 },
    ),
    /download is 2000 bytes/,
  );
  await assert.rejects(
    downloadStatic(
      'https://example.test/streamed',
      path.join(dir, 'b.zip'),
      null,
      { maxBytes: 1000 },
    ),
    /exceeds the size cap/,
  );
  // Under the cap it is written whole.
  const got = await downloadStatic(
    'https://example.test/streamed',
    path.join(dir, 'c.zip'),
    null,
    { maxBytes: 1600 },
  );
  assert.equal(got.bytes, 1600);
});

test('a download that does not finish in time is abandoned', async (t) => {
  const dir = await tempDir(t);
  stubFetch(
    t,
    (url, init) => () =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }),
  );
  await assert.rejects(
    downloadStatic('https://example.test/slow', path.join(dir, 'a.zip'), null, {
      timeoutMs: 50,
    }),
    (error) => error?.name === 'TimeoutError',
  );
});

test('the build writes where the server reads: RAIL_PATHS_DIR unless --out names a folder', () => {
  const served = path.join(os.tmpdir(), 'served-packs');
  assert.equal(
    parseBuildArgs(['--feed', 'a'], { RAIL_PATHS_DIR: served }).out,
    path.resolve(served),
  );
  const own = path.join(os.tmpdir(), 'own-packs');
  assert.equal(
    parseBuildArgs(['--feed', 'a', '--out', own], { RAIL_PATHS_DIR: served })
      .out,
    path.resolve(own),
  );
  assert.match(
    parseBuildArgs(['--feed', 'a'], {}).out,
    /[\\/]\.cache[\\/]rail-paths$/,
  );
  // The served folder is held to the same rule as --out.
  const src = fileURLToPath(new URL('../packs', import.meta.url));
  assert.throws(
    () => parseBuildArgs(['--feed', 'a'], { RAIL_PATHS_DIR: src }),
    /--out must not be inside src\//,
  );
});

test('--no-schedule is refused for a feed named only through its schedule pack', () => {
  const ktmb = getRegisteredRailFeed('ktmb');
  const mbta = getRegisteredRailFeed('mbta-rail');
  assert.match(buildRefusal(ktmb, { schedule: false }), /ktmb.*schedule pack/);
  assert.match(
    buildRefusal(getRegisteredRailFeed('renfe-larga-distancia'), {
      schedule: false,
    }),
    /renfe-larga-distancia/,
  );
  assert.equal(buildRefusal(ktmb, { schedule: true }), null);
  assert.equal(buildRefusal(mbta, { schedule: false }), null);
});

/** Run the build script with the given arguments and environment. */
function runBuild(args, env = {}) {
  const base = { ...process.env };
  delete base.RAIL_PATHS_DIR;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...base, ...env },
    timeout: 60_000,
  });
}

test('a build in which a feed fails exits with code 2', async (t) => {
  const dir = await tempDir(t);
  const broken = path.join(dir, 'broken.zip');
  await writeFile(broken, 'this is not a zip');
  const out = path.join(dir, 'packs');
  const run = runBuild([
    '--feed',
    'mbta-rail',
    '--local-gtfs',
    `mbta-rail=${broken}`,
    '--out',
    out,
  ]);
  assert.equal(run.status, FEED_FAILED_EXIT_CODE, run.stderr);
  assert.match(run.stderr, /mbta-rail skipped/);
  assert.match(run.stdout, /done: 0 built, failed: mbta-rail/);
});

test('a build with no --out writes to RAIL_PATHS_DIR', async (t) => {
  const dir = await tempDir(t);
  const broken = path.join(dir, 'broken.zip');
  await writeFile(broken, 'this is not a zip');
  const served = path.join(dir, 'served');
  const run = runBuild(
    ['--feed', 'mbta-rail', '--local-gtfs', `mbta-rail=${broken}`],
    { RAIL_PATHS_DIR: served },
  );
  assert.equal(run.status, FEED_FAILED_EXIT_CODE, run.stderr);
  assert.ok(
    run.stdout.includes(`1 feeds → ${path.resolve(served)}`),
    run.stdout,
  );
});

test('--no-schedule leaves a pack-routed feed and its schedule pack as they were', async (t) => {
  const dir = await tempDir(t);
  const zip = path.join(dir, 'ktmb.zip');
  await writeFile(zip, 'not read: the build is refused first');
  const out = path.join(dir, 'packs');
  const runRefused = async () => {
    const run = runBuild([
      '--feed',
      'ktmb',
      '--no-schedule',
      '--local-gtfs',
      `ktmb=${zip}`,
      '--out',
      out,
    ]);
    assert.equal(run.status, FEED_FAILED_EXIT_CODE, run.stderr);
    assert.match(
      run.stderr,
      /ktmb skipped: --no-schedule: ktmb names its trains only through its schedule pack/,
    );
    return run;
  };
  await runRefused();
  const schedule = path.join(out, 'ktmb.schedule.json');
  await writeFile(schedule, '{"version":1,"feedId":"ktmb"}');
  await runRefused();
  assert.equal(
    await readFile(schedule, 'utf8'),
    '{"version":1,"feedId":"ktmb"}',
    'the schedule pack stays',
  );
});
