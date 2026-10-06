import {
  SENTINEL2_MAX_CLOUD,
  SENTINEL2_WINDOW_DAYS,
  quantizeScenePoint,
} from '../data/sentinel2Tiles.js';
import { createMapCredits } from './credits.js';

/** Map stack id this module reports on. */
export const SENTINEL2_STACK_ID = 'sentinel2-latest';

/**
 * Above this camera height the Sentinel-2 layer is not drawn (it starts at
 * z8, see SENTINEL2_TERRAIN_LEVELS), so a scene lookup would spend free
 * quota on imagery nobody can see.
 */
export const SCENE_LOOKUP_MAX_HEIGHT_M = 400_000;

/** Quiet time after the camera stops before the date is looked up. */
export const SCENE_LOOKUP_DEBOUNCE_MS = 800;

const STATUS_TIMEOUT_MS = 3000;

/**
 * Ask the local server whether Sentinel Hub credentials are configured. Only
 * a boolean comes back; the credentials never leave the server. Any failure
 * (a static build with no server, a timeout) reads as "not configured", so the
 * map stack stays locked and the app behaves as it does without a key.
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<boolean>}
 */
export async function fetchSentinelHubConfigured({ fetchImpl, signal } = {}) {
  const doFetch = fetchImpl || globalThis.fetch?.bind(globalThis);
  if (!doFetch) return false;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), STATUS_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await doFetch('/api/sentinel2/status', {
      cache: 'no-store',
      signal: timeout.signal,
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.hasKey === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/**
 * On-screen readout for the Sentinel-2 Latest stack — pure, exported for
 * tests. It always says the imagery is an archive mosaic, never live.
 * @param {{kind: 'scene', scene: {date: ?string, cloudCover: ?number}} | {kind: 'zoom'} | {kind: 'budget'} | {kind: 'unknown'}} reading
 * @returns {string} Credit markup.
 */
export function formatSentinel2Readout(reading) {
  const window = `least-cloudy of the last ${SENTINEL2_WINDOW_DAYS} days · not live`;
  if (reading?.kind === 'scene') {
    const date = reading.scene?.date;
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const cloud = Number(reading.scene.cloudCover);
      const cloudText = Number.isFinite(cloud)
        ? ` (${escapeHtml(cloud)} % cloud)`
        : '';
      return `Sentinel-2 · acquired ${escapeHtml(date)}${cloudText} at screen centre · ${window}`;
    }
    return `Sentinel-2 · no scene ≤${SENTINEL2_MAX_CLOUD} % cloud in the last ${SENTINEL2_WINDOW_DAYS} days here · not live`;
  }
  if (reading?.kind === 'zoom')
    return `Sentinel-2 · zoom in to see 10 m imagery · ${window}`;
  if (reading?.kind === 'budget')
    return `Sentinel-2 · acquisition date unavailable (daily free quota reached) · ${window}`;
  return `Sentinel-2 · ${window}`;
}

/**
 * The lon/lat under the middle of the screen, or under the camera when the
 * centre ray misses the globe (a horizon view).
 * @returns {{lon: number, lat: number, height: number} | null}
 */
function cameraFocus(viewer, Cesium) {
  const camera = viewer?.camera;
  const carto = camera?.positionCartographic;
  if (!carto) return null;
  const height = carto.height;
  const canvas = viewer.scene?.canvas;
  let focus = null;
  if (canvas && Cesium?.Cartesian2 && camera.pickEllipsoid) {
    const centre = new Cesium.Cartesian2(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    const hit = camera.pickEllipsoid(centre, viewer.scene.globe?.ellipsoid);
    if (hit) focus = Cesium.Cartographic.fromCartesian(hit);
  }
  focus ||= carto;
  const toDeg = 180 / Math.PI;
  return { lon: focus.longitude * toDeg, lat: focus.latitude * toDeg, height };
}

/**
 * While Sentinel-2 Latest is the active map, keep an on-screen credit saying
 * when the imagery at screen centre was acquired. Looks the date up once per
 * 0.1° cell after the camera settles (the server caches it too), and never
 * while the stack is inactive or the view too high to show Sentinel-2.
 *
 * @param {{viewer: object, controller: {subscribe: Function, getActiveId: Function}, Cesium?: object, fetchImpl?: typeof fetch, credits?: {show: Function, destroy: Function}, debounceMs?: number}} options
 * @returns {() => void} Dispose.
 */
export function attachSentinel2SceneReadout({
  viewer,
  controller,
  Cesium = null,
  fetchImpl,
  credits = createMapCredits(viewer),
  debounceMs = SCENE_LOOKUP_DEBOUNCE_MS,
}) {
  // A composed controller without settled-state events cannot drive this.
  if (typeof controller?.subscribe !== 'function') return () => {};
  const doFetch = fetchImpl || globalThis.fetch?.bind(globalThis);
  let active = false;
  let timer = null;
  let lookup = null;
  let lastKey = null;
  let removeMoveEnd = null;
  let disposed = false;

  const show = (reading) => {
    if (!disposed && active) credits.show(formatSentinel2Readout(reading));
  };

  const run = async () => {
    timer = null;
    const focus = cameraFocus(viewer, Cesium);
    if (!focus) return show({ kind: 'unknown' });
    if (focus.height > SCENE_LOOKUP_MAX_HEIGHT_M) {
      lastKey = null;
      return show({ kind: 'zoom' });
    }
    const point = quantizeScenePoint(focus.lon, focus.lat);
    if (!point) return show({ kind: 'unknown' });
    if (point.key === lastKey) return undefined;
    lastKey = point.key;
    lookup?.abort();
    const controllerRef = new AbortController();
    lookup = controllerRef;
    try {
      const response = await doFetch(
        `/api/sentinel2/scene?lon=${point.lon}&lat=${point.lat}`,
        { signal: controllerRef.signal },
      );
      if (controllerRef.signal.aborted) return undefined;
      if (response.status === 429) {
        lastKey = null;
        return show({ kind: 'budget' });
      }
      if (!response.ok) {
        lastKey = null;
        return show({ kind: 'unknown' });
      }
      return show({ kind: 'scene', scene: await response.json() });
    } catch {
      if (controllerRef.signal.aborted) return undefined;
      lastKey = null;
      return show({ kind: 'unknown' });
    }
  };

  const schedule = () => {
    if (!active || disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void run(), debounceMs);
  };

  const sync = (activeId) => {
    const next = activeId === SENTINEL2_STACK_ID;
    if (next === active) return;
    active = next;
    if (active) {
      show({ kind: 'unknown' });
      removeMoveEnd = viewer?.camera?.moveEnd?.addEventListener?.(schedule);
      lastKey = null;
      schedule();
    } else {
      clearTimeout(timer);
      timer = null;
      lookup?.abort();
      lookup = null;
      removeMoveEnd?.();
      removeMoveEnd = null;
      credits.show(null);
    }
  };

  const unsubscribe = controller.subscribe((state) => sync(state?.activeId));
  sync(controller.getActiveId?.());

  return () => {
    if (disposed) return;
    sync(null);
    disposed = true;
    unsubscribe();
    credits.destroy();
  };
}
