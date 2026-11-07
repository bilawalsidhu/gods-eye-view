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
    dataSource: new Cesium.CustomDataSource(),
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
  parts.namedMarkers = createNamedMarkers(ctx);
  const selection = createSelection(ctx);
  selection.installInteraction(state.viewer);
  t.after(() => {
    selection.destroy();
    state.clickSubscription();
    parts.namedMarkers.destroy();
    parts.rendering.clearRendered();
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
    assert.equal(
      state.dataSource.entities.values.filter((e) => e.polygon).length,
      selected ? 1 : 0,
    );
  };
  assert.equal(selection.selectRecord(record.id), true);
  assertSelected(true);
  return {
    state,
    selection,
    assertSelected,
    draw,
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
