import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Cesium from 'cesium';
import { createCctvCesiumRenderer } from './cesium.js';
import { viewshedColors } from '../../../data/cctvViewshed.js';

function viewer() {
  return {
    entities: new Cesium.EntityCollection(),
    scene: { primitives: new Cesium.PrimitiveCollection() },
    camera: { moveStart: new Cesium.Event(), moveEnd: new Cesium.Event() },
    isDestroyed: () => false,
  };
}
function setup(t) {
  const owner = viewer();
  const sprites = [];
  const state = { _recordById: new Map(), _projectionEntities: [] };
  const renderer = createCctvCesiumRenderer({
    state,
    services: {
      sprites: {
        registerSpriteCollection: (...args) => sprites.push(['add', ...args]),
        unregisterSpriteCollection: (...args) =>
          sprites.push(['remove', ...args]),
      },
    },
  });
  renderer.attach(owner);
  t.after(() => renderer.destroy());
  const p = (x, y, z) => new Cesium.Cartesian3(x, y, z);
  const positions = {
    mount: p(6378137, 0, 10),
    tl: p(6378137, 100, 40),
    tr: p(6378137, 140, 40),
    br: p(6378137, 140, 0),
    bl: p(6378137, 100, 0),
    capCenter: p(6378137, 120, 20),
  };
  return { owner, renderer, sprites, positions, state };
}

test('native CCTV releases only its original viewer resources and listeners', (t) => {
  const h = setup(t);
  const foreignViewer = viewer();
  const foreign = foreignViewer.entities.add({ id: 'cctv-a-cap' });
  const neighbor = h.owner.entities.add({ id: 'neighbor' });
  const markers = h.renderer.createMarkers();
  h.renderer.createMarker({ id: 'a' }, h.positions.mount);
  h.renderer.createCoverage('a', h.positions);
  const record = { camera: { id: 'a' }, frustumPositions: h.positions };
  const volume = h.renderer.createVolume(record, viewshedColors(30).fill);
  assert.equal(volume.allowPicking, false);
  assert.equal(volume.asynchronous, false);
  let moves = 0;
  h.renderer.onMoveEnd(() => moves++);
  h.owner.camera.moveEnd.raiseEvent();
  assert.equal(moves, 1);
  assert.throws(() => h.renderer.attach(foreignViewer), /already has an owner/);
  h.renderer.destroy(foreignViewer);
  h.renderer.destroy();
  h.owner.camera.moveEnd.raiseEvent();
  assert.equal(moves, 1);
  assert.deepEqual(h.owner.entities.values, [neighbor]);
  assert.equal(h.owner.scene.primitives.length, 0);
  assert.equal(foreignViewer.entities.getById(foreign.id), foreign);
  assert.deepEqual(h.sprites, [
    ['add', 'cctv', markers],
    ['remove', 'cctv', markers],
  ]);
});

test('coverage construction rolls back partial entities and can retry', (t) => {
  const h = setup(t);
  const collision = h.owner.entities.add({ id: 'cctv-a-ray-br' });
  assert.throws(() => h.renderer.createCoverage('a', h.positions));
  assert.deepEqual(h.owner.entities.values, [collision]);
  h.owner.entities.remove(collision);
  const lines = h.renderer.createCoverage('a', h.positions);
  assert.equal(lines.length, 5);
  assert.deepEqual(
    lines.map((line) => line._coverageRole),
    ['edge', 'edge', 'edge', 'edge', 'cap'],
  );
});

test('replaced native entity identities survive CCTV teardown', (t) => {
  const h = setup(t);
  const [line] = h.renderer.createCoverage('a', h.positions);
  h.owner.entities.remove(line);
  const replacement = h.owner.entities.add({ id: line.id });
  h.renderer.destroy();
  assert.deepEqual(h.owner.entities.values, [replacement]);
});

test('native materials convert portable colours and keep depth-fail and dash policy', (t) => {
  const h = setup(t);
  const [line] = h.renderer.createCoverage('a', h.positions);
  const tint = viewshedColors(210).line;
  h.renderer.styleLine(line, {
    visible: true,
    width: 1.8,
    tint,
    dashed: true,
    depthFail: tint.withAlpha(0.18),
  });
  const now = Cesium.JulianDate.now();
  assert.equal(line.polyline.material.getType(now), 'PolylineDash');
  assert.ok(
    Cesium.Color.equals(line.polyline.material.getValue(now).color, tint),
  );
  assert.equal(line.polyline.depthFailMaterial.getValue(now).color.alpha, 0.18);
  h.renderer.styleLine(line, {
    visible: false,
    width: 0.9,
    tint,
    dashed: false,
  });
  assert.equal(line.show, false);
  assert.equal(line.polyline.material.getType(now), 'Color');
  assert.equal(line.polyline.depthFailMaterial, undefined);
});

test('obstruction queries include the owned marker set and enforce finite range', (t) => {
  const h = setup(t);
  const markers = h.renderer.createMarkers();
  const exclude = [{}];
  let query;
  h.owner.scene.pickFromRay = (ray, exclusions) => {
    query = { ray, exclusions };
    return {
      position: Cesium.Cartesian3.add(
        ray.origin,
        new Cesium.Cartesian3(0, 20, 0),
        new Cesium.Cartesian3(),
      ),
    };
  };
  assert.equal(
    h.renderer.obstructionRay(
      h.positions.mount,
      Cesium.Cartesian3.UNIT_Y,
      exclude,
      10,
    ),
    undefined,
  );
  assert.ok(
    h.renderer.obstructionRay(
      h.positions.mount,
      Cesium.Cartesian3.UNIT_Y,
      exclude,
      30,
    ),
  );
  assert.deepEqual(query.exclusions, [markers, ...exclude]);
  assert.ok(query.ray instanceof Cesium.Ray);
});
