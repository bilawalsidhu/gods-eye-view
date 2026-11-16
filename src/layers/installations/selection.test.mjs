import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as context from '../../data/contextStore.js';
import { createSelection } from './selection.js';
import { createRendering } from './rendering.js';
import { createNamedMarkers, namedPointId } from './namedMarkers.js';
import { bindFakeCesiumScene } from '../../testSupport/fakeCesiumScene.mjs';
import { fakeInput } from '../../input/testDoubles.mjs';

function harness(t) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  const record = {
    id: 'base',
    name: 'Base',
    class: 'base',
    namedArea: true,
    latitude: 0,
    longitude: 0,
    footprints: [
      [
        [
          [0, 0],
          [0.01, 0],
          [0.01, 0.01],
          [0, 0],
        ],
      ],
    ],
  };
  const state = {
    enabled: true,
    selectedId: null,
    records: [record],
    recordById: new Map([[record.id, record]]),
    renderedKeys: new Map(),
    viewer: {
      camera: { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 1e6) },
      scene: {
        globe: { show: false },
        canvas: Object.assign(new EventTarget(), {
          clientWidth: 1280,
          clientHeight: 800,
        }),
        primitives: { add: (p) => p, remove() {} },
        pick: () => picked,
      },
    },
  };
  let picked;
  const { draw } = bindFakeCesiumScene(state.viewer);
  const input = fakeInput(state.viewer);
  t.mock.method(
    Cesium.SceneTransforms,
    'worldToWindowCoordinates',
    () => new Cesium.Cartesian2(640, 400),
  );
  let labels = [];
  const services = {
    context,
    anchors: {},
    ground: { floorAltitudeM: () => 0, cachedGroundFloor: () => 0 },
    render: { governorRequestRender() {} },
  };
  const parts = {
    model: {
      colorFor: () => [1, 165 / 255, 0, 1],
      installationSourceLabel: () => 'OpenStreetMap',
    },
  };
  const ctx = {
    state,
    services,
    parts,
    overlayHost: {
      setEntries(_id, entries) {
        labels = entries;
      },
      clearSource() {},
      setVisible() {},
    },
  };
  parts.rendering = createRendering(ctx);
  parts.rendering.attach(state.viewer);
  parts.namedMarkers = createNamedMarkers(ctx);
  const selection = createSelection(ctx);
  selection.installInteraction(state.viewer);
  t.after(() => {
    selection.destroy();
    state.clickSubscription();
    parts.namedMarkers.destroy();
    parts.rendering.clearRendered();
    parts.rendering.detach();
    input.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const assertSelected = (selected) => {
    assert.equal(state.selectedId, selected ? record.id : null);
    assert.equal(labels[0].selected, selected);
    assert.equal(labels[0].variant, selected ? 'selected' : 'card');
    assert.equal(state.sets.fills.size(), selected ? 1 : 0);
  };
  assert.equal(selection.selectRecord(record.id), true);
  assertSelected(true);
  return {
    state,
    selection,
    assertSelected,
    draw,
    input,
    parts,
    /** Click on what `pick` names, as the scene would pick it. */
    click(value) {
      picked = value;
      input.tap({ x: 640, y: 400 });
    },
  };
}

for (const layerId of ['flights', 'military', 'satellites']) {
  for (const publishBeforeEvent of [false, true]) {
    test(`${layerId} programmatic selection clears the installation card and fill (context first: ${publishBeforeEvent})`, (t) => {
      const h = harness(t);
      const subject = { id: 'other', layerId, origin: 'programmatic' };
      if (publishBeforeEvent) context.selectTrackedSubjectContext(subject);
      window.dispatchEvent(
        new CustomEvent('gev:awareness-subject-selected', { detail: subject }),
      );
      h.assertSelected(false);
      if (!publishBeforeEvent) context.selectTrackedSubjectContext(subject);
      assert.equal(context.getSelectedEntityContext().id, 'other');
      assert.equal(context.getSelectedEntityContext().layerId, layerId);
    });
  }
}

test('entity selection and clear still release the installation card and fill', (t) => {
  const h = harness(t);
  const other = {};
  context.registerEntityContext(other, { id: 'other', layerId: 'vessels' });
  context.selectEntityContext(other);
  h.assertSelected(false);
  h.selection.selectRecord('base');
  context.clearSelectedEntityContextForLayer('military-installations');
  h.assertSelected(false);
});

test('destroy removes all installation context listeners', (t) => {
  const h = harness(t);
  h.selection.destroy();
  context.selectTrackedSubjectContext({ id: 'other', layerId: 'flights' });
  for (const type of [
    'gev:entity-selected',
    'gev:entity-selection-cleared',
    'gev:awareness-subject-selected',
  ]) {
    window.dispatchEvent(
      new CustomEvent(type, { detail: { id: 'other', layerId: 'flights' } }),
    );
    h.assertSelected(true);
  }
});

test('a click on a named marker point selects its site; again releases it', (t) => {
  const h = harness(t);
  h.state.selectedId = null;
  context.clearSelectedEntityContextForLayer('military-installations');
  h.parts.rendering.renderRecords();
  h.assertSelected(false);
  const setId = h.parts.namedMarkers.setId;
  const item = h.draw.set(setId).items.get(namedPointId('base'));
  assert.deepEqual(item.meta, { installationId: 'base' });
  const pointPick = { id: { set: setId, id: item.id, meta: item.meta } };
  h.click(pointPick);
  h.assertSelected(true);
  h.click(pointPick);
  h.assertSelected(false);
  // Another set's item with the same meta is not this layer's point.
  h.click({ id: { set: 'other:1', id: item.id, meta: item.meta } });
  h.assertSelected(false);
});

test('a click on a site dot or its outline selects the site; another set does not', (t) => {
  const h = harness(t);
  h.state.selectedId = null;
  context.clearSelectedEntityContextForLayer('military-installations');
  h.state.records[0].namedArea = false;
  h.state.records[0].outlineLines = [
    [
      [0, 0],
      [0.01, 0],
    ],
  ];
  h.parts.rendering.renderRecords();
  const selectedNow = () => h.state.selectedId === 'base';
  assert.equal(selectedNow(), false);
  const dots = h.state.sets.dots;
  const dot = h.draw.set(dots.id).items.get('base');
  assert.equal(dot.show, true);
  assert.equal(dot.height, 'clampGround');
  assert.equal(dot.pixelSize, 9);
  assert.equal(dot.disableDepthTest, Infinity);
  // The dot carries the site's shared context record, for point-and-ask.
  assert.equal(context.getContextStore().entities.get('base').entity, dot.meta);
  h.click({ id: { set: dots.id, id: 'base', meta: dot.meta } });
  assert.equal(selectedNow(), true);
  assert.equal(context.getSelectedEntityContext().id, 'base');
  // Drawn larger and white by the selected set, hidden in its own.
  assert.equal(h.draw.set(dots.id).items.get('base').show, false);
  assert.equal(h.draw.set(dots.id).items.get('base').pixelSize, 9);
  const selectedSet = h.draw.set(h.state.sets.selected.id);
  const selected = selectedSet.items.get('base');
  assert.equal(selected.pixelSize, 13);
  assert.deepEqual(selected.color, [1, 1, 1, 1]);
  assert.equal(selected.meta, dot.meta);
  // A click on the selected dot clears it.
  h.click({ id: { set: selectedSet.spec.id, id: 'base', meta: dot.meta } });
  assert.equal(selectedNow(), false);
  assert.equal(selectedSet.items.size, 0);
  assert.equal(h.draw.set(dots.id).items.get('base').show, true);
  const outlines = h.state.sets.outlines;
  const outline = h.draw.set(outlines.id).items.get('base:outline:0');
  assert.equal(outline.mode, 'draped');
  assert.equal(outline.clampTo, 'both');
  h.click({ id: { set: outlines.id, id: outline.id, meta: outline.meta } });
  assert.equal(selectedNow(), true);
  h.click({ id: { set: 'other:1', id: outline.id, meta: outline.meta } });
  assert.equal(selectedNow(), false);
});
