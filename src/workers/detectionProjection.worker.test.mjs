// src/workers/detectionProjection.worker.test.mjs
//
// Verification for the detection projection worker (PLAN Phase 5 concurrency
// bullet). The real module is driven in-process through its `self.onmessage`
// protocol. Pins:
//
//   1. Projection math — the row-major view-projection layout is load-bearing:
//     sx = ((vp0·x + vp4·y + vp8·z + vp12)/w·0.5 + 0.5)·width, and a swapped
//     coefficient pair silently projects every bracket to the wrong pixel.
//   2. Rejection paths — horizon-occluded AND behind-the-clip objects come
//     back visible:false with the zeroed shape the main thread reads.
//   3. Reticle scaling — AIR brackets ride the near/far curve and clamps;
//     non-AIR uses the fixed tracked/untracked sizes.
//   4. Dispatch placement — detection.js posts to the worker BEFORE iterating,
//     caps the in-flight queue at depth 1, and consumes a stored answer only
//     when its request still describes the current frame bit-for-bit (first
//     frame, camera motion, cohort churn, and unanswered-request frames all
//     fall back to main-thread projection).
import test from 'node:test';
import assert from 'node:assert/strict';

import { readSource } from '../testSupport/readSource.js';

const posted = [];
const messageHandlers = [];
globalThis.self = {
  addEventListener: (type, fn) => { if (type === 'message') messageHandlers.push(fn); },
  postMessage: (msg) => posted.push(msg),
};

await import('./detectionProjection.worker.js');
const send = (data) => messageHandlers.forEach((fn) => fn({ data }));

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


// Requests now carry the cohort as an id-keyed Map (stable per-object hashes —
// cohort order may permute between frames), not an index-ordered array.
function cohort(objects) {
  return new Map(objects.map((o) => [o.id, o]));
}

const WIDTH = 1000;
const HEIGHT = 500;
// Orthographic-style matrix: sx = (x·0.5 + 0.5)·W, sy = (0.5 − y·0.5)·H,
// clipW = 1. Exact expected pixels are computable from the object position.
const ORTHO = {
  vp0: 1, vp5: 1, vp15: 1,
  vp1: 0, vp3: 0, vp4: 0, vp7: 0, vp8: 0, vp9: 0, vp11: 0, vp12: 0, vp13: 0,
};
const occluderCameraPos = geodeticToEcef(0, 0, 500_000);
const camPos = occluderCameraPos;

test('projection worker: row-major transform maps positions to exact pixels', () => {
  posted.length = 0;
  const pos = geodeticToEcef(0, 0.5);
  send({
    objectsById: cohort([{ id: 0, type: 'Vessel', skipLabel: false, position: pos }]),
    viewProjection: ORTHO,
    cameraPosition: camPos,
    width: WIDTH,
    height: HEIGHT,
    camPos,
    occluderCameraPos,
    requestId: 1,
  });
  assert.equal(posted.length, 1);
  const msg = posted[0];
  assert.equal(msg.requestId, 1, 'requestId must be echoed verbatim');
  assert.equal(msg.results.length, 1);
  const row = msg.results[0];
  // Deterministic expected values from the DOCUMENTED layout above.
  const expectedSx = (pos.x * 0.5 + 0.5) * WIDTH;
  const expectedSy = (0.5 - pos.y * 0.5) * HEIGHT;
  assert.ok(Math.abs(row.sx - expectedSx) < 1e-6, `sx ${row.sx} ≠ ${expectedSx}`);
  assert.ok(Math.abs(row.sy - expectedSy) < 1e-6, `sy ${row.sy} ≠ ${expectedSy}`);
  assert.equal(row.visible, true);
  // Distance from camPos to the surface point ≈ 500 km along the radial.
  assert.ok(row.distance > 400_000 && row.distance < 600_000, `distance ${row.distance}`);
  assert.equal(row.halfW, 16, 'non-AIR untracked bracket uses the fixed default width');
  assert.equal(row.halfH, 10);
  assert.equal(row.type, 'Vessel');
  assert.equal(row.skipLabel, false);
});

test('projection worker: horizon-occluded objects return the zeroed invisible shape', () => {
  posted.length = 0;
  send({
    objectsById: cohort([{ id: 'far', type: 'Vessel', skipLabel: false, position: geodeticToEcef(0, 179) }]),
    viewProjection: ORTHO,
    cameraPosition: camPos,
    width: WIDTH,
    height: HEIGHT,
    camPos,
    occluderCameraPos,
    requestId: 2,
  });
  const row = posted[0].results[0];
  assert.deepEqual(
    { id: row.id, visible: row.visible, sx: row.sx, sy: row.sy, distance: row.distance, halfW: row.halfW, halfH: row.halfH },
    { id: 'far', visible: false, sx: 0, sy: 0, distance: 0, halfW: 0, halfH: 0 },
    'occluded rows must be fully zeroed — the main thread reads every field',
  );
});

