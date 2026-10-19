import * as Cesium from 'cesium';
import { createWindRendering } from '../wind/rendering.js';
import { OCEAN_FIELD_SPEC, fieldRampMax } from '../wind/fieldSpec.js';
import { formatWindValidTime } from '../wind/index.js';
import { t, msg, translateKnown } from '../../i18n/index.js';
import { unitLabel } from '../../ui/unitLabels.js';

const BOX_STEP_DEG = 0.25;
const DOT = '·';

/** Camera view rectangle in degrees, or null when the camera sees no Earth. */
export function viewBox(viewer, cesium) {
  const camera = viewer?.scene?.camera ?? viewer?.camera;
  if (!camera?.computeViewRectangle) return null;
  let rect;
  try {
    rect = camera.computeViewRectangle(cesium?.Ellipsoid?.WGS84);
  } catch {
    return null;
  }
  if (!rect) return null;
  // Degrees rounded to 1e-4 (about 10 m): stable query strings, no
  // radian round-off such as -75.00000000000001.
  const deg = (r) => Math.round(((r * 180) / Math.PI) * 1e4) / 1e4;
  const box = {
    latMin: Math.max(-90, deg(rect.south)),
    latMax: Math.min(90, deg(rect.north)),
    lonMin: deg(rect.west),
    lonMax: deg(rect.east),
  };
  if (
    ![box.latMin, box.latMax, box.lonMin, box.lonMax].every(Number.isFinite) ||
    !(box.latMax > box.latMin)
  )
    return null;
  return box;
}

// Tier thresholds, mirrored from the server because the client cannot import
// it across the package boundary: GLOBAL_SPAN_KM in
// server/providers/oceanCurrents.js and HFR_MAX_SPAN_KM in
// server/ocean/fieldGrid.js. index.test.mjs pins both numbers and the span
// formula to values printed by the server functions.
const GLOBAL_SPAN_KM = 5000;
const HFR_MAX_SPAN_KM = 800;
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const DEG = Math.PI / 180;

/**
 * Larger ground span of a view box in km, the server's boxSpanKm: meridian
 * arc at the box's middle latitude for the latitude span, the parallel at
 * that latitude for the eastward longitude span. null for a box the server
 * would refuse (non-finite bound, latMax not above latMin).
 *
 * @param {{latMin: number, latMax: number, lonMin: number, lonMax: number}|null} box
 * @returns {number|null}
 */
export function viewSpanKm(box) {
  if (!box) return null;
  const { latMin, latMax, lonMin, lonMax } = box;
  for (const v of [latMin, latMax, lonMin, lonMax])
    if (!Number.isFinite(v)) return null;
  if (!(latMax > latMin)) return null;
  const rawSpan = (((lonMax - lonMin) % 360) + 360) % 360;
  const lonSpanDeg = rawSpan === 0 ? (lonMax === lonMin ? 0 : 360) : rawSpan;
  if (!(lonSpanDeg > 0)) return null;
  const midLat = (latMin + latMax) / 2;
  const sin = Math.sin(midLat * DEG);
  const w = 1 - WGS84_E2 * sin * sin;
  const metresPerDegLat =
    ((WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w))) * DEG;
  const metresPerDegLon =
    (WGS84_A / Math.sqrt(w)) * Math.cos(midLat * DEG) * DEG;
  const latKm = ((latMax - latMin) * metresPerDegLat) / 1000;
  const lonKm = (lonSpanDeg * metresPerDegLon) / 1000;
  return Math.max(latKm, lonKm);
}

/**
 * The tier the server will answer a box with: 'global' above 5000 km,
 * 'coastal' (the HF radar composite) at 800 km or under, 'regional' between.
 *
 * @param {object|null} box - View box in degrees.
 * @returns {'global'|'regional'|'coastal'|null}
 */
export function viewTier(box) {
  const span = viewSpanKm(box);
  if (span === null) return null;
  if (span > GLOBAL_SPAN_KM) return 'global';
  return span <= HFR_MAX_SPAN_KM ? 'coastal' : 'regional';
}

/** A box counts as moved when any edge shifted by BOX_STEP_DEG or more. */
export function boxChanged(previous, next) {
  if (!previous || !next) return true;
  return ['latMin', 'latMax', 'lonMin', 'lonMax'].some(
    (key) => Math.abs(previous[key] - next[key]) >= BOX_STEP_DEG,
  );
}

