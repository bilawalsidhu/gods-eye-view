import * as Cesium from 'cesium';
import { createBomRendering } from './rendering.js';
import { BOM_RADAR_OFF_MESSAGE, createBomRadarSource } from './source.js';
import { pickBomProduct, bomRangeLabel } from './select.js';
import { maskBomFurniture } from './records.js';
import { imageryHostStatus } from '../weather/imageryHost.js';
import { decodeInfraredImage } from '../weather/infraredImage.js';
import { msg, t, translateKnown } from '../../i18n/index.js';

/** Each frame shows this long; the newest one holds longer before the loop restarts. */
export const BOM_FRAME_MS = 500;
export const BOM_HOLD_MS = 1500;
const RESELECT_DEBOUNCE_MS = 1000;
const PRODUCTS_RETRY_MS = 5000;
const FETCH_CONCURRENCY = 4;
const MAX_IMAGE_EDGE = 2048;
// BoM publishes about every 5-6 minutes; much older means the feed has stalled.
const DELAYED_AFTER_MS = 30 * 60_000;
const OPACITY = { light: 0.45, strong: 0.85 };

// Approximate rain-rate colours, light to extreme; the images carry their own.
const LEGEND = [
  [msg('Light'), '#7878ff', msg('Light rain')],
  [msg('Moderate'), '#009690', msg('Moderate rain')],
  [msg('Heavy'), '#ffc800', msg('Heavy rain')],
  [msg('Very heavy'), '#ff6400', msg('Very heavy rain')],
  [msg('Extreme'), '#c80000', msg('Extreme rain rates')],
];
const BOM_NAME = 'Bureau of Meteorology';

/**
 * `02:39 ACDT`: a UTC epoch in the viewer's own time zone (the browser's
 * default, or `timeZone` when given), with its zone abbreviation. The layer
 * covers all of Australia, so no single local zone would suit every radar.
 */
export function formatLocalTime(timeMs, timeZone) {
  if (!Number.isFinite(timeMs)) return t('Unavailable');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-AU', {
      ...(timeZone ? { timeZone } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
      .formatToParts(new Date(timeMs))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

const ageText = (timeMs, nowMs) => {
  const minutes = Math.max(0, Math.floor((nowMs - timeMs) / 60_000));
  return minutes >= 60
    ? t('{hours} h {minutes} min ago', {
        hours: Math.floor(minutes / 60),
        minutes: minutes % 60,
      })
    : t('{minutes} min ago', { minutes });
};

async function mapPool(items, limit, worker) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await worker(queue.shift());
    }),
  );
}

function releaseCanvas(canvas) {
  // Drop the backing store now rather than at garbage collection.
  if (canvas && 'width' in canvas) canvas.width = canvas.height = 0;
}

/**
 * Opt-in Bureau of Meteorology rain-radar loop for Australia.
 *
 * Frames come from the operator's own local server (BOM_RADAR_ENABLED=1) and
 * are never persisted. The layer picks the nearest radar to the view centre,
 * with a range that suits the camera altitude, preloads up to 12 frames and
 * then animates them: stacked imagery layers on a globe, a raised shell on
 * Google 3D Tiles.
 * @param {object} [options]
 * @param {object} [options.source] Browser source (`getStatus`, `getProducts`,
 *   `getFrames`, `getFrameImage`).
 * @param {{registerDynamicCredit: Function, BOM_RADAR_CREDIT: object}} [options.credits]
 */
