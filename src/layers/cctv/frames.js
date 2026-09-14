import {
  FRAME_SIGNATURE_W,
  FRAME_SIGNATURE_H,
  PROJECTION_CANVAS_WIDTH,
  PROJECTION_CANVAS_HEIGHT,
  PROJECTION_TEXTURE_SWAP_MS,
  ACTIVE_FRAME_REFRESH_MS,
  FRAME_ENDPOINT,
  MEDIA_ENDPOINT,
  PROJECTION_ACTIVE_REFRESH_MS,
  PROJECTION_IDLE_REFRESH_MS,
  PLACEHOLDER_REPAINT_MS,
} from './policy.js';

export function createFrames({ state: layerState, services, parts, source }) {
  /**
   * FNV-1a over the RGB channels of a downsampled frame. Pure (takes the raw
   * pixel buffer, no DOM) so it is unit-testable.
   *
   * Alpha is skipped deliberately — CCTV stills are opaque, so hashing it would
   * cost a third more work to mix in a constant.
   *
   * @param {Uint8ClampedArray|number[]} data - RGBA pixels, 4 bytes per pixel.
   * @returns {number|null} Unsigned 32-bit signature, or null for empty input.
   */

  function frameSignatureFromPixels(data) {
    if (!data || typeof data.length !== 'number' || data.length < 4)
      return null;
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ data[i], 0x01000193);
      hash = Math.imul(hash ^ data[i + 1], 0x01000193);
      hash = Math.imul(hash ^ data[i + 2], 0x01000193);
    }
    return hash >>> 0;
  }

  /**
   * Signature of the runtime's freshly decoded frame, via a reused 64x36
   * scratch canvas.
   *
   * @param {Object} runtime - Projection runtime holding the decoded `.image`.
   * @returns {number|null} Signature, or null when it cannot be computed (the
   *   caller then treats the frame as changed — the pre-2026-07-30 behavior).
   */

  function projectionFrameSignature(runtime) {
    const image = runtime?.image;
    if (!image) return null;
    if (!runtime.signatureCtx) {
      const canvas = document.createElement('canvas');
      canvas.width = FRAME_SIGNATURE_W;
      canvas.height = FRAME_SIGNATURE_H;
      runtime.signatureCanvas = canvas;
      runtime.signatureCtx = canvas.getContext('2d', {
        willReadFrequently: true,
      });
    }
    const ctx = runtime.signatureCtx;
    if (!ctx) return null;
    try {
      ctx.clearRect(0, 0, FRAME_SIGNATURE_W, FRAME_SIGNATURE_H);
      ctx.drawImage(image, 0, 0, FRAME_SIGNATURE_W, FRAME_SIGNATURE_H);
      return frameSignatureFromPixels(
        ctx.getImageData(0, 0, FRAME_SIGNATURE_W, FRAME_SIGNATURE_H).data,
      );
    } catch {
      // Tainted canvas (a cross-origin source served without CORS) or a decode
      // race. Returning null means "assume changed", so behavior degrades to
      // the unconditional redraw this optimization replaced.
      return null;
    }
  }

  /**
   * Blits the latest projection canvas into the next of two alternating
   * offscreen buffer canvases and returns it (H5).
   *
   * Two buffers are required because Cesium's Material image path re-uploads a
   * canvas texture only when the uniform receives a NEW object reference —
   * redrawing the same canvas in place is invisible to the GPU. Alternating
   * references forces a texture recreate, which at <=1Hz and 1080p is cheap.
   *
   * @param {Object} runtime - Projection runtime with `.canvas`.
   * @returns {HTMLCanvasElement|null} The freshly painted buffer, or null.
   */

  function paintNextProjectionBuffer(runtime) {
    if (!runtime?.canvas) return null;
    if (!runtime.buffers) {
      runtime.buffers = [0, 1].map(() => {
        const buffer = document.createElement('canvas');
        buffer.width = PROJECTION_CANVAS_WIDTH;
        buffer.height = PROJECTION_CANVAS_HEIGHT;
        return buffer;
      });
      runtime.bufferIndex = 0;
    }
    runtime.bufferIndex = (runtime.bufferIndex + 1) % 2;
    const buffer = runtime.buffers[runtime.bufferIndex];
    const ctx = buffer.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, buffer.width, buffer.height);
    ctx.drawImage(runtime.canvas, 0, 0);
    return buffer;
  }

  /**
   * Pushes fresh pixels into the monitor plane material. Called every
   * projection tick.
   *
   * Video feeds are skipped entirely — their HTMLVideoElement uniform is
   * updated per-frame by Cesium natively (H5). Image/webcam-frame feeds swap
   * the double-buffer canvas reference, throttled to PROJECTION_TEXTURE_SWAP_MS.
   *
   * @param {Object} record - Camera record with an initialized projection runtime.
   */

  function refreshProjectionTextures(record) {
    const runtime = record?.projection;
    if (!runtime || runtime.mode === 'video') return;
    const now = Date.now();
    if (
      now - parts.model.safeNumber(runtime.lastTextureSwapAt, 0) <
      PROJECTION_TEXTURE_SWAP_MS
    )
      return;

    const planeShowing = !!(runtime.planeEntity?.show && runtime.planeMaterial);
    if (!planeShowing) return;

    // Only swap when the canvas content actually changed since the last swap.
    // Frames land every ~10 s but this runs at 1 Hz — swapping an UNCHANGED
    // canvas re-uploads the texture for nothing, and each material image
    // reassignment is a flash opportunity on the live plane (owner field test
    // 2026-07-04: intermittent white flashes on the monitor plane).
    if (runtime.canvasStamp === runtime.lastSwappedCanvasStamp) return;

    const buffer = paintNextProjectionBuffer(runtime);
    if (!buffer) return;
    runtime.lastTextureSwapAt = now;
    runtime.lastSwappedCanvasStamp = runtime.canvasStamp;
    runtime.planeMaterial.image = buffer;
  }

  /**
   * Builds the URL for fetching a camera frame image from the backend.
   * Includes a tick parameter to control cache invalidation cadence.
   * @param {Object} camera - Camera object.
   * @param {number} [refreshMs=ACTIVE_FRAME_REFRESH_MS] - Refresh interval used for tick bucketing.
   * @returns {string} Frame URL.
   */

  function frameUrlFor(...args) {
    return source.getFrameUrl(...args);
  }

  /**
   * Builds the URL for fetching a camera's video/media stream.
   * @param {Object} camera - Camera object.
   * @returns {string} Media URL.
   */

  function mediaUrlFor(...args) {
    return source.getMediaUrl(...args);
  }

  /**
   * Paints a placeholder frame onto the projection canvas when no live feed
   * image or video is available. Shows camera name, city, and status text
   * over a dark gradient with tactical border lines.
   * @param {CanvasRenderingContext2D} ctx - 2D context for the projection canvas.
   * @param {Object} camera - Camera object for label info.
   * @param {Object|null} [health=null] - Health state for status message.
   */

  function paintProjectionPlaceholder(ctx, camera, health = null) {
    if (!ctx) return;
    const w = PROJECTION_CANVAS_WIDTH;
    const h = PROJECTION_CANVAS_HEIGHT;
    ctx.clearRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#05111a');
    g.addColorStop(1, '#01070c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const label = String(camera?.name || 'CCTV');
    const city = String(camera?.city || 'GLOBAL');
    const status = String(
      health?.message || health?.status || camera?.feedType || 'NO FEED',
    ).toUpperCase();

    ctx.strokeStyle = 'rgba(0, 220, 255, 0.24)';
    ctx.lineWidth = 2;
    ctx.strokeRect(18, 18, w - 36, h - 36);
    ctx.strokeRect(36, 36, w - 72, h - 72);

    ctx.fillStyle = 'rgba(170, 242, 255, 0.95)';
    ctx.font = '600 32px "JetBrains Mono", monospace';
    ctx.fillText(label.slice(0, 42), 46, 74);
    ctx.fillStyle = 'rgba(127, 216, 231, 0.8)';
    ctx.font = '500 24px "JetBrains Mono", monospace';
    ctx.fillText(city.toUpperCase(), 46, 112);
    ctx.font = '500 21px "JetBrains Mono", monospace';
    ctx.fillText(status.slice(0, 58), 46, h - 42);
  }

  /**
   * Triggers a new frame fetch for an image-mode projection if the refresh
   * interval has elapsed. Active cameras refresh more frequently than idle ones.
   * @param {Object} record - Camera record.
   * @param {boolean} [force=false] - Bypass the interval check.
   */

  function refreshProjectionImage(record, force = false) {
    const runtime = record?.projection;
    if (!runtime || runtime.mode !== 'image' || !runtime.image) return;
    // Hidden-state gate (perf wave 2): no new frame fetch/decode for a canvas
    // nobody can see. The refresh interval re-fills naturally on return.
    if (typeof document !== 'undefined' && document.hidden && !force) return;
    // Do not replace an in-flight URL on the 10-second refresh boundary. Slow
    // providers otherwise leave cancelled server requests behind and the plane
    // can remain permanently pending. The proxy bounds each attempt; load/error
    // clears this latch so the next normal tick can refresh.
    if (runtime.imageLoading) return;
    const now = Date.now();
    const refreshMs =
      record.camera.id === layerState._activeCameraId
        ? PROJECTION_ACTIVE_REFRESH_MS
        : PROJECTION_IDLE_REFRESH_MS;
    if (!force && now - runtime.lastImageRefreshAt < refreshMs) return;
    runtime.lastImageRefreshAt = now;

    const frameUrl = frameUrlFor(record.camera, refreshMs);
    const sep = frameUrl.includes('?') ? '&' : '?';
    runtime.imageLoading = true;
    runtime.imageReady = false;
    runtime.image.src = `${frameUrl}${sep}projTs=${Math.floor(now / refreshMs)}`;
  }

  /**
   * Repaints the projection placeholder at most once per PLACEHOLDER_REPAINT_MS.
   * The projection loop runs at RAF cadence — unthrottled, a pending feed would
   * re-fill the 1080p canvas (gradient + text) on every single frame.
   * @param {Object} record - Camera record.
   * @param {Object} runtime - Projection runtime.
   * @param {Object|null} health - Health state for status text.
   */

  function paintPlaceholderThrottled(record, runtime, health) {
    const now = Date.now();
    if (
      now - parts.model.safeNumber(runtime.lastPlaceholderPaintAt, 0) <
      PLACEHOLDER_REPAINT_MS
    )
      return;
    runtime.lastPlaceholderPaintAt = now;
    runtime.drawnImageStamp = -1;
    // The placeholder overwrites the canvas, so the last real frame is no longer
    // on it. Drop the signature or an identical frame returning after an outage
    // would be skipped as "unchanged" and leave the placeholder on the plane.
    runtime.lastFrameSignature = null;
    runtime.canvasStamp = (runtime.canvasStamp || 0) + 1;
    paintProjectionPlaceholder(runtime.ctx, record.camera, health);
  }

  /**
   * Draws the current frame (video or image) onto the projection canvas.
   * Falls back to the placeholder if the media source is not yet ready.
   * Image feeds only repaint when a NEW image finished loading (stamp check):
   * re-blitting an unchanged 1080p image every RAF tick is pure waste since
   * texture uploads are already throttled to 1Hz buffer swaps.
   * @param {Object} record - Camera record with an initialized projection runtime.
   */

  function drawProjectionFrame(record) {
    const runtime = record?.projection;
    if (!runtime || !runtime.ctx) return;

    const health = layerState._healthById.get(record.camera.id) || null;

    if (runtime.mode === 'video' && runtime.video) {
      const video = runtime.video;
      if (
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        runtime.ctx.clearRect(
          0,
          0,
          PROJECTION_CANVAS_WIDTH,
          PROJECTION_CANVAS_HEIGHT,
        );
        runtime.ctx.drawImage(
          video,
          0,
          0,
          PROJECTION_CANVAS_WIDTH,
          PROJECTION_CANVAS_HEIGHT,
        );
        runtime.canvasStamp = (runtime.canvasStamp || 0) + 1;
        return;
      }
      paintPlaceholderThrottled(record, runtime, health);
      return;
    }

    refreshProjectionImage(record);
    if (runtime.image && runtime.imageReady) {
      if (runtime.drawnImageStamp !== runtime.imageStamp) {
        // The frame URL carries a 10s cache-buster tick, so a fresh Image
        // DECODES every PROJECTION_ACTIVE_REFRESH_MS whether or not the provider
        // actually published a new picture — measured 2026-07-30: a London
        // camera republished once in 5 minutes, an Austin one not at all.
        // Redrawing regardless bumped canvasStamp, which forced a buffer swap
        // and a fresh 1920x1080 texture upload; the plane renders its white
        // base color (planeMaterial color = WHITE, alpha .95) for the frame or
        // two Cesium needs to rebind, which IS the periodic white flash from the
        // owner field tests (2026-07-04 and 2026-07-30).
        const signature = projectionFrameSignature(runtime);
        runtime.drawnImageStamp = runtime.imageStamp;
        if (signature !== null && signature === runtime.lastFrameSignature) {
          // Identical pixels — leave the canvas, and therefore the bound
          // texture, completely alone. No canvasStamp bump, no swap, no flash.
          return;
        }
        runtime.lastFrameSignature = signature;
        runtime.ctx.clearRect(
          0,
          0,
          PROJECTION_CANVAS_WIDTH,
          PROJECTION_CANVAS_HEIGHT,
        );
        runtime.ctx.drawImage(
          runtime.image,
          0,
          0,
          PROJECTION_CANVAS_WIDTH,
          PROJECTION_CANVAS_HEIGHT,
        );
        runtime.canvasStamp = (runtime.canvasStamp || 0) + 1;
        runtime.lastPlaceholderPaintAt = 0;
      }
      return;
    }
    // A refresh is in flight (imageReady=false): keep the last good frame on
    // the canvas instead of flashing the placeholder. Placeholder only paints
    // when nothing has ever been drawn for this camera.
    if (runtime.drawnImageStamp === -1) {
      paintPlaceholderThrottled(record, runtime, health);
    }
  }
  return {
    frameSignatureFromPixels,
    projectionFrameSignature,
    paintNextProjectionBuffer,
    refreshProjectionTextures,
    frameUrlFor,
    mediaUrlFor,
    paintProjectionPlaceholder,
    refreshProjectionImage,
    paintPlaceholderThrottled,
    drawProjectionFrame,
  };
}