function legendFor(snapshot) {
  const max = fieldRampMax(OCEAN_FIELD_SPEC, snapshot ?? {});
  const last = OCEAN_FIELD_SPEC.ramp.length - 1;
  return OCEAN_FIELD_SPEC.ramp.map((color, index) => {
    const t = index / last;
    const speed = max * Math.pow(t, 1 / OCEAN_FIELD_SPEC.rampGamma);
    return { color, label: `${speed.toFixed(2)}${index === last ? '+' : ''}` };
  });
}

const KIND_LABEL = {
  observed: msg('Observed'),
  modeled: msg('Modelled'),
  derived: msg('Derived'),
  mixed: msg('Observed + modelled'),
};

/*
 * English that arrives in the manifest (server/ocean/fieldGrid.js tier labels,
 * server/providers/oceanCurrents.js reasons). It stays English in data and is
 * translated where it is shown; other server prose shows as sent.
 */
const SERVER_TEXT = new Set([
  msg('Global surface currents'),
  msg('HF radar surface currents'),
  msg('HF radar over global surface currents'),
  msg('Ocean current upstream unavailable'),
  msg('Ocean current field unavailable'),
]);
const serverText = (text) =>
  typeof text === 'string' && text
    ? SERVER_TEXT.has(text)
      ? t(text)
      : translateKnown(text)
    : null;

/** A source problem in the UI language; the HTTP status rides a placeholder. */
function presentProblem(problem) {
  const http = /^Ocean current HTTP (\d+)$/.exec(problem);
  if (http)
    return t('{source} HTTP {status}', {
      source: t('Ocean currents'),
      status: http[1],
    });
  return t(problem);
}

