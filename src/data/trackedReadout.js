import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { WORLD_OVERLAY_STYLE } from '../overlays/worldOverlayTokens.js';
import { engineFromViewer } from '../globe/cesium/engineFromViewer.js';

/**
 * @module trackedReadout
 * @description Presentation-model bridge for the protected tracked-target
 * entry in the shared world-overlay host. This module owns no canvas,
 * projection, frame listener, layout, fade, or paint path.
 */

export const TRACKED_OVERLAY_SOURCE_ID = 'tracked';
export const TRACKED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: true,
  solveIntervalMs: 0,
  hideInCockpit: true,
});
const TRACKED_BILLBOARD_SCALE = Object.freeze({
  near: 1000,
  nearValue: 3,
  far: 8_000_000,
  farValue: 0.5,
});

const DEFAULT_TRACKED_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

let _viewer = null;
// The globe engine, when the readout was given one (or a viewer with a
// registered engine): the followed target is engine.camera.following().
let _engine = null;
let _trackedEntityChangedRemove = null;
let _selectedContext = null;
let _contextSelectedHandler = null;
let _contextClearedHandler = null;
let _aircraftSelectedHandler = null;
let _activeEntryId = null;
let _overlayHost = DEFAULT_TRACKED_OVERLAY_HOST;

/**
 * Convert the former newline/inline label text into the explicit presentation
 * model used by the host.
 * @param {string} text Raw source-formatted label text.
 * @param {string} accent Source-owned accent color.
 * @returns {{title:string,details:string[],accent:string}}
 */
export function trackedLabelModelFromText(
  text,
  accent = WORLD_OVERLAY_STYLE.accent,
) {
  const raw = String(text || '').trim();
  if (!raw) return { title: '', details: [], accent };
  let lines;
  if (raw.includes('\n')) {
    lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } else {
    const parts = raw.split(' · ');
    lines =
      parts.length > 1
        ? [parts[0].trim(), parts.slice(1).join(' · ').trim()]
        : [raw];
  }
  return { title: lines[0] || '', details: lines.slice(1), accent };
}

/**
 * Read only the layer-owned display cache. There is deliberately no fallback
 * to `entity.position.getValue()`: doing so in the host's post-render phase
 * would recompute dead reckoning after the follow camera settled and jitter.
 * @param {Object|null} entity Tracked or selected presentation entity.
 * @returns {Object|null}
 */
export function cachedTrackedDisplayPosition(entity) {
  if (!entity || typeof entity.gevDisplayPosition !== 'function') return null;
  try {
    return entity.gevDisplayPosition() || null;
  } catch {
    return null;
  }
}

/**
 * Anchor for the tracked CARD: the position the target is visually at.
 *
 * A layer that renders its tracked contact as a 3D model publishes
 * `gevVisualPosition`, which returns the translation that model is actually rendering
 * with. For a grounded aircraft that differs from the display position by the full
 * ground-snap offset (~100 m at an inland airport), so a card anchored to the display
 * position sits below the aircraft and climbs slowly as the coarse floor cell warms.
 *
 * Falls back to the display position, so layers without a 3D visual (and any layer
 * before its model is ready) are unchanged. This deliberately does NOT repurpose
 * `gevDisplayPosition`: that accessor carries the follow-camera anti-jitter contract
 * and must keep returning the value the camera settled on.
 * @param {Object|null} entity Tracked or selected presentation entity.
 * @returns {Object|null}
 */
export function cachedTrackedVisualPosition(entity) {
  if (entity && typeof entity.gevVisualPosition === 'function') {
    try {
      const visual = entity.gevVisualPosition();
      if (visual) return visual;
    } catch {
      /* fall through to the display position */
    }
  }
  return cachedTrackedDisplayPosition(entity);
}

function entryIdFor(entity) {
  const explicit = String(entity?.gevTrackedId || '').trim();
  if (explicit) return explicit;
  const fallback = String(entity?.id || '').trim();
  return fallback ? `entity:${fallback}` : null;
}

// A follow's plain-data label as the subject the readout reads (the shape a
// Cesium layer's tracked Entity has): one subject per follow handle.
const _labelSubjects = new WeakMap();
function followSubject(handle) {
  if (!handle) return null;
  const { label } = handle;
  if (!label) return handle.native ?? null;
  let subject = _labelSubjects.get(handle);
  if (!subject) {
    subject = {
      gevTrackedId: label.id,
      get gevLabelModel() {
        const { model } = handle.label ?? label;
        return typeof model === 'function' ? model() : model;
      },
      gevDisplayPosition: () => (handle.label ?? label).position(),
    };
    _labelSubjects.set(handle, subject);
  }
  return subject;
}

function trackedSubject() {
  if (_engine) return followSubject(_engine.camera.following());
  return _viewer?.trackedEntity || null;
}

function activeEntity() {
  return trackedSubject() || _selectedContext?.entity || null;
}

/**
 * Build the host entry from a layer-owned tracked presentation model.
 * @param {Object|null} entity Tracked or selected presentation entity.
 * @returns {Object|null}
 */
