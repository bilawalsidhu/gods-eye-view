import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
import { createPhotoSlots } from './photos.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';

/** Compose recent wildlife observations without acquiring data at construction.
 * The layer draws on the globe engine it is attached to (attachRenderer) and
 * keeps its observations, filters and selection while detached. */
export function createWildlifeSightingsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
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
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Wildlife sightings require a snapshot source');
  const state = {
    engine: null,
    enabled: false,
    destroyed: false,
    manager: null,
    request: null,
    background: null,
    cameraTimer: null,
    removeCamera: null,
    removeContext: null,
    removeClick: null,
    rows: new Map(),
    renderedRows: [],
    rowById: new Map(),
    badges: null,
    pointById: new Map(),
    positions: new Map(),
    cells: [],
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
  context = bindOverlayHost(context, () => state.engine);
  overlayHost = bindOverlayHost(overlayHost, () => state.engine);
  const parts = {};
  const services = {
    source,
    overlayHost,
    picking,
    pointer,
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
