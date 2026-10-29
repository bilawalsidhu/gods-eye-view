// Faces are MnDOT's own GIF renderings of each lit message. This module picks
// which signs get one, sizes them, decodes their frames and draws a frame into
// the sign's stable `{ frame, stamp }` slot for the world-overlay host. The
// pure helpers run under node --test; decoding and drawing take their browser
// APIs as arguments so tests can stand them in.

import { approxDistanceKm } from '../../data/approxDistance.js';
import { gifSize } from './gif.js';

/** Signs with a face at once: bounds image fetches and canvases. */
export const FACE_BUDGET = 40;
/** Faces hold full size to here, then shrink until they fade out. */
export const FACE_SCALE_FULL_M = 3_000;
export const FACE_FADE_START_M = 4_000;
export const FACE_FADE_END_M = 5_000;
/** Signs further than this from the camera never get a face. */
const FACE_MAX_DISTANCE_KM = 40;
const DEFAULT_FRAME_MS = 3_000;
const MIN_FRAME_MS = 500;
const MAX_FRAME_MS = 10_000;
const STALE_DIM = 'rgba(0, 0, 0, 0.5)';

/**
 * CSS size of a face: half the GIF's pixels, so the slot canvas at the GIF's
 * native size is a fixed 2x (as CCTV's frame canvas).
 * @param {Uint8Array} bytes
 * @returns {?{ width: number, height: number }}
 */
export function faceCssSize(bytes) {
  const size = gifSize(bytes);
  return size ? { width: size.width / 2, height: size.height / 2 } : null;
}

/**
 * The lit signs that get a face: nearest the camera's ground point, within
 * reach, and none at all above the face altitude.
 * @param {Array<{id: string, lat: number, lon: number}>} signs
 * @param {{ lat: number, lon: number, heightM: number }} view
 * @param {number} [limit]
 * @returns {string[]} Sign ids, nearest first.
 */
export function selectFaceIds(signs, view, limit = FACE_BUDGET) {
  if (!view || !Number.isFinite(view.heightM)) return [];
  if (view.heightM > FACE_FADE_END_M) return [];
  return signs
    .map((sign) => ({
      id: sign.id,
      km: approxDistanceKm(view.lat, view.lon, sign.lat, sign.lon),
    }))
    .filter(({ km }) => km <= FACE_MAX_DISTANCE_KM)
    .sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map(({ id }) => id);
}

/**
 * How long a GIF frame shows: its own delay within 0.5-10 s; 0 means 3 s.
 * @param {number} ms
 */
export function clampFrameDelayMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_FRAME_MS;
  return Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, ms));
}

/**
 * Open a GIF for drawing. With ImageDecoder every frame is available and
 * decoded on demand; without it, only the first frame.
 * @param {Uint8Array} bytes
 * @param {{ ImageDecoder?: Function, createImageBitmap?: Function }} [env]
 * @returns {Promise<{ frameCount: number,
 *   decode: (index: number) => Promise<{ image: CanvasImageSource,
 *     durationMs: number, close: () => void }>,
 *   close: () => void }>}
 */
export async function openGifFrames(bytes, env = globalThis) {
  const Decoder = env.ImageDecoder;
  if (
    typeof Decoder === 'function' &&
    (await Decoder.isTypeSupported?.('image/gif'))
  ) {
    const decoder = new Decoder({ data: bytes, type: 'image/gif' });
    await decoder.tracks.ready;
    const frameCount = Math.max(1, decoder.tracks.selectedTrack?.frameCount);
    return {
      frameCount: Number.isFinite(frameCount) ? frameCount : 1,
      async decode(index) {
        const { image } = await decoder.decode({ frameIndex: index });
        return {
          image,
          durationMs: (image.duration ?? 0) / 1000,
          close: () => image.close?.(),
        };
      },
      close: () => decoder.close?.(),
    };
  }
  const bitmap = await env.createImageBitmap(
    new Blob([bytes], { type: 'image/gif' }),
  );
  return {
    frameCount: 1,
    async decode() {
      return { image: bitmap, durationMs: 0, close() {} };
    },
    close: () => bitmap.close?.(),
  };
}

/**
 * A stable frame slot whose canvas is the GIF's native size.
 * @param {{ width: number, height: number }} cssSize
 * @param {(width: number, height: number) => HTMLCanvasElement} createCanvas
 */
export function createFaceSlot(cssSize, createCanvas) {
  return {
    frame: createCanvas(cssSize.width * 2, cssSize.height * 2),
    stamp: 0,
  };
}

/**
 * Draw one decoded frame into a slot and tell the host it changed. Stale
 * faces are dimmed in the slot itself, so no host option is needed.
 * @param {{ frame: HTMLCanvasElement, stamp: number }} slot
 * @param {CanvasImageSource} image
 * @param {{ stale?: boolean }} [options]
 */
export function drawFaceFrame(slot, image, { stale = false } = {}) {
  const { frame } = slot;
  const context = frame.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, frame.width, frame.height);
  context.drawImage(image, 0, 0, frame.width, frame.height);
  if (stale) {
    context.fillStyle = STALE_DIM;
    context.fillRect(0, 0, frame.width, frame.height);
  }
  slot.stamp += 1;
}
