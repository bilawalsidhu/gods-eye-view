// src/workers/aisVisibility.worker.test.mjs
//
// Verification for the AIS visibility worker (PLAN Phase 5 concurrency
// bullet). The worker is pure JS with a `self.onmessage` protocol, so the
// REAL module is driven here in-process — no browser, no fake math. The
// pins cover the three properties the render path depends on:
//
//   1. Math honesty — the bitmask disagrees with the WGS84 horizon only at
//      the user's peril (a wrong occluder silently hides live vessels).
//   2. Full-cohort protocol — one message in, one bitmask for the ENTIRE
//      cohort out, requestId echoed, buffer transferred zero-copy.
//   3. Never-blocks-the-main-thread — the dispatcher is fire-and-forget and
//      the main-thread onmessage keeps only the LATEST requestId's result
//      (older results are discarded, not awaited).
import test from 'node:test';
import assert from 'node:assert/strict';

import { readSource } from '../testSupport/readSource.js';

// Install the worker global BEFORE importing the module: the worker does
// `self.addEventListener('message', ...)` at import time and
// `self.postMessage(...)` per message. Captured messages drive the
// assertions below.
const posted = [];
const messageHandlers = [];
globalThis.self = {
  addEventListener: (type, fn) => { if (type === 'message') messageHandlers.push(fn); },
  postMessage: (msg, transfer) => posted.push({ msg, transfer }),
};

await import('./aisVisibility.worker.js');
const send = (data) => messageHandlers.forEach((fn) => fn({ data }));

// WGS84 geodetic → ECEF (same ellipsoid the worker hardcodes).
function geodeticToEcef(latDeg, lonDeg, heightM = 0) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return {
    x: (n + heightM) * Math.cos(lat) * Math.cos(lon),
    y: (n + heightM) * Math.cos(lat) * Math.sin(lon),
    z: (n * (1 - e2) + heightM) * Math.sin(lat),
  };
}

const CAM_ALT_M = 500_000;
// Horizon angular radius from 500 km is acos(a/(a+h)) ≈ 22.0° — the probes
// sit well clear of that edge (1° inside, 30° and 179° outside) so the test
// pins the geometry, not a floating-point knife-edge.
const cameraPosition = geodeticToEcef(0, 0, CAM_ALT_M);

test('visibility worker: requestId round-trip, Uint8Array bitmask, zero-copy transfer', () => {
  posted.length = 0;
  const positions = [geodeticToEcef(0, 1), geodeticToEcef(0, 30), geodeticToEcef(0, 179)];
  send({ positions, cameraPosition, requestId: 42 });

  assert.equal(posted.length, 1);
  const { msg, transfer } = posted[0];
  assert.equal(msg.requestId, 42, 'requestId must be echoed verbatim');
  assert.ok(msg.visible instanceof Uint8Array, 'bitmask must be a Uint8Array');
  assert.equal(msg.visible.length, positions.length, 'one bit per input position');
  assert.ok(Array.isArray(transfer) && transfer[0] === msg.visible.buffer,
    'bitmask buffer must be handed off via the transfer list (zero-copy)');
});

test('visibility worker: horizon math — near-surface visible, over-the-horizon occluded', () => {
  posted.length = 0;
  // Same longitude ±1° (≈111 km, inside the 2200 km horizon), then 30°
  // (≈3330 km, beyond it), then nearly antipodal.
  const positions = [
    geodeticToEcef(0, 1),
    geodeticToEcef(0, -1),
    geodeticToEcef(0, 30),
    geodeticToEcef(0, 179),
  ];
  send({ positions, cameraPosition, requestId: 7 });
  const { msg } = posted[0];
  assert.deepEqual([...msg.visible], [1, 1, 0, 0],
    '±1° vessels must be visible from 500 km; 30° and 179° must be horizon-occluded');
});

test('visibility worker: answers EVERY message with its own requestId — never drops', () => {
  posted.length = 0;
  send({ positions: [geodeticToEcef(0, 1)], cameraPosition, requestId: 1 });
  send({ positions: [geodeticToEcef(0, 179)], cameraPosition, requestId: 2 });
  assert.equal(posted.length, 2, 'the worker answers every request');
  assert.deepEqual(posted.map((p) => p.msg.requestId), [1, 2]);
  // Latest-wins is enforced on the MAIN-thread side (below); the worker is
  // a dumb, reliable calculator.
  assert.deepEqual([...posted[0].msg.visible], [1]);
  assert.deepEqual([...posted[1].msg.visible], [0]);
});

