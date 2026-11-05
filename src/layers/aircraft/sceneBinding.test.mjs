import assert from 'node:assert/strict';
import test from 'node:test';
import { createAircraftSceneBinding } from './sceneBinding.js';
import { LayerBindings } from '../../ui/layerBindings.js';
import { createEngineEvent } from '../../globe/contract.js';
import { readLayerSource } from '../../testSupport/readLayerSource.mjs';

function observedShell(t) {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => {
    globalThis.window = previous;
  });
  const trackedEntityChanged = createEngineEvent();
  const shell = {
    generation: 1,
    trackedEntityChanged,
  };
  const bindings = new LayerBindings({
    viewer: { trackedEntityChanged },
    services: {},
    operations: {
      _stampNavigation() {
        shell.generation++;
      },
    },
  });
  bindings.observeCamera();
  t.after(() => bindings.stop());
  return shell;
}

// What the tracking modules do around follow.start on a resume or a share
// restore (the shared aircraft tracking.js and satellites tracking.js).
function follow(trackedEntityChanged, entity, restoring) {
  if (restoring) entity.gevRestoring = true;
  try {
    trackedEntityChanged.raiseEvent(entity);
  } finally {
    if (restoring) delete entity.gevRestoring;
  }
}

function binding(flightState, tracked) {
  const renderer = {
    fleet: {
      attach() {},
      detach() {},
      setVisible() {},
      restoreOrder() {},
    },
    models: { setVisible() {}, destroy() {} },
    follow: {
      isFollowing: () => true,
      release() {},
    },
    tracked: { remove() {} },
    destroy() {},
  };
  return createAircraftSceneBinding({
    id: 'flights',
    flightState,
    services: {
      renderer: { create: () => renderer },
      render: { releaseContinuousRender() {} },
      picking: { unregisterPickOwner() {} },
    },
    parts: {
      snapshots: { presentRecords() {} },
      tracking: {
        _trackFlight: tracked,
        _removeClickHandler() {},
        _detachTrail() {},
      },
      rendering: { _releaseTrackedModel() {}, _releaseModels() {} },
      motion: { _resetTrackedDisplay() {} },
    },
  });
}

test('resuming an aircraft on Cesium preserves the pending share navigation', (t) => {
  const shell = observedShell(t);
  let restored;
  binding(
    { initialized: true, _trackedIcao: 'a00000', _preloadModel: {} },
    (id, options) => {
      restored = { id, ...options };
      follow(
        shell.trackedEntityChanged,
        { gevSelectionOrigin: options.origin },
        options.resume,
      );
    },
  ).attachRenderer({});
  assert.equal(restored.id, 'a00000');
  assert.equal(restored.resume, true);
  assert.equal(
    shell.generation,
    1,
    'restored tracking cannot supersede and clear itself',
  );
  for (const origin of ['user', 'voice', 'programmatic']) {
    follow(shell.trackedEntityChanged, { gevSelectionOrigin: origin }, false);
  }
  assert.equal(
    shell.generation,
    4,
    'new tracking still takes navigation authority',
  );
});

test('a restored aircraft followed again later is new navigation', (t) => {
  const shell = observedShell(t);
  const entity = { gevSelectionOrigin: 'share-restore' };
  follow(shell.trackedEntityChanged, entity, true);
  assert.equal(shell.generation, 1);
  assert.equal('gevRestoring' in entity, false, 'the mark does not stick');
  // Cockpit exit or a refocus hands the same aircraft back to the camera.
  shell.trackedEntityChanged.raiseEvent(undefined);
  shell.trackedEntityChanged.raiseEvent(entity);
  assert.equal(shell.generation, 2);
});

test('an engine switch resumes the aircraft with the origin it was selected by', () => {
  const calls = [];
  const flightState = {
    initialized: true,
    _trackedIcao: 'a00000',
    _preloadModel: null,
    _modelEpoch: 0,
    _modelPending: new Map(),
    _modelGen: new Map(),
    _billboards: new Map(),
    _cullPositions: new Map(),
    _detectionObjects: new Set(),
    _groundSnap: new Map(),
  };
  const scene = binding(flightState, (id, options) => calls.push(options));
  flightState._preloadModel = {};
  scene.attachRenderer({});
  assert.equal(calls[0].origin, 'programmatic');
  flightState._trackedEntity = { gevSelectionOrigin: 'voice' };
  scene.detachRenderer({});
  flightState._preloadModel = {};
  scene.attachRenderer({});
  assert.equal(calls[1].origin, 'voice');
  assert.equal(calls[1].resume, true);
  assert.equal(calls[1].follow, true);
});

test('every follow of a resumed or share-restored subject is marked while it starts', () => {
  for (const [file, resume] of [
    ['aircraft/tracking.js', 'resume'],
    ['satellites/tracking.js', 'resuming'],
  ]) {
    const source = readLayerSource(new URL(`../${file}`, import.meta.url));
    assert.match(
      source,
      new RegExp(
        `const restoring = ${resume} \\|\\| origin === 'share-restore';\\s*if \\(restoring\\) entity\\.gevRestoring = true;\\s*try \\{[\\s\\S]*?follow\\.start\\(entity\\);?\\s*\\} finally \\{\\s*if \\(restoring\\) delete entity\\.gevRestoring;`,
      ),
      file,
    );
    assert.equal(source.match(/follow\.start\(/g).length, 1, file);
  }
});
