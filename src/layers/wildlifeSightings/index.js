import * as Cesium from 'cesium';
import { horizonOccluder } from '../../data/iconOrientation.js';
import { createPhotoSlots } from './photos.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';

/** Compose recent wildlife observations without acquiring data at construction. */
export function createWildlifeSightingsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  sprites = null,
  badgeSprites = null,
  render = null,
  context = null,
  focus = null,
  groundFloor = null,
  now = () => Date.now(),
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = (timer) => clearTimeout(timer),
  requestIdleCallback,
  cancelIdleCallback,
  imageFactory,
  eventTarget = globalThis.window,
  cesium = Cesium,
  project = (scene, position) =>
    Cesium.SceneTransforms.worldToWindowCoordinates(scene, position),
  occluderFactory = horizonOccluder,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Wildlife sightings require a snapshot source');
  const state = {
    viewer: null,
    enabled: false,
    destroyed: false,
    manager: null,
    request: null,
    background: null,
    cameraTimer: null,
    removeCamera: null,
    removeContext: null,
    clickHandler: null,
    rows: new Map(),
    renderedRows: [],
    rowById: new Map(),
    points: null,
    pointById: new Map(),
    positions: new Map(),
    cells: [],
    staging: null,
    selectedId: null,
    selectedRow: null,
    carriers: new Map(),
    contextIds: new Set(),
    publishingContext: false,
    ambientIds: [],
    ambientRows: [],
    confirmed: false,
    taxa: 'all',
    drawnParams: null,
    pendingParams: null,
    failedParams: null,
    controlsListener: null,
    lastUpdate: null,
    error: null,
    stale: false,
    loading: false,
    gridCells: [],
    gridParams: null,
    gridAvailable: false,
    gridTotal: 0,
    labelRows: [],
    query: null,
    band: null,
    lastQueryKey: null,
    retryAt: 0,
    failures: 0,
  };
  const parts = {};
  const services = {
    source,
    overlayHost,
    screenSpaceEventHandlerFactory,
    picking,
    pointer,
    sprites,
    badgeSprites,
    render,
    context,
    focus,
    groundFloor,
    now,
    setTimer,
    clearTimer,
    requestIdleCallback,
    cancelIdleCallback,
    eventTarget,
    cesium,
    project,
    occluderFactory,
  };
  const owner = { state, services, parts };
  parts.photos = createPhotoSlots({
    imageFactory,
    now,
    setTimer,
    clearTimer,
    onChange() {
      if (!state.enabled) return;
      parts.selection.publishAmbient();
    },
  });
  parts.rendering = createRendering(owner);
  parts.selection = createSelection(owner);
  parts.controls = createControls(owner);
  parts.lifecycle = createLifecycle(owner);
  return Object.assign({}, parts.controls.methods, parts.lifecycle.methods, {
    selectSighting: parts.selection.selectAndFocus,
    clearSightingSelection: parts.selection.clearAndRebuild,
    subscribeSelection: parts.selection.subscribe,
    /** Return the current surface anchor for a retained observation. */
    getSightingPosition(id) {
      return state.positions.get(id) || null;
    },
  });
}
