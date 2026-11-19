import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../cctv.js';

/**
 * A failing feed group probe must log a fixed line and nothing else. The
 * failure can carry an upstream URL, a key or a stack; none of that belongs
 * in the log.
 *
 * The failure is induced INSIDE the real feed-availability code rather than
 * simulated around it: the availability's clock throws, so the real
 * probeFeedGroups rejects and the real catch in ../cctv.js runs with an
 * error whose message carries the synthetic value below. Nothing else in
 * the request path rejects the probe, so this is the only way to reach that
 * catch with the production modules in place.
 */

/** Synthetic value that must never appear in any captured console output. */
const SYNTHETIC_SECRET = 'synthetic-cctv-probe-secret-9f2b41';

/** The fixed line a probe failure must log, and nothing else. */
const EXPECTED_WARNING = '[CCTV] feed group probe failed';

/**
 * Synthetic value in the OPERATOR's city id. The group key the probe builds
 * is `txdot:<cityId>`, and the city id is free-form operator text, so it can
 * carry a secret. It must never appear in any captured console output.
 */
const SYNTHETIC_CITY_SECRET = 'synthetic-cctv-city-secret-3d81a7';

/** The fixed line a SUCCESSFUL probe must log, and nothing else. */
const EXPECTED_SUCCESS = '[CCTV] feed group probe completed';

/** A TxDOT ITS camera: the only source kind the group probe groups. */
const TXDOT_SOURCE = {
  id: 'txdot-group-probe-fixture',
  name: 'TxDOT group probe fixture',
  city: 'Austin',
  cityId: 'tx-probe-fixture',
  provider: 'TxDOT',
  lat: 30.2672,
  lon: -97.7431,
  feedType: 'image',
  sourceKind: 'txdot-its',
  snapshotUrl:
    'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId?icdId=fixture&districtCode=AUS',
};

/**
 * A TxDOT ITS camera whose OPERATOR-set city id carries the synthetic
 * secret. The group probe keys its verdict map by `txdot:<cityId>`, so this
 * is the source that makes the leak observable.
 */
const SECRET_CITY_SOURCE = {
  ...TXDOT_SOURCE,
  id: 'txdot-secret-city-fixture',
  name: 'TxDOT secret city fixture',
  cityId: `tx-probe-${SYNTHETIC_CITY_SECRET}`,
};

/** Set env vars for one test and restore them afterwards. */
function withEnv(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    process.env[name] = value;
  }
}

/** GET /api/cctv/sources through the real proxy middleware. */
async function requestSources(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end() {},
  };
  await handler({ url: '/sources', method: 'GET' }, res);
  return res;
}

test('a failed feed group probe logs a fixed line, never the failure text', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-group-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The env pack answers the catalog, so no live pack is fetched (no network).
  withEnv(t, {
    CCTV_SOURCES_JSON: JSON.stringify([TXDOT_SOURCE]),
    CCTV_SOURCES_FILE: path.join(root, 'absent-pack.json'),
    CCTV_FORCE_AUSTIN: '0',
  });

  // The availability reads its clock through Date.now, captured when the
  // plugin builds it. The clock throws only for the availability's own
  // verdict calls, so the catalog and the request keep working and the
  // rejection comes from the real feed-availability code.
  const realNow = Date.now;
  t.mock.method(Date, 'now', function guardedNow() {
    const stack = new Error().stack || '';
    if (
      stack.includes('groupVerdictFresh') ||
      stack.includes('setGroupVerdict') ||
      stack.includes('probeFeedGroups')
    ) {
      throw new Error(SYNTHETIC_SECRET);
    }
    return realNow();
  });

  const captured = { log: [], warn: [], error: [] };
  let sawProbeFailure;
  const probeFailed = new Promise((resolve) => {
    sawProbeFailure = resolve;
  });
  for (const level of ['log', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => {
      const line = args.map((arg) => String(arg)).join(' ');
      captured[level].push(line);
      if (line.includes('feed group probe')) sawProbeFailure();
    });
  }
  // The probe must never reach an upstream.
  const stubFetch = async () => new Response('stub', { status: 503 });
  t.mock.method(globalThis, 'fetch', stubFetch);

  const res = await requestSources(cctvProxy({ sourceRoot: root }));

  // The catch runs on a later microtask; wait for it, but never hang.
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, 5000);
    timer.unref?.();
  });
  await Promise.race([probeFailed, timeout]);
  clearTimeout(timer);

  const probeWarnings = captured.warn.filter((line) =>
    line.includes('feed group probe'),
  );
  assert.equal(
    probeWarnings.length,
    1,
    'the real group-probe catch ran exactly once',
  );
  // The comparison stays in an assert.ok so a failure reports the shape of
  // the log line, never its text: the text is what may carry the secret.
  assert.ok(
    probeWarnings[0] === EXPECTED_WARNING,
    'the failure is logged as a fixed line, with no error values',
  );
  const everything = [
    ...captured.log,
    ...captured.warn,
    ...captured.error,
  ].join('\n');
  assert.ok(
    !everything.includes(SYNTHETIC_SECRET),
    'the failure text never reaches a log',
  );
  assert.equal(res.statusCode, 200, 'the request still answered');
});