export function createTrackedOverlayEntry(entity) {
  const model = entity?.gevLabelModel;
  const id = entryIdFor(entity);
  if (!id || !model || typeof entity.gevDisplayPosition !== 'function') {
    return null;
  }
  const title = String(model.title || '').trim();
  if (!title) return null;
  return {
    id,
    position: () => cachedTrackedVisualPosition(entity),
    variant: 'tracked',
    tracked: true,
    protected: true,
    paintLane: 'tracked',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details: Array.isArray(model.details)
      ? model.details.map((line) => String(line))
      : [],
    accent: model.accent || WORLD_OVERLAY_STYLE.accent,
    cardStyle: model.cardStyle,
    selected: model.selected === true,
    leaderStyle: model.leaderStyle,
    leaderAnimationMs: model.leaderAnimationMs,
    leaderAnimationStartedAt: model.leaderAnimationStartedAt,
    leaderDrawRatio: model.leaderDrawRatio,
    anchorRadiusPx: Number.isFinite(Number(model.anchorRadiusPx))
      ? Math.max(0, Number(model.anchorRadiusPx))
      : 10,
    anchorRadiusScale: Object.prototype.hasOwnProperty.call(
      model,
      'anchorRadiusScale',
    )
      ? model.anchorRadiusScale
      : TRACKED_BILLBOARD_SCALE,
    minAnchorGapPx: 16,
    anchorGapPaddingPx: 10,
    verticalOnly: true,
    viewportMargin: 6,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    interactive: false,
  };
}

function publishEntity(entity) {
  const entry = createTrackedOverlayEntry(entity);
  if (!entry) {
    clearTrackedSource();
    return;
  }
  _activeEntryId = entry.id;
  _overlayHost.setEntries(
    TRACKED_OVERLAY_SOURCE_ID,
    [entry],
    TRACKED_OVERLAY_SOURCE_OPTIONS,
  );
  _overlayHost.setVisible(TRACKED_OVERLAY_SOURCE_ID, true);
}

function clearTrackedSource() {
  _activeEntryId = null;
  _overlayHost.clearSource(TRACKED_OVERLAY_SOURCE_ID);
}

function syncActiveEntity() {
  publishEntity(activeEntity());
}

/**
 * Republish a layer's newly assigned `gevLabelModel` when that entity owns the
 * active tracked readout. Layers call this only when presentation text changes;
 * position remains the live frame-cache getter already registered with host.
 * @param {Object} entity Entity whose model changed.
 */
export function refreshTrackedReadout(entity) {
  // A follow handle stands for its label subject; so does a layer's tracked
  // visual that names its follow handle (gevFollowHandle, an engine without
  // tracked entities: the Navara aircraft renderer).
  const subject =
    _labelSubjects.get(entity) ??
    _labelSubjects.get(entity?.gevFollowHandle) ??
    entity;
  if (subject && subject === activeEntity()) publishEntity(subject);
}

/** Current tracked host entry id, used to resolve its actual painted rectangle. */
export function getActiveTrackedReadoutId() {
  return _activeEntryId;
}

/** Static-context layers whose click selection publishes the readout card. */
const READOUT_CONTEXT_LAYERS = new Set(['alpr-cameras', 'local-adsb']);

/**
 * Initialize the model bridge and selection listeners. No render listener is
 * installed; the already-initialized world-overlay host owns the frame lane.
 * @param {Object} target The globe engine (or a viewer whose engine is
 *   registered): the readout follows engine.camera.following(), its label
 *   (plain data) or its Cesium entity. A bare viewer (tests) is read for
 *   its trackedEntity.
 */
export function initTrackedReadout(target) {
  if (!target || _viewer === target) return;
  if (_viewer) destroyTrackedReadout();
  _viewer = target;
  _engine = engineFromViewer(target);
  _overlayHost.setVisible(TRACKED_OVERLAY_SOURCE_ID, true);
  const changed = _engine
    ? _engine.camera.followChanged
    : target.trackedEntityChanged;
  _trackedEntityChangedRemove =
    changed?.addEventListener?.(() => {
      if (trackedSubject()) _selectedContext = null;
      syncActiveEntity();
    }) || null;
  _contextSelectedHandler = (event) => {
    const record = event.detail;
    if (READOUT_CONTEXT_LAYERS.has(record?.layerId)) {
      _selectedContext = record;
      publishEntity(record.entity);
      return;
    }
    if (_selectedContext) {
      _selectedContext = null;
      syncActiveEntity();
    }
  };
  _contextClearedHandler = (event) => {
    if (
      !_selectedContext ||
      event.detail?.layerId === _selectedContext.layerId
    ) {
      _selectedContext = null;
      syncActiveEntity();
    }
  };
  _aircraftSelectedHandler = () => {
    _selectedContext = null;
    if (!trackedSubject()) clearTrackedSource();
  };
  window.addEventListener('gev:entity-selected', _contextSelectedHandler);
  window.addEventListener(
    'gev:entity-selection-cleared',
    _contextClearedHandler,
  );
  window.addEventListener(
    'gev:awareness-subject-selected',
    _aircraftSelectedHandler,
  );
  syncActiveEntity();
  // Boot-verification contract: the track regression harness asserts this
  // exact line at init (dropped by the host migration; restored).
  console.log('[TrackedReadout] Initialized');
}

/** Tear down selection listeners and clear the host source. */
export function destroyTrackedReadout() {
  _trackedEntityChangedRemove?.();
  _trackedEntityChangedRemove = null;
  if (_contextSelectedHandler)
    window.removeEventListener('gev:entity-selected', _contextSelectedHandler);
  if (_contextClearedHandler)
    window.removeEventListener(
      'gev:entity-selection-cleared',
      _contextClearedHandler,
    );
  if (_aircraftSelectedHandler)
    window.removeEventListener(
      'gev:awareness-subject-selected',
      _aircraftSelectedHandler,
    );
  _contextSelectedHandler = null;
  _contextClearedHandler = null;
  _aircraftSelectedHandler = null;
  _selectedContext = null;
  clearTrackedSource();
  _overlayHost.setVisible(TRACKED_OVERLAY_SOURCE_ID, false);
  _viewer = null;
  _engine = null;
}

/** Inject a host recorder for focused lifecycle tests; null restores production. */
export function _setTrackedOverlayHostForTest(host = null) {
  _overlayHost = host || DEFAULT_TRACKED_OVERLAY_HOST;
}
