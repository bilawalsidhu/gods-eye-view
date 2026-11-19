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