/**
 * A SUCCESSFUL group probe must log a fixed line, and nothing from the
 * verdict map.
 *
 * The verdict map is keyed by the group key, and the group key is built from
 * the OPERATOR's own `cityId` (`txdot:<cityId>`). The city id is free-form
 * operator text, so it can carry a secret; logging the map verbatim would
 * print that secret to the server log.
 *
 * The probe runs through the REAL route (GET /api/cctv/sources), the real
 * catalog, the real group probe and the real availability store — only the
 * upstream snapshot request is stubbed, and it answers with a genuine TxDOT
 * envelope so the probe really succeeds and the success logger is reached.
 *
 * NEGATIVE CONTROL (pre-fix): restore the old success logger in
 * server/providers/cctv.js —
 *
 *   console.log('[CCTV] feed group probe:', JSON.stringify(verdicts));
 *
 * and re-run this file. The probe still succeeds and the log is still
 * reached, but the captured line now contains the verdict map with the
 * `txdot:<cityId>` key, so both assertions below fail: the line is no longer
 * the fixed EXPECTED_SUCCESS, and the captured output contains
 * SYNTHETIC_CITY_SECRET. Reverting the production change restores the pass.
 */
test('a successful feed group probe logs a fixed line, never the city id', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-group-probe-ok-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The env pack answers the catalog, so no live pack is fetched (no network).
  withEnv(t, {
    CCTV_SOURCES_JSON: JSON.stringify([SECRET_CITY_SOURCE]),
    CCTV_SOURCES_FILE: path.join(root, 'absent-pack.json'),
    CCTV_FORCE_AUSTIN: '0',
  });

  const captured = { log: [], warn: [], error: [] };
  let sawProbeSuccess;
  const probeSucceeded = new Promise((resolve) => {
    sawProbeSuccess = resolve;
  });
  for (const level of ['log', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => {
      const line = args.map((arg) => String(arg)).join(' ');
      captured[level].push(line);
      // Any success-logger line releases the wait, so the pre-fix negative
      // control fails fast on the assertions rather than on the timeout.
      if (level === 'log' && line.includes('feed group probe'))
        sawProbeSuccess();
    });
  }

  // The upstream answers with a real TxDOT envelope (base64 JPEG), so the
  // probe genuinely succeeds and the success logger is the one under test.
  const upstreamCalls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    upstreamCalls.push(String(url));
    return new Response(
      JSON.stringify({
        snippet: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  const res = await requestSources(cctvProxy({ sourceRoot: root }));

  // The probe resolves on a later microtask; wait for the log, never hang.
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, 5000);
    timer.unref?.();
  });
  await Promise.race([probeSucceeded, timeout]);
  clearTimeout(timer);

  // The probe really reached the upstream and really succeeded: the fixed
  // line is reached because there WAS a verdict to log, not because the
  // probe failed into the catch below.
  assert.equal(
    upstreamCalls.length,
    1,
    'the group probe made exactly one upstream snapshot request',
  );
  assert.ok(
    upstreamCalls[0].startsWith(
      'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId',
    ),
    'the probe used the source snapshot URL',
  );
  assert.equal(
    captured.warn.filter((line) => line === EXPECTED_WARNING).length,
    0,
    'the probe succeeded, so the failure catch never ran',
  );

  const probeLogs = captured.log.filter((line) =>
    line.includes('feed group probe'),
  );
  assert.equal(probeLogs.length, 1, 'the success logger ran exactly once');
  // The comparison stays in an assert.ok so a failure reports the shape of
  // the log line, never its text: the text is what may carry the secret.
  assert.ok(
    probeLogs[0] === EXPECTED_SUCCESS,
    'the success is logged as a fixed line, with no group keys or verdicts',
  );
  const everything = [
    ...captured.log,
    ...captured.warn,
    ...captured.error,
  ].join('\n');
  assert.ok(
    !everything.includes(SYNTHETIC_CITY_SECRET),
    'the operator city id never reaches a log',
  );
  assert.equal(res.statusCode, 200, 'the request still answered');
});
