import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createRendering as civil } from './rendering.js';
import { createRendering as military } from '../military/rendering.js';

for (const [name, createRendering] of [
  ['civil', civil],
  ['military', military],
]) {
  test(`${name} cold model admission stays bounded and cancellation destroys late results`, async (t) => {
    const pending = [];
    t.mock.method(
      Cesium.Model,
      'fromGltfAsync',
      (options) => new Promise((resolve) => pending.push({ options, resolve })),
    );
    const state = {
      _models: new Map(),
      _modelPending: new Set(),
      _modelGen: new Map(),
      _modelEpoch: 1,
      _specCache: new Map(),
      _models3dEnabled: true,
      _models3dMode: 'all',
      _viewer: { camera: { positionCartographic: { height: 65000 } } },
      _billboardCollection: { show: true },
      _billboards: new Map(),
      _modelCollection: { isDestroyed: () => false, remove() {} },
      records: { data: new Map() },
    };
    const services = {
      militaryRegistry: { isMilitaryIcao: () => false },
      aircraftPresentation: { isTr3b: () => false, tr3bIconKind: () => null },
      camera: {},
      focus: {},
      recession: {},
    };
    const parts = { enrichment: { _requestTypeEnrichment() {} } };
    const rendering = createRendering({
      flightState: state,
      services,
      parts,
      resolveAsset: (url) => url,
    });
    const calls = Array.from({ length: 20 }, (_, i) => {
      const id = `plane-${i}`;
      state._billboards.set(id, { show: true });
      state.records.data.set(id, { klass: 'jet' });
      return rendering._ensureModel(id);
    });
    assert.equal(
      pending.length,
      4,
      'a dense fleet does not start hundreds of simultaneous loads',
    );
    assert.equal(state._modelPending.size, 4);
    assert.ok(pending.every((p) => p.options.asynchronous === true));
    assert.ok(
      [...state._billboards.values()].every((bb) => bb.show),
      'billboards cover loading models',
    );
    rendering._releaseModels();
    const results = pending.map(() => ({
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    }));
    pending.forEach((p, i) => p.resolve(results[i]));
    await Promise.all(calls);
    assert.ok(
      results.every((m) => m.destroyed),
      'late GPU resources do not leak after a regime change',
    );
    assert.equal(state._models.size, 0);
    assert.equal(state._modelPending.size, 0);
    assert.equal(state._modelGen.size, 0);
    state._modelLoadsThisTick = 0;
    state.records.data.set('ground-race', { klass: 'jet', onGround: true });
    state._billboards.set('ground-race', { show: true });
    state._groundMode = 'hide';
    await rendering._ensureModel('ground-race');
    assert.equal(
      pending.length,
      4,
      'hidden ground contacts start no model load',
    );
    state._groundMode = 'show';
    const loading = rendering._ensureModel('ground-race');
    assert.equal(pending.length, 5);
    // Preference changes before the next fleet tick must still reject a late
    // result, even without a release/generation change having run yet.
    state._groundMode = 'hide';
    const late = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    pending.at(-1).resolve(late);
    await loading;
    assert.equal(late.destroyed, true);
    assert.equal(state._models.has('ground-race'), false);
    assert.equal(state._modelPending.size, 0);
  });
}