// Independent reference: Cesium EllipsoidalOccluder.isScaledSpacePointVisible.
// Deliberately written from the Cesium algorithm, not shared with the worker.
function cesiumReferenceVisible(cam, p) {
  const A = 6378137.0;
  const B = 6356752.314245179;
  const cv = { x: cam.x / A, y: cam.y / A, z: cam.z / B };
  const pt = { x: p.x / A, y: p.y / A, z: p.z / B };
  const vh = cv.x * cv.x + cv.y * cv.y + cv.z * cv.z - 1;
  const vt = { x: pt.x - cv.x, y: pt.y - cv.y, z: pt.z - cv.z };
  const vtDotVc = -(vt.x * cv.x + vt.y * cv.y + vt.z * cv.z);
  const occluded = vh < 0
    ? vtDotVc > 0
    : vtDotVc > vh && (vtDotVc * vtDotVc) / (vt.x * vt.x + vt.y * vt.y + vt.z * vt.z) > vh;
  return !occluded;
}

test('visibility worker: agrees with the Cesium occluder reference across altitudes and latitudes', () => {
  // The worker replaces Cesium's occluder on the hot path — it must agree
  // with it everywhere, or vessels flip between the worker path and the
  // main-thread fallback as the camera moves. Probes span the horizon edge
  // at each altitude (0.5×–4× the horizon angle) and off-equator latitudes
  // where the ellipsoid's normal tilt is largest.
  for (const [altM, lats] of [
    [2000, [0, 45, -60]],      // horizon ≈ 1.4°
    [500_000, [0, 45]],        // horizon ≈ 22°
    [5_000_000, [0, -45]],     // horizon ≈ 60°
  ]) {
    for (const lat of lats) {
      const cam = geodeticToEcef(lat, 20, altM);
      const probes = [];
      for (let dLon = -120; dLon <= 120; dLon += 2) probes.push(geodeticToEcef(lat, 20 + dLon));
      posted.length = 0;
      send({ positions: probes, cameraPosition: cam, requestId: 1 });
      const got = [...posted[0].msg.visible];
      const expected = probes.map((p) => (cesiumReferenceVisible(cam, p) ? 1 : 0));
      const mismatches = got
        .map((v, i) => (v === expected[i] ? null : `dLon=${(i * 2) - 120}: worker=${v} cesium=${expected[i]}`))
        .filter(Boolean);
      assert.deepEqual(mismatches, [],
        `worker disagrees with Cesium occluder at alt=${altM} lat=${lat}`);
    }
  }
});

test('visibility worker: a full 12k cohort comes back as one 12k bitmask', () => {  posted.length = 0;
  const positions = Array.from({ length: 12_000 }, (_, i) => geodeticToEcef(0, (i % 360) - 180));
  send({ positions, cameraPosition, requestId: 99 });
  const { msg } = posted[0];
  assert.equal(msg.visible.length, 12_000,
    'the render path replaces the WHOLE cohort per dispatch — no partial masks');
  assert.equal(msg.visible[0], 0, 'lon -180 (antipodal to the camera) stays occluded in the bulk result');
});

test('dispatcher is fire-and-forget and the main thread keeps only the latest result', () => {
  const src = readSource('../data/aisLiveVessels.js', import.meta.url);
  assert.match(src, /Returns immediately — result is delivered asynchronously via onmessage/,
    'dispatch must document its non-blocking contract');
  // postMessage-and-return: no await between dispatch and render — the
  // horizon math never stalls a frame.
  assert.doesNotMatch(src, /await\s+dispatchVisibilityWorker/,
    'nothing may await the visibility dispatch');
  // Latest-wins filter: stale responses are discarded, not queued.
  assert.match(src, /if \(requestId === _workerPendingId\)/,
    'main-thread onmessage must gate on the latest requestId');
  assert.match(src, /_workerPendingId = -1;/,
    'a consumed result must clear the pending id (single-use)');
});
