import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from './lifecycle.js';
import { createRendering } from './rendering.js';
import { createState } from './state.js';

const overlays = () => ({
  clearOverlaySource() {},
  setOverlaySourceVisible() {},
  setOverlayEntries() {},
});

/** A viewer whose data sources and entities record what was done to them. */
function recordingViewer() {
  const calls = [];
  return {
    calls,
    dataSources: {
      add: (source) => calls.push(['add', source]),
      remove: (source, destroy) => calls.push(['remove', source, destroy]),
    },
    entities: { remove: (entity) => calls.push(['removeEntity', entity]) },
    scene: { requestRender() {} },
  };
}

test('the stations data source is added once, clustered, and removed with its listener', () => {
  const services = {
    ground: { cachedGroundFloor: () => null },
    overlays: overlays(),
    render: { governorRequestRender() {} },
  };
  const state = createState({ services });
  const rendering = createRendering({ state, services, parts: {} });
  const viewer = recordingViewer();
  state._viewer = viewer;

  rendering.installDataSource(viewer);
  const source = state._dataSource;
  assert.ok(source, 'a data source is made');
  assert.equal(source.name, 'Radio stations');
  assert.equal(source.clustering.enabled, true);
  assert.equal(typeof state._removeClusterListener, 'function');
  rendering.installDataSource(viewer);
  assert.deepEqual(viewer.calls, [['add', source]], 'added once');

  rendering.setStationsShown(false);
  assert.equal(source.show, false);

  rendering.removeDataSource();
  assert.deepEqual(viewer.calls.at(-1), ['remove', source, true]);
  assert.equal(state._dataSource, null);
  assert.equal(state._removeClusterListener, null);
  assert.equal(source.clustering.clusterEvent.numberOfListeners, 0);
});

test('the lifecycle leaves the Cesium data source and entities to the rendering part', () => {
  const services = { overlays: overlays() };
  const state = createState({ services });
  const done = [];
  const record =
    (name) =>
    (...args) =>
      done.push([name, ...args]);
  const parts = {
    clustering: {
      resetRadioClusterOverlayIdentities() {},
      emptyRadioOverlayDiagnostics: () => ({}),
    },
    playback: { installAudio() {}, stopRadioPlayback() {} },
    rendering: {
      installDataSource: record('installDataSource'),
      setStationsShown: record('setStationsShown'),
      removeSelectionEntity: record('removeSelectionEntity'),
      removeDataSource: record('removeDataSource'),
    },
    interaction: {
      syncRadioLifecyclePresentation() {},
      removeInteraction() {},
    },
    presentation: { emitState() {} },
    navigation: { invalidateRadioCameraNavigation() {} },
    tuning: { endRadioTuning() {} },
    volume: { cancelRadioVolumeTransition() {} },
  };
  const { methods } = createLifecycle({ state, services, parts });
  const viewer = recordingViewer();

  methods.init(viewer);
  assert.deepEqual(done, [
    ['installDataSource', viewer],
    ['setStationsShown', false],
  ]);
  done.length = 0;
  methods.destroy();
  assert.deepEqual(done, [
    ['setStationsShown', false],
    ['removeSelectionEntity'],
    ['removeDataSource'],
  ]);
  assert.deepEqual(viewer.calls, [], 'the lifecycle drives no viewer itself');
  assert.equal(state._viewer, null);
});
