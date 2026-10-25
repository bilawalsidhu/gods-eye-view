import * as Cesium from 'cesium';
import { DISPATCH_AGENCIES, DISPATCH_CATEGORIES } from './records.js';
import { DISPATCH_WINDOW_MS } from './source.js';

export const DISPATCH_LAYER_ID = 'dispatch';
export const DISPATCH_OVERLAY_SOURCE_ID = 'dispatch';
export const DISPATCH_REFRESH_MS = 2 * 60 * 1000;
const PICK_PREFIX = 'dispatch:';
const POINT_HEIGHT_OFFSET_M = 4;
const RECENT_MS = 30 * 60 * 1000;
const LABEL_RANGE_M = 9000;
const LABEL_COHORT_LIMIT = 60;
const LABEL_COLLISION_CAPACITY = 30;
const NO_OVERLAY_HOST = Object.freeze({
  setEntries() {},
  clearSource() {},
  setVisible() {},
});

/** "just now", "12 min ago", "3 h 5 min ago", "2 d 4 h ago". */
export function formatCallAge(ageMs) {
  const minutes = Math.max(0, Math.floor(ageMs / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    const restHours = hours % 24;
    return `${Math.floor(hours / 24)} d${restHours ? ` ${restHours} h` : ''} ago`;
  }
  const rest = minutes % 60;
  return `${hours} h${rest ? ` ${rest} min` : ''} ago`;
}

/** "6 h", "2 d". */
export function formatWindow(windowMs) {
  const hours = Math.round(windowMs / 3_600_000);
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24} d` : `${hours} h`;
}

/** Calls per agency, in feed order, with each feed's look-back window. */
export function summarizeAgencies(calls, windows = {}) {
  const counts = new Map();
  for (const call of calls)
    counts.set(call.agency, (counts.get(call.agency) || 0) + 1);
  return Object.values(DISPATCH_AGENCIES)
    .filter((agency) => counts.has(agency.id))
    .map((agency) => ({
      id: agency.id,
      name: agency.name,
      count: counts.get(agency.id),
      windowMs: windows[agency.id] ?? DISPATCH_WINDOW_MS,
    }));
}

const callCount = (count) => `${count} call${count === 1 ? '' : 's'}`;

/** Fade older calls so the newest read first. */
export function callAlpha(ageMs, windowMs = DISPATCH_WINDOW_MS) {
  const ratio = Math.min(1, Math.max(0, ageMs / windowMs));
  return 1 - ratio * 0.6;
}

/** Count calls per category, in legend order, omitting empty categories. */
export function summarizeCategories(calls) {
  const counts = new Map();
  for (const call of calls)
    counts.set(call.category, (counts.get(call.category) || 0) + 1);
  return DISPATCH_CATEGORIES.filter((category) => counts.has(category.id)).map(
    (category) => ({
      id: category.id,
      label: category.label,
      color: category.color,
      count: counts.get(category.id),
    }),
  );
}

/**
 * Emergency services calls (Seattle Fire 911 dispatches, Everett Police calls
 * and King County Sheriff reports) drawn as points coloured by category.
 *
 * Runs its own fetch timer while enabled: first fetch on enable, then every
 * 2 minutes; the source refetches each feed on its own slower interval.
 * Calls fade across their feed's look-back window. Clicking a call selects
 * it; its details appear in the row info and on its world label.
 */
export function createDispatchLayer({
  source,
  overlayHost = NO_OVERLAY_HOST,
  services = {},
  cesium = Cesium,
  now = () => Date.now(),
  refreshMs = DISPATCH_REFRESH_MS,
  setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimer = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Dispatch requires a snapshot source');
  const requestRender = services.render?.governorRequestRender || (() => {});
  const picking = services.picking || {};
  const sprites = services.sprites || {};
  const isPointerFree = services.isPointerFree || (() => true);

  const state = {
    viewer: null,
    points: null,
    rendered: new Map(),
    calls: [],
    windows: {},
    enabled: false,
    destroyed: false,
    selectedId: null,
    loading: false,
    error: null,
    lastUpdate: null,
    abort: null,
    timer: null,
    moveEndRemove: null,
    clickHandler: null,
    listener: null,
  };

  const notify = () => {
    requestRender('dispatch');
    state.listener?.();
  };

  function callPosition(call) {
    let height = POINT_HEIGHT_OFFSET_M;
    const scene = state.viewer?.scene;
    const carto = cesium.Cartographic.fromDegrees(call.lon, call.lat);
    const sampled = scene?.sampleHeightSupported
      ? scene.sampleHeight(carto)
      : scene?.globe?.getHeight?.(carto);
    if (Number.isFinite(sampled)) height += sampled;
    return cesium.Cartesian3.fromDegrees(call.lon, call.lat, height);
  }

  function styleRendered(entry) {
    const selected = entry.call.id === state.selectedId;
    const recent = now() - entry.call.time < RECENT_MS;
    entry.point.pixelSize = selected ? 12 : recent ? 9 : 7;
    entry.point.outlineColor = selected
      ? cesium.Color.YELLOW
      : cesium.Color.BLACK.withAlpha(0.85);
    entry.point.outlineWidth = selected ? 2 : 1;
    entry.glow.show = selected || recent;
    entry.glow.pixelSize = selected ? 24 : 18;
  }

  function publishLabels() {
    if (!state.enabled || !state.viewer) {
      overlayHost.clearSource(DISPATCH_OVERLAY_SOURCE_ID);
      return;
    }
    const eye = state.viewer.camera?.positionWC;
    const at = now();
    const near = [];
    for (const entry of state.rendered.values()) {
      const selected = entry.call.id === state.selectedId;
      const distance = eye
        ? cesium.Cartesian3.distance(eye, entry.position)
        : Number.POSITIVE_INFINITY;
      if (selected || distance <= LABEL_RANGE_M)
        near.push({ entry, distance, selected });
    }
    near.sort((a, b) => b.selected - a.selected || a.distance - b.distance);
    overlayHost.setEntries(
      DISPATCH_OVERLAY_SOURCE_ID,
      near
        .slice(0, LABEL_COHORT_LIMIT)
        .map(({ entry, distance, selected }) => ({
          id: entry.call.id,
          position: entry.position,
          variant: 'label',
          title: entry.call.type,
          details: selected
            ? [
                DISPATCH_AGENCIES[entry.call.agency]?.name,
                entry.call.address,
                formatCallAge(at - entry.call.time),
              ].filter(Boolean)
            : [],
          accent: entry.call.color,
          priority: selected
            ? LABEL_RANGE_M * 2
            : Math.round(LABEL_RANGE_M - Math.min(distance, LABEL_RANGE_M)),
          selected,
          collisionGroup: 'ambient-label',
          paintLane: selected ? undefined : 'ambient-label',
          maxDistance: selected ? undefined : LABEL_RANGE_M,
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          gapPx: 12,
          verticalOnly: true,
        })),
      {
        cohortLimit: LABEL_COHORT_LIMIT,
        collisionCapacity: LABEL_COLLISION_CAPACITY,
        moving: false,
      },
    );
  }

  function render() {
    if (!state.points) return;
    const visible = state.enabled ? state.calls : [];
    const keep = new Set(visible.map((call) => call.id));
    for (const [id, entry] of state.rendered) {
      if (keep.has(id)) continue;
      state.points.remove(entry.point);
      state.points.remove(entry.glow);
      state.rendered.delete(id);
    }
    const at = now();
    for (const call of visible) {
      const existing = state.rendered.get(call.id);
      const alpha = callAlpha(at - call.time, windowFor(call));
      const color = cesium.Color.fromCssColorString(call.color);
      if (existing) {
        existing.call = call;
        existing.point.color = color.withAlpha(alpha);
        styleRendered(existing);
        continue;
      }
      const position = callPosition(call);
      const pickId = `${PICK_PREFIX}${call.id}`;
      const scaleByDistance = new cesium.NearFarScalar(500, 1.3, 120_000, 0.5);
      const glow = state.points.add({
        position,
        pixelSize: 18,
        color: color.withAlpha(0.25),
        outlineColor: color.withAlpha(0.12),
        outlineWidth: 3,
        scaleByDistance,
        disableDepthTestDistance: 5000,
        id: pickId,
      });
      const point = state.points.add({
        position,
        pixelSize: 8,
        color: color.withAlpha(alpha),
        outlineColor: cesium.Color.BLACK.withAlpha(0.85),
        outlineWidth: 1,
        scaleByDistance,
        disableDepthTestDistance: 5000,
        id: pickId,
      });
      const entry = { call, point, glow, position };
      state.rendered.set(call.id, entry);
      styleRendered(entry);
    }
    if (state.selectedId && !state.rendered.has(state.selectedId))
      state.selectedId = null;
    publishLabels();
    requestRender('dispatch-points');
  }

  function windowFor(call) {
    return state.windows[call.agency] ?? DISPATCH_WINDOW_MS;
  }

  function select(id) {
    const previous = state.rendered.get(state.selectedId);
    state.selectedId = id && state.rendered.has(id) ? id : null;
    if (previous) styleRendered(previous);
    const next = state.rendered.get(state.selectedId);
    if (next) styleRendered(next);
    publishLabels();
    notify();
  }

  function installClickHandler() {
    if (
      state.clickHandler ||
      !state.viewer?.scene?.canvas ||
      typeof cesium.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const handler = new cesium.ScreenSpaceEventHandler(
      state.viewer.scene.canvas,
    );
    state.clickHandler = handler;
    handler.setInputAction((click) => {
      if (!state.enabled || !click?.position || !isPointerFree()) return;
      const picked = state.viewer.scene.pick(click.position);
      const id = typeof picked?.id === 'string' ? picked.id : '';
      if (id.startsWith(PICK_PREFIX)) select(id.slice(PICK_PREFIX.length));
      else if (state.selectedId) select(null);
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    const handler = state.clickHandler;
    state.clickHandler = null;
    if (handler && !handler.isDestroyed?.()) handler.destroy();
  }

  function onMoveEnd() {
    if (state.enabled) publishLabels();
  }

  function scheduleRefresh(delayMs = refreshMs) {
    clearTimer(state.timer);
    state.timer = null;
    if (!state.enabled || !(delayMs >= 0) || !(refreshMs > 0)) return;
    state.timer = setTimer(() => {
      state.timer = null;
      void load();
    }, delayMs);
  }

  async function load() {
    if (!state.enabled || !state.viewer) return false;
    clearTimer(state.timer);
    state.timer = null;
    state.abort?.abort();
    const controller = new AbortController();
    state.abort = controller;
    const current = () =>
      state.enabled && state.abort === controller && !controller.signal.aborted;
    state.loading = true;
    notify();
    try {
      const snapshot = await source.getSnapshot({ signal: controller.signal });
      if (!current()) return false;
      const calls = Array.isArray(snapshot) ? snapshot : snapshot?.calls;
      if (!Array.isArray(calls)) throw new Error('Malformed emergency feed');
      const failures = Array.isArray(snapshot?.failures)
        ? snapshot.failures
        : [];
      state.calls = calls;
      state.windows = { ...(snapshot?.windows || {}) };
      // Other feeds still show; name the ones that failed.
      state.error = failures.length
        ? `${failures.map((failure) => failure.name).join(', ')} unavailable`
        : null;
      state.lastUpdate = now();
      render();
      return true;
    } catch (error) {
      if (!current()) return false;
      // Keep the last good calls on screen; the row reports the failure.
      state.error = error?.message || 'Emergency feeds unavailable';
      return false;
    } finally {
      if (state.abort === controller) {
        state.abort = null;
        state.loading = false;
        notify();
        scheduleRefresh();
      }
    }
  }

  function selectedCall() {
    return state.rendered.get(state.selectedId)?.call || null;
  }

  const layer = {
    id: DISPATCH_LAYER_ID,
    name: 'Emergency Services',
    icon: '🚨',
    source: 'Seattle Fire · Everett PD · KC Sheriff',
    updateInterval: 0,
    init(viewer) {
      if (state.viewer)
        throw new Error('Dispatch layer is already initialized');
      state.viewer = viewer;
      state.points = new cesium.PointPrimitiveCollection();
      state.points.show = false;
      viewer.scene.primitives.add(state.points);
      overlayHost.setVisible(DISPATCH_OVERLAY_SOURCE_ID, false);
      sprites.registerSpriteCollection?.(DISPATCH_LAYER_ID, state.points);
      state.moveEndRemove = viewer.camera.moveEnd.addEventListener(onMoveEnd);
    },
    enable() {
      if (state.enabled || state.destroyed) return;
      state.enabled = true;
      state.points.show = true;
      overlayHost.setVisible(DISPATCH_OVERLAY_SOURCE_ID, true);
      picking.registerPickOwner?.(
        DISPATCH_LAYER_ID,
        (id) =>
          typeof id === 'string' &&
          id.startsWith(PICK_PREFIX) &&
          state.rendered.has(id.slice(PICK_PREFIX.length)),
      );
      installClickHandler();
      sprites.restoreSpriteOrder?.(state.viewer);
      // Self-driving, so a restore that enables without an update still loads.
      scheduleRefresh(0);
    },
    disable() {
      state.enabled = false;
      clearTimer(state.timer);
      state.timer = null;
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      picking.unregisterPickOwner?.(DISPATCH_LAYER_ID);
      removeClickHandler();
      state.selectedId = null;
      state.calls = [];
      render();
      if (state.points) state.points.show = false;
      overlayHost.clearSource(DISPATCH_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(DISPATCH_OVERLAY_SOURCE_ID, false);
      notify();
    },
    update() {
      return load();
    },
    destroy(viewer = state.viewer) {
      if (state.destroyed) return;
      layer.disable();
      state.destroyed = true;
      state.moveEndRemove?.();
      state.moveEndRemove = null;
      sprites.unregisterSpriteCollection?.(DISPATCH_LAYER_ID, state.points);
      if (viewer?.scene?.primitives && state.points)
        viewer.scene.primitives.remove(state.points);
      state.points = null;
      state.rendered.clear();
      state.viewer = null;
      state.listener = null;
      state.lastUpdate = null;
      state.error = null;
    },
    setRowControlsListener(value) {
      state.listener = typeof value === 'function' ? value : null;
    },
    getRowControls() {
      const call = selectedCall();
      if (!state.calls.length && !call) return null;
      const agency = call ? DISPATCH_AGENCIES[call.agency] : null;
      const info = call
        ? [
            `${agency?.name || 'Emergency'} · ${call.type}`,
            [call.address, formatCallAge(now() - call.time)]
              .filter(Boolean)
              .join(' · '),
            [
              `${agency?.idLabel || 'Incident'} ${call.incident}`,
              call.approximate
                ? `approximate location (reporting area ${call.area})`
                : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ].join('\n')
        : summarizeAgencies(state.calls, state.windows)
            .map(
              (entry) =>
                `${entry.name} · ${callCount(entry.count)} in the last ${formatWindow(entry.windowMs)}`,
            )
            .join('\n');
      return {
        chips: call
          ? [
              {
                id: 'clear-dispatch-selection',
                label: 'CLEAR',
                title: 'Clear the selected call',
                onClick: () => select(null),
              },
            ]
          : [],
        legend: summarizeCategories(state.calls).map((category) => ({
          label: category.label,
          color: category.color,
          count: category.count,
        })),
        info,
        infoTitle:
          'Seattle Fire 911 dispatches (City of Seattle, last 6 h, ~5 min delay), Everett Police calls (City of Everett, last 2 d, posted daily) and King County Sheriff offense reports (King County, last 3 d, about a day late, placed at reporting-area centres). Calls fade with age; click one to select it.',
      };
    },
    getStats() {
      const count = state.rendered.size;
      return {
        count,
        countLabel: state.enabled && count ? callCount(count) : '',
        lastUpdate: state.lastUpdate,
        loading: state.loading,
        loadingLabel: state.loading ? 'Loading emergency calls' : '',
        error: state.error,
        source: 'Seattle Fire · Everett PD · KC Sheriff',
      };
    },
    getDiagnostics() {
      return {
        enabled: state.enabled,
        calls: state.calls.length,
        rendered: state.rendered.size,
        selectedId: state.selectedId,
        requestPending: Boolean(state.abort),
        refreshScheduled: Boolean(state.timer),
      };
    },
  };
  return layer;
}

export { createEmergencyServicesSource } from './source.js';
