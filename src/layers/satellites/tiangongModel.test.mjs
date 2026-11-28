import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { issModelSpec } from './issModel.js';
import {
  ISS_MODEL_LOCAL_AXES,
  ISS_NORAD,
  TIANGONG_MODEL_URL,
  TIANGONG_NORAD,
} from './policy.js';
import { stationModelShouldShow } from './stationModel.js';
import { tiangongIsModule, tiangongModelSpec } from './tiangongModel.js';

test("Tiangong is CSS (TIANHE) by NORAD number, drawn at the file's meters", () => {
  const spec = tiangongModelSpec();
  assert.equal(TIANGONG_NORAD, 48274);
  assert.equal(spec.norad, TIANGONG_NORAD);
  assert.equal(spec.key, 'tiangong');
  assert.equal(spec.scale, 1);
  assert.equal(spec.modelUrl, TIANGONG_MODEL_URL);
  // The same frame as the ISS file, so the same flight-axes mapping.
  assert.equal(spec.localAxes, ISS_MODEL_LOCAL_AXES);
  // No telemetry; Cockpit views on the model, so the model stays while the
  // Cockpit rides it.
  assert.equal(spec.createTelemetry, null);
  assert.equal(typeof spec.cockpitMount, 'function');
  assert.equal(spec.hideInCockpit, false);
  assert.equal(spec.syncOrbit, null);
  assert.equal(typeof spec.createArticulation().update, 'function');
});

test("the ISS spec keeps the ISS's own rules; its ring has none", () => {
  const spec = issModelSpec({ parts: {} });
  assert.equal(spec.norad, ISS_NORAD);
  assert.equal(spec.key, 'iss');
  assert.equal(spec.hideInCockpit, false);
  assert.equal(typeof spec.cockpitMount, 'function');
  assert.equal(typeof spec.createTelemetry, 'function');
  // Its ring is drawn only while tracked, as for every satellite.
  assert.equal(spec.syncOrbit, null);
});

test("the station's modules are CSS (…) entries; ships are vehicles", () => {
  assert.equal(
    tiangongIsModule(TIANGONG_NORAD, { name: 'CSS (TIANHE)' }),
    true,
  );
  assert.equal(tiangongIsModule(53239, { name: 'CSS (WENTIAN)' }), true);
  assert.equal(tiangongIsModule(54216, { name: 'CSS (MENGTIAN)' }), true);
  assert.equal(tiangongIsModule(60000, { name: 'SHENZHOU-23 (SZ-23)' }), false);
  assert.equal(tiangongIsModule(60001, { name: 'TIANZHOU-10' }), false);
  assert.equal(
    tiangongIsModule(60002, undefined),
    true,
    'unknown: not a vehicle',
  );
});

test("a station hidden for the Cockpit stays hidden; the dot's rules otherwise", () => {
  const shown = {
    enabled: true,
    showPoints: true,
    hasStation: true,
    classVisible: true,
    tracked: false,
    cockpitHidden: false,
  };
  assert.equal(stationModelShouldShow(shown), true);
  assert.equal(
    stationModelShouldShow({ ...shown, cockpitHidden: true }),
    false,
  );
  assert.equal(stationModelShouldShow({ ...shown, hasStation: false }), false);
  assert.equal(
    stationModelShouldShow({ ...shown, classVisible: false, tracked: true }),
    true,
  );
});

test('the shipped asset is centred on the station, in meters, with its own textures', () => {
  const glb = readFileSync(
    new URL(`../../../public${TIANGONG_MODEL_URL}`, import.meta.url),
  );
  assert.equal(glb.toString('latin1', 0, 4), 'glTF');
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
  assert.deepEqual(gltf.scenes[0].nodes.length, 1);
  const root = gltf.nodes[gltf.scenes[0].nodes[0]];
  assert.equal(root.name, 'tiangong');
  // The same compression and texture format as the ISS file.
  assert.ok(gltf.extensionsUsed.includes('KHR_draco_mesh_compression'));
  assert.ok(gltf.extensionsUsed.includes('EXT_texture_webp'));
  assert.ok(gltf.textures.length > 0);
  assert.equal(gltf.animations ?? undefined, undefined);
  // Station extents (without the vehicles): 41.9 m across the lab wings,
  // 57.2 m along the flight direction. The root puts their centre at the
  // origin, so minimumPixelSize scales about the orbital position.
  const vehicles = new Set([
    'SHENZHOU_FORWARD',
    'SHENZHOU_NADIR',
    'TIANZHOU_AFT',
  ]);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (index) => {
    const node = gltf.nodes[index];
    if (vehicles.has(node.name)) return;
    const offset = node.translation ?? [0, 0, 0];
    for (const primitive of gltf.meshes[node.mesh]?.primitives ?? []) {
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], accessor.min[i] + offset[i]);
        max[i] = Math.max(max[i], accessor.max[i] + offset[i]);
      }
    }
    (node.children ?? []).forEach(visit);
  };
  root.children.forEach(visit);
  assert.ok(Math.abs(max[0] - min[0] - 41.9) < 0.1, `X ${max[0] - min[0]}`);
  assert.ok(Math.abs(max[2] - min[2] - 57.2) < 0.1, `Z ${max[2] - min[2]}`);
  for (let i = 0; i < 3; i++)
    assert.ok(
      Math.abs((min[i] + max[i]) / 2 + root.translation[i]) < 0.05,
      `centre ${i}`,
    );
});
