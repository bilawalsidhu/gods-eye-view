import * as Cesium from 'cesium';
import { RADAR_MAX_GAP_MS } from '../weather/clock.js';
import { imageryHostStatus } from '../weather/imageryHost.js';
import { BIRD_MIGRATION_ID, describeFrame, mergeMotion } from './model.js';
import { PATTERN_LEGEND } from './pattern.js';
import { createMigrationRendering } from './rendering.js';

const PENDING = Object.freeze({ kind: 'pending' });
const PENDING_RETRY_MS = 15_000;
const PROVISIONAL_RETRY_MS = 3 * 60_000;

/**
 * Nocturnal migration over CONUS: recolored IEM N0Q reflectivity draped on the
 * imagery host, and one VAD ground track per radar from the same-origin proxy.
 * Joins the weather clock; the latest tick loads on enable, older ticks only
 * when the clock selects them.
 */
export function createBirdMigrationLayer({
  source,
  clock,
  cesium = Cesium,
  createRendering = createMigrationRendering,
  documentRef = globalThis.document,
  eventTarget = globalThis.window,
  setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutImpl = (id) => globalThis.clearTimeout(id),
} = {}) {
  if (
    typeof source?.getManifest !== 'function' ||
    typeof source?.getMotion !== 'function'
  )
    throw new TypeError('Bird migration requires a manifest and motion source');
  if (typeof clock?.register !== 'function')
    throw new TypeError('Bird migration requires the weather clock');
  let viewer = null;
  let rendering = null;
  let manifest = null;
  let shown = null;
  let enabled = false;
  let loading = false;
  let error = null;
  let listener = null;
  let imageryHost = null;
  let runNavigation = null;
  let hostCollection;
  let unregisterClock = null;
  let manifestRequest = null;
  let retry = null;
  const motions = new Map();
  const motionRequests = new Map();

  const notify = () => listener?.();
  const getHost = () =>
    imageryHost?.() ?? { collection: viewer?.imageryLayers, kind: 'globe' };
  const hostStatus = () => imageryHostStatus(getHost());
  const frameAt = (time) => ({ time, motion: motions.get(time) ?? PENDING });
  const draw = () => {
    if (rendering && shown) rendering.show(frameAt(shown));
  };
  const unsubscribeClock = clock.subscribe?.(notify);

  function cancelRetry() {
    if (retry) clearTimeoutImpl(retry.timer);
    retry = null;
  }

  function scheduleRetry(time, motion) {
    if (motion.kind === 'reduced' && motion.final) return;
    if (retry?.time === time) return;
    cancelRetry();
    retry = {
      time,
      timer: setTimeoutImpl(
        () => {
          retry = null;
          if (enabled && shown === time) ensureMotion(time);
        },
        motion.kind === 'reduced' ? PROVISIONAL_RETRY_MS : PENDING_RETRY_MS,
      ),
    };
  }

  function ensureMotion(time) {
    const known = motions.get(time);
    if ((known?.kind === 'reduced' && known.final) || motionRequests.has(time))
      return;
    const controller = new AbortController();
    motionRequests.set(time, controller);
    notify();
    source
      .getMotion(time, { signal: controller.signal })
      .catch((cause) =>
        controller.signal.aborted
          ? null
          : {
              kind: 'unavailable',
              reason: cause?.message || 'Direction service unavailable',
            },
      )
      .then((next) => {
        if (!next || motionRequests.get(time) !== controller) return;
        const merged = mergeMotion(motions.get(time), next);
        motions.set(time, merged);
        if (time === shown) {
          draw();
          scheduleRetry(time, merged);
        }
      })
      .finally(() => {
        if (motionRequests.get(time) === controller)
          motionRequests.delete(time);
        notify();
      });
  }

  function select(time) {
    shown = time;
    cancelRetry();
    if (time === null) rendering?.setHidden(true);
    else {
      rendering?.setHidden(false);
      draw();
      ensureMotion(time);
    }
    notify();
  }

  function registerClock() {
    if (unregisterClock || !rendering || !enabled) return;
    unregisterClock = clock.register({
      id: BIRD_MIGRATION_ID,
      maxGapMs: RADAR_MAX_GAP_MS,
      getTimes: () => manifest?.ticks ?? [],
      getShownTime: () => shown,
      isSuspended: () =>
        getHost().kind === 'none' || Boolean(documentRef?.hidden),
      async apply(time, { signal }) {
        if (!enabled || signal.aborted) return false;
        select(time);
        return true;
      },
    });
  }

  function checkHost() {
    const { collection } = getHost();
    if (collection === hostCollection) return;
    hostCollection = collection;
    rendering?.rehome();
    notify();
  }
  const onMapStackChanged = () => checkHost();

  const layer = {
    id: BIRD_MIGRATION_ID,
    name: 'Bird migration',
    icon: '➶',
    source: 'NWS NEXRAD · OBSERVED',
    updateInterval: 300_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({
        viewer,
        cesium,
        getHost,
        onChange: notify,
      });
      hostCollection = getHost().collection;
      eventTarget?.addEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      registerClock();
    },
    attachShellServices(services) {
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
      checkHost();
      notify();
    },
    enable() {
      enabled = true;
      registerClock();
    },
    disable() {
      enabled = false;
      unregisterClock?.();
      unregisterClock = null;
      manifestRequest?.abort();
      manifestRequest = null;
      for (const controller of motionRequests.values()) controller.abort();
      motionRequests.clear();
      cancelRetry();
      motions.clear();
      manifest = null;
      shown = null;
      loading = false;
      error = null;
      rendering?.clear();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      manifestRequest?.abort();
      const controller = new AbortController();
      manifestRequest = controller;
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const next = await source.getManifest({ signal: controller.signal });
        if (!enabled || manifestRequest !== controller) return false;
        if (next.unavailable) {
          error = `${next.reason}; previous frames retained`;
          return true;
        }
        manifest = next;
        error = null;
        for (const time of motions.keys())
          if (!next.ticks.includes(time)) motions.delete(time);
        await clock.refresh();
        if (clock.getState().mode === 'latest' && enabled) select(next.latest);
        return true;
      } catch (cause) {
        if (controller.signal.aborted || manifestRequest !== controller)
          return false;
        error = cause?.message || 'Bird migration unavailable';
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (manifestRequest === controller) {
          manifestRequest = null;
          loading = false;
          notify();
        }
      }
    },
    setParams(params = {}) {
      if (params.focus === true && enabled && manifest && runNavigation) {
        const { west, south, east, north } = manifest.bounds;
        runNavigation(() =>
          viewer.camera.flyTo({
            destination: cesium.Rectangle.fromDegrees(west, south, east, north),
            duration: 1.4,
          }),
        );
      }
      if (enabled) {
        if (params.play === true) void clock.togglePlay();
        if (params.latest === true) void clock.latest();
        if ([-1, 1].includes(params.step)) void clock.step(params.step);
      }
      notify();
    },
    getParams() {
      return {};
    },
    getRowControls() {
      const card = describeFrame(shown ? frameAt(shown) : null);
      const diagnostic = rendering?.getDiagnostics();
      const reducing = shown !== null && motionRequests.has(shown);
      const status =
        hostStatus() ||
        error ||
        diagnostic?.error ||
        (manifest?.stale ? 'Stale source' : null) ||
        (loading || reducing ? 'Loading…' : null) ||
        card.status;
      const coverage = {
        id: 'coverage',
        label: 'View US radars',
        disabled: !manifest || !runNavigation,
        params: { focus: true },
      };
      return {
        readout: true,
        summary: {
          label: card.label,
          coverage: card.coverage,
          shownTime: shown,
          maxGapMinutes: RADAR_MAX_GAP_MS / 60_000,
          detail: card.detail,
          status,
          units: 'dBZ',
          lines: [
            ...card.lines,
            { id: 'attribution', text: card.attribution, muted: true },
          ],
          settings: [],
          actions: [coverage],
        },
        chips: [coverage],
        legend: PATTERN_LEGEND.map(({ label, color }) => ({
          label,
          color,
          blurb: `${label} dBZ low-altitude echo`,
        })),
        info: [card.detail, status, ...card.lines.map(({ text }) => text)]
          .filter(Boolean)
          .join('\n'),
        infoTitle:
          'Lowest-tilt NWS reflectivity between 5 and 35 dBZ, which at night is mostly migrating birds and insects but still includes light rain. Arrows are a per-radar velocity-azimuth fit of N0U velocity over gates with correlation coefficient below 0.95. ' +
          card.attribution,
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: shown ? 1 : 0,
        countLabel: clock.getState().mode === 'latest' ? 'Observed' : 'History',
        lastUpdate: shown ? Date.parse(shown) : null,
        loading,
        error: error || rendering?.getDiagnostics().error || null,
        stale: Boolean(manifest?.stale),
        source: 'NWS NEXRAD',
        observedAt: shown,
      };
    },
    getDiagnostics() {
      const shared = clock.getState();
      return {
        ...rendering?.getDiagnostics(),
        shown,
        motion: shown ? frameAt(shown).motion.kind : null,
        historyFrames: manifest?.ticks.length ?? 0,
        clock: {
          mode: shared.mode,
          target: shared.target,
          playing: shared.playing,
        },
      };
    },
    destroy() {
      layer.disable();
      unsubscribeClock?.();
      eventTarget?.removeEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      rendering?.destroy();
      rendering = null;
      viewer = null;
      imageryHost = null;
      runNavigation = null;
      listener = null;
    },
  };
  return layer;
}
