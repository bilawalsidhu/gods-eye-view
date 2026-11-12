import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gstime, propagate, twoline2satrec } from 'satellite.js';
import {
  ISS_MODEL_SCALE,
  issFlightAxes,
  issModelShouldShow,
  temeToEcefAxes,
} from './issModel.js';
import {
  ISS_MODEL_CENTER_NATIVE,
  ISS_MODEL_LOCAL_AXES,
  ISS_MODEL_NATIVE_SPAN,
  ISS_MODEL_URL,
  ISS_NORAD,
  ISS_SPAN_M,
} from './policy.js';

const ISS_TLE = [
  '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9002',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579  1234',
];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

const shown = {
  enabled: true,
  showPoints: true,
  hasIss: true,
  classVisible: true,
  tracked: false,
  cockpitHidden: false,
};

test('the ISS model shows on the same terms as its dot', () => {
  assert.equal(issModelShouldShow(shown), true);
  assert.equal(issModelShouldShow({ ...shown, enabled: false }), false);
  assert.equal(issModelShouldShow({ ...shown, showPoints: false }), false);
  assert.equal(issModelShouldShow({ ...shown, hasIss: false }), false);
  assert.equal(issModelShouldShow({ ...shown, classVisible: false }), false);
});

test('a tracked ISS keeps its model with its class hidden', () => {
  assert.equal(
    issModelShouldShow({ ...shown, classVisible: false, tracked: true }),
    true,
  );
});

test('the Cockpit hold hides the model', () => {
  assert.equal(
    issModelShouldShow({ ...shown, tracked: true, cockpitHidden: true }),
    false,
  );
});

test('the model is the ISS by NORAD number, at its real 109 m span', () => {
  assert.equal(ISS_NORAD, 25544);
  assert.ok(
    Math.abs(ISS_MODEL_SCALE * ISS_MODEL_NATIVE_SPAN - ISS_SPAN_M) < 1e-9,
  );
});

test('the native span and centre match the shipped asset', () => {
  const glb = readFileSync(
    new URL(`../../../public${ISS_MODEL_URL}`, import.meta.url),
  );
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
  const root = gltf.nodes[gltf.scenes[0].nodes[0]];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  // Every node below the root rests untransformed (joint nodes included), so
  // each mesh's bounds are already in the root's frame.
  const visit = (index) => {
    const node = gltf.nodes[index];
    assert.equal(node.rotation ?? null, null);
    assert.equal(node.scale ?? null, null);
    assert.equal(node.translation ?? null, null);
    for (const primitive of gltf.meshes[node.mesh]?.primitives ?? []) {
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], accessor.min[i]);
        max[i] = Math.max(max[i], accessor.max[i]);
      }
    }
    (node.children ?? []).forEach(visit);
  };
  root.children.forEach(visit);
  // The truss is the longest axis, glTF X.
  assert.ok(Math.abs(max[0] - min[0] - ISS_MODEL_NATIVE_SPAN) < 0.01);
  assert.ok(max[0] - min[0] > max[1] - min[1]);
  assert.ok(max[0] - min[0] > max[2] - min[2]);
  ISS_MODEL_CENTER_NATIVE.forEach((value, i) =>
    assert.ok(Math.abs((min[i] + max[i]) / 2 - value) < 0.01),
  );
  // The scene root moves that centre to the origin: minimumPixelSize scales
  // the model about its origin, so the far-range model stays centred.
  assert.deepEqual(
    root.translation.map((value, i) => value + ISS_MODEL_CENTER_NATIVE[i]),
    [0, 0, 0],
  );
  // NASA's own textures ship with it.
  assert.ok(gltf.textures.length > 0);
});

test('the model axes are a proper rotation of the flight axes', () => {
  // A cyclic order of x, y, z keeps the frame right-handed (no mirroring).
  const order = ISS_MODEL_LOCAL_AXES.join('');
  assert.ok(['xyz', 'yzx', 'zxy'].includes(order));
});

