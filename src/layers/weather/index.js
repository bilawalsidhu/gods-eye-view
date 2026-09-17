import * as Cesium from 'cesium';
import { createWeatherRendering } from './rendering.js';

const STOPS = [
  [10, '#00ecec'],
  [20, '#0000f6'],
  [30, '#00c800'],
  [40, '#ffff00'],
  [50, '#ff9000'],
  [60, '#dc0000'],
  [70, '#ff00ff'],
  [80, '#05ede0'],
];
const LIGHTNING_STOPS = [
  ['0.1', '#FFFFCC'],
  ['1', '#FFA400'],
  ['5', '#FF4500'],
  ['10', '#FF0000'],
  ['50', '#FF00FF'],
  ['100', '#4000C0'],
  ['200', '#00C7FF'],
  ['300+', '#00FF00'],
];
const utc = (value) =>
  value ? `${value.slice(5, 16).replace('T', ' ')} UTC` : 'Unavailable';

/** A per-application observation layer, using the existing layer lifecycle and
 * row controls. History is transient: shared links always open latest imagery. */
export function createWeatherLayer({
  feed,
  id = 'weather-radar',
  cesium = Cesium,
  createRendering = createWeatherRendering,
  documentRef = globalThis.document,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Weather requires a snapshot source');
  const radar = id === 'weather-radar';
  const lightning = id === 'weather-lightning';
  const satellite = !radar && !lightning;
  let product = radar ? 'radar' : lightning ? 'lightning' : 'clouds-regional';
  let opacity = 'strong';
  let viewer = null,
    rendering = null,
    manifest = null,
    request = null,
    listener = null;
  let enabled = false,
    loading = false,
    playing = false,
    followLatest = true;
  let generation = 0,
    timer = null,
    error = null,
    removeCamera = null;
  let motion = null;
  let runNavigation = null;
  const notify = () => listener?.();
  const shownTime = () => rendering?.getDiagnostics().time;
  const observationDelayed = () =>
    manifest?.latest &&
    Date.now() - Date.parse(manifest.latest) >
      (product === 'clouds' ? 240 : lightning ? 45 : 20) * 60_000;
  const stop = () => {
    playing = false;
    clearTimeout(timer);
    timer = null;
  };
  const suspended = () => documentRef?.hidden || motion?.matches;
  const onVisibility = () => {
    if (suspended()) stop();
    notify();
  };

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!enabled || !playing || suspended()) return;
    timer = setTimeout(() => {
      timer = null;
      const times = manifest?.times || [];
      const next = (times.indexOf(shownTime()) + 1) % times.length;
      if (times[next]) void show(times[next]);
      else stop();
    }, 2000);
  }
  async function show(time, signal) {
    if (!enabled || !manifest?.times?.includes(time)) return false;
    const owner = ++generation;
    loading = true;
    notify();
    try {
      const ok = await rendering.setFrame(manifest, time, { signal });
      if (owner !== generation || !enabled || signal?.aborted) return false;
      error = ok ? null : 'Frame unavailable; previous observation retained';
      if (!ok) stop();
      return ok;
    } catch {
      if (owner === generation) {
        error = 'Weather imagery unavailable';
        stop();
      }
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
    id,
    name: radar
      ? 'Rain radar'
      : lightning
        ? 'Lightning density'
        : 'Satellite clouds',
    icon: radar ? '◉' : lightning ? 'ϟ' : '☁',
    source: 'NOAA nowCOAST · OBSERVED',
    updateInterval: lightning ? 600_000 : 120_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({ viewer, cesium, onChange: notify });
      rendering.setAlpha(opacity === 'light' ? 0.4 : satellite ? 0.7 : 0.8);
      motion = matchMedia?.('(prefers-reduced-motion: reduce)');
      motion?.addEventListener?.('change', onVisibility);
      documentRef?.addEventListener?.('visibilitychange', onVisibility);
      removeCamera = viewer.camera.moveEnd?.addEventListener(() => {
        if (enabled) notify();
      });
    },
    attachShellServices(services) {
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
      stop();
      rendering?.clear();
      manifest = null;
      loading = false;
      error = null;
      followLatest = true;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      clearTimeout(timer);
      timer = null;
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      request = controller;
      const abort = () => {
        controller.abort(signal.reason);
        stop();
      };
      signal?.addEventListener('abort', abort, { once: true });
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const snapshot = await feed.getSnapshot({
          product,
          signal: controller.signal,
        });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        if (snapshot.unavailable) {
          error = 'Weather source unavailable; previous observation retained';
          stop();
          return true;
        }
        manifest = snapshot;
        error = null;
        const time =
          followLatest || !snapshot.times.includes(shownTime())
            ? snapshot.latest
            : shownTime();
        if (shownTime() !== time) await show(time, controller.signal);
        return !controller.signal.aborted && request === controller && enabled;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || 'Weather unavailable';
        stop();
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = Boolean(rendering?.getDiagnostics().loading);
          notify();
          schedule();
        }
      }
    },
    setParams(params = {}) {
      if (['light', 'strong'].includes(params.opacity)) {
        opacity = params.opacity;
        rendering?.setAlpha(opacity === 'light' ? 0.4 : satellite ? 0.7 : 0.8);
      }
      if (
        satellite &&
        ['clouds', 'clouds-regional'].includes(params.product) &&
        params.product !== product
      ) {
        product = params.product;
        ++generation;
        request?.abort();
        request = null;
        stop();
        manifest = null;
        error = null;
        loading = false;
        followLatest = true;
        rendering?.clear();
        if (enabled) void layer.update(viewer);
      }
      if (
        params.focus === true &&
        enabled &&
        manifest?.bounds &&
        runNavigation
      ) {
        const b = lightning
          ? { west: 110, south: -25, east: 0, north: 80 }
          : manifest.bounds;
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
      if (
        params.play === true &&
        enabled &&
        manifest?.times?.length > 1 &&
        !suspended()
      ) {
        playing = !playing;
        followLatest = false;
        if (playing) schedule();
        else stop();
      }
      if (params.latest === true && manifest) {
        stop();
        followLatest = true;
        void show(manifest.latest);
      }
      if ([-1, 1].includes(params.step) && manifest && !loading) {
        stop();
        followLatest = false;
        const at = manifest.times.indexOf(shownTime());
        const next = Math.max(
          0,
          Math.min(manifest.times.length - 1, at + params.step),
        );
        void show(manifest.times[next]);
      }
      notify();
    },
    getParams() {
      return radar ? { opacity } : { product, opacity };
    },
    getRowControls() {
      const time = shownTime();
      const times = manifest?.times || [];
      const index = times.indexOf(time);
      const current = index >= 0;
      const age = time
        ? Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 60000))
        : null;
      const lag =
        age === null
          ? ''
          : age >= 60
            ? `${Math.floor(age / 60)}h ${age % 60}m ago`
            : `${age}m ago`;
      const diagnostic = rendering?.getDiagnostics();
      const b = manifest?.bounds;
      const canvas = viewer?.scene?.canvas;
      const point =
        canvas &&
        viewer.camera.pickEllipsoid?.(
          new cesium.Cartesian2(
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          ),
          viewer.scene.globe.ellipsoid,
        );
      const camera = point
        ? cesium.Cartographic.fromCartesian(point, viewer.scene.globe.ellipsoid)
        : null;
      const lon = camera ? cesium.Math.toDegrees(camera.longitude) : 0;
      const lat = camera ? cesium.Math.toDegrees(camera.latitude) : 0;
      const outside =
        b &&
        camera &&
        (lon < b.west ||
          lon > b.east ||
          lat < b.south ||
          lat > b.north ||
          (lightning && lon > 0 && lon < 110));
      return {
        summary: {
          label: radar
            ? 'Rain radar · US'
            : lightning
              ? 'Lightning density · 15 min'
              : product === 'clouds'
                ? 'Satellite infrared · global'
                : 'Satellite infrared · N. America',
          detail: time
            ? `${followLatest ? 'Observed' : 'History'} · ${utc(time)} · ${lag}`
            : 'Waiting for observation',
          status:
            error ||
            diagnostic?.error ||
            (observationDelayed()
              ? 'Source observations delayed'
              : manifest?.stale
                ? 'Stale source'
                : loading
                  ? 'Loading next frame…'
                  : outside
                    ? 'Map center outside coverage'
                    : null),
          units: radar ? 'dBZ' : lightning ? 'strikes/km²/min ×10³' : '',
        },
        chips: [
          ...(satellite
            ? [
                ['clouds-regional', 'N. America'],
                ['clouds', 'Global'],
              ].map(([value, label]) => ({
                id: value,
                label,
                active: product === value,
                params: { product: value },
                title:
                  value === 'clouds'
                    ? 'Hourly global infrared; usually 2–3 hours delayed'
                    : 'GOES regional infrared; approximately 5-minute updates',
              }))
            : []),
          {
            id: 'previous',
            label: '‹ Earlier',
            disabled: loading || index <= 0,
            params: { step: -1 },
            title: 'Previous observed frame',
          },
          {
            id: 'play',
            label: playing ? 'Pause' : 'Play history',
            active: playing,
            disabled:
              (loading && !playing) || times.length < 2 || !!motion?.matches,
            params: { play: true },
            title: 'Replay recent observations; this is not a forecast',
          },
          {
            id: 'next',
            label: 'Later ›',
            disabled: loading || !current || index >= times.length - 1,
            params: { step: 1 },
            title: 'Next observed frame',
          },
          {
            id: 'latest',
            label: 'Latest',
            active: followLatest,
            disabled: !manifest,
            params: { latest: true },
            title: lightning
              ? 'Follow the newest observation; refresh every ten minutes'
              : 'Follow the newest observation; refresh every two minutes',
          },
          ...['light', 'strong'].map((value) => ({
            id: `opacity-${value}`,
            label: value === 'light' ? 'Soft' : 'Vivid',
            active: opacity === value,
            params: { opacity: value },
            title: 'Image opacity; does not alter the observed values',
          })),
          {
            id: 'coverage',
            label: radar
              ? 'View US radar'
              : lightning
                ? 'View Americas & Pacific'
                : 'View coverage',
            disabled: !manifest || !runNavigation,
            params: { focus: true },
          },
        ],
        legend:
          radar || lightning
            ? (lightning ? LIGHTNING_STOPS : STOPS).map(([label, color]) => ({
                label: String(label),
                color,
                blurb: lightning
                  ? `${label} strikes/km²/min ×10³ (15-minute density)`
                  : `${label} dBZ radar reflectivity`,
              }))
            : [],
        info: `${radar ? 'RADAR REFLECTIVITY · dBZ' : lightning ? 'LIGHTNING DENSITY · 15 min accumulation' : product === 'clouds' ? 'GLOBAL INFRARED · hourly' : 'GOES INFRARED · ~5 min'}\n${time ? `${followLatest ? 'Latest observation' : 'History'}: ${utc(time)}\n${lag}${current && !followLatest ? ` · frame ${index + 1}/${times.length}` : ''}` : 'Observation: unavailable'}${loading ? '\nLoading imagery…' : ''}${manifest?.stale ? '\nSTALE · cached source metadata' : ''}${error || diagnostic?.error ? '\n' + (error || diagnostic.error) : ''}\n${radar ? 'Contiguous US · gaps ≠ no rain' : lightning ? 'Americas + Pacific · not individual strikes\nColor: strikes/km²/min ×10³' : product === 'clouds' ? '60°S–60°N · typically 2–3 h delayed' : 'North America · clouds + surface temperature'}${outside ? '\nMap center is outside source coverage' : ''}${motion?.matches ? '\nReduced motion · manual history available' : ''}`,
        infoTitle: lightning
          ? 'NOAA/NWS 15-minute lightning density derived from Vaisala NLDN/GLD360. Coverage 110°E across the Pacific/Americas to 0°, 25°S–80°N. Not a live strike count, global coverage or a safety warning.'
          : radar
            ? 'NOAA MRMS radar echoes indicate precipitation patterns, not rain rate, a storm warning or a future forecast. Native source approximately 1 km; display is limited to level 6. Frames use exact advertised observation times.'
            : 'Infrared satellite imagery reveals cloud and land/sea temperature patterns. Bright regions are generally colder, often higher cloud tops. This is an observed image draped on the globe, not measured cloud volume. Global mosaic coverage and freshness differ from regional GOES.',
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: shownTime() ? 1 : 0,
        countLabel: followLatest ? 'Observed' : 'History',
        lastUpdate: shownTime() ? Date.parse(shownTime()) : null,
        loading,
        error: error || rendering?.getDiagnostics().error || null,
        stale: Boolean(manifest?.stale || observationDelayed()),
        source: 'NOAA nowCOAST',
        observedAt: shownTime(),
      };
    },
    getDiagnostics() {
      return {
        ...rendering?.getDiagnostics(),
        playing,
        followLatest,
        historyFrames: manifest?.times?.length || 0,
        timerActive: timer !== null,
      };
    },
    destroy() {
      layer.disable();
      removeCamera?.();
      removeCamera = null;
      motion?.removeEventListener?.('change', onVisibility);
      documentRef?.removeEventListener?.('visibilitychange', onVisibility);
      runNavigation = null;
      viewer = null;
      rendering = null;
      listener = null;
    },
  };
  return layer;
}
