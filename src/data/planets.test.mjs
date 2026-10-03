import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import planetsLayer from './planets.js';

/**
 * Recording entity-collection stub: captures entity specs so tests can pin
 * the label property contracts Cesium enforces downstream, without a scene.
 */
function makeViewerStub() {
  const added = [];
  return {
    added,
    entities: {
      add(spec) {
        const entity = { ...spec, show: false };
        added.push(entity);
        return entity;
      },
      remove(entity) {
        const idx = added.indexOf(entity);
        if (idx !== -1) added.splice(idx, 1);
        return idx !== -1;
      },
      get values() { return [...added]; },
    },
    clock: { currentTime: Cesium.JulianDate.now() },
    // Deliberately NO `scene`: since the Phase 15B interval conversion the
    // layer must not need frame plumbing at init (the old preRender listener
    // did). This stub doubles as that regression pin.
  };
}

test('planet labels declare translucencyByDistance as a NearFarScalar', async () => {
  const viewer = makeViewerStub();
  await planetsLayer.init(viewer);
  try {
    assert.equal(viewer.added.length, 8, 'seven planets + the Moon');
    for (const entity of viewer.added) {
      const fade = entity.label.translucencyByDistance;
      assert.ok(
        fade instanceof Cesium.NearFarScalar,
        `${entity.label.text}: translucencyByDistance must be a NearFarScalar`
          + ' — a Cesium.Interval is accepted silently (undefined <= undefined'
          + ' passes the far/near guard) and clones into NaN translucency',
      );
      assert.deepEqual(
        { near: fade.near, nearValue: fade.nearValue, far: fade.far, farValue: fade.farValue },
        { near: 1e9, nearValue: 1.0, far: 5e9, farValue: 0.3 },
      );
    }
  } finally {
    planetsLayer.destroy(viewer);
  }
});

test('init does not require scene frame plumbing (interval-driven updates)', async () => {
  const viewer = makeViewerStub();
  await planetsLayer.init(viewer);
  planetsLayer.destroy(viewer);
  assert.equal(viewer.added.length, 0, 'destroy removes every entity');
});

test('enable/disable own exactly one refresh interval, and destroy stops it', async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let intervals = 0;
  let clears = 0;
  globalThis.setInterval = (fn, ms) => { intervals += 1; return realSetInterval(fn, ms); };
  globalThis.clearInterval = (timer) => { clears += 1; return realClearInterval(timer); };
  try {
    // No init: _viewer stays null so _update() early-returns and no Cesium
    // ephemeris code runs — this test pins the TIMER contract only.
    await planetsLayer.enable();
    assert.equal(intervals, 1, 'enable registers exactly one refresh interval');
    await planetsLayer.enable();
    assert.equal(intervals, 1, 'enable is idempotent about the interval');
    await planetsLayer.disable();
    assert.equal(clears, 1, 'disable stops the interval');
    await planetsLayer.destroy();
    assert.equal(clears, 1, 'destroy after disable clears nothing extra');
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test('destroy without enable is safe', async () => {
  await planetsLayer.destroy();
  assert.equal(planetsLayer.id, 'planets');
});

test('update satisfies the manager enable contract and is viewerless-safe', async () => {
  // DataLayerManager's enable transaction calls module.update(viewer, {signal})
  // unconditionally and rolls the enable back if it throws. Planets shipped
  // without this method, so every manager-driven enable (UI toggle included)
  // failed with a TypeError and the layer stayed OFF — the 15B census caught
  // it as `not-enabled`.
  assert.equal(typeof planetsLayer.update, 'function', 'update must exist');
  // No init/enable here: _update early-returns on the null _viewer, so this
  // pins the contract shape without running Cesium ephemeris code.
  const result = await planetsLayer.update({}, {});
  assert.notEqual(result, false, 'update must not report lifecycle rejection');
});
