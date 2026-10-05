import {
  shouldSendViewportImage,
  hasStructuredViewIdentity,
} from './realtimeProtocol.js';
// Viewport-screenshot size guards (M13). The old code clamped WIDTH only, so a
// tall portrait window produced an oversized capture whose dc.send could throw.
// Cap total pixels (clamps both dimensions) and drop the image entirely if the
// encoded data URL is still too big for the data channel.
export const VIEWPORT_MAX_PIXELS = 1200 * 900;

// ~1.08 MP, matches the old 1200px-wide landscape budget
export const VIEWPORT_MAX_ENCODED_BYTES = 200 * 1024;

export async function captureViewportImage() {
  const viewer = window.__godsEyeView?.viewer;
  const source =
    viewer?.scene?.canvas ||
    document.querySelector('#cesiumContainer .cesium-widget canvas');
  if (!source || !source.width || !source.height) return null;
  // No fresh frame (hidden, or the bounded render wait timed out) → no
  // capture. The caller labels this image "Current"; a stale preserved
  // frame would feed the model old entities as current context. (perf
  // wave 2 fix)
  const fresh = await renderFreshCesiumFrame(viewer);
  if (!fresh) return null;

  // Clamp BOTH dimensions by a total-pixel budget so tall portrait windows are
  // downscaled too (the old width-only clamp let them through — M13).
  const { width, height } = computeDownscale(
    source.width,
    source.height,
    VIEWPORT_MAX_PIXELS,
  );
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, width, height);
    if (isNearlyBlackFrame(ctx, width, height)) {
      console.warn('[GEV Voice] Skipped black Cesium viewport capture');
      return null;
    }
    const dataUrl = canvas.toDataURL('image/jpeg', 0.74);
    // Even after the pixel clamp, a busy frame can encode large. If the payload
    // would still overflow the data channel, skip the image rather than let the
    // send throw and strand the turn (M13). The caller falls through without it.
    if (estimateDataUrlBytes(dataUrl) > VIEWPORT_MAX_ENCODED_BYTES) {
      console.warn('[GEV Voice] Skipped oversized viewport capture', {
        bytes: estimateDataUrlBytes(dataUrl),
        limit: VIEWPORT_MAX_ENCODED_BYTES,
      });
      return null;
    }
    return dataUrl;
  } catch {
    return null;
  }
}

// Scale (w, h) down so w*h <= maxPixels while preserving aspect ratio. Never
// upscales. Both dimensions shrink together, so portrait and landscape are
// treated equally (M13). Pure + deterministic → unit-tested (exported below).
export function computeDownscale(width, height, maxPixels) {
  const w = Math.max(1, Math.floor(width) || 0);
  const h = Math.max(1, Math.floor(height) || 0);
  const budget = Math.max(1, maxPixels || 0);
  if (w * h <= budget) return { width: w, height: h };
  const scale = Math.sqrt(budget / (w * h));
  // Floor (not round) both dims so the result can never exceed the budget:
  // floor(w*s) * floor(h*s) <= (w*s)(h*s) = budget. Rounding could push a
  // narrow-tall frame back over the ceiling.
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
  };
}

// Approximate the decoded byte length of a base64 data URL without allocating
// the buffer: strip the "data:...;base64," prefix, then base64 is 4 chars per
// 3 bytes (minus any '=' padding). Exported for unit tests.
export function estimateDataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0;
  const commaIndex = dataUrl.indexOf(',');
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * Ensure the canvas holds a CURRENT frame before capture.
 * @returns {Promise<boolean>} true only when a fresh frame was presented —
 *   false while hidden (render loop suspended; a capture would be stale) or
 *   when the bounded wait timed out. Callers must not label a non-fresh
 *   canvas as current. (perf wave 2)
 */
export async function renderFreshCesiumFrame(viewer) {
  const scene = viewer?.scene;
  if (!scene) return false;
  // While the document is hidden the render loop is suspended — don't
  // secretly restart rendering for an optional screenshot, and don't pass
  // the stale preserved frame off as current.
  if (typeof document !== 'undefined' && document.hidden) return false;
  try {
    // Under the idle render governor a bare scene.render() doesn't
    // necessarily draw — request a frame and await its postRender (bounded),
    // which also covers the just-became-visible race.
    const rendered = new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve(true);
      });
      setTimeout(() => {
        remove();
        resolve(false);
      }, 400);
    });
    scene.requestRender?.();
    const fresh = await rendered;
    // A tab switch during the bounded wait invalidates freshness.
    if (typeof document !== 'undefined' && document.hidden) return false;
    return fresh;
  } catch {
    return false;
  }
}