/** Construct the ocean-currents layer: the wind renderer driven by the current field. */
export function createOceanCurrentsLayer({
  feed,
  clock,
  cesium = Cesium,
  container,
  createRendering = createWindRendering,
  debounceMs = 450,
  retryMs = 60_000,
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Ocean currents require a snapshot source');
  let viewer = null;
  let rendering = null;
  let imageryHost = null;
  let request = null;
  let enabled = false;
  let manifest = null;
  let error = null;
  let loading = false;
  let paused = false;
  let overlay = 'none';
  let lastBox = null;
  // Tier of the box last sent to the server; a moveEnd landing in another
  // tier updates at once instead of after the debounce.
  let lastTier = null;
  // Wall-clock phases of the last update, for the QA script and diagnostics:
  // startedAt is the update entry, fetchMs the snapshot (manifest + .bin,
  // cache hits included), renderedAt the setField entry; the renderer's
  // buildMs/readyMs are measured from renderedAt.
  let timing = null;
  let removeMoveEnd = null;
  let timer = null;
  let retry = null;
  let rowControlsListener = null;
  const notify = () => rowControlsListener?.();
  const unsubscribeClock = clock?.subscribe(notify);
  const clearTimers = () => {
    if (timer) clearTimeout(timer);
    if (retry) clearTimeout(retry);
    timer = null;
    retry = null;
  };

  function onMoveEnd() {
    if (!enabled) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const next = viewBox(viewer, cesium);
    if (!boxChanged(lastBox, next)) return;
    // Crossing a tier line (a zoom from the globe into a region, or from a
    // region to the coast) is the case that waits longest for new data, so
    // it skips the debounce; pans inside a tier still settle first.
    if (next && viewTier(next) !== lastTier) {
      void layer.update(viewer);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      const settled = viewBox(viewer, cesium);
      if (boxChanged(lastBox, settled)) void layer.update(viewer);
    }, debounceMs);
  }
  // A cold server build or an upstream outage answers unavailable; the data
  // manager's 15-minute poll is too slow to recover from that, so try again
  // sooner on our own.
  function scheduleRetry() {
    if (retry) clearTimeout(retry);
    retry = setTimeout(() => {
      retry = null;
      if (enabled && !request) void layer.update(viewer);
    }, retryMs);
  }

  // Phases of the last update in ms. buildMs and readyMs come from the GPU
  // renderer when the field was handed to it; totalMs spans update entry to
  // the first frame whose geometry is ready, so the moveEnd debounce sits
  // outside it. null until measured.
  function updateTiming(gpu) {
    if (!timing) return null;
    const rendered = timing.renderedAt !== null;
    const buildMs =
      rendered && Number.isFinite(gpu?.buildMs) ? gpu.buildMs : null;
    const readyMs =
      rendered && Number.isFinite(gpu?.readyMs) ? gpu.readyMs : null;
    const totalMs =
      readyMs === null ? null : timing.renderedAt - timing.startedAt + readyMs;
    return { fetchMs: timing.fetchMs, buildMs, readyMs, totalMs };
  }

  let sequence = 0;
  let latestOutcome = Promise.resolve(false);

  const now = () => globalThis.performance?.now?.() ?? Date.now();

  async function runUpdate(nextViewer, signal) {
    if (!enabled) return false;
    if (nextViewer) viewer = nextViewer;
    const startedAt = now();
    rendering?.rehome?.();
    request?.abort();
    const controller = new AbortController();
    if (signal?.aborted) controller.abort(signal.reason);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    request = controller;
    loading = true;
    notify();
    const box = viewBox(viewer, cesium);
    if (box) lastTier = viewTier(box);
    try {
      signal?.throwIfAborted();
      const snapshot = await feed.getSnapshot({
        signal: controller.signal,
        box,
      });
      if (!enabled || controller.signal.aborted || request !== controller)
        return false;
      timing = { startedAt, fetchMs: now() - startedAt, renderedAt: null };
      manifest = snapshot;
      error = null;
      lastBox = box;
      if (snapshot.unavailable) {
        rendering.stop();
        rendering.clear();
        scheduleRetry();
      } else {
        rendering.setOptions?.({ overlay, paused });
        timing.renderedAt = now();
        rendering.setField(snapshot);
        rendering.start();
      }
      return true;
    } catch (cause) {
      if (controller.signal.aborted || request !== controller) return false;
      error = cause?.message || msg('Ocean current source unavailable');
      scheduleRetry();
      return true;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (request === controller) {
        request = null;
        loading = false;
        notify();
      }
    }
  }

  const layer = {
    id: 'ocean-currents',
    name: 'Ocean Currents',
    icon: '\u{1F300}',
    source: 'HYCOM / NOAA CoastWatch / IOOS HF radar',
    updateInterval: 900_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({
        cesium,
        container: container ?? nextViewer.container,
        getViewer: () => viewer,
        getHost: () =>
          imageryHost?.() ?? {
            collection: viewer.imageryLayers ?? viewer.scene?.imageryLayers,
            kind: 'globe',
          },
        onStatusChange: notify,
        spec: OCEAN_FIELD_SPEC,
      });
      rendering.attach();
      rendering.setOptions?.({ overlay, paused });
    },
    attachShellServices(services) {
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      rendering?.rehome?.();
    },
    enable() {
      enabled = true;
      rendering?.start();
      const moveEnd = viewer?.scene?.camera?.moveEnd ?? viewer?.camera?.moveEnd;
      if (!removeMoveEnd && moveEnd?.addEventListener) {
        const remove = moveEnd.addEventListener(onMoveEnd);
        removeMoveEnd =
          typeof remove === 'function'
            ? remove
            : () => moveEnd.removeEventListener(onMoveEnd);
      }
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      manifest = null;
      error = null;
      lastBox = null;
      lastTier = null;
      timing = null;
      clearTimers();
      removeMoveEnd?.();
      removeMoveEnd = null;
      rendering?.stop();
      rendering?.clear();
    },
    update(nextViewer, { signal } = {}) {
      const outcome = (async () => {
        const mine = ++sequence;
        const result = await runUpdate(nextViewer, signal);
        // A camera move superseded this request: answer with what replaced
        // it, so the manager never mistakes its own refresh for a rejection
        // (a rejected enable-time update rolls the layer back to disabled).
        if (
          result === false &&
          !signal?.aborted &&
          enabled &&
          sequence !== mine
        )
          return latestOutcome;
        return result;
      })();
      latestOutcome = outcome;
      return outcome;
    },
    setParams(params = {}) {
      if (typeof params.paused === 'boolean') paused = params.paused;
      if (['none', 'speed'].includes(params.overlay)) overlay = params.overlay;
      rendering?.setOptions?.({ overlay, paused });
      notify();
    },
    getParams() {
      return { paused, overlay };
    },
    getRowControls() {
      const provenance = manifest?.provenance;
      const diagnostic = rendering?.getDiagnostics?.();
      const valid = formatWindValidTime(manifest?.cycle?.validIso);
      const preparing =
        enabled &&
        diagnostic?.renderMode === 'gpu-streamlines' &&
        diagnostic.gpu?.pathCount > 0 &&
        !diagnostic.gpu?.ready;
      const label =
        serverText(provenance?.tierLabel) ||
        (manifest?.tier === 'global'
          ? t('Global surface currents')
          : t('Surface currents'));
      const kind = KIND_LABEL[provenance?.kind]
        ? t(KIND_LABEL[provenance.kind])
        : null;
      const age = provenance?.ageLabel || t('age unknown');
      const status = loading
        ? t('Loading currents')
        : preparing
          ? t('Preparing flow')
          : (error && presentProblem(error)) ||
            serverText(manifest?.reason) ||
            (manifest?.stale ? t('Cached field · stale') : null);
      const rmse = Number.isFinite(provenance?.rmseMs)
        ? t('Holdout RMSE {value} m/s', { value: provenance.rmseMs })
        : null;
      const lines = [
        ...(kind ? [`${kind} · ${age}`] : []),
        ...(rmse ? [rmse] : []),
        ...(provenance?.caveats || []),
      ];
      const time = valid || t('Unavailable');
      const controls = {
        readout: true,
        summary: {
          label: t('Ocean currents'),
          coverage: label,
          validTime: manifest?.cycle?.validIso,
          detail: t('{label} · valid {time}', { label, time }),
          compact: t('{scope} · valid {time}', {
            scope: manifest?.tier === 'global' ? t('Global') : t('Regional'),
            time,
          }),
          status,
          units: 'm/s',
          lines: lines.map((text, i) => ({ id: `prov-${i}`, text })),
        },
        chips: [
          {
            id: 'motion',
            label: diagnostic?.reducedMotion
              ? t('Reduced motion')
              : paused
                ? t('Resume')
                : t('Pause'),
            active: paused || Boolean(diagnostic?.reducedMotion),
            disabled: Boolean(diagnostic?.reducedMotion),
            params: { paused: !paused },
            title: t('Pause visual flow; the field does not advance in time'),
          },
          ...['none', 'speed'].map((value) => ({
            id: `overlay-${value}`,
            label: value === 'none' ? t('None') : t('Speed'),
            active: overlay === value,
            params: { overlay: value },
            title:
              value === 'none'
                ? t('Current streamlines with no field shading')
                : t('Surface current speed shading'),
          })),
        ],
        legend: manifest?.u ? legendFor(manifest) : [],
        info: `${label} (${unitLabel('m/s')})\n${t('Valid: {time}', { time })}${loading ? ` · ${t('loading')}` : preparing ? ` · ${t('preparing')}` : ''}${manifest?.stale ? ` · ${t('STALE')}` : ''}${kind ? `\n${kind} · ${age}` : ''}${rmse ? `\n${rmse}` : ''}${error ? `\n${presentProblem(error)}` : ''}`,
        infoTitle: t(
          'Surface ocean currents. Globe: HYCOM ESPC-D forecast on a 1 degree lattice (CoastWatch altimetry when HYCOM is down). Regional: HYCOM at its own resolution. Coastal: IOOS HF-radar analysis over the global field. Streamline colour follows speed; animation shows flow through one fixed field and does not advance time.',
        ),
      };
      controls.summary.settings = [
        {
          id: 'field',
          label: t('FIELD'),
          chips: controls.chips.filter((chip) =>
            chip.id.startsWith('overlay-'),
          ),
        },
        {
          id: 'motion',
          label: t('MOTION'),
          chips: controls.chips.filter((chip) => chip.id === 'motion'),
        },
      ];
      controls.summary.actions = [];
      return controls;
    },
    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    destroy() {
      layer.disable();
      unsubscribeClock?.();
      rendering?.destroy();
      rendering = null;
      imageryHost = null;
      viewer = null;
      rowControlsListener = null;
    },
    getStats() {
      const diagnostic = rendering?.getDiagnostics?.();
      const preparing =
        enabled &&
        diagnostic?.renderMode === 'gpu-streamlines' &&
        diagnostic.gpu?.pathCount > 0 &&
        !diagnostic.gpu?.ready;
      const valid = Date.parse(manifest?.cycle?.validIso);
      return {
        count: manifest?.speed?.validCells ?? 0,
        countLabel: t('Field'),
        lastUpdate: Number.isFinite(valid) ? valid : null,
        loading: loading || Boolean(preparing),
        paused,
        overlay,
        tier: manifest?.tier ?? null,
        stale: Boolean(manifest?.stale),
        source: manifest?.provenance?.tierLabel || msg('Surface currents'),
        validTime:
          formatWindValidTime(manifest?.cycle?.validIso) || t('Unavailable'),
        error:
          error ||
          manifest?.reason ||
          (manifest?.unavailable ? msg('Ocean currents unavailable') : null),
      };
    },
    getDiagnostics() {
      const diagnostic = rendering?.getDiagnostics?.() || {};
      return { ...diagnostic, timing: updateTiming(diagnostic.gpu) };
    },
    getParticleCount() {
      return rendering?.getParticleCount() || 0;
    },
  };
  return layer;
}
