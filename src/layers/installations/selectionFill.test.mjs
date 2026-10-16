import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { createRendering } from './rendering.js';
import { createLifecycle } from './lifecycle.js';

function harness() {
  const ring = [[-97, 30], [-96.99, 30], [-96.99, 30.01], [-97, 30]];
  const record = { id: 'base', latitude: 30, longitude: -97, name: 'Base', class: 'base', footprints: [[ring, ring.map(([x,y]) => [x+0.001,y+0.001])], [ring]] };
  const state = { enabled: true, selectedId: 'base', records: [record], recordById: new Map([['base', record]]), renderedKeys: new Map(), dataSource: new C.CustomDataSource(), viewer: { scene: { globe: { show: false } }, camera: {} } };
  let listener, removed = 0;
  const noop = () => {};
  const services = { ground: { floorAltitudeM: () => 0, cachedGroundFloor: () => 0 }, anchors: {}, render: { governorRequestRender: noop }, context: { removeEntityContextsForLayer: noop, clearSelectedEntityContextForLayer: noop }, picking: { registerPickOwner: noop, unregisterPickOwner: noop }, maps: { subscribeMapStack(cb) { listener = cb; return () => { listener = null; removed++; }; } } };
  const parts = { model: { colorFor: () => C.Color.ORANGE, installationSourceLabel: () => 'OpenStreetMap' }, viewport: { clearUnavailableRetry: noop }, ingestion: { setInstallationStatus: noop } };
  parts.rendering = createRendering({ state, services, parts });
  const lifecycle = createLifecycle({ state, services, parts, source: {} }).methods;
  return { state, record, parts, lifecycle, changeSurface: () => listener(), removed: () => removed };
}

test('selected multipart footprints classify Google tiles with one constant translucent material and holes', () => {
  const h = harness(), render = h.parts.rendering;
  render.syncSelectionFill();
  const fills = h.state.dataSource.entities.values.slice();
  assert.equal(fills.length, 2);
  for (const fill of fills) {
    assert.equal(fill.installationId, 'base');
    assert.equal(fill.polygon.classificationType.getValue(), C.ClassificationType.CESIUM_3D_TILE);
    assert.equal(fill.polygon.height, undefined);
    assert.equal(fill.polygon.extrudedHeight, undefined);
    assert.equal(fill.polygon.material.isConstant, true);
    assert.equal(fill.polygon.material.color.getValue().alpha, 0.22);
  }
  assert.equal(fills[0].polygon.hierarchy.getValue().holes.length, 1);
  assert.equal(fills[0].polygon.material, fills[1].polygon.material);
  for (let i = 0; i < 100; i++) render.syncSelectionFill();
  assert.deepEqual(h.state.dataSource.entities.values, fills, 'repaints retain ground geometry');
  h.state.selectedId = null; render.syncSelectionFill();
  assert.equal(h.state.dataSource.entities.values.length, 0);
});

test('surface changes reclassify selected geometry and disable tears down fills and subscription', () => {
  const h = harness();
  h.lifecycle.enable(); h.parts.rendering.syncSelectionFill();
  h.state.viewer.scene.globe.show = true; h.changeSurface();
  assert.ok(h.state.dataSource.entities.values.every(e => e.polygon.classificationType.getValue() === C.ClassificationType.BOTH));
  h.lifecycle.disable();
  assert.equal(h.state.dataSource.entities.values.length, 0);
  assert.equal(h.removed(), 1);
  h.lifecycle.enable(); h.parts.rendering.syncSelectionFill();
  assert.equal(h.state.dataSource.entities.values.length, 0, 'reenabling cannot revive a stale selection');
  h.lifecycle.disable();
});


test('geometry rebuild and canonical alias migration preserve shared selection before pruning', async () => {
  const context = await import('../../data/contextStore.js');
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    const h = harness();
    const services = { context, render: { governorRequestRender() {} }, ground: { floorAltitudeM: () => 0, cachedGroundFloor: () => 0 }, anchors: {} };
    const rendering = createRendering({ state: h.state, services, parts: h.parts });
    const cleared = [];
    window.addEventListener('gev:entity-selection-cleared', e => { cleared.push(e.detail); h.state.selectedId = null; });
    rendering.renderRecords({ claimSelection: true });
    const oldEntity = context.getSelectedEntityContext().entity;
    h.record.latitude += 0.001;
    rendering.renderRecords();
    assert.equal(h.state.selectedId, 'base');
    assert.equal(context.getSelectedEntityContext().id, 'base');
    assert.notEqual(context.getSelectedEntityContext().entity, oldEntity);
    const replacement = { ...h.record, id: 'canonical', aliasIds: ['base'] };
    h.state.records = [replacement]; h.state.recordById = new Map([['canonical', replacement]]);
    rendering.renderRecords();
    assert.equal(h.state.selectedId, 'canonical');
    assert.equal(context.getSelectedEntityContext().id, 'canonical');
    assert.deepEqual(cleared, [], 'no transient eviction can tear down the selected card or fill');
    rendering.clearRendered();
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
