import * as Cesium from 'cesium';
import { createWindRendering } from '../wind/rendering.js';
import { OCEAN_FIELD_SPEC, fieldRampMax } from '../wind/fieldSpec.js';
import { formatWindValidTime } from '../wind/index.js';

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
  observed: 'Observed',
  modeled: 'Modelled',
  derived: 'Derived',
  mixed: 'Observed + modelled',
};

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
    timer = setTimeout(() => {
      timer = null;
      const next = viewBox(viewer, cesium);
      if (boxChanged(lastBox, next)) void layer.update(viewer);
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

  let sequence = 0;
  let latestOutcome = Promise.resolve(false);

  async function runUpdate(nextViewer, signal) {
    if (!enabled) return false;
    if (nextViewer) viewer = nextViewer;
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
    try {
      signal?.throwIfAborted();
      const snapshot = await feed.getSnapshot({
        signal: controller.signal,
        box,
      });
      if (!enabled || controller.signal.aborted || request !== controller)
        return false;
      manifest = snapshot;
      error = null;
      lastBox = box;
      if (snapshot.unavailable) {
        rendering.stop();
        rendering.clear();
        scheduleRetry();
      } else {
        rendering.setOptions?.({ overlay, paused });
        rendering.setField(snapshot);
        rendering.start();
      }
      return true;
    } catch (cause) {
      if (controller.signal.aborted || request !== controller) return false;
      error = cause?.message || 'Ocean current source unavailable';
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
      const tierLabel =
        provenance?.tierLabel ||
        (manifest?.tier === 'global' ? 'Global surface currents' : null);
      const kind = KIND_LABEL[provenance?.kind] || null;
      const status = loading
        ? 'Loading currents'
        : preparing
          ? 'Preparing flow'
          : error ||
            manifest?.reason ||
            (manifest?.stale ? `Cached field ${DOT} stale` : null);
      const lines = [
        ...(kind
          ? [`${kind} ${DOT} ${provenance.ageLabel || 'age unknown'}`]
          : []),
        ...(Number.isFinite(provenance?.rmseMs)
          ? [`Holdout RMSE ${provenance.rmseMs} m/s`]
          : []),
        ...(provenance?.caveats || []),
      ];
      const label = tierLabel || 'Surface currents';
      const controls = {
        readout: true,
        summary: {
          label: 'Ocean currents',
          coverage: label,
          validTime: manifest?.cycle?.validIso,
          detail: `${label} ${DOT} ${valid || 'Unavailable'}`,
          compact: `${manifest?.tier === 'global' ? 'Global' : 'Regional'} ${DOT} valid ${valid || 'Unavailable'}`,
          status,
          units: 'm/s',
          lines: lines.map((text, i) => ({ id: `prov-${i}`, text })),
        },
        chips: [
          {
            id: 'motion',
            label: diagnostic?.reducedMotion
              ? 'Reduced motion'
              : paused
                ? 'Resume'
                : 'Pause',
            active: paused || Boolean(diagnostic?.reducedMotion),
            disabled: Boolean(diagnostic?.reducedMotion),
            params: { paused: !paused },
            title: 'Pause visual flow; the field does not advance in time',
          },
          ...['none', 'speed'].map((value) => ({
            id: `overlay-${value}`,
            label: value === 'none' ? 'None' : 'Speed',
            active: overlay === value,
            params: { overlay: value },
            title:
              value === 'none'
                ? 'Current streamlines with no field shading'
                : 'Surface current speed shading',
          })),
        ],
        legend: manifest?.u ? legendFor(manifest) : [],
        info: `${label} (m/s)\nValid: ${valid || 'Unavailable'}${loading ? ` ${DOT} loading` : preparing ? ` ${DOT} preparing` : ''}${manifest?.stale ? ` ${DOT} STALE` : ''}${kind ? `\n${kind}${provenance?.ageLabel ? ` ${DOT} ${provenance.ageLabel}` : ''}` : ''}${Number.isFinite(provenance?.rmseMs) ? `\nHoldout RMSE ${provenance.rmseMs} m/s` : ''}${error ? '\n' + error : ''}`,
        infoTitle:
          'Surface ocean currents. Globe: HYCOM ESPC-D forecast on a 1 degree lattice (CoastWatch altimetry when HYCOM is down). Regional: HYCOM at its own resolution. Coastal: IOOS HF-radar analysis over the global field. Streamline colour follows speed; animation shows flow through one fixed field and does not advance time.',
      };
      controls.summary.settings = [
        {
          id: 'field',
          label: 'FIELD',
          chips: controls.chips.filter((chip) =>
            chip.id.startsWith('overlay-'),
          ),
        },
        {
          id: 'motion',
          label: 'MOTION',
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
        countLabel: 'Field',
        lastUpdate: Number.isFinite(valid) ? valid : null,
        loading: loading || Boolean(preparing),
        paused,
        overlay,
        tier: manifest?.tier ?? null,
        stale: Boolean(manifest?.stale),
        source: manifest?.provenance?.tierLabel || 'Surface currents',
        validTime:
          formatWindValidTime(manifest?.cycle?.validIso) || 'Unavailable',
        error:
          error ||
          manifest?.reason ||
          (manifest?.unavailable ? 'Ocean currents unavailable' : null),
      };
    },
    getDiagnostics() {
      return rendering?.getDiagnostics?.() || {};
    },
    getParticleCount() {
      return rendering?.getParticleCount() || 0;
    },
  };
  return layer;
}
