import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSelection } from '../layers/cctv/selection.js';
import { createPresentation } from '../layers/cctv/presentation.js';

const catalog = JSON.parse(
  readFileSync(
    new URL('../../config/cctv_sources.argentina.json', import.meta.url),
  ),
);

for (const feedType of ['embed', 'hls', 'image', 'none']) {
  test(`an off-screen Argentina ${feedType} camera activates by ID and stays in the light picker`, () => {
    const camera = {
      ...catalog.find(
        (entry) =>
          entry.feedType === (feedType === 'none' ? 'image' : feedType),
      ),
      feedType,
    };
    const visible = {
      camera: { id: 'visible', city: 'Test', name: 'Visible' },
    };
    const target = { camera };
    const state = {
      _activeCameraId: null,
      _records: [visible, target],
      _recordById: new Map([
        [visible.camera.id, visible],
        [camera.id, target],
      ]),
      _viewRecords: [visible],
      _cardIds: new Set(),
      _cardGraceState: new Map(),
      _geoQueue: [],
      _healthById: new Map(),
    };
    let viewPasses = 0;
    let geometryQueues = 0;
    let notifications = 0;
    const noop = () => {};
    const parts = {
      model: {
        sectorAreaKm2: () => 0,
        currentViewContext: () => 'global',
        isVideoFeedType: (type) => type === 'hls',
        cctvRecordNeedsActivation: (id, active, record) =>
          id !== active || !record.activationDone,
      },
      calibration: {
        normalizeCalibration: () => ({}),
        deriveCalBadge: () => 'raw-prior',
      },
      projection: { startProjectionLoop: noop, ensureProjectionRuntime: noop },
      geometry: {
        coverageNeighborCount: () => 0,
        clearProbeClampOnDeactivation: noop,
        runActivationObstructionProbe: noop,
        ensureActiveCoverageEntities: noop,
        updateRecordGeometry: noop,
      },
      ground: { rearmGroundResolution: noop, resolveFootprintGround: noop },
      frames: {
        refreshProjectionImage: noop,
        frameUrlFor: () => null,
        mediaUrlFor: () => null,
      },
      rendering: {
        refreshCoverageStyles: noop,
        refreshHorizonCulling: () => {
          viewPasses++;
        },
      },
      geometryQueue: {
        enqueueViewGeometry: () => {
          geometryQueues++;
        },
      },
      cards: { refreshAmbientCards: noop },
      presentation: {
        notifyListeners: () => {
          notifications++;
        },
      },
    };
    const selection = createSelection({
      state,
      parts,
      services: {
        activation: {
          CCTV_ACTIVATION_RESULT: {
            ACTIVATED: 'activated',
            UNCHANGED: 'unchanged',
            NOT_FOUND: 'not-found',
          },
        },
        picking: { resolvePickId: noop },
        render: { releaseContinuousRender: noop },
      },
    });
    parts.selection = selection;
    const presentation = createPresentation({ state, parts, services: {} });
    assert.deepEqual(
      presentation.uiState().cameraIndex.map((entry) => entry.id),
      ['visible'],
    );
    assert.equal(selection.setActiveCamera(camera.id), 'activated');
    assert.equal(selection.getActiveRecord(), target);
    assert.deepEqual(
      presentation.uiState().cameraIndex.map((entry) => entry.id),
      [camera.id, 'visible'],
    );
    assert.equal(viewPasses, 1, 'activation reruns visibility');
    assert.equal(geometryQueues, 1, 'activation queues its new working set');
    const index = presentation.uiState().cameraIndex;
    state._viewRecords = [];
    assert.deepEqual(
      presentation.uiState().cameraIndex.map((entry) => entry.id),
      [camera.id],
      'panning away retains the active camera',
    );
    assert.notEqual(presentation.uiState().cameraIndex, index);
    assert.equal(selection.setActiveCamera(camera.id), 'unchanged');
    assert.equal(notifications, 1, 'reselect does not restart the player');
    assert.equal(selection.setActiveCamera('unknown'), 'not-found');
    assert.equal(selection.getActiveRecord(), target);
  });
}
