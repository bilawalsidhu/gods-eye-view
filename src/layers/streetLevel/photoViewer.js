import {
  createPanoramaRenderer,
  PANO_FOV_DEFAULT_DEG,
  wrapDegrees,
} from './panorama.js';
import { imageSize } from './imageSize.js';
import { nextViewKey } from './photoViewers.js';
import { msg, t } from '../../i18n/index.js';

// Each mount's and each canvas's key comes from `nextViewKey()`, never
// reused by any viewer: a view that sees one viewer unmount and another
// mount in the same tick still draws them fresh elements (a destroyed
// renderer leaves its canvas's context lost).

/**
 * EXPAND puts the viewer's wrap full screen, or (iPhone) opens it as a
 * popover. Each is tried on its own: a browser that cannot parse one
 * (Safari before 16.4) throws on the selector.
 */
const EXPANDED_SELECTORS = [
  '.sl-viewer-wrap:fullscreen',
  '.sl-viewer-wrap:popover-open',
];

/** A photo download (tens of kilobytes to a few megabytes). */
const IMAGE_TIMEOUT_MS = 15_000;

/** A picture file or decoded side past these is refused (a photo is a few MB). */
export const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 16_384;
/** 64 MP: 256 MB once decoded to RGBA. A 16,384 px square is four times that. */
const MAX_IMAGE_PIXELS = 8_192 * 8_192;
/** Where in a file to look for its dimensions (a JPEG's EXIF comes first). */
const HEADER_BYTES = 256 * 1024;

/** Whether a picture this size is past what the viewer decodes. */
function tooManyPixels(width, height) {
  return (
    width > MAX_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE ||
    width * height > MAX_IMAGE_PIXELS
  );
}

/** Panorama texture widths: enough for a docked viewer, and for an expanded one. */
const PANO_MID_SIZE = Object.freeze([2048, 1024]);
export const PANO_FULL_SIZE = Object.freeze([4096, 2048]);

/**
 * Load an image within the timeout. A CORS-clean one (for WebGL) is decoded
 * off the main thread into an ImageBitmap where the browser can: uploading
 * a decoded bitmap costs a fraction of uploading an <img> (90 ms → 15 ms for
 * 4096×2048 on a phone-class CPU). `resize` shrinks a bitmap while decoding
 * it (a panorama larger than any texture the viewer uploads).
 * @param {string} url
 * @param {{crossOrigin?: boolean, timeoutMs?: number, resize?: [number, number]|null, failure?: string}} [options]
 */
export function loadImage(
  url,
  {
    crossOrigin = true,
    timeoutMs = IMAGE_TIMEOUT_MS,
    resize = null,
    failure = msg('The photo could not be loaded'),
    signal = null,
  } = {},
) {
  if (
    crossOrigin &&
    url &&
    typeof globalThis.createImageBitmap === 'function' &&
    typeof globalThis.fetch === 'function'
  )
    return loadBitmap(url, timeoutMs, resize, failure, signal);
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error(failure));
    if (signal?.aborted) return reject(new Error(failure));
    const image = new Image();
    if (crossOrigin) image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    // Stop the download: another photo opened, or the time ran out.
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', stop);
      image.onload = image.onerror = null;
      image.src = '';
      reject(new Error(failure));
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener?.('abort', stop, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', stop);
    };
    image.onload = () => {
      settle();
      // An <img> reads no header first: refuse what it decoded too large.
      if (tooManyPixels(image.naturalWidth || 0, image.naturalHeight || 0)) {
        image.src = '';
        reject(oversized(failure));
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      settle();
      reject(new Error(failure));
    };
    image.src = url;
  });
}

