import {
  createPanoramaRenderer,
  PANO_FOV_DEFAULT_DEG,
  wrapDegrees,
} from './panorama.js';
import { imageSize } from './imageSize.js';
import { msg, t } from '../../i18n/index.js';

/** A photo download (tens of kilobytes to a few megabytes). */
export const IMAGE_TIMEOUT_MS = 15_000;

/** A picture file or decoded side past these is refused (a photo is a few MB). */
export const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 16_384;
/** 64 MP: 256 MB once decoded to RGBA. A 16,384 px square is four times that. */
export const MAX_IMAGE_PIXELS = 8_192 * 8_192;
/** Where in a file to look for its dimensions (a JPEG's EXIF comes first). */
const HEADER_BYTES = 256 * 1024;

/** Whether a picture this size is past what the viewer decodes. */
export function tooManyPixels(width, height) {
  return (
    width > MAX_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE ||
    width * height > MAX_IMAGE_PIXELS
  );
}

/** Panorama texture widths: enough for a docked viewer, and for an expanded one. */
export const PANO_MID_SIZE = Object.freeze([2048, 1024]);
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
 * A picture refused for its size (`tooLarge`): the viewer will not load
 * that file another way, an <img> having no size limit at all.
 */
export function oversized(failure) {
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
  let root = null;
  let picture = null;
  let canvas = null;
  let prevButton = null;
  let nextButton = null;
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
  /** The document the viewer was built in (new canvases come from it). */
  let documentOf = null;
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

  function syncButtons() {
    const enabled = Boolean(photo?.sequenceId) && showing !== null;
    if (prevButton) prevButton.disabled = !enabled;
    if (nextButton) nextButton.disabled = !enabled;
    if (enabled) checkEnds(photo);
  }

  /** Disable ‹ or › at once where the sequence ends (it also warms the neighbours). */
  function checkEnds(target) {
    for (const [delta, button] of [
      [-1, prevButton],
      [1, nextButton],
    ])
      step(target, delta).then(
        (id) => {
          if (photo === target && button && !id) disable(button);
        },
        () => {},
      );
  }

  /** Disable a step button, keeping keyboard focus in the viewer. */
  function disable(button) {
    if (button.ownerDocument?.activeElement === button) root?.focus?.();
    button.disabled = true;
  }

  function show(kind) {
    showing = kind;
    if (picture) picture.hidden = kind !== 'flat';
    if (canvas) canvas.hidden = kind !== 'pano';
    if (root) root.dataset.kind = kind || '';
    syncButtons();
  }

  function applyRenderMode() {
    if (picture)
      picture.style.objectFit = renderMode === 'fill' ? 'cover' : 'contain';
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
    event.preventDefault?.();
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
    // A lost canvas hands back its lost context: draw on a new element.
    const fresh = makeCanvas(documentOf);
    fresh.hidden = canvas.hidden;
    canvas.replaceWith?.(fresh);
    canvas = fresh;
    // Show the photo again through the core, unless a newer one is opening.
    if (showing === 'pano' && photo && openingId === null) {
      const again = photo.id;
      show(null);
      openingId = again;
      onReopen(again);
    }
  }

  /** The panorama canvas, wired for drag, pinch, wheel and context loss. */
  function makeCanvas(doc) {
    const element = doc.createElement('canvas');
    element.className = 'sl-photo-pano';
    element.hidden = true;
    listen(element, 'pointerdown', onPointerDown);
    listen(element, 'pointermove', onPointerMove);
    listen(element, 'pointerup', onPointerUp);
    listen(element, 'pointercancel', onPointerUp);
    listen(element, 'wheel', onWheel, { passive: false });
    listen(element, 'webglcontextlost', onContextLost);
    return element;
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
        const button = delta < 0 ? prevButton : nextButton;
        if (button && photo?.id === fromId) disable(button);
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
    canvas.classList.add('sl-photo-dragging');
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
    canvas.classList.remove('sl-photo-dragging');
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
   * expanded, the dialog's own Esc shrinks it.
   */
  function onEscapeKey(event) {
    if (
      event.key !== 'Escape' ||
      event.shiftKey ||
      event.defaultPrevented ||
      root?.closest?.('.sl-viewer-wrap-expanded') ||
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

  function build(host) {
    const doc = host.ownerDocument;
    documentOf = doc;
    root = doc.createElement('div');
    root.className = 'sl-photo-viewer';
    root.dataset.provider = providerId;
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
    root.setAttribute(
      'aria-label',
      t(
        '{name} photo. ← and → step along the sequence. On a 360° photo, drag or use Shift+← →, ↑ ↓ to look around, and + − to zoom',
        { name },
      ),
    );
    picture = doc.createElement('img');
    picture.className = 'sl-photo-flat';
    picture.alt = t('{name} street-level photo', { name });
    picture.draggable = false;
    picture.hidden = true;
    canvas = makeCanvas(doc);
    const nav = (label, glyph, delta) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = `sl-photo-step sl-photo-step-${delta < 0 ? 'prev' : 'next'}`;
      button.textContent = glyph;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.disabled = true;
      listen(button, 'click', (event) => {
        event.stopPropagation();
        stepBy(delta);
      });
      return button;
    };
    prevButton = nav(t('Previous photo in this sequence (←)'), '‹', -1);
    nextButton = nav(t('Next photo in this sequence (→)'), '›', 1);
    root.append(picture, canvas, prevButton, nextButton);
    host.append(root);
    listen(root, 'keydown', onKeyDown);
    // The viewer's box in the panel; without one, the root's own handler
    // takes Esc (one listener per element and type).
    escapeTarget = host.closest?.('.sl-viewer-wrap') ?? null;
    if (escapeTarget) listen(escapeTarget, 'keydown', onEscapeKey);
    applyRenderMode();
  }

  function teardown() {
    pointers.clear();
    pinch = null;
    for (const remove of removeListeners) remove();
    removeListeners = [];
    if (poseFrame) cancelAnimationFrame(poseFrame);
    poseFrame = 0;
    drag = null;
    renderer?.destroy();
    renderer = null;
    root?.remove();
    root = picture = canvas = prevButton = nextButton = null;
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
      picture.src = image.src;
      sharp.shown = url;
      requestRender();
    } catch {
      /* the first version stays; a later resize may try again */
    } finally {
      // Discarded or failed: nothing is on its way, so it may be asked again.
      if (sharp.loading === url) sharp.loading = null;
    }
  }

  /** The viewer is the expanded dialog, not docked in the panel. */
  function isExpanded() {
    return Boolean(root?.closest?.('.sl-viewer-wrap-expanded'));
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
    const width = (canvas?.clientWidth || 0) * ratio;
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
    // Shown first: a hidden canvas measures 0 and would be sized 1×1.
    show('pano');
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
    picture.src = image.src;
    flatSharp = { shown: null, loading: null };
    photo = target;
    show('flat');
    return true;
  }

  async function openPhoto(id, seq, keepView, signal) {
    const target = await getPhoto(id, { signal });
    if (seq !== openSeq) return;
    let shown = false;
    if (sources.hasPano(target) && ensureRenderer()) {
      try {
        shown = await showPano(target, seq, keepView, signal);
      } catch {
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
      if (root && root.parentNode === host) return;
      teardown();
      rendererFailed = false;
      build(host);
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
      if (picture) picture.removeAttribute('src');
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
  };
  return adapter;
}
