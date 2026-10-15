import {
  createPanoramaRenderer,
  PANO_FOV_DEFAULT_DEG,
  wrapDegrees,
} from '../../panorama.js';
import {
  IMAGE_TIMEOUT_MS,
  MISSING_FILE_MESSAGE,
  PANO_TEXTURE_WIDTH,
  VEGBILDER_PROVIDER_ID,
  roadName,
  vegbilderPhotoUrl,
} from './policy.js';

/** A flat photo in an <img> (no CORS needed to show it). */
export function loadPicture(url, { timeoutMs = IMAGE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error(MISSING_FILE_MESSAGE));
    const image = new Image();
    image.decoding = 'async';
    const timer = setTimeout(() => {
      image.src = '';
      reject(new Error(MISSING_FILE_MESSAGE));
    }, timeoutMs);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error(MISSING_FILE_MESSAGE));
    };
    image.src = url;
  });
}

/**
 * A panorama as a texture-sized bitmap: Vegvesen's are 8,192 × 4,096, past
 * what many GPUs take, so the browser scales them while decoding.
 */
export async function loadPanorama(
  url,
  { timeoutMs = IMAGE_TIMEOUT_MS, width = PANO_TEXTURE_WIDTH } = {},
) {
  if (!url) throw new Error(MISSING_FILE_MESSAGE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      mode: 'cors',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(MISSING_FILE_MESSAGE);
    return await createImageBitmap(await response.blob(), {
      resizeWidth: width,
      resizeHeight: width / 2,
      resizeQuality: 'high',
    });
  } catch {
    throw new Error(MISSING_FILE_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Viewer adapter for Vegbilder photos: a flat photo in an <img>, a 360°
 * photo on a WebGL panorama (drag to look, wheel to zoom), and ‹ › along the
 * drive (also ← →). A 360° photo whose file is missing shows its front view.
 *
 * @param {object} options
 * @param {(imageId: string) => Promise<object>} options.getImage   A normalized photo with signed addresses.
 * @param {(image: object, delta: -1|1) => Promise<string|null>} options.step   The photo `delta` along the drive, or null at its end.
 * @param {(imageId: string) => void} options.onStep   Open the photo ‹ › chose (through the core).
 * @param {(image: object) => void} [options.onShown]
 * @param {object} [options.render]   Render governor.
 * @param {typeof loadPicture} [options.loadFlat]
 * @param {typeof loadPanorama} [options.loadPano]
 * @param {(canvas: HTMLCanvasElement) => object} [options.createRenderer]
 * @returns {import('../../registry.js').ViewerAdapter}
 */
export function createVegbilderViewer({
  getImage,
  step,
  onStep,
  onShown = () => {},
  render,
  loadFlat = loadPicture,
  loadPano = loadPanorama,
  createRenderer = createPanoramaRenderer,
}) {
  const listeners = new Set();
  let root = null;
  let picture = null;
  let canvas = null;
  let prevButton = null;
  let nextButton = null;
  let renderer = null;
  let rendererFailed = false;
  let image = null;
  /** What shows: 'flat', 'pano' or null. */
  let showing = null;
  let openSeq = 0;
  let renderMode = 'letterbox';
  let drag = null;
  let poseFrame = 0;
  let removeListeners = [];
  let openingId = null;
  let keepViewFor = null;
  let steps = Promise.resolve();

  function requestRender() {
    render?.governorRequestRender?.('vegbilder-viewer');
  }

  function emit() {
    if (!image || !showing) return;
    const view = showing === 'pano' && renderer ? renderer.getView() : null;
    const heading = image.heading;
    const road = roadName(image.road);
    const pose = {
      providerId: VEGBILDER_PROVIDER_ID,
      imageId: image.id,
      position: { lon: image.lon, lat: image.lat },
      bearing:
        heading === null
          ? null
          : view
            ? wrapDegrees(heading + view.yaw)
            : heading,
      tilt: view ? view.pitch : 0,
      altitude: null,
      isPano: showing === 'pano',
      capturedAt: image.capturedAt,
      capturedAtPrecision: 'day',
      title: road,
      creator: 'Statens vegvesen',
      sequenceId: image.driveId,
      externalUrl: vegbilderPhotoUrl(image),
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

  function emitSoon() {
    if (poseFrame) return;
    poseFrame = requestAnimationFrame(() => {
      poseFrame = 0;
      emit();
    });
  }

  function syncButtons() {
    const enabled = Boolean(image?.driveId) && showing !== null;
    if (prevButton) prevButton.disabled = !enabled;
    if (nextButton) nextButton.disabled = !enabled;
    if (!enabled) return;
    const target = image;
    for (const [delta, button] of [
      [-1, prevButton],
      [1, nextButton],
    ])
      step(target, delta).then(
        (id) => {
          if (image === target && button && !id) disable(button);
        },
        () => {},
      );
  }

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

  /** A lost WebGL context: drop the renderer and show the photo again on a new canvas. */
  function onContextLost(event) {
    event.preventDefault?.();
    try {
      renderer?.destroy();
    } catch {
      /* already gone */
    }
    renderer = null;
    const fresh = makeCanvas(canvas.ownerDocument);
    fresh.hidden = canvas.hidden;
    canvas.replaceWith?.(fresh);
    canvas = fresh;
    if (showing === 'pano' && image && openingId === null) {
      const again = image.id;
      show(null);
      adapter.open(again).catch(() => {});
    }
  }

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

  function stepBy(delta) {
    steps = steps.then(async () => {
      const fromId = openingId ?? image?.id;
      if (!fromId || !root) return;
      let nextId = null;
      try {
        nextId = await step(await getImage(fromId), delta);
      } catch {
        return;
      }
      if ((openingId ?? image?.id) !== fromId) return;
      if (!nextId) {
        const button = delta < 0 ? prevButton : nextButton;
        if (button && image?.id === fromId) disable(button);
        return;
      }
      openingId = nextId;
      keepViewFor = nextId;
      onStep(nextId);
    });
  }

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
    renderer.setView({
      yaw:
        drag.view.yaw -
        ((event.clientX - drag.x) / width) * fov * (width / height),
      pitch: drag.view.pitch + ((event.clientY - drag.y) / height) * fov,
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

  function onKeyDown(event) {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const pano = showing === 'pano' && renderer;
    const turn = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
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
    root = doc.createElement('div');
    // KartaView's viewer styles, with Vegbilder's colour.
    root.className = 'sl-photo-viewer';
    root.dataset.provider = VEGBILDER_PROVIDER_ID;
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
    root.setAttribute(
      'aria-label',
      'Vegbilder road photo. ← and → step along the drive. On a 360° photo, drag or use Shift+← →, ↑ ↓ to look around, and + − to zoom',
    );
    picture = doc.createElement('img');
    picture.className = 'sl-photo-flat';
    picture.alt = 'Statens vegvesen road photo';
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
    prevButton = nav('Previous photo of this drive (←)', '‹', -1);
    nextButton = nav('Next photo of this drive (→)', '›', 1);
    root.append(picture, canvas, prevButton, nextButton);
    host.append(root);
    listen(root, 'keydown', onKeyDown);
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
    image = null;
  }

  async function showPano(target, seq, keepView) {
    const bitmap = await loadPano(target.urls.full);
    if (seq !== openSeq) {
      bitmap?.close?.();
      return false;
    }
    if (!ensureRenderer()) {
      bitmap?.close?.();
      throw new Error(MISSING_FILE_MESSAGE);
    }
    if (!keepView || showing !== 'pano')
      renderer.setView({ yaw: 0, pitch: 0, fov: PANO_FOV_DEFAULT_DEG });
    image = target;
    // Shown first: a hidden canvas measures 0 and would be sized 1×1.
    show('pano');
    renderer.setImage(bitmap);
    return true;
  }

  async function showFlat(target, seq, url) {
    const loaded = await loadFlat(url);
    if (seq !== openSeq) return false;
    picture.src = loaded.src;
    image = target;
    show('flat');
    return true;
  }

  async function openImage(id, seq, keepView) {
    const target = await getImage(id);
    if (seq !== openSeq) return;
    let shown = false;
    if (target.isPano && ensureRenderer()) {
      try {
        shown = await showPano(target, seq, keepView);
      } catch (error) {
        if (seq !== openSeq) return;
        // The panorama failed: its front view is better than nothing.
        if (!target.urls.preview) throw error;
        shown = await showFlat(target, seq, target.urls.preview);
      }
    } else
      shown = await showFlat(
        target,
        seq,
        target.isPano
          ? target.urls.preview || target.urls.full
          : target.urls.full,
      );
    if (!shown) return;
    emit();
    onShown(target);
  }

  const adapter = {
    async mount(host) {
      if (!host) throw new Error('Street Level viewer has no host element');
      if (root && root.parentNode === host) return;
      teardown();
      rendererFailed = false;
      build(host);
    },

    async open(imageId) {
      if (!root) throw new Error('Vegbilder viewer is not mounted');
      const id = String(imageId);
      const seq = ++openSeq;
      const keepView = keepViewFor === id;
      keepViewFor = null;
      openingId = id;
      try {
        await openImage(id, seq, keepView);
      } finally {
        if (openingId === id && seq === openSeq) openingId = null;
      }
    },

    close() {
      openSeq++;
      openingId = null;
      keepViewFor = null;
      image = null;
      show(null);
      if (picture) picture.removeAttribute('src');
      renderer?.clear?.();
    },

    unmount() {
      openSeq++;
      openingId = null;
      keepViewFor = null;
      teardown();
    },

    resize() {
      renderer?.resize();
    },

    supportsRenderModes: () => showing !== 'pano',

    setRenderMode(mode) {
      renderMode = mode === 'fill' ? 'fill' : 'letterbox';
      applyRenderMode();
    },

    onPose(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return adapter;
}