async function loadBitmap(url, timeoutMs, resize, failure, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The caller's abort (the photo changed) stops a multi-megabyte download.
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      mode: 'cors',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(failure);
    // Picture hosts are not ours: refuse a file or an image past any real
    // photo's size before it is decoded.
    const length = Number(response.headers?.get?.('content-length'));
    if (length > MAX_IMAGE_BYTES) throw oversized(failure);
    const blob = await boundedBlob(response, failure);
    // Its declared size, before anything decodes it.
    const size = imageSize(
      new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()),
    );
    if (size && tooManyPixels(size.width, size.height))
      throw oversized(failure);
    const bitmap = await (resize
      ? createImageBitmap(blob, {
          resizeWidth: resize[0],
          resizeHeight: resize[1],
          resizeQuality: 'high',
        })
      : createImageBitmap(blob));
    // (A resized decode reports its new size: this guards unresized ones.)
    if (tooManyPixels(bitmap.width, bitmap.height)) {
      bitmap.close?.();
      throw oversized(failure);
    }
    return bitmap;
  } catch (error) {
    // A size refusal stays one: the viewer must not fetch it another way.
    if (error?.tooLarge) throw error;
    throw new Error(failure);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Unmounted, superseded or left without a view before the view drew what
 * was waiting on it (`undrawn`): a mount or an open that fails as closed.
 */
function undrawn() {
  return Object.assign(new Error('Street-level viewer was closed'), {
    undrawn: true,
  });
}

/**
 * A picture refused for its size (`tooLarge`): the viewer will not load
 * that file another way, an <img> having no size limit at all.
 */
function oversized(failure) {
  return Object.assign(new Error(failure), { tooLarge: true });
}

/**
 * The body as a Blob, read with a running count so a host that sends no
 * length (or a false one) cannot fill memory before the cap is checked.
 */
async function boundedBlob(response, failure) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw oversized(failure);
    return blob;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      reader.cancel().catch(() => {});
      throw oversized(failure);
    }
    chunks.push(value);
  }
  return new Blob(chunks, {
    type: response.headers?.get?.('content-type') || 'image/jpeg',
  });
}

/** The panorama size a canvas this wide can show sharply at this field of view. */
export function panoSizeFor(canvasPixels, fovDeg) {
  const needed = (Math.max(1, canvasPixels) * 360) / Math.max(1, fovDeg);
  return needed > PANO_MID_SIZE[0] ? PANO_FULL_SIZE : PANO_MID_SIZE;
}

/**
 * @typedef {object} PhotoSources   Where a provider's photo comes from.
 * @property {(photo: object) => boolean} hasPano   A 360° photo with an equirectangular image.
 * @property {(photo: object) => {url: string, width: number, resize?: [number, number]|null}|null} panoFirst
 *   The panorama shown first, its texture width (0 when it is only a preview), and a size to shrink it to.
 * @property {(photo: object, size: [number, number], view: {expanded: boolean}) => {url: string, resize?: [number, number]|null, timeoutMs?: number}|null} panoSharp
 *   A sharper panorama for a canvas that needs `size`, or null; `expanded` while the viewer is.
 * @property {(photo: object, view: {expanded: boolean}) => Array<string>} flatFirst   Flat versions to try in turn (`expanded` while the viewer is).
 * @property {(photo: object, pixels: number) => string|null} flatSharp
 *   A sharper flat version for a picture this many device pixels wide, or null.
 * @property {(photo: object) => {title?: string|null, creator?: string|null, license?: string|null, externalUrl: string, capturedAtPrecision?: 'day'|'month'}} describe
 * @property {(photo: object) => number|null} [bearingOf]   Where the camera looked (default `photo.heading`).
 */

/**
 * Viewer adapter for providers whose photos are plain image files: a flat
 * photo in an <img>, a 360° photo on a WebGL panorama (drag to look, wheel
 * or pinch to zoom), and ‹ › to step along the sequence (also ← →). Poses
 * follow the view direction.
 *
 * The adapter draws nothing itself. It presents the viewer through
 * `subscribeView()` (the street-level layer's `subscribePhotoViewer()`): a
 * fresh `{host, mountKey, providerId, label, alt, kind, src, fit, canvasKey,
 * dragging, prevLabel, prevDisabled, nextLabel, nextDisabled, actions}` on
 * each change,
 * or null while unmounted. A view draws it into `host` (the application's is
 * `StreetLevelPhotoViewer`), forwards its events to `actions` and hands each
 * element back through `actions.attach(name, element)` on every draw: the
 * panorama canvas to draw on, the frame and picture to measure, the root
 * and buttons to keep focus. A view may draw at once, inside its listener,
 * or later (Vue draws on a microtask). Each mount has its own `mountKey`,
 * and a new `canvasKey` asks for a fresh canvas (a lost WebGL context):
 * neither is ever reused. `actions.supersede()` tells a viewer another one
 * is drawn in its place: it unmounts, and a mount still waiting to be drawn
 * fails as closed. Mounting with no view subscribed fails, and a mount or
 * a panorama's open waiting on a draw when the last view leaves fails as
 * closed (the mount unmounts; the open leaves no photo shown). A view
 * handing back another canvas element than the renderer's (one subscribed
 * since) gets the panorama drawn again on it, as after a lost context;
 * while several views draw, a canvas the panorama moved off is not moved
 * back to, and once one view is left its canvas is taken back.
 *
 * Photos are normalized by the provider: `{id, sequenceId, lon, lat,
 * heading, isPano, capturedAt}` plus whatever its `sources` read.
 *
 * @param {object} options
 * @param {string} options.providerId
 * @param {string} options.name   Provider name for labels and messages, e.g. 'KartaView'.
 * @param {PhotoSources} options.sources
 * @param {(photoId: string) => Promise<object>} options.getPhoto   A normalized photo.
 * @param {(photo: object, delta: -1|1) => Promise<string|null>} options.step   The photo `delta` along the sequence, or null at its end.
 * @param {(imageId: string) => void} options.onStep   Open the photo ‹ › chose (through the core, so loading and errors show).
 * @param {(photo: object) => void} [options.onShown]   A photo is on screen.
 * @param {(photo: object) => void} [options.onShowing]   The photo this open shows, just before its pose.
 * @param {(imageId: string) => void} [options.onReopen]   Draw the same photo again after a GPU reset (default: `onStep`).
 * @param {() => boolean} [options.onEscape]   Esc in the docked viewer: true when it was used (e.g. a selection cleared).
 * @param {object} [options.render]   Render governor.
 * @param {(url: string, options?: object) => Promise<HTMLImageElement|ImageBitmap>} [options.load]
 * @param {(canvas: HTMLCanvasElement) => object} [options.createRenderer]
 * @returns {import('./registry.js').ViewerAdapter}
 */