test('flight axes: orthonormal, z away from the Earth, x along the motion', () => {
  const satrec = twoline2satrec(ISS_TLE[0], ISS_TLE[1]);
  for (const minutes of [0, 17, 46, 80]) {
    const date = new Date(Date.UTC(2024, 0, 1, 12, minutes));
    const { position, velocity } = propagate(satrec, date);
    const gmst = gstime(date);
    const r = temeToEcefAxes(position, gmst);
    const v = temeToEcefAxes(velocity, gmst);
    const axes = issFlightAxes(r, v);
    for (const key of ['x', 'y', 'z'])
      assert.ok(Math.abs(norm(axes[key]) - 1) < 1e-9);
    assert.ok(Math.abs(dot(axes.x, axes.y)) < 1e-9);
    assert.ok(Math.abs(dot(axes.y, axes.z)) < 1e-9);
    assert.ok(Math.abs(dot(axes.x, axes.z)) < 1e-9);
    const rUnit = [r.x, r.y, r.z].map((c) => c / norm([r.x, r.y, r.z]));
    assert.ok(dot(axes.z, rUnit) > 0.999999);
    // A near-circular orbit: the along-track axis is almost the velocity.
    const vUnit = [v.x, v.y, v.z].map((c) => c / norm([v.x, v.y, v.z]));
    assert.ok(dot(axes.x, vUnit) > 0.999);
    // Right-handed: x × y = z.
    const cross = [
      axes.x[1] * axes.y[2] - axes.x[2] * axes.y[1],
      axes.x[2] * axes.y[0] - axes.x[0] * axes.y[2],
      axes.x[0] * axes.y[1] - axes.x[1] * axes.y[0],
    ];
    assert.ok(dot(cross, axes.z) > 0.999999);
  }
});

test('flight axes refuse a degenerate state', () => {
  assert.equal(issFlightAxes({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), null);
  assert.equal(issFlightAxes({ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }), null);
});

test('TEME to Earth-fixed axes keeps the position eciToGeodetic uses', () => {
  const v = temeToEcefAxes({ x: 1, y: 0, z: 0 }, Math.PI / 2);
  assert.ok(Math.abs(v.x) < 1e-12);
  assert.ok(Math.abs(v.y + 1) < 1e-12);
});

test('the ISS live panel follows the ISS selection', async () => {
  const { issLiveShouldShow } = await import('./issLive.js');
  const base = {
    enabled: true,
    trackedNorad: ISS_NORAD,
    cockpitHeld: false,
    dismissed: false,
  };
  assert.equal(issLiveShouldShow(base), true);
  assert.equal(issLiveShouldShow({ ...base, trackedNorad: 48274 }), false);
  assert.equal(issLiveShouldShow({ ...base, trackedNorad: null }), false);
  assert.equal(issLiveShouldShow({ ...base, enabled: false }), false);
  assert.equal(issLiveShouldShow({ ...base, cockpitHeld: true }), false);
  assert.equal(issLiveShouldShow({ ...base, dismissed: true }), false);
});

test("the ISS live player is NASA's stream on the privacy-enhanced host", async () => {
  const { issLiveEmbedUrl, issLiveWatchUrl } = await import('./issLive.js');
  const { ISS_LIVE_VIDEO_ID } = await import('./policy.js');
  const embed = new URL(issLiveEmbedUrl(ISS_LIVE_VIDEO_ID));
  assert.equal(embed.origin, 'https://www.youtube-nocookie.com');
  assert.equal(embed.pathname, `/embed/${ISS_LIVE_VIDEO_ID}`);
  // Muted, or the browser will not start it on its own.
  assert.equal(embed.searchParams.get('mute'), '1');
  assert.equal(embed.searchParams.get('autoplay'), '1');
  assert.equal(
    issLiveWatchUrl(ISS_LIVE_VIDEO_ID),
    `https://www.youtube.com/watch?v=${ISS_LIVE_VIDEO_ID}`,
  );
});