export function createBomRadarLayer({
  source = createBomRadarSource(),
  credits = null,
  cesium = Cesium,
  createRendering = createBomRendering,
  decodeImage = decodeInfraredImage,
  createCanvas = () => document.createElement('canvas'),
  now = () => Date.now(),
  timeZone = undefined,
  documentRef = globalThis.document,
  eventTarget = globalThis.window,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  for (const method of [
    'getStatus',
    'getProducts',
    'getFrames',
    'getFrameImage',
  ])
    if (typeof source?.[method] !== 'function')
      throw new TypeError('BoM radar requires a radar source');

  let viewer = null;
  let rendering = null;
  let listener = null;
  let enabled = false;
  let off = false;
  let loading = false;
  let error = null;
  let status = null;
  let opacity = 'strong';
  let looping = true;
  let radars = [];
  let productsComplete = false;
  let productsStale = false;
  let manifest = null;
  let pick = null;
  const images = new Map();
  let shownIndex = -1;
  let request = null;
  let generation = 0;
  let loopTimer = null;
  let reselectTimer = null;
  let retryTimer = null;
  let removeCamera = null;
  let motion = null;
  let imageryHost = null;
  let runNavigation = null;
  let hostCollection;
  let hostHidden = false;
  let creditShown = false;

  const notify = () => listener?.();
  const getHost = () =>
    imageryHost?.() ?? { collection: viewer?.imageryLayers, kind: 'globe' };
  const suspended = () => hostHidden || documentRef?.hidden || motion?.matches;
  const frames = () => manifest?.frames ?? [];
  const shownFrame = () => frames()[shownIndex] ?? null;

  function stopLoop() {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  function show(index) {
    const frame = frames()[index];
    if (!frame || !rendering) return;
    shownIndex = index;
    rendering.show(frame.file);
    if (!creditShown && credits) {
      creditShown = true;
      credits.registerDynamicCredit(viewer, credits.BOM_RADAR_CREDIT);
    }
    notify();
  }
  function step() {
    loopTimer = null;
    const count = frames().length;
    if (!enabled || count < 2 || suspended() || !looping) return;
    show((shownIndex + 1) % count);
    loopTimer = setTimeout(
      step,
      shownIndex === count - 1 ? BOM_HOLD_MS : BOM_FRAME_MS,
    );
  }
  /** Resume from the shown frame; a paused or reduced-motion view rests on the newest. */
  function startLoop() {
    stopLoop();
    const count = frames().length;
    if (!enabled || !count || hostHidden) return;
    if (count < 2 || !looping || suspended()) {
      if (shownIndex < 0 || !looping || motion?.matches) show(count - 1);
      return;
    }
    if (shownIndex < 0) show(0);
    loopTimer = setTimeout(
      step,
      shownIndex === count - 1 ? BOM_HOLD_MS : BOM_FRAME_MS,
    );
  }

  function checkHost() {
    if (!viewer || !rendering) return;
    const host = getHost();
    const next = imageryHostStatus(host);
    const changed = host.collection !== hostCollection || status !== next;
    hostCollection = host.collection;
    status = next;
    hostHidden = next !== null;
    if (!changed) return;
    rendering.rehome();
    if (hostHidden) stopLoop();
    else startLoop();
    notify();
  }

  /** The ground point the camera is looking at, and its altitude. */
  function cameraView() {
    const camera = viewer?.camera;
    const here = camera?.positionCartographic;
    if (!here) return null;
    const canvas = viewer.scene?.canvas;
    const point =
      canvas &&
      camera.pickEllipsoid?.(
        new cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
        viewer.scene.globe?.ellipsoid,
      );
    const ground = point
      ? cesium.Cartographic.fromCartesian(point, viewer.scene.globe?.ellipsoid)
      : here;
    return {
      view: {
        lat: cesium.Math.toDegrees(ground.latitude),
        lon: cesium.Math.toDegrees(ground.longitude),
      },
      height: here.height,
    };
  }
  function choose() {
    const camera = cameraView();
    if (!camera) return null;
    return pickBomProduct({
      radars,
      view: camera.view,
      height: camera.height,
      current: manifest?.product ?? null,
    });
  }

  function clearDisplay() {
    stopLoop();
    rendering?.clear();
    for (const canvas of images.values()) releaseCanvas(canvas);
    images.clear();
    manifest = null;
    pick = null;
    shownIndex = -1;
  }
  function goOff() {
    off = true;
    clearDisplay();
    error = BOM_RADAR_OFF_MESSAGE;
  }

  async function toCanvas(bytes, signal) {
    const bitmap = await decodeImage(
      new Blob([bytes], { type: 'image/png' }),
      signal,
    );
    try {
      if (
        !(bitmap.width > 0 && bitmap.height > 0) ||
        bitmap.width > MAX_IMAGE_EDGE ||
        bitmap.height > MAX_IMAGE_EDGE
      )
        throw new Error('BoM radar frame has unexpected dimensions');
      const canvas = createCanvas();
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      // Both hosts draw this canvas, so the image's own title bar and caption
      // are hidden once here.
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      maskBomFurniture(pixels.data, canvas.width, canvas.height);
      context.putImageData(pixels, 0, 0);
      return canvas;
    } finally {
      bitmap.close?.();
    }
  }

  /**
   * Fetch and decode the frames not already held. Frames no longer listed are
   * returned as `discard`: their imagery layers may still be drawing them, so
   * they are released only once the renderer has been reconciled.
   */
  async function loadFrames(payload, signal) {
    const wanted = new Set(payload.frames.map(({ file }) => file));
    const discard = [];
    if (manifest && manifest.product !== payload.product) {
      discard.push(...images.values());
      images.clear();
    }
    await mapPool(
      payload.frames.filter(({ file }) => !images.has(file)),
      FETCH_CONCURRENCY,
      async ({ file }) => {
        try {
          const bytes = await source.getFrameImage({ file, signal });
          const canvas = await toCanvas(bytes, signal);
          // A superseded load must not repopulate a cleared layer.
          signal.throwIfAborted();
          images.set(file, canvas);
        } catch (cause) {
          if (signal.aborted || cause?.code === 'disabled') throw cause;
          // One missing frame shortens the loop; it does not end it.
        }
      },
    );
    for (const [file, canvas] of [...images]) {
      if (wanted.has(file)) continue;
      discard.push(canvas);
      images.delete(file);
    }
    return {
      usable: payload.frames.filter(({ file }) => images.has(file)),
      discard,
    };
  }

  /** Show `chosen`: fetch its frames, preload them all, then start the loop. */
  async function present(chosen, controller) {
    const payload = await source.getFrames({
      product: chosen.product,
      signal: controller.signal,
    });
    const { usable, discard } = await loadFrames(payload, controller.signal);
    if (controller.signal.aborted) return false;
    if (!usable.length) {
      error = msg('BoM radar frames unavailable');
      return true;
    }
    const previousFile = shownFrame()?.file;
    // A different radar or range replaces the picture: hold the old frame still
    // until the new loop has drawn rather than flashing blank frames.
    if (manifest && manifest.product !== payload.product) stopLoop();
    manifest = { ...payload, frames: usable };
    pick = chosen;
    error = null;
    shownIndex = usable.findIndex(({ file }) => file === previousFile);
    await rendering.setFrames(
      {
        bounds: payload.bounds,
        frames: usable.map(({ file, timeMs }) => ({ key: file, time: timeMs })),
        images,
      },
      { signal: controller.signal },
    );
    for (const canvas of discard) releaseCanvas(canvas);
    if (controller.signal.aborted) return false;
    startLoop();
    return true;
  }

  function begin(signal) {
    request?.abort();
    const controller = new AbortController();
    if (signal?.aborted) controller.abort(signal.reason);
    request = controller;
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    loading = true;
    notify();
    return {
      controller,
      end() {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      },
    };
  }
  const current = (controller) =>
    enabled && request === controller && !controller.signal.aborted;

  /** Choose a product for the current view and present it. */
  async function select(controller) {
    const chosen = choose();
    if (!chosen) {
      // Nothing reaches the view centre: show nothing rather than a far radar.
      clearDisplay();
      error = null;
      notify();
      return true;
    }
    return present(chosen, controller);
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (!enabled || productsComplete) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!enabled) return;
      // A request still in flight (a preload, say) must not swallow the retry.
      if (request) scheduleRetry();
      else void layer.update(viewer);
    }, PRODUCTS_RETRY_MS);
  }
  function scheduleReselect() {
    clearTimeout(reselectTimer);
    reselectTimer = null;
    if (!enabled || off || !radars.length) return;
    reselectTimer = setTimeout(async () => {
      reselectTimer = null;
      if (!enabled || off) return;
      if (request) return scheduleReselect();
      const next = choose();
      if (next?.product === manifest?.product) return;
      const run = begin();
      try {
        await select(run.controller);
      } catch (cause) {
        if (current(run.controller))
          error = cause?.message || msg('BoM radar unavailable');
      } finally {
        run.end();
      }
    }, RESELECT_DEBOUNCE_MS);
  }

  const delayed = () => {
    const newest = frames().at(-1);
    return Boolean(newest && now() - newest.timeMs > DELAYED_AFTER_MS);
  };

  const layer = {
    id: 'bom-radar',
    name: 'AU rain radar',
    icon: '◉',
    source: 'Bureau of Meteorology · OBSERVED',
    updateInterval: 120_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({
        viewer,
        cesium,
        getHost,
        onChange: notify,
        createCanvas,
      });
      rendering.setAlpha(OPACITY[opacity]);
      checkHost();
      eventTarget?.addEventListener?.('gev:map-stack-changed', checkHost);
      motion = matchMedia?.('(prefers-reduced-motion: reduce)');
      motion?.addEventListener?.('change', onVisibility);
      documentRef?.addEventListener?.('visibilitychange', onVisibility);
      removeCamera = viewer.camera.moveEnd?.addEventListener(() => {
        checkHost();
        scheduleReselect();
        if (enabled) notify();
      });
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
    },
    disable() {
      enabled = false;
      ++generation;
      request?.abort();
      request = null;
      clearTimeout(reselectTimer);
      clearTimeout(retryTimer);
      reselectTimer = retryTimer = null;
      clearDisplay();
      radars = [];
      productsComplete = false;
      productsStale = false;
      off = false;
      loading = false;
      error = null;
      shownIndex = -1;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      checkHost();
      const run = begin(signal);
      const { controller } = run;
      try {
        controller.signal.throwIfAborted();
        const feature = await source.getStatus({ signal: controller.signal });
        if (!current(controller)) return false;
        if (!feature.enabled) {
          goOff();
          return true;
        }
        off = false;
        const products = await source.getProducts({
          signal: controller.signal,
        });
        if (!current(controller)) return false;
        radars = products.radars;
        productsComplete = products.complete;
        productsStale = products.stale;
        scheduleRetry();
        const ok = await select(controller);
        return ok && current(controller);
      } catch (cause) {
        if (!current(controller)) return false;
        if (cause?.code === 'disabled') {
          goOff();
          return true;
        }
        // Keep the last loop on screen when a refresh fails.
        error = cause?.message || msg('BoM radar unavailable');
        return true;
      } finally {
        run.end();
      }
    },
    setParams(params = {}) {
      if (Object.hasOwn(OPACITY, params.opacity)) {
        opacity = params.opacity;
        rendering?.setAlpha(OPACITY[opacity]);
      }
      if (params.play === true) {
        looping = !looping;
        if (looping) startLoop();
        else stopLoop();
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
      notify();
    },
    getParams() {
      return { opacity };
    },
    getRowControls() {
      const frame = shownFrame();
      const count = frames().length;
      const place = manifest
        ? [
            manifest.name ??
              (pick?.radarId
                ? t('Radar {id}', { id: pick.radarId })
                : t('Radar')),
            bomRangeLabel(manifest.rangeKm),
          ]
            .filter(Boolean)
            .join(' ')
        : null;
      const lines = [];
      if (off) lines.push(t('Off · personal use only'));
      else if (frame && place) {
        lines.push(
          `${place} · ${formatLocalTime(frame.timeMs, timeZone)} · ${ageText(frame.timeMs, now())}`,
          loading
            ? t('Frame {index}/{count} · loading', {
                index: shownIndex + 1,
                count,
              })
            : t('Frame {index}/{count}', { index: shownIndex + 1, count }),
        );
      } else
        lines.push(
          loading
            ? t('Loading radar…')
            : !productsComplete && !off
              ? t('Locating radars…')
              : radars.length
                ? t(
                    'No BoM radar reaches the view centre · move closer to an Australian radar',
                  )
                : t('Waiting for radar locations'),
        );
      if (!productsComplete && frame && !off) lines.push(t('Locating radars…'));
      if (manifest?.stale || productsStale)
        lines.push(t('STALE · last known radar listing'));
      if (delayed()) lines.push(t('Radar frames delayed'));
      const note = status || error;
      if (note) lines.push(translateKnown(note));
      lines.push(t('{source} · personal use only', { source: BOM_NAME }));
      return {
        chips: [
          {
            id: 'play',
            label: looping ? t('Pause') : t('Loop'),
            active: looping && !motion?.matches,
            disabled: count < 2 || Boolean(motion?.matches),
            params: { play: true },
            title: t('Animate the last frames of the radar loop'),
          },
          ...['light', 'strong'].map((value) => ({
            id: `opacity-${value}`,
            label: value === 'light' ? t('Soft') : t('Vivid'),
            active: opacity === value,
            params: { opacity: value },
            title: t('Image opacity; does not alter the observed values'),
          })),
          {
            id: 'coverage',
            label: t('View radar'),
            disabled: !manifest || !runNavigation,
            params: { focus: true },
          },
        ],
        legend: LEGEND.map(([label, color, blurb]) => ({
          label: t(label),
          color,
          blurb: t(
            '{blurb} (approximate colours; the radar image carries the exact scale)',
            { blurb: t(blurb) },
          ),
        })),
        info: lines.join('\n'),
        infoTitle: t(
          'Bureau of Meteorology rain radar, fetched live by this server over anonymous FTP. BoM allows personal or in-organisation use only: no redistribution, no public deployment. Frame times are shown in your own time zone. Images are georeferenced by their corner coordinates; the longest-range products can misregister by a few kilometres. Radar echoes are observed rainfall, not a forecast or warning.',
        ),
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      const newest = frames().at(-1);
      return {
        count: frames().length,
        countLabel: manifest
          ? bomRangeLabel(manifest.rangeKm) || t('Radar')
          : '—',
        lastUpdate: newest?.timeMs ?? null,
        loading,
        error: error || rendering?.getDiagnostics().error || null,
        stale: Boolean(manifest?.stale || productsStale || delayed()),
        source: 'Bureau of Meteorology',
        observedAt: newest ? new Date(newest.timeMs).toISOString() : null,
      };
    },
    getDiagnostics() {
      return {
        ...rendering?.getDiagnostics(),
        product: manifest?.product ?? null,
        radar: pick?.radarId ?? null,
        frames: frames().length,
        residentImages: images.size,
        shown: shownFrame()?.file ?? null,
        playing: looping && loopTimer !== null,
        off,
      };
    },
    destroy() {
      layer.disable();
      removeCamera?.();
      removeCamera = null;
      motion?.removeEventListener?.('change', onVisibility);
      documentRef?.removeEventListener?.('visibilitychange', onVisibility);
      eventTarget?.removeEventListener?.('gev:map-stack-changed', checkHost);
      runNavigation = null;
      imageryHost = null;
      viewer = null;
      rendering = null;
      listener = null;
    },
  };
  function onVisibility() {
    if (suspended()) stopLoop();
    else startLoop();
    notify();
  }
  return layer;
}