export function createPhotoViewer({
  providerId,
  name,
  sources,
  getPhoto,
  step,
  onStep,
  onShown = () => {},
  onShowing = () => {},
  onReopen = onStep,
  onEscape = () => false,
  render,
  load = loadImage,
  createRenderer = createPanoramaRenderer,
}) {
  const LOAD_FAILED = `The ${name} photo could not be loaded`;
  const listeners = new Set();
  /** The elements the view handed back. */
  let root = null;
  let picture = null;
  let canvas = null;
  let prevButton = null;
  let nextButton = null;
  /** What the view draws; null while unmounted. */
  let presented = null;
  const viewListeners = new Set();
  /** Waiting for the view's root (a mount), or its canvas: a fresh one, or the next draw. */
  const rootWaiters = new Set();
  const canvasWaiters = new Set();
  /** How many times the view has handed the canvas back (once per draw). */
  let canvasDraws = 0;
  /**
   * Canvases the panorama moved off while more than one view draws: one
   * handed back again (a second view drawing its own) is not moved back to,
   * so two views cannot take turns. Forgotten once a single view is left,
   * so its canvas is taken back.
   */
  let retiredCanvases = new WeakSet();
  /** The canvas moved while an open waited on its draw. */
  let canvasMoved = false;
  let renderer = null;
  /** WebGL failed once: 360° photos show their front view instead. */
  let rendererFailed = false;
  let photo = null;
  /** What shows: 'flat', 'pano' or null. */
  let showing = null;
  let openSeq = 0;
  let renderMode = 'letterbox';
  let drag = null;
  let poseFrame = 0;
  let removeListeners = [];
  /** A context loss's look direction, for the reopen of that photo. */
  let restoreView = null;
  /** The panel's viewer box, where Esc is listened for (null: the root). */
  let escapeTarget = null;
  /** Width of the panorama texture on screen (0: the preview). */
  let panoWidth = 0;
  /** The sharper panorama on its way, for which open (resizes come in bursts). */
  let panoComing = null;
  /** A resize came while it loaded: look again once it lands. */
  let lookAgain = false;
  /** The sharper flat version on screen, and the one on its way. */
  let flatSharp = { shown: null, loading: null };
  /** The open in progress: another open, a close or an unmount stops its downloads. */
  let openAbort = null;
  /** The photo an open is fetching: ‹ › step on from it, not the old one. */
  let openingId = null;
  /** ‹ › chose this photo: keep the panorama's look direction for it. */
  let keepViewFor = null;
  /** ‹ › presses run one after another, each from where the last one went. */
  let steps = Promise.resolve();

  /** Files refused for their size: never loaded again, by any path. */
  const refused = new Set();
  async function loadAs(url, options) {
    if (refused.has(url)) throw oversized(LOAD_FAILED);
    try {
      return await load(url, { failure: LOAD_FAILED, ...options });
    } catch (error) {
      if (error?.tooLarge) refused.add(url);
      throw error;
    }
  }

  function requestRender() {
    render?.governorRequestRender?.(`${providerId}-viewer`);
  }

  function emit() {
    if (!photo || !showing) return;
    // A lost GPU context, still being recovered: the open that redraws the
    // panorama poses once it is on screen.
    if (showing === 'pano' && !renderer) return;
    const view = showing === 'pano' ? renderer.getView() : null;
    const heading = sources.bearingOf
      ? sources.bearingOf(photo)
      : photo.heading;
    const described = sources.describe(photo);
    const pose = {
      providerId,
      imageId: photo.id,
      position: { lon: photo.lon, lat: photo.lat },
      bearing:
        heading === null || heading === undefined
          ? null
          : view
            ? wrapDegrees(heading + view.yaw)
            : heading,
      tilt: view ? view.pitch : 0,
      altitude: null,
      isPano: showing === 'pano',
      capturedAt: photo.capturedAt,
      capturedAtPrecision: described.capturedAtPrecision || 'day',
      title: described.title ?? null,
      creator: described.creator ?? null,
      license: described.license ?? null,
      sequenceId: photo.sequenceId,
      externalUrl: described.externalUrl,
    };
    for (const listener of [...listeners]) {
      try {
        listener(pose);
      } catch {
        /* listener errors are the core's to log */
      }
    }
    requestRender();
  }

  /** Re-emit on the next frame: a drag moves the view many times a frame. */
  function emitSoon() {
    if (poseFrame) return;
    poseFrame = requestAnimationFrame(() => {
      poseFrame = 0;
      emit();
    });
  }

  /** Present the viewer with `patch` applied (null: nothing to draw). */
  function present(patch) {
    if (patch === null) presented = null;
    else if (presented) presented = { ...presented, ...patch };
    else return;
    for (const listener of [...viewListeners]) listener(presented);
  }

  /** Settle everything waiting on the view (it drew, or it went). */
  function wake(waiters) {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  /** A draw of the canvas, or none coming: unmounted, no view, or the open stopped. */
  function canvasDrawn(drawn, signal) {
    if (drawn() || !presented || !viewListeners.size || signal?.aborted)
      return Promise.resolve();
    return new Promise((resolve) => {
      canvasWaiters.add(resolve);
      signal?.addEventListener?.('abort', resolve, { once: true });
    });
  }

  /** The panorama canvas once the view has drawn it, or the open stopped. */
  function canvasReady(signal) {
    return canvasDrawn(() => Boolean(canvas), signal);
  }

  /**
   * A draw of the canvas after the `count`th (it hands the canvas back each
   * time), or none coming. A view may draw synchronously, inside the
   * presentation, before anything waits: counted, that draw is not missed.
   */
  function drawnAfter(count, signal) {
    return canvasDrawn(() => canvasDraws > count, signal);
  }

  function syncButtons() {
    const enabled = Boolean(photo?.sequenceId) && showing !== null;
    present({ prevDisabled: !enabled, nextDisabled: !enabled });
    if (enabled) checkEnds(photo);
  }

  /** Disable ‹ or › at once where the sequence ends (it also warms the neighbours). */
  function checkEnds(target) {
    for (const delta of [-1, 1])
      step(target, delta).then(
        (id) => {
          if (photo === target && presented && !id) disable(delta);
        },
        () => {},
      );
  }

  /** Disable a step button, keeping keyboard focus in the viewer. */
  function disable(delta) {
    const button = delta < 0 ? prevButton : nextButton;
    if (button && button.ownerDocument?.activeElement === button)
      root?.focus?.();
    present(delta < 0 ? { prevDisabled: true } : { nextDisabled: true });
  }

  function show(kind) {
    showing = kind;
    present({ kind: kind || '' });
    syncButtons();
  }

  function applyRenderMode() {
    present({ fit: renderMode === 'fill' ? 'cover' : 'contain' });
  }

  function ensureRenderer() {
    if (renderer || rendererFailed || !canvas) return renderer;
    try {
      renderer = createRenderer(canvas);
    } catch {
      rendererFailed = true;
      renderer = null;
    }
    return renderer;
  }

  /**
   * A lost WebGL context (GPU reset, memory pressure) takes the panorama
   * with it: drop the renderer, and show the photo again on a new one.
   */
  function onContextLost(event) {
    // Only the canvas on screen: a replaced one has nothing left to lose.
    const from = event?.currentTarget ?? event?.target;
    if (from && from !== canvas) return;
    event.preventDefault?.();
    dropRenderer();
    // A lost canvas hands back its lost context: the view draws a new
    // element in its place and hands it back.
    canvas = null;
    present({ canvasKey: nextViewKey() });
    reopen();
  }

  /**
   * The view drew the panorama on another canvas element than the
   * renderer's (a view that subscribed since): the renderer cannot follow
   * it, so the photo is drawn again on a new one, as after a lost context.
   */
  function moveCanvas(element) {
    dropRenderer();
    retiredCanvases.add(canvas);
    canvas = element;
    // An open waiting on the draw goes on, on the new canvas.
    if (openingId !== null) canvasMoved = true;
    else reopen();
  }

  /** Let the renderer go, keeping the user's look for the photo's reopen. */
  function dropRenderer() {
    const lost = renderer;
    renderer = null;
    // The new renderer starts facing the photo's heading: keep the user's look.
    if (showing === 'pano' && photo && lost)
      restoreView = { id: photo.id, view: lost.getView() };
    try {
      lost?.destroy();
    } catch {
      /* already gone */
    }
  }

  /** Show the panorama again through the core, unless a newer photo is opening. */
  function reopen() {
    if (showing === 'pano' && photo && openingId === null) {
      const again = photo.id;
      show(null);
      openingId = again;
      onReopen(again);
    }
  }

  /**
   * Step along the sequence from the photo showing, or from the one on its
   * way after an earlier press, and open it through the core.
   */
  function stepBy(delta) {
    steps = steps.then(async () => {
      const fromId = openingId ?? photo?.id;
      if (!fromId || !root) return;
      let from;
      let nextId = null;
      try {
        from = await getPhoto(fromId);
        if (from.sequenceId) nextId = await step(from, delta);
      } catch {
        // Not the end of the sequence, just no answer: the press is lost.
        return;
      }
      // Closed, or another photo was opened meanwhile.
      if ((openingId ?? photo?.id) !== fromId) return;
      if (!nextId) {
        if (presented && photo?.id === fromId) disable(delta);
        return;
      }
      openingId = nextId;
      keepViewFor = nextId;
      onStep(nextId);
    });
  }

  /** Pointers on the panorama: one drags the view, two pinch the zoom. */
  const pointers = new Map();
  let pinch = null;

  function pinchSpan() {
    const [a, b] = [...pointers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  }

  function onPointerDown(event) {
    if (showing !== 'pano' || !renderer) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture?.(event.pointerId);
    if (pointers.size === 2) {
      drag = null;
      pinch = { span: pinchSpan(), fov: renderer.getView().fov };
      return;
    }
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      view: renderer.getView(),
    };
    present({ dragging: true });
  }

  function onPointerMove(event) {
    if (pointers.has(event.pointerId))
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2 && renderer) {
      renderer.setView({ fov: pinch.fov * (pinch.span / pinchSpan()) });
      return;
    }
    if (!drag || event.pointerId !== drag.id || !renderer) return;
    const { fov } = drag.view;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const vertical = fov;
    const horizontal = fov * (width / height);
    renderer.setView({
      yaw: drag.view.yaw - ((event.clientX - drag.x) / width) * horizontal,
      pitch: drag.view.pitch + ((event.clientY - drag.y) / height) * vertical,
    });
    emitSoon();
  }

  function onPointerUp(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    present({ dragging: false });
  }

  function onWheel(event) {
    if (showing !== 'pano' || !renderer) return;
    event.preventDefault();
    const { fov } = renderer.getView();
    renderer.setView({ fov: fov * Math.exp(event.deltaY * 0.001) });
  }

  /**
   * Docked, Esc anywhere in the viewer's box (the photo, its toolbar, its
   * caption) is the provider's before the panel's, which would collapse;
   * expanded, the panel's own Esc shrinks it.
   */
  function onEscapeKey(event) {
    if (
      event.key !== 'Escape' ||
      event.shiftKey ||
      event.defaultPrevented ||
      isExpanded() ||
      !onEscape()
    )
      return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onKeyDown(event) {
    if (!escapeTarget) onEscapeKey(event);
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const pano = showing === 'pano' && renderer;
    const turn = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    // Shift+← → look around a panorama; ← → step along the sequence.
    if (turn && event.shiftKey && pano) {
      event.preventDefault();
      const { yaw, fov } = renderer.getView();
      renderer.setView({ yaw: yaw + (turn * fov) / 4 });
      emitSoon();
    } else if (turn) {
      event.preventDefault();
      stepBy(turn);
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && pano) {
      event.preventDefault();
      const { pitch, fov } = renderer.getView();
      renderer.setView({
        pitch: pitch + ((event.key === 'ArrowUp' ? 1 : -1) * fov) / 6,
      });
      emitSoon();
    } else if (['+', '=', '-', '_'].includes(event.key) && pano) {
      event.preventDefault();
      const { fov } = renderer.getView();
      renderer.setView({
        fov: fov * (event.key === '+' || event.key === '=' ? 0.85 : 1 / 0.85),
      });
    }
  }

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    removeListeners.push(() =>
      target.removeEventListener(type, handler, options),
    );
  }

  /** The elements the view hands back, by name. */
  const ELEMENTS = {
    root: (element) => (root = element),
    picture: (element) => (picture = element),
    canvas: (element) => (canvas = element),
    prev: (element) => (prevButton = element),
    next: (element) => (nextButton = element),
  };

  /** Present the viewer in `host`; its view draws it and hands back its elements. */
  function build(host) {
    // Events from a view drawn for an earlier mount are not this one's.
    const current =
      (handler) =>
      (...args) => {
        if (presented?.actions === actions) handler(...args);
      };
    const actions = {
      attach(name, element) {
        if (presented?.actions !== actions || !element) return;
        const retired = name === 'canvas' && retiredCanvases.has(element);
        if (retired) {
          // Another view still draws the panorama: this draw is counted, so
          // an open waiting on it goes on, but the panorama stays put.
        } else if (
          name === 'canvas' &&
          renderer &&
          canvas &&
          element !== canvas
        )
          moveCanvas(element);
        else ELEMENTS[name]?.(element);
        if (name === 'root') wake(rootWaiters);
        if (name === 'canvas') {
          canvasDraws++;
          wake(canvasWaiters);
        }
      },
      keydown: current(onKeyDown),
      pointerdown: current(onPointerDown),
      pointermove: current(onPointerMove),
      pointerup: current(onPointerUp),
      wheel: current(onWheel),
      contextLost: current(onContextLost),
      supersede: current(() => adapter.unmount()),
      step: current((delta, event) => {
        event?.stopPropagation?.();
        stepBy(delta);
      }),
    };
    presented = {
      host,
      mountKey: nextViewKey(),
      providerId,
      label: t(
        '{name} photo. ← and → step along the sequence. On a 360° photo, drag or use Shift+← →, ↑ ↓ to look around, and + − to zoom',
        { name },
      ),
      alt: t('{name} street-level photo', { name }),
      kind: undefined,
      src: null,
      fit: renderMode === 'fill' ? 'cover' : 'contain',
      canvasKey: nextViewKey(),
      dragging: false,
      prevLabel: t('Previous photo in this sequence (←)'),
      prevDisabled: true,
      nextLabel: t('Next photo in this sequence (→)'),
      nextDisabled: true,
      actions,
    };
    present({});
    // The viewer's box in the panel; without one, the root's own handler
    // takes Esc (one listener per element and type).
    escapeTarget = host.closest?.('.sl-viewer-wrap') ?? null;
    if (escapeTarget) listen(escapeTarget, 'keydown', onEscapeKey);
  }

  function teardown() {
    pointers.clear();
    pinch = null;
    for (const remove of removeListeners) remove();
    removeListeners = [];
    escapeTarget = null;
    if (poseFrame) cancelAnimationFrame(poseFrame);
    poseFrame = 0;
    drag = null;
    renderer?.destroy();
    renderer = null;
    // The view takes its elements away.
    present(null);
    root = picture = canvas = prevButton = nextButton = null;
    wake(rootWaiters);
    wake(canvasWaiters);
    showing = null;
    photo = null;
  }

  /** Device pixels across the flat photo's frame (its longer side). */
  function viewerPixels() {
    const ratio = globalThis.devicePixelRatio || 1;
    const element = showing === 'pano' ? canvas : picture;
    const side = Math.max(
      element?.clientWidth || 0,
      element?.clientHeight || 0,
    );
    return (side || root?.clientWidth || 0) * ratio;
  }

  /** A sharper version once the first is on screen, if nothing replaced it. */
  async function upgrade(target, seq, kind) {
    // A 360° photo shown flat (no WebGL) keeps its front view.
    if (kind === 'flat' && target.isPano) return;
    // Another photo is opening: the one still shown is not worth more bytes.
    if (openingId !== null && openingId !== target.id) return;
    const signal = openAbort?.signal;
    if (kind === 'pano') {
      const size = panoSizeNow();
      if (size[0] <= panoWidth) return;
      // Resizes come in bursts while the panel animates: one load at a time
      // for this photo, and one more look once it lands.
      if (panoComing?.seq === seq) {
        lookAgain = true;
        return;
      }
      const sharp = sources.panoSharp(target, size, {
        expanded: isExpanded(),
      });
      if (!sharp?.url) return;
      const coming = { seq, width: size[0], controller: new AbortController() };
      panoComing = coming;
      lookAgain = false;
      try {
        const image = await loadAs(sharp.url, {
          crossOrigin: true,
          signal: coming.controller.signal,
          resize: sharp.resize ?? null,
          ...(sharp.timeoutMs ? { timeoutMs: sharp.timeoutMs } : {}),
        });
        if (seq !== openSeq || photo !== target || showing !== 'pano') {
          image.close?.();
          return;
        }
        if (!renderer || size[0] <= panoWidth) {
          image.close?.();
          return;
        }
        renderer.setImage(image);
        panoWidth = size[0];
        requestRender();
      } catch {
        /* the first version stays */
      } finally {
        if (panoComing === coming) {
          panoComing = null;
          if (lookAgain && seq === openSeq && photo === target) {
            lookAgain = false;
            upgrade(target, seq, 'pano');
          }
        }
      }
      return;
    }
    const url = sources.flatSharp(target, viewerPixels());
    if (!url || url === flatSharp.shown || url === flatSharp.loading) return;
    const sharp = flatSharp;
    sharp.loading = url;
    try {
      const image = await loadAs(url, { crossOrigin: false, signal });
      if (seq !== openSeq || photo !== target || showing !== 'flat') return;
      present({ src: image.src });
      sharp.shown = url;
      requestRender();
    } catch {
      /* the first version stays; a later resize may try again */
    } finally {
      // Discarded or failed: nothing is on its way, so it may be asked again.
      if (sharp.loading === url) sharp.loading = null;
    }
  }

  /** The viewer is expanded (full screen, or the iPhone popover), not docked in the panel. */
  function isExpanded() {
    return EXPANDED_SELECTORS.some((selector) => {
      try {
        return Boolean(root?.closest?.(selector));
      } catch {
        return false;
      }
    });
  }

  /** Another photo, or none: a sharper panorama still on its way is not needed. */
  function dropSharpPanorama() {
    panoComing?.controller?.abort();
    panoComing = null;
    lookAgain = false;
  }

  /** The sharp panorama this viewer needs now: 2,048 docked, 4,096 expanded. */
  function panoSizeNow() {
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    // The canvas fills the frame; until the view shows it, it measures 0.
    const width = (canvas?.clientWidth || root?.clientWidth || 0) * ratio;
    return panoSizeFor(width, renderer?.getView().fov ?? PANO_FOV_DEFAULT_DEG);
  }

  async function showPano(target, seq, keepView, signal) {
    // If the panorama fails, the caller shows the front view rather than
    // waiting on it twice.
    const first = sources.panoFirst(target);
    if (!first?.url) throw new Error(LOAD_FAILED);
    const image = await loadAs(first.url, {
      crossOrigin: true,
      signal,
      // Never decoded at more than the texture it becomes.
      resize: first.resize ?? PANO_MID_SIZE,
    });
    if (seq !== openSeq) {
      image.close?.();
      return false;
    }
    // The context may have been lost while this loaded: build on the new
    // canvas, or let the caller show the front view.
    if (!ensureRenderer()) {
      image.close?.();
      throw new Error(LOAD_FAILED);
    }
    const restore = restoreView?.id === target.id ? restoreView.view : null;
    restoreView = null;
    if (restore) renderer.setView(restore);
    else if (!keepView || showing !== 'pano')
      renderer.setView({ yaw: 0, pitch: 0, fov: PANO_FOV_DEFAULT_DEG });
    photo = target;
    // Shown first: a hidden canvas measures 0 and would be sized 1×1. The
    // view draws it shown, at once or on a microtask, and hands the canvas
    // back then.
    const draws = canvasDraws;
    canvasMoved = false;
    show('pano');
    await drawnAfter(draws, signal);
    // The view drew it on another canvas: the panorama goes there.
    if (canvasMoved && seq === openSeq && !renderer && ensureRenderer()) {
      const moved = restoreView?.id === target.id ? restoreView.view : null;
      restoreView = null;
      if (moved) renderer.setView(moved);
    }
    canvasMoved = false;
    // The last view left before drawing it: the canvas was never shown, and
    // nothing is drawn until a view is back.
    if (seq === openSeq && canvasDraws === draws && !viewListeners.size) {
      image.close?.();
      photo = null;
      show(null);
      throw undrawn();
    }
    if (seq !== openSeq || !renderer) {
      image.close?.();
      if (seq !== openSeq) return false;
      throw new Error(LOAD_FAILED);
    }
    renderer.setImage(image);
    panoWidth = first.width || 0;
    // A sharper version of the photo before was dropped by `open`; one of
    // this photo, asked by a resize meanwhile, is still worth having.
    return true;
  }

  async function showFlat(target, seq, signal) {
    const urls = sources
      .flatFirst(target, { expanded: isExpanded() })
      .filter(Boolean);
    let image;
    let failure = null;
    for (const url of urls) {
      try {
        image = await loadAs(url, { crossOrigin: false, signal });
        break;
      } catch (error) {
        failure = error;
        if (seq !== openSeq) return false;
      }
    }
    if (!image) throw failure || new Error(LOAD_FAILED);
    if (seq !== openSeq) return false;
    present({ src: image.src });
    flatSharp = { shown: null, loading: null };
    photo = target;
    show('flat');
    return true;
  }

  async function openPhoto(id, seq, keepView, signal) {
    const target = await getPhoto(id, { signal });
    if (seq !== openSeq) return;
    // A canvas lost moments ago: the view is drawing its replacement.
    if (sources.hasPano(target) && !rendererFailed) {
      await canvasReady(signal);
      if (seq !== openSeq) return;
    }
    let shown = false;
    if (sources.hasPano(target) && ensureRenderer()) {
      try {
        shown = await showPano(target, seq, keepView, signal);
      } catch (error) {
        if (error?.undrawn) throw error;
        // The panorama failed: its front view is better than nothing.
        if (seq !== openSeq) return;
        shown = await showFlat(target, seq, signal);
      }
    } else shown = await showFlat(target, seq, signal);
    if (!shown) return;
    onShowing(target);
    emit();
    onShown(target);
    upgrade(target, seq, showing);
  }

  const adapter = {
    async mount(host) {
      if (!host) throw new Error('Street Level viewer has no host element');
      if (root && presented?.host === host) return;
      teardown();
      rendererFailed = false;
      if (!viewListeners.size)
        throw new Error('Street Level photo viewer has no view to draw it');
      // Resolves once the view drew the viewer, or it was unmounted, or its
      // last view left, meanwhile.
      const waitRoot = () => new Promise((resolve) => rootWaiters.add(resolve));
      let drawn = waitRoot();
      build(host);
      // This mount's presentation: a later mount presents its own. A view
      // may have unmounted it already, inside its first draw.
      const mine = presented?.actions;
      if (!mine) throw undrawn();
      for (;;) {
        if (!root) await drawn;
        const current = presented?.actions === mine;
        if (root && current) return;
        // Unmounted, superseded or mounted again: that is not this mount.
        if (!current) throw undrawn();
        // Its last view left, and another subscribed since: it draws.
        if (viewListeners.size) {
          drawn = waitRoot();
          continue;
        }
        // No view will draw it. Unmounted, as when superseded, so a view
        // subscribing later draws nothing.
        adapter.unmount();
        throw undrawn();
      }
    },

    /** Resolves once the photo is on screen and its pose was emitted. */
    async open(imageId) {
      if (!root) throw new Error(`${name} viewer is not mounted`);
      const id = String(imageId);
      const seq = ++openSeq;
      dropSharpPanorama();
      // The previous open's downloads stop: only this photo is wanted now.
      openAbort?.abort();
      const opening = (openAbort = new AbortController());
      const keepView = keepViewFor === id;
      keepViewFor = null;
      openingId = id;
      try {
        await openPhoto(id, seq, keepView, opening.signal);
      } catch (error) {
        // A later open, or a close, stopped this one: that is not a failure.
        if (seq !== openSeq) return;
        throw error;
      } finally {
        if (openingId === id && seq === openSeq) openingId = null;
      }
    },

    close() {
      openSeq++;
      dropSharpPanorama();
      openAbort?.abort();
      openAbort = null;
      openingId = null;
      keepViewFor = null;
      photo = null;
      flatSharp = { shown: null, loading: null };
      show(null);
      present({ src: null });
      renderer?.clear?.();
    },

    unmount() {
      openSeq++;
      dropSharpPanorama();
      openAbort?.abort();
      openAbort = null;
      refused.clear();
      openingId = null;
      keepViewFor = null;
      flatSharp = { shown: null, loading: null };
      teardown();
    },

    resize() {
      renderer?.resize();
      // Expanded: a docked viewer's panorama or flat version is now too soft.
      if (showing === 'pano' && photo && panoSizeNow()[0] > panoWidth)
        upgrade(photo, openSeq, 'pano');
      else if (showing === 'flat' && photo) upgrade(photo, openSeq, 'flat');
    },

    /** FIT / FILL frame a flat photo; a panorama has no frame to fit. */
    supportsRenderModes: () => showing !== 'pano',

    setRenderMode(mode) {
      renderMode = mode === 'fill' ? 'fill' : 'letterbox';
      applyRenderMode();
    },

    /** The photo's direction became known (its drive loaded): pose again. */
    refreshPose() {
      emit();
    },

    onPose(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Receive every presentation of the viewer, starting with the current
     * one (null while unmounted).
     * @param {(view: ?object) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    subscribeView(listener) {
      viewListeners.add(listener);
      listener(presented);
      return () => {
        // The last view went: a mount or an open waiting on its draw fails
        // as closed.
        if (!viewListeners.delete(listener)) return;
        // One view left: the canvases moved off are its to hand back again.
        if (viewListeners.size <= 1) retiredCanvases = new WeakSet();
        if (!viewListeners.size) {
          wake(rootWaiters);
          wake(canvasWaiters);
        }
      };
    },
  };
  return adapter;
}
