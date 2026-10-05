import * as Cesium from 'cesium';
import { createWeatherRendering } from './rendering.js';
import { imageryHostStatus } from './imageryHost.js';
import {
  RADAR_MAX_GAP_MS,
  REGIONAL_INFRARED_MAX_GAP_MS,
  GLOBAL_INFRARED_MAX_GAP_MS,
  LIGHTNING_MAX_GAP_MS,
} from './clock.js';

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
  clock,
  id = 'weather-radar',
  cesium = Cesium,
  createRendering = createWeatherRendering,
  documentRef = globalThis.document,
  eventTarget = globalThis.window,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Weather requires a snapshot source');
  const radar = id === 'weather-radar';
  const lightning = id === 'weather-lightning';
  const satellite = !radar && !lightning;
  let product = radar ? 'radar' : lightning ? 'lightning' : 'clouds-regional';
  let opacity = 'strong';
  let infrared = 'filtered';
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
  let imageryHost = null;
  let hostCollection;
  let hostHidden = false;
  let hostStatus = null;
  let unregisterClock = null;
  let frameRequest = null;
  let noFrame = false;
  const maxGap = () =>
    radar
      ? RADAR_MAX_GAP_MS
      : lightning
        ? LIGHTNING_MAX_GAP_MS
        : product === 'clouds'
          ? GLOBAL_INFRARED_MAX_GAP_MS
          : REGIONAL_INFRARED_MAX_GAP_MS;
  const isLatest = () =>
    clock ? clock.getState().mode === 'latest' : followLatest;
  const getHost = () =>
    imageryHost?.() ?? { collection: viewer?.imageryLayers, kind: 'globe' };
  const notify = () => listener?.();
  const shownTime = () => (noFrame ? null : rendering?.getDiagnostics().time);
  const unsubscribeClock = clock?.subscribe(() => {
    if (!clock.getState().playing || suspended()) rendering?.cancelPrefetch?.();
    notify();
  });
  const observationDelayed = () =>
    manifest?.latest &&
    Date.now() - Date.parse(manifest.latest) >
      (product === 'clouds' ? 240 : lightning ? 45 : 20) * 60_000;
  const stop = () => {
    if (clock) return;
    playing = false;
    rendering?.cancelPrefetch?.();
    clearTimeout(timer);
    timer = null;
  };
  const suspended = () => hostHidden || documentRef?.hidden || motion?.matches;
  const onVisibility = () => {
    if (suspended()) rendering?.cancelPrefetch?.();
    if (clock) void clock.refresh();
    else if (suspended()) stop();
    notify();
  };

  function checkHost(resume = true) {
    const host = getHost();
    const status = imageryHostStatus(host);
    const changed = host.collection !== hostCollection || hostStatus !== status;
    hostCollection = host.collection;
    hostStatus = status;
    hostHidden = status !== null;
    // Keep playback intent and the displayed time while the host is unavailable.
    if (!changed || !rendering) return;
    ++generation;
    rendering.rehome?.();
    clearTimeout(timer);
    timer = null;
    loading = Boolean(request && !request.signal.aborted);
    if (clock && enabled) {
      if (resume) {
        void clock.refresh();
        if (!hostHidden && manifest && isLatest()) void show(manifest.latest);
      }
      notify();
      return;
    }
    if (resume && enabled && !hostHidden && manifest) {
      const time =
        followLatest || !manifest.times.includes(shownTime())
          ? manifest.latest
          : shownTime();
      if (
        time !== shownTime() ||
        (satellite && rendering.getDiagnostics().infrared !== infrared)
      )
        void show(time);
      else schedule();
    }
    notify();
  }
  const onMapStackChanged = () => checkHost();

  function schedule() {
    if (clock) return;
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
  async function applyClockTime(time, { signal }) {
    if (!enabled || signal.aborted) return false;
    if (time !== null) return show(time, signal);
    ++generation;
    frameRequest?.abort();
    frameRequest = null;
    noFrame = true;
    rendering?.setHidden(true);
    loading = Boolean(request && !request.signal.aborted);
    notify();
    return true;
  }
  function registerClock() {
    if (!clock || unregisterClock || !rendering || !enabled) return;
    unregisterClock = clock.register({
      id,
      get maxGapMs() {
        return maxGap();
      },
      getTimes: () => manifest?.times ?? [],
      getShownTime: shownTime,
      apply: applyClockTime,
      isSuspended: suspended,
    });
  }
  async function warmNext(time) {
    if (
      !enabled ||
      suspended() ||
      !(clock ? clock.getState().playing : playing)
    )
      return;
    const times = manifest?.times ?? [];
    const next = times[(times.indexOf(time) + 1) % times.length];
    if (!next || next === time) return;
    try {
      await rendering.prefetch?.(manifest, next, { infrared });
    } catch {
      // Speculative work must not change the displayed frame or playback state.
    }
  }
  async function show(time, signal) {
    checkHost(false);
    if (!enabled || hostHidden || !manifest?.times?.includes(time))
      return false;
    signal?.throwIfAborted();
    frameRequest?.abort();
    const controller = new AbortController();
    frameRequest = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const owner = ++generation;
    loading = true;
    notify();
    try {
      const ok = await rendering.setFrame(manifest, time, {
        signal: controller.signal,
        infrared,
      });
      if (owner !== generation || !enabled || controller.signal.aborted)
        return false;
      if (ok) {
        noFrame = false;
        rendering.setHidden?.(false);
        void warmNext(time);
      }
      error = ok ? null : 'Frame unavailable; previous observation retained';
      if (!ok) stop();
      return ok;
    } catch {
      if (owner === generation && !controller.signal.aborted) {
        error = 'Weather imagery unavailable';
        stop();
      }
      return false;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (frameRequest === controller) frameRequest = null;
      if (owner === generation) {
        loading = Boolean(request && !request.signal.aborted);
        notify();
        if (clock && isLatest()) void clock.refresh();
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
      rendering = createRendering({
        viewer,
        cesium,
        getHost,
        onChange: notify,
      });
      checkHost(false);
      eventTarget?.addEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      rendering.setAlpha(opacity === 'light' ? 0.4 : satellite ? 0.7 : 0.8);
      motion = matchMedia?.('(prefers-reduced-motion: reduce)');
      motion?.addEventListener?.('change', onVisibility);
      documentRef?.addEventListener?.('visibilitychange', onVisibility);
      registerClock();
      removeCamera = viewer.camera.moveEnd?.addEventListener(() => {
        checkHost();
        if (enabled) notify();
      });
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
      registerClock();
    },
    disable() {
      enabled = false;
      unregisterClock?.();
      unregisterClock = null;
      ++generation;
      frameRequest?.abort();
      frameRequest = null;
      noFrame = false;
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
      checkHost(false);
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
        if (clock) {
          await clock.refresh();
          if (
            isLatest() &&
            request === controller &&
            !controller.signal.aborted
          )
            await show(snapshot.latest, controller.signal);
          return (
            !controller.signal.aborted && request === controller && enabled
          );
        }
        const time =
          followLatest || !snapshot.times.includes(shownTime())
            ? snapshot.latest
            : shownTime();
        if (
          shownTime() !== time ||
          (satellite && rendering.getDiagnostics().infrared !== infrared)
        )
          await show(time, controller.signal);
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
      const infraredChanged =
        satellite &&
        ['filtered', 'full'].includes(params.infrared) &&
        params.infrared !== infrared;
      if (infraredChanged) infrared = params.infrared;
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
        frameRequest?.abort();
        frameRequest = null;
        noFrame = false;
        request?.abort();
        request = null;
        stop();
        manifest = null;
        error = null;
        loading = false;
        followLatest = true;
        rendering?.clear();
        if (clock) void clock.refresh();
        if (enabled) void layer.update(viewer);
      }
      if (infraredChanged && enabled && manifest) {
        clearTimeout(timer);
        timer = null;
        if (clock && !isLatest()) void clock.refresh();
        else void show(shownTime() || manifest.latest);
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
      if (clock && enabled) {
        if (params.play === true) void clock.togglePlay();
        if (params.latest === true) void clock.latest();
        if ([-1, 1].includes(params.step)) void clock.step(params.step);
      }
      if (
        !clock &&
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
      if (!clock && params.latest === true && manifest) {
        stop();
        followLatest = true;
        void show(manifest.latest);
      }
      if (!clock && [-1, 1].includes(params.step) && manifest && !loading) {
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
      return radar
        ? { opacity }
        : satellite
          ? { product, opacity, infrared }
          : { product, opacity };
    },
    getRowControls() {
      const shared = clock?.getState();
      const followLatest = isLatest();
      const missing =
        noFrame &&
        shared?.mode === 'history' &&
        shared.products.find((entry) => entry.id === id)?.selected === null
          ? `No frame within ${maxGap() / 60_000 < 60 ? `${maxGap() / 60_000} min` : `${maxGap() / 3600_000} h`} of ${utc(shared.target)}`
          : null;
      const time = shownTime();
      const relation =
        shared?.mode === 'history' && time
          ? Date.parse(time) === Date.parse(shared.target)
            ? ' · synced'
            : Date.parse(time) < Date.parse(shared.target)
              ? ' · nearest'
              : ''
          : '';
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
      const controls = {
        readout: true,
        summary: {
          label: radar
            ? 'Rain radar · US'
            : lightning
              ? 'Lightning density · 15 min'
              : 'Satellite clouds',
          coverage: radar
            ? 'CONUS'
            : lightning
              ? 'Americas + Pacific'
              : product === 'clouds'
                ? 'Global · 60°S–60°N'
                : 'North America',
          shownTime: time,
          maxGapMinutes: maxGap() / 60_000,
          detail: time
            ? `${followLatest ? 'Observed' : 'History'} · ${utc(time)} · ${lag}${relation}`
            : missing
              ? 'Observation unavailable'
              : 'Waiting for observation',
          status:
            missing ||
            hostStatus ||
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
                    ? 'Hourly global mosaic; usually 2–3 hours delayed'
                    : 'GOES regional clouds; approximately 5-minute updates',
              }))
            : []),
          ...(satellite
            ? [
                {
                  id: 'filtered',
                  label: 'Clouds only',
                  active: infrared === 'filtered',
                  params: { infrared: 'filtered' },
                  title:
                    'Dim everything but the bright, cold cloud tops; a brightness filter, not a cloud mask',
                },
                {
                  id: 'full',
                  label: 'Full',
                  active: infrared === 'full',
                  params: { infrared: 'full' },
                  title: 'The complete infrared image at the chosen opacity',
                },
              ]
            : []),
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
        info: hostHidden
          ? hostStatus
          : `${radar ? 'RADAR REFLECTIVITY · dBZ' : lightning ? 'LIGHTNING DENSITY · 15 min accumulation' : product === 'clouds' ? 'GLOBAL INFRARED · hourly' : 'GOES INFRARED · ~5 min'}\n${time ? `${followLatest ? 'Latest observation' : 'History'}: ${utc(time)}\n${lag}${current && !followLatest ? ` · frame ${index + 1}/${times.length}` : ''}${loading ? ' · loading' : ''}` : `Observation: unavailable${loading ? ' · loading' : ''}`}${missing ? `\n${missing}` : ''}${manifest?.stale ? '\nSTALE · cached source metadata' : ''}${error || diagnostic?.error ? '\n' + (error || diagnostic.error) : ''}\n${radar ? 'Contiguous US · gaps ≠ no rain' : lightning ? 'Americas + Pacific · not individual strikes\nColor: strikes/km²/min ×10³' : product === 'clouds' ? '60°S–60°N · typically 2–3 h delayed' : 'North America · infrared imagery'}${outside ? '\nMap center is outside source coverage' : ''}${motion?.matches ? (clock ? '\nReduced motion · history playback unavailable' : '\nReduced motion · manual history available') : ''}`,
        infoTitle: lightning
          ? 'NOAA/NWS 15-minute lightning density derived from Vaisala NLDN/GLD360. Coverage 110°E across the Pacific/Americas to 0°, 25°S–80°N. Not a live strike count, global coverage or a safety warning.'
          : radar
            ? 'NOAA MRMS radar echoes indicate precipitation patterns, not rain rate, a storm warning or a future forecast. Native source approximately 1 km; display is limited to level 6. Frames use exact advertised observation times.'
            : 'GOES-19/18 longwave infrared Band 14 regional; NESDIS global longwave mosaic. Clouds only dims everything but bright, cold cloud tops; a brightness filter, not a cloud mask. Coverage and freshness differ by region.',
      };
      controls.summary.settings = [
        ...(satellite
          ? [
              {
                id: 'region',
                label: 'REGION',
                chips: controls.chips.filter(({ params }) => params.product),
              },
              {
                id: 'image',
                label: 'IMAGE',
                chips: controls.chips.filter(({ params }) => params.infrared),
              },
            ]
          : []),
        {
          id: 'opacity',
          label: 'OPACITY',
          chips: controls.chips.filter(({ params }) => params.opacity),
        },
      ];
      controls.summary.actions = controls.chips.filter(
        ({ id }) => id === 'coverage',
      );
      return controls;
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: shownTime() ? 1 : 0,
        countLabel: isLatest() ? 'Observed' : 'History',
        lastUpdate: shownTime() ? Date.parse(shownTime()) : null,
        loading,
        error: error || rendering?.getDiagnostics().error || null,
        stale: Boolean(manifest?.stale || observationDelayed()),
        source: 'NOAA nowCOAST',
        observedAt: shownTime(),
      };
    },
    getDiagnostics() {
      const shared = clock?.getState();
      return {
        ...rendering?.getDiagnostics(),
        playing: shared ? shared.playing : playing && !hostHidden,
        followLatest: isLatest(),
        ...(shared
          ? {
              clock: {
                mode: shared.mode,
                target: shared.target,
                playing: shared.playing,
              },
            }
          : {}),
        historyFrames: manifest?.times?.length || 0,
        timerActive: timer !== null,
      };
    },
    destroy() {
      layer.disable();
      unsubscribeClock?.();
      removeCamera?.();
      removeCamera = null;
      motion?.removeEventListener?.('change', onVisibility);
      documentRef?.removeEventListener?.('visibilitychange', onVisibility);
      eventTarget?.removeEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      runNavigation = null;
      imageryHost = null;
      viewer = null;
      rendering = null;
      listener = null;
    },
  };
  return layer;
}
