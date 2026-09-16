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
  let product = radar ? 'radar' : 'clouds-regional';
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
        loading = false;
        notify();
        schedule();
      }
    }
  }
  const layer = {
    id,
    name: radar ? 'Rain radar' : 'Satellite clouds',
    icon: radar ? '◉' : '☁',
    source: 'NOAA nowCOAST · OBSERVED',
    updateInterval: 120_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({ viewer, cesium, onChange: notify });
      rendering.setAlpha(opacity === 'light' ? 0.4 : radar ? 0.8 : 0.7);
      motion = matchMedia?.('(prefers-reduced-motion: reduce)');
      motion?.addEventListener?.('change', onVisibility);
      documentRef?.addEventListener?.('visibilitychange', onVisibility);
      removeCamera = viewer.camera.moveEnd?.addEventListener(notify);
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
      ++generation;
      clearTimeout(timer);
      timer = null;
      request?.abort();
      const controller = new AbortController();
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
        rendering?.setAlpha(opacity === 'light' ? 0.4 : radar ? 0.8 : 0.7);
      }
      if (
        !radar &&
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
        const b = manifest.bounds;
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
      const camera = viewer?.camera?.positionCartographic;
      const lon = camera ? cesium.Math.toDegrees(camera.longitude) : 0;
      const lat = camera ? cesium.Math.toDegrees(camera.latitude) : 0;
      const outside =
        b &&
        camera &&
        (lon < b.west || lon > b.east || lat < b.south || lat > b.north);
      return {
        chips: [
          ...(!radar
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
            title: 'Follow the newest observation; refresh every two minutes',
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
            label: radar ? 'View US radar' : 'View coverage',
            disabled: !manifest || !runNavigation,
            params: { focus: true },
          },
        ],
        legend: radar
          ? STOPS.map(([label, color]) => ({
              label: String(label),
              color,
              blurb: `${label} dBZ radar reflectivity`,
            }))
          : [],
        info: `${radar ? 'RADAR REFLECTIVITY · dBZ' : product === 'clouds' ? 'GLOBAL INFRARED · hourly' : 'GOES INFRARED · ~5 min'}\n${time ? `${followLatest ? 'Latest observation' : 'History'}: ${utc(time)}\n${lag}${current && !followLatest ? ` · frame ${index + 1}/${times.length}` : ''}` : 'Observation: unavailable'}${loading ? '\nLoading imagery…' : ''}${manifest?.stale ? '\nSTALE · cached source metadata' : ''}${error || diagnostic?.error ? '\n' + (error || diagnostic.error) : ''}\n${radar ? 'Contiguous US · gaps ≠ no rain' : product === 'clouds' ? '60°S–60°N · typically 2–3 h delayed' : 'North America · clouds + surface temperature'}${outside ? '\nMap center is outside source coverage' : ''}${motion?.matches ? '\nReduced motion · manual history available' : ''}`,
        infoTitle: radar
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
        lastUpdate: shownTime() ? Date.parse(shownTime()) : null,
        loading,
        error: error || rendering?.getDiagnostics().error || null,
        stale: Boolean(manifest?.stale),
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