test('projection worker: behind-the-clip objects (clipW ≤ 0) are rejected', () => {
  posted.length = 0;
  // clipW = vp3·x + vp7·y + vp11·z + vp15 — zero coefficients make clipW 0
  // regardless of position: the "behind the camera" door with a trivial matrix.
  send({
    objectsById: cohort([{ id: 0, type: 'Vessel', skipLabel: false, position: geodeticToEcef(0, 0.5) }]),
    viewProjection: { ...ORTHO, vp15: 0 },
    cameraPosition: camPos,
    width: WIDTH,
    height: HEIGHT,
    camPos,
    occluderCameraPos,
    requestId: 3,
  });
  assert.equal(posted[0].results[0].visible, false);
});

test('projection worker: AIR reticle rides the near/far curve with clamps', () => {
  posted.length = 0;
  const nearPos = geodeticToEcef(0, 0.5);
  // Occluder at 5,000 km altitude (horizon ≈ 60°) so the far probe at 50°
  // stays VISIBLE; `camPos` is an independent field, so the far message
  // parks it 9,000 km from that probe to reach the ≥ 8,000 km far plateau.
  const hiOccluder = geodeticToEcef(0, 0, 5_000_000);
  const farPos = geodeticToEcef(0, 50);
  const base = {
    viewProjection: ORTHO,
    cameraPosition: camPos,
    width: WIDTH,
    height: HEIGHT,
    occluderCameraPos: hiOccluder,
  };
  send({
    ...base,
    objectsById: cohort([
      { id: 'near-untracked', type: 'AIR', skipLabel: false, position: nearPos },
      { id: 'near-tracked', type: 'AIR', skipLabel: true, position: nearPos },
    ]),
    camPos: { x: nearPos.x - 100, y: nearPos.y, z: nearPos.z }, // 100 m → near plateau (×3)
    requestId: 4,
  });
  const [nearU, nearT] = posted[0].results;
  // Near plateau (scale 3): untracked 9×3=27 / 7×3=21; tracked 14×3=42 / 11×3=33.
  assert.equal(nearU.halfW, 27);
  assert.equal(nearU.halfH, 21);
  assert.equal(nearT.halfW, 42);
  assert.equal(nearT.halfH, 33);

  send({
    ...base,
    objectsById: cohort([{ id: 'far-untracked', type: 'AIR', skipLabel: false, position: farPos }]),
    camPos: { x: farPos.x - 9_000_000, y: farPos.y, z: farPos.z }, // 9,000 km → far plateau (×0.5)
    requestId: 5,
  });
  const farU = posted[1].results[0];
  assert.equal(farU.visible, true, '50° stays inside the 5,000 km occluder horizon');
  // Far plateau (scale 0.5): 9×0.5=4.5 clamps UP to the 7 px floor.
  assert.equal(farU.halfW, 7, 'far AIR width clamps to the 7 px floor');
  assert.equal(farU.halfH, 5, 'far AIR height clamps to the 5 px floor');
});

test('projection worker: objects without a position are skipped, not crashed on', () => {
  posted.length = 0;
  send({
    objectsById: cohort([
      { id: 'a', type: 'Vessel', skipLabel: false, position: null },
      { id: 'b', type: 'Vessel', skipLabel: false, position: geodeticToEcef(0, 1) },
    ]),
    viewProjection: ORTHO,
    cameraPosition: camPos,
    width: WIDTH,
    height: HEIGHT,
    camPos,
    occluderCameraPos,
    requestId: 5,
  });
  assert.deepEqual(posted[0].results.map((r) => r.id), ['b'],
    'a positionless object yields no row — the keyed answer makes the gap explicit');
});

test('detection.js consumes only exact-match answers and caps the worker queue at depth 1', () => {
  const src = readSource('../data/detection.js', import.meta.url);
  assert.match(src, /Dispatch projection work to the Web Worker before iterating objects/,
    'dispatch must precede the draw loop');
  // The historical gate — `_workerProjectionResultId === requestId` — could
  // never pass: the next frame incremented the id before any cross-task
  // answer arrived, so every worker result was discarded and the synchronous
  // fallback paid the full projection cost every frame. Pin its absence.
  assert.doesNotMatch(src, /_workerProjectionResultId/,
    'the requestId-equality consumption gate was dead logic and must stay gone');
  assert.match(src,
    /projectionRequestMatches\(\s*_workerProjectionRequest,\s*objects/,
    'stored answers are consumed only when their request still describes this frame');
  assert.match(src, /worker && !workerResult && !_projectionInFlight/,
    'no new request may be posted while one is unanswered — queue depth is capped at 1');
  assert.match(src, /uses the synchronous main-thread projection below/,
    'the synchronous fallback path must stay documented and present');
  // Sizes are re-derived main-thread-side from the worker's distance: the
  // worker cannot see the DENSE profile, and consuming its non-DENSE sizes in
  // a DENSE steady state would silently shrink untracked brackets (16/10
  // instead of 11/7).
  assert.match(src, /_bracketHalfSizes\(obj, r\.distance\)/,
    'consumed rows must derive sizes through the shared, mode-aware helper');
});
