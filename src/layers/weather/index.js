import * as Cesium from 'cesium';
import { createWeatherRendering } from './rendering.js';
import { imageryHostStatus } from './imageryHost.js';
import {
  RADAR_MAX_GAP_MS,
  REGIONAL_INFRARED_MAX_GAP_MS,
  GLOBAL_INFRARED_MAX_GAP_MS,
  LIGHTNING_MAX_GAP_MS,
} from './clock.js';
import { formatUtcDayMonth, t, msg } from '../../i18n/index.js';
import { formatScaleLabel } from '../../ui/unitLabels.js';

/**
 * A stored (English) failure in the language. HTTP failures from source.js
 * and infraredImage.js carry their status in the text, so they are matched
 * back onto a placeholder; anything else is a plain catalog key.
 */
function presentWeatherProblem(problem) {
  const http = /^Weather (image )?HTTP (\d+)$/.exec(problem);
  if (http) {
    return http[1]
      ? t('Weather image HTTP {status}', { status: http[2] })
      : t('Weather HTTP {status}', { status: http[2] });
  }
  return t(problem);
}

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
  value
    ? `${formatUtcDayMonth(value)} ${value.slice(11, 16)} UTC`
    : t('Unavailable');

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
  let infrared = 100;
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
      error = ok
        ? null
        : msg('Frame unavailable; previous observation retained');
      if (!ok) stop();
      return ok;
    } catch {
      if (owner === generation && !controller.signal.aborted) {
        error = msg('Weather imagery unavailable');
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
      if (!removeCamera) {
        removeCamera = viewer.camera.moveEnd?.addEventListener(() => {
          checkHost();
          notify();
        });
      }
      registerClock();
    },
    disable() {
      enabled = false;
      removeCamera?.();
      removeCamera = null;
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
          return enabled && !signal?.aborted && request !== controller;
        if (snapshot.unavailable) {
          error = msg(
            'Weather source unavailable; previous observation retained',
          );
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
            enabled &&
            !signal?.aborted &&
            (!controller.signal.aborted || request !== controller)
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
        return (
          enabled &&
          !signal?.aborted &&
          (!controller.signal.aborted || request !== controller)
        );
      } catch (cause) {
        if (controller.signal.aborted || request !== controller)
          return enabled && !signal?.aborted && request !== controller;
        error = cause?.message || msg('Weather unavailable');
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
      const nextInfrared = satellite
        ? params.infrared === 'full'
          ? 0
          : params.infrared === 'filtered'
            ? 100
            : params.infrared
        : null;
      const infraredChanged =
        satellite &&
        Number.isInteger(nextInfrared) &&
        nextInfrared >= 0 &&
        nextInfrared <= 100 &&
        nextInfrared !== infrared;
      if (infraredChanged) infrared = nextInfrared;
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
          ? maxGap() / 60_000 < 60
            ? t('No frame within {gap} min of {time}', {
                gap: maxGap() / 60_000,
                time: utc(shared.target),
              })
            : t('No frame within {gap} h of {time}', {
                gap: maxGap() / 3600_000,
                time: utc(shared.target),
              })
          : null;
      const time = shownTime();
      const relation =
        shared?.mode === 'history' && time
          ? Date.parse(time) === Date.parse(shared.target)
            ? 'synced'
            : Date.parse(time) < Date.parse(shared.target)
              ? 'nearest'
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
            ? t('{hours}h {minutes}m ago', {
                hours: Math.floor(age / 60),
                minutes: age % 60,
              })
            : t('{minutes}m ago', { minutes: age });
      const diagnostic = rendering?.getDiagnostics();
      // Errors are stored in English (stats, diagnostics); shown translated.
      const problem = error || diagnostic?.error;
      const shownProblem = problem ? presentWeatherProblem(problem) : null;
      const shownHost = hostStatus ? t(hostStatus) : null;
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
      let detail = time
        ? t('{state} · {time} · {lag}', {
            state: followLatest ? t('Observed') : t('History'),
            time: utc(time),
            lag,
          })
        : missing
          ? t('Observation unavailable')
          : t('Waiting for observation');
      if (relation === 'synced') detail = t('{detail} · synced', { detail });
      else if (relation === 'nearest')
        detail = t('{detail} · nearest', { detail });
      const infoHeading = radar
        ? t('RADAR REFLECTIVITY · dBZ')
        : lightning
          ? t('LIGHTNING DENSITY · 15 min accumulation')
          : product === 'clouds'
            ? t('GLOBAL INFRARED · hourly')
            : t('GOES INFRARED · ~5 min');
      const infoTime = time
        ? `${t('{state}: {time}', {
            state: followLatest ? t('Latest observation') : t('History'),
            time: utc(time),
          })}\n${[
            lag,
            current && !followLatest
              ? t('frame {index}/{total}', {
                  index: index + 1,
                  total: times.length,
                })
              : '',
            loading ? t('loading') : '',
          ]
            .filter(Boolean)
            .join(' · ')}`
        : [t('Observation: unavailable'), loading ? t('loading') : '']
            .filter(Boolean)
            .join(' · ');
      const infoCoverage = radar
        ? t('Contiguous US · gaps ≠ no rain')
        : lightning
          ? `${t('Americas + Pacific · not individual strikes')}\n${t('Color: strikes/km²/min ×10³')}`
          : product === 'clouds'
            ? t('60°S–60°N · typically 2–3 h delayed')
            : t('North America · infrared imagery');
      const infoMotion = motion?.matches
        ? clock
          ? t('Reduced motion · history playback unavailable')
          : t('Reduced motion · manual history available')
        : '';
      const controls = {
        readout: true,
        summary: {
          label: radar
            ? t('Rain radar · US')
            : lightning
              ? t('Lightning density · 15 min')
              : t('Satellite clouds'),
          coverage: radar
            ? 'CONUS'
            : lightning
              ? t('Americas + Pacific')
              : product === 'clouds'
                ? t('Global · 60°S–60°N')
                : t('North America'),
          shownTime: time,
          maxGapMinutes: maxGap() / 60_000,
          detail,
          status:
            missing ||
            shownHost ||
            shownProblem ||
            (observationDelayed()
              ? t('Source observations delayed')
              : manifest?.stale
                ? t('Stale source')
                : loading
                  ? t('Loading next frame…')
                  : outside
                    ? t('Map center outside coverage')
                    : null),
          units: radar ? 'dBZ' : lightning ? t('strikes/km²/min ×10³') : '',
        },
        chips: [
          ...(satellite
            ? [
                ['clouds-regional', t('N. America')],
                ['clouds', t('Global')],
              ].map(([value, label]) => ({
                id: value,
                label,
                active: product === value,
                params: { product: value },
                title:
                  value === 'clouds'
                    ? t('Hourly global mosaic; usually 2–3 hours delayed')
                    : t('GOES regional clouds; approximately 5-minute updates'),
              }))
            : []),
          ...(satellite
            ? [
                {
                  id: 'filtered',
                  label: t('Clouds only'),
                  active: infrared === 100,
                  params: { infrared: 100 },
                  title: t(
                    'Apply the full cloud brightness key; 100% filter strength',
                  ),
                },
                {
                  id: 'full',
                  label: t('Full'),
                  active: infrared === 0,
                  params: { infrared: 0 },
                  title: t(
                    'Show the complete infrared image; 0% filter strength',
                  ),
                },
              ]
            : []),
          ...['light', 'strong'].map((value) => ({
            id: `opacity-${value}`,
            label: value === 'light' ? t('Soft') : t('Vivid'),
            active: opacity === value,
            params: { opacity: value },
            title: t('Image opacity; does not alter the observed values'),
          })),
          {
            id: 'coverage',
            label: radar
              ? t('View US radar')
              : lightning
                ? t('View Americas & Pacific')
                : t('View coverage'),
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
                  ? t('{value} strikes/km²/min ×10³ (15-minute density)', {
                      value: formatScaleLabel(label),
                    })
                  : t('{value} dBZ radar reflectivity', {
                      value: formatScaleLabel(label),
                    }),
              }))
            : [],
        info: hostHidden
          ? shownHost
          : `${infoHeading}\n${infoTime}${missing ? `\n${missing}` : ''}${manifest?.stale ? `\n${t('STALE · cached source metadata')}` : ''}${shownProblem ? `\n${shownProblem}` : ''}\n${infoCoverage}${outside ? `\n${t('Map center is outside source coverage')}` : ''}${infoMotion ? `\n${infoMotion}` : ''}`,
        infoTitle: lightning
          ? t(
              'NOAA/NWS 15-minute lightning density derived from Vaisala NLDN/GLD360. Coverage 110°E across the Pacific/Americas to 0°, 25°S–80°N. Not a live strike count, global coverage or a safety warning.',
            )
          : radar
            ? t(
                'NOAA MRMS radar echoes indicate precipitation patterns, not rain rate, a storm warning or a future forecast. Native source approximately 1 km; display is limited to level 6. Frames use exact advertised observation times.',
              )
            : t(
                'GOES-19/18 longwave infrared Band 14 regional; NESDIS global longwave mosaic. Clouds only dims everything but bright, cold cloud tops; a brightness filter, not a cloud mask. Coverage and freshness differ by region.',
              ),
      };
      controls.summary.settings = [
        ...(satellite
          ? [
              {
                id: 'region',
                label: t('REGION'),
                chips: controls.chips.filter(({ params }) => params.product),
              },
              {
                id: 'image',
                label: t('IMAGE'),
                chips: controls.chips.filter(
                  ({ params }) => params.infrared !== undefined,
                ),
                range: {
                  id: 'cloud-filter',
                  param: 'infrared',
                  min: 0,
                  max: 100,
                  step: 1,
                  value: infrared,
                  label: t('FILTER'),
                  unit: '%',
                  ariaLabel: t('Cloud filter strength'),
                  commitOnChange: true,
                },
              },
            ]
          : []),
        {
          id: 'opacity',
          label: t('OPACITY'),
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
        countLabel: isLatest() ? t('Observed') : t('History'),
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
