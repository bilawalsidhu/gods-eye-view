import test from 'node:test';
import assert from 'node:assert/strict';
import { createRendering } from './rendering.js';
import { createLifecycle } from './lifecycle.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

function harness() {
  const ring = [[-97, 30], [-96.99, 30], [-96.99, 30.01], [-97, 30]];
  const record = { id: 'base', latitude: 30, longitude: -97, name: 'Base', class: 'base', footprints: [[ring, ring.map(([x,y]) => [x+0.001,y+0.001])], [ring]] };
  let globeVisible = false;
  const viewer = { scene: {}, camera: {} };
  const { draw } = bindFakeDraw(viewer, { globe: { isGlobeVisible: () => globeVisible } });
  const state = { enabled: true, selectedId: 'base', records: [record], recordById: new Map([['base', record]]), renderedKeys: new Map(), viewer };
  let listener, removed = 0;
  const noop = () => {};
  const services = { ground: { floorAltitudeM: () => 0, cachedGroundFloor: () => 0 }, anchors: {}, render: { governorRequestRender: noop }, context: { removeEntityContextsForLayer: noop, clearSelectedEntityContextForLayer: noop }, picking: { registerPickOwner: noop, unregisterPickOwner: noop }, maps: { subscribeMapStack(cb) { listener = cb; return () => { listener = null; removed++; }; } } };
  const parts = { model: { colorFor: () => [1, 165 / 255, 0, 1], installationSourceLabel: () => 'OpenStreetMap' }, viewport: { clearUnavailableRetry: noop }, ingestion: { setInstallationStatus: noop } };
  parts.rendering = createRendering({ state, services, parts });
  parts.rendering.attach(viewer);
  const lifecycle = createLifecycle({ state, services, parts, source: {} }).methods;
  const fills = () => [...draw.set(state.sets.fills.id).items.values()];
  return { state, record, parts, lifecycle, draw, fills, showGlobe: (shown) => { globeVisible = shown; }, changeSurface: () => listener(), removed: () => removed };
}

test('selected multipart footprints drape on Google tiles with one constant translucent colour and holes', () => {
  const h = harness(), render = h.parts.rendering;
  render.syncSelectionFill();
  const fills = h.fills();
  assert.equal(fills.length, 2);
  for (const fill of fills) {
    assert.equal(fill.meta.installationId, 'base');
    assert.equal(fill.clampTo, 'tiles');
    assert.equal(fill.height, 'clampGround');
    assert.equal(fill.extrudeHeight, undefined);
    assert.deepEqual(fill.fill, [1, 165 / 255, 0, 0.22]);
  }
  assert.equal(fills[0].geometry.rings.length, 2, 'the hole is a second ring');
  assert.equal(fills[0].fill, fills[1].fill);
  const writes = h.draw.set(h.state.sets.fills.id).writes;
  for (let i = 0; i < 100; i++) render.syncSelectionFill();
  assert.equal(h.draw.set(h.state.sets.fills.id).writes, writes, 'repaints retain ground geometry');
  assert.deepEqual(h.fills(), fills);
  h.state.selectedId = null; render.syncSelectionFill();
  assert.equal(h.fills().length, 0);
});

test('surface changes reclassify selected geometry and disable tears down fills and subscription', () => {
  const h = harness();
  h.lifecycle.enable(); h.parts.rendering.syncSelectionFill();
  h.showGlobe(true); h.changeSurface();
  assert.ok(h.fills().every((fill) => fill.clampTo === 'both'));
  h.lifecycle.disable();
  assert.equal(h.fills().length, 0);
  assert.equal(h.removed(), 1);
  h.lifecycle.enable(); h.parts.rendering.syncSelectionFill();
  assert.equal(h.fills().length, 0, 'reenabling cannot revive a stale selection');
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
    rendering.attach(h.state.viewer);
    const cleared = [];
    window.addEventListener('gev:entity-selection-cleared', e => { cleared.push(e.detail); h.state.selectedId = null; });
    rendering.renderRecords({ claimSelection: true });
    const oldCarrier = context.getSelectedEntityContext().entity;
    h.record.latitude += 0.001;
    rendering.renderRecords();
    assert.equal(h.state.selectedId, 'base');
    assert.equal(context.getSelectedEntityContext().id, 'base');
    assert.notEqual(context.getSelectedEntityContext().entity, oldCarrier);
    const replacement = { ...h.record, id: 'canonical', aliasIds: ['base'] };
    h.state.records = [replacement]; h.state.recordById = new Map([['canonical', replacement]]);
    rendering.renderRecords();
    assert.equal(h.state.selectedId, 'canonical');
    assert.equal(context.getSelectedEntityContext().id, 'canonical');
    assert.deepEqual(cleared, [], 'no transient eviction can tear down the selected card or fill');
    rendering.clearRendered();
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
