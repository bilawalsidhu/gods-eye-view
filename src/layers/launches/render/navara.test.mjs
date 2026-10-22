import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { WHITE } from '../../shared/color.js';
import { createLaunchesNavaraRenderer } from './navara.js';

const position = geo.cartesian3.fromDegrees(0, 0, 1000);
test('mission bank growth, callbacks and source visibility write actual mover stores', async () => {
  const engine = createFakeEngine();
  const renderer = createLaunchesNavaraRenderer(engine);
  const source = renderer.createDataSource();
  let sample = position;
  for (let i = 0; i < 1100; i++)
    renderer.addEntity(source, {
      id: `rocket-launch:${i}`,
      position: renderer.callback(() => sample),
      point: { pixelSize: 6, color: WHITE, show: true },
    });
  const values = source.entities.values;
  source.show = true;
  await Promise.resolve();
  const listed = engine.movers.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].count, 1100);
  const set = engine.fake.moverSet(listed[0].id);
  assert.equal(set.store.pickIds[1000], 'rocket-launch:1000');
  const remove = renderer.on('preRender', () => {});
  sample = { x: 1, y: 2, z: 3 };
  engine.fake.frame();
  assert.deepEqual([...set.store.positions.slice(0, 3)], [1, 2, 3]);
  assert.equal(source.entities.values, values);
  source.entities.getById('rocket-launch:0').point.show = false;
  await Promise.resolve();
  assert.equal(set.store.shows[0], 0);
  source.show = false;
  await Promise.resolve();
  assert.equal(engine.movers.list()[0].count, 0);
  const commits = engine.fake.moverSet(listed[0].id).commits;
  sample = { x: 7, y: 8, z: 9 };
  engine.fake.resetCalls();
  engine.fake.frames(3);
  assert.equal(engine.fake.moverSet(listed[0].id).commits, commits);
  assert.equal(
    engine.fake.renderRequests,
    0,
    'hidden motion must not sustain rendering',
  );
  source.show = true;
  await Promise.resolve();
  assert.equal(engine.movers.list()[0].count, 1100);
  source.entities.removeAll();
  await Promise.resolve();
  assert.equal(values.length, 0);
  assert.equal(engine.movers.list()[0].count, 0);
  remove();
  renderer.destroy();
  assert.equal(engine.movers.list().length, 0);
  engine.destroy();
});

test('mission lines retain dash styles and orbit matrices and release on removal', () => {
  const engine = createFakeEngine();
  const renderer = createLaunchesNavaraRenderer(engine);
  const source = renderer.createDataSource();
  source.show = true;
  const entity = renderer.addEntity(source, {
    id: 'rocket-transfer:x',
    polyline: {
      positions: [position, { x: 0, y: 6778137, z: 0 }],
      width: 2,
      material: renderer.dash({
        color: WHITE,
        dashLength: 24,
        dashPattern: 0xf0f0,
      }),
    },
  });
  const first = engine.lines.list()[0];
  assert.deepEqual(engine.fake.line(first.id).options.dash, {
    kind: 'pixels',
    lengthPx: 6,
    gapPx: 6,
  });
  entity.show = false;
  assert.equal(engine.lines.list()[0].shown, false);
  const orbit = renderer.createOrbit({
    positions: [position, { x: 0, y: 6778137, z: 0 }],
    width: 3,
    color: WHITE,
  });
  assert.deepEqual(orbit.modelMatrix, geo.matrix4.IDENTITY);
  orbit.modelMatrix[12] = 42;
  renderer.commitOrbit(orbit);
  assert.equal(engine.fake.line(engine.lines.list()[1].id).modelMatrix[12], 42);
  renderer.removePrimitive(orbit);
  renderer.removeDataSource(source);
  assert.equal(engine.lines.list().length, 0);
  renderer.destroy();
  engine.destroy();
});

test('mission hover uses engine drillPick and obeys disabled state', () => {
  const engine = createFakeEngine();
  const renderer = createLaunchesNavaraRenderer(engine);
  const source = renderer.createDataSource();
  const entity = renderer.addEntity(source, {
    id: 'rocket-launch:x',
    position,
    point: { pixelSize: 6, color: WHITE },
  });
  engine.fake.script('drillPick', [{ id: entity.id }]);
  let enabled = true,
    hovered = null;
  const handler = renderer.listenMove(
    source,
    (e) => {
      hovered = e;
    },
    { enabled: () => enabled },
  );
  engine.fake.input('move', { endPosition: { x: 1, y: 2 } });
  assert.equal(hovered, entity);
  enabled = false;
  hovered = null;
  engine.fake.input('move', { endPosition: { x: 1, y: 2 } });
  assert.equal(hovered, null);
  handler.destroy();
  renderer.destroy();
  engine.destroy();
});

test('flat pad uses a native mesh description, ellipsoid ENU placement and idempotent disposal', () => {
  const engine = createFakeEngine();
  engine.fake.script('sampleHeight', 125);
  let config,
    removed = 0;
  const view = {
    registerMesh() {},
    addMesh(value) {
      config = value;
      return {
        delete() {
          removed++;
        },
      };
    },
  };
  const renderer = createLaunchesNavaraRenderer(engine, {
    view,
    MeshDesc: class {},
  });
  const pad = renderer.createPad({ id: 'x', lon: 0, lat: 0 });
  assert.equal(
    engine.fake.callsOf('surface.sampleHeight').length,
    0,
    'flat pad must not sample a coarse tile',
  );
  const group = config.gevLaunchPad.group;
  assert.equal(group.children.length, 2);
  assert.equal(group.matrix.elements[12], 6378137);
  assert.equal(group.children[0].material.polygonOffsetUnits, -4);
  pad.show = false;
  assert.equal(group.visible, false);
  pad.destroy();
  pad.destroy();
  assert.equal(removed, 1);
  renderer.destroy();
  engine.destroy();
});
