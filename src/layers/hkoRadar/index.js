import * as Cesium from 'cesium';
import { orderWeatherImagery } from '../weather/imageryOrder.js';
import { imageryHostStatus } from '../weather/imageryHost.js';

const utc = (value) =>
  value ? `${value.slice(5, 16).replace('T', ' ')} UTC` : 'Unavailable';
const REFRESH_MS = 180_000;
const IMAGERY_PRIORITY = 2;

/** Hong Kong Observatory 128 km rain radar draped on its LatLonBox. */
export function createHkoRadarLayer({
  feed,
  cesium = Cesium,
  documentRef = globalThis.document,
  eventTarget = globalThis.window,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('HKO radar requires a snapshot source');
  let viewer = null;
  let imagery = null;
  let imageryCollection = null;
  let imageryErrorRemove = null;
  let manifest = null;
  let request = null;
  let listener = null;
  let enabled = false;
  let loading = false;
  let error = null;
  let opacity = 'strong';
  let shownTime = null;
  let generation = 0;
  let timer = null;
  let motion = null;
  let runNavigation = null;
  let imageryHost = null;
  let hostCollection;
  let hostHidden = false;
  let hostStatus = null;
  const notify = () => listener?.();
  const getHost = () =>
    imageryHost?.() ?? { collection: viewer?.imageryLayers, kind: 'globe' };
  const alpha = () => (opacity === 'light' ? 0.4 : 0.8);
  const clearImagery = () => {
    imageryErrorRemove?.();
    imageryErrorRemove = null;
    if (imagery && imageryCollection) {
      try {
        imageryCollection.remove(imagery, true);
      } catch {
        /* already detached */
      }
    }
    imagery = null;
    imageryCollection = null;
  };
  const suspended = () => hostHidden || documentRef?.hidden;
  const schedule = () => {
    clearTimeout(timer);
    timer = null;
    if (!enabled || suspended() || !manifest) return;
    timer = setTimeout(() => {
      timer = null;
      if (enabled) void layer.update(viewer);
    }, REFRESH_MS);
  };
  function checkHost(resume = true) {
    const host = getHost();
    const status = imageryHostStatus(host);
    const changed = host.collection !== hostCollection || hostStatus !== status;
    hostCollection = host.collection;
    hostStatus = status;
    hostHidden = status !== null;
    if (!changed) return;
    ++generation;
    clearImagery();
    shownTime = null;
    loading = Boolean(request && !request.signal.aborted);
    if (resume && enabled && !hostHidden && manifest)
      void show(manifest.latest);
    notify();
  }
  const onVisibility = () => {
    if (suspended()) {
      clearTimeout(timer);
      timer = null;
    } else if (enabled) schedule();
    notify();
  };
  const onMapStackChanged = () => checkHost();

  async function show(time) {
    const host = getHost();
    if (!enabled || hostHidden || !host.collection || !manifest) return false;
    const frame = manifest.frames.find((item) => item.time === time);
    if (!frame) return false;
    const owner = ++generation;
    loading = true;
    notify();
    try {
      const rectangle = cesium.Rectangle.fromDegrees(
        manifest.extent.west,
        manifest.extent.south,
        manifest.extent.east,
        manifest.extent.north,
      );
      let provider;
      if (typeof cesium.SingleTileImageryProvider?.fromUrl === 'function') {
        provider = await cesium.SingleTileImageryProvider.fromUrl(frame.url, {
          rectangle,
        });
      } else if (typeof cesium.SingleTileImageryProvider === 'function') {
        provider = new cesium.SingleTileImageryProvider({
          url: frame.url,
          rectangle,
        });
      } else {
        error = 'Globe imagery unavailable';
        return false;
      }
      if (!enabled || owner !== generation || hostHidden) return false;
      clearImagery();
      imagery = host.collection.addImageryProvider(provider);
      orderWeatherImagery(host.collection, imagery, IMAGERY_PRIORITY);
      imageryCollection = host.collection;
      imagery.alpha = alpha();
      imageryErrorRemove = provider.errorEvent?.addEventListener?.(() => {
        error = 'HKO radar frame unavailable';
        notify();
      });
      shownTime = frame.time;
      error = null;
      viewer?.scene?.requestRender?.();
      return true;
    } catch {
      if (owner === generation) error = 'HKO radar imagery unavailable';
      return false;
    } finally {
      if (owner === generation) {
        loading = Boolean(request && !request.signal.aborted);
        notify();
        schedule();
      }
    }
  }

  const layer = {
    id: 'weather-hko-radar',
    name: 'HK rain radar',
    icon: '◉',
    source: 'HKO · OBSERVED',
    updateInterval: REFRESH_MS,
    init(nextViewer) {
      viewer = nextViewer;
      checkHost(false);
      eventTarget?.addEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      motion = matchMedia?.('(prefers-reduced-motion: reduce)');
      documentRef?.addEventListener?.('visibilitychange', onVisibility);
    },
    attachShellServices(services) {
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      checkHost();
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
      notify();
    },
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
      ++generation;
      request?.abort();
      request = null;
      clearTimeout(timer);
      timer = null;
      clearImagery();
      manifest = null;
      shownTime = null;
      loading = false;
      error = null;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      checkHost(false);
      clearTimeout(timer);
      timer = null;
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      request = controller;
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const snapshot = await feed.getSnapshot({ signal: controller.signal });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        if (snapshot.unavailable) {
          error = 'HKO radar unavailable; previous observation retained';
          return true;
        }
        manifest = snapshot;
        error = null;
        const target =
          shownTime && manifest.frames.some((f) => f.time === shownTime)
            ? shownTime
            : manifest.latest;
        if (!hostHidden) await show(target);
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || 'HKO radar unavailable';
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
          schedule();
        }
      }
    },
    setParams(params = {}) {
      if (['light', 'strong'].includes(params.opacity)) {
        opacity = params.opacity;
        if (imagery) imagery.alpha = alpha();
        viewer?.scene?.requestRender?.();
      }
      if (
        params.focus === true &&
        enabled &&
        manifest?.extent &&
        runNavigation
      ) {
        const b = manifest.extent;
        runNavigation(() =>
          viewer.camera.flyTo({
            destination: cesium.Rectangle.fromDegrees(
              b.west,
              b.south,
              b.east,
              b.north,
            ),
            duration: motion?.matches ? 0 : 1.4,
          }),
        );
      }
      if (params.latest === true && manifest) {
        void show(manifest.latest);
      }
      if ([-1, 1].includes(params.step) && manifest && !loading) {
        const times = manifest.frames.map((f) => f.time);
        const at = times.indexOf(shownTime);
        const next = Math.max(
          0,
          Math.min(
            times.length - 1,
            (at < 0 ? times.length - 1 : at) + params.step,
          ),
        );
        void show(times[next]);
      }
      notify();
    },
    getParams() {
      return { opacity };
    },
    getRowControls() {
      const time = shownTime;
      const lag = time
        ? `${Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 60_000))}m ago`
        : '';
      const index = manifest
        ? manifest.frames.findIndex((f) => f.time === time)
        : -1;
      const controls = {
        summary: {
          label: 'HK rain radar',
          coverage: 'Hong Kong · 128 km',
          shownTime: time,
          detail: time
            ? `Observed · ${utc(time)} · ${lag}`
            : 'Waiting for observation',
          status:
            hostStatus ||
            error ||
            (manifest?.stale
              ? 'Stale source'
              : loading
                ? 'Loading next frame…'
                : null),
          units: '',
        },
        chips: [
          ...['light', 'strong'].map((value) => ({
            id: `opacity-${value}`,
            label: value === 'light' ? 'Soft' : 'Vivid',
            active: opacity === value,
            params: { opacity: value },
            title: 'Image opacity; does not alter the observed values',
          })),
          {
            id: 'coverage',
            label: 'View Hong Kong',
            disabled: !manifest || !runNavigation,
            params: { focus: true },
          },
        ],
        legend: [],
        info: hostHidden
          ? hostStatus
          : `HKO 128 km RADAR\n${time ? `Latest observation: ${utc(time)}\n${lag}${loading ? ' · loading' : ''}${index >= 0 ? ` · frame ${index + 1}/${manifest.frames.length}` : ''}` : `Observation: unavailable${loading ? ' · loading' : ''}`}${manifest?.stale ? '\nSTALE · cached source metadata' : ''}${error ? `\n${error}` : ''}\nHong Kong and vicinity · gaps ≠ no rain`,
        infoTitle:
          'Hong Kong Observatory 128 km rain radar mosaic. Frames are public GroundOverlay imagery from HKO; not a rainfall rate, nowcast or warning. Attribute HKO / DATA.GOV.HK.',
      };
      controls.summary.settings = [
        {
          id: 'opacity',
          label: 'OPACITY',
          chips: controls.chips.filter(({ params }) => params.opacity),
        },
      ];
      controls.summary.actions = [
        {
          id: 'prev',
          label: 'Prev',
          disabled: !manifest || index <= 0 || loading,
          params: { step: -1 },
        },
        {
          id: 'latest',
          label: 'Latest',
          disabled: !manifest || time === manifest.latest || loading,
          params: { latest: true },
        },
        ...controls.chips.filter(({ id }) => id === 'coverage'),
      ];
      return controls;
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: shownTime ? 1 : 0,
        countLabel: 'Observed',
        lastUpdate: shownTime ? Date.parse(shownTime) : null,
        loading,
        error,
        stale: Boolean(manifest?.stale),
        source: 'Hong Kong Observatory',
        observedAt: shownTime,
      };
    },
    getDiagnostics() {
      return {
        shownTime,
        historyFrames: manifest?.frames?.length || 0,
        timerActive: timer !== null,
        hostStatus,
        error,
      };
    },
    destroy() {
      layer.disable();
      documentRef?.removeEventListener?.('visibilitychange', onVisibility);
      eventTarget?.removeEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      runNavigation = null;
      imageryHost = null;
      viewer = null;
      listener = null;
    },
  };
  return layer;
}

export { createHkoRadarSource } from './source.js';