export function isNearlyBlackFrame(ctx, width, height) {
  const sampleWidth = Math.min(48, width);
  const sampleHeight = Math.min(32, height);
  if (!sampleWidth || !sampleHeight) return true;

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = sampleWidth;
  sampleCanvas.height = sampleHeight;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!sampleCtx) return false;
  sampleCtx.drawImage(ctx.canvas, 0, 0, sampleWidth, sampleHeight);
  const pixels = sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let visiblePixels = 0;
  let luminanceTotal = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 8) continue;
    visiblePixels++;
    luminanceTotal +=
      pixels[index] * 0.2126 +
      pixels[index + 1] * 0.7152 +
      pixels[index + 2] * 0.0722;
  }
  return visiblePixels === 0 || luminanceTotal / visiblePixels < 2;
}

// True when an error payload is the benign result of deleting a viewport
// screenshot the server had already truncated (M14). Non-fatal if EITHER the
// error code is item_not_found OR it echoes the event_id of a delete we issued.
// The event_id match narrows the code-only whitelist so an unrelated
// item_not_found (should one ever arise) still surfaces normally.
export function isBenignViewportDeleteError(payload, pendingDeleteIds = null) {
  if (!payload || payload.type !== 'error') return false;
  const echoedId = payload.event_id;
  if (echoedId && pendingDeleteIds && pendingDeleteIds.has(echoedId))
    return true;
  const code = payload.error?.code;
  return code === 'item_not_found';
}

/** Own the one retained viewport image and bounded pending deletion identities. */
export class RealtimeViewport {
  constructor({ readChannel, operations, capture = captureViewportImage }) {
    Object.assign(this, { readChannel, capture }, operations);
    this.generation = 0;
    this.pendingViewportDeletes = new Set();
    this.lastViewportItemId = null;
  }
  get dc() {
    return this.readChannel();
  }

  async sendVisualContextIfUseful(result) {
    if (
      result?.action !== 'get_entity_context' ||
      !this.dc ||
      this.dc.readyState !== 'open'
    )
      return false;
    const viewScale = result.scene?.basemap?.viewScale;
    if (!shouldSendViewportImage(viewScale)) return false;
    if (hasStructuredViewIdentity(result)) return false;
    const generation = this.generation;
    const channel = this.dc;
    const imageUrl = await this.capture();
    if (
      !imageUrl ||
      generation !== this.generation ||
      this.dc !== channel ||
      channel.readyState !== 'open'
    )
      return false;

    // Keep at most one viewport screenshot in context. Images are the single
    // most expensive item (re-billed every turn they linger), so we proactively
    // delete the previous one before adding a new one. Text history is left to
    // the server-side retention_ratio truncation (see /api/realtime/token) —
    // deleting old text per-turn busts the prompt cache for little gain.
    if (this.lastViewportItemId) {
      // Tag the delete with our own event_id and remember it. If the item was
      // already server-truncated, the item_not_found error echoes this id and we
      // recognize it as the benign race it is instead of a fatal error (M14).
      const deleteEventId = `evt_del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      this.pendingViewportDeletes.add(deleteEventId);
      // Bound the set so a long session can't accumulate ids unbounded.
      if (this.pendingViewportDeletes.size > 8) {
        this.pendingViewportDeletes.delete(
          this.pendingViewportDeletes.values().next().value,
        );
      }
      this.sendRealtimeEvent(
        {
          event_id: deleteEventId,
          type: 'conversation.item.delete',
          item_id: this.lastViewportItemId,
        },
        'client.conversation.item.delete.old_viewport',
      );
    }

    const newItemId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const contextEvent = {
      type: 'conversation.item.create',
      item: {
        id: newItemId,
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: "Current God's Eye View viewport screenshot. Read any clearly visible street, building, and place labels in the image and combine them with the structured nearbyPlaces, streetLabels, and scene context. Do not invent labels that are not legible.",
          },
          {
            type: 'input_image',
            image_url: imageUrl,
            detail: 'high',
          },
        ],
      },
    };
    // Only claim lastViewportItemId once the send actually succeeds. If the image
    // is still too large for the data channel, sendRealtimeEvent returns false
    // (it no longer throws — M13); we then leave lastViewportItemId pointing at
    // the item we just deleted as null and fall through so the caller still
    // issues queueResponseCreate WITHOUT the image, instead of stranding the turn.
    const sent = this.sendRealtimeEvent(
      contextEvent,
      'client.viewport_context',
    );
    this.lastViewportItemId = sent ? newItemId : null;
    return sent;
  }

  reset() {
    this.generation++;
    this.lastViewportItemId = null;
    this.pendingViewportDeletes.clear();
  }

  consumeDeleteError(payload) {
    if (!isBenignViewportDeleteError(payload, this.pendingViewportDeletes))
      return false;
    if (payload.event_id) this.pendingViewportDeletes.delete(payload.event_id);
    return true;
  }
}
