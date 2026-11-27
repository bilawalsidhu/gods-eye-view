// A camera pin's still: the frame as it was when the camera was
// pinned, saved as a small JPEG data URL, so the pin never changes, never
// asks the camera proxy again and outlives the layer ("Cameras off · last
// frame"). The frame comes from what the card already shows (its image or the
// live video canvas); failing that, the same-origin frame URL is read once.

// Only registered camera imagery can be copied out of the live view. A plain
// image URL has no response headers and cannot establish where its pixels came from.
export const canKeepCameraFrame = (kind) =>
  kind === 'upstream-image' || kind === 'hls-pull';

/** For a pin, prefer a drawn video frame. A still needs its own provenance. */
export async function captureCameraPin(shown, frame, signal) {
  if (shown?.tagName === 'CANVAS') {
    const still = await captureFrameStill({ shown, url: '' });
    if (still) return still;
  }
  if (signal?.aborted || !frame?.readImage) return '';
  let image;
  try {
    image = await frame.readImage(signal, { liveOnly: true });
    return !signal?.aborted && canKeepCameraFrame(image.sourceKind)
      ? await captureFrameStill({ url: image.url })
      : '';
  } catch {
    return '';
  } finally {
    image?.release();
  }
}

/** Longest side of the saved thumbnail, in pixels. */
export const STILL_MAX_WIDTH = 320;
/** Largest the saved still may be, in characters of its data URL. */
export const STILL_MAX_CHARS = 48_000;

/**
 * Draw a loaded image or canvas into a downscaled JPEG data URL within the
 * size cap, or '' when it cannot be read (not loaded, tainted, too big).
 * @param {HTMLImageElement|HTMLCanvasElement} source
 * @param {{document?: Document, maxWidth?: number, maxChars?: number}} [options]
 * @returns {string}
 */
export function encodeStill(
  source,
  {
    document = globalThis.document,
    maxWidth = STILL_MAX_WIDTH,
    maxChars = STILL_MAX_CHARS,
  } = {},
) {
  const width =
    source?.naturalWidth || source?.videoWidth || source?.width || 0;
  const height =
    source?.naturalHeight || source?.videoHeight || source?.height || 0;
  if (!width || !height || !document?.createElement) return '';
  const scale = Math.min(
    1,
    maxWidth / width,
    STILL_MAX_WIDTH / Math.max(width, height),
  );
  // Smaller and plainer until it fits; past that it is not kept.
  for (const quality of [0.72, 0.55, 0.4]) {
    let size = scale;
    for (let step = 0; step < 3; step++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * size));
      canvas.height = Math.max(1, Math.round(height * size));
      const context = canvas.getContext?.('2d');
      if (!context) return '';
      try {
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/jpeg', quality);
        if (url.startsWith('data:image/') && url.length <= maxChars) return url;
      } catch {
        // A tainted canvas cannot be read: no still.
        return '';
      }
      size *= 0.75;
    }
  }
  return '';
}

/**
 * Save a camera's frame as it is now.
 * @param {{shown?: HTMLImageElement|HTMLCanvasElement|null, url?: string}} frame
 *   What the card shows, and the frame's URL to read once otherwise.
 * @param {{document?: Document, Image?: typeof Image}} [options]
 * @returns {Promise<string>} The data URL, or '' when there is none.
 */
export async function captureFrameStill(...args) {
  return captureOverride ? captureOverride(...args) : captureNow(...args);
}

let captureOverride = null;
/** Replace the capture (tests: the test DOM cannot draw images); null restores it. */
export function _setFrameStillCaptureForTest(capture) {
  captureOverride = typeof capture === 'function' ? capture : null;
}

async function captureNow(
  { shown = null, url = '' } = {},
  { document = globalThis.document, Image = globalThis.Image } = {},
) {
  const now = shown ? encodeStill(shown, { document }) : '';
  if (now || !url || typeof Image !== 'function') return now;
  const image = new Image();
  image.decoding = 'async';
  const loaded = new Promise((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
  });
  image.src = url;
  return (await loaded) ? encodeStill(image, { document }) : '';
}

/** Brightest a frame may be, as the sum of a pixel's channels, and be blank. */
const BLANK_MAX_LEVEL = 24;

/**
 * Whether a loaded frame is blank: every sampled pixel near black (an
 * upstream that answers a rate limit or an outage with a black image). A
 * frame that cannot be read (tainted, not loaded, no 2D canvas) is not
 * called blank.
 * @param {HTMLImageElement|HTMLCanvasElement} source
 * @param {{document?: Document}} [options]
 * @returns {boolean}
 */
export function isBlankFrame(source, { document = globalThis.document } = {}) {
  if (blankOverride) return blankOverride(source);
  const width = source?.naturalWidth || source?.width || 0;
  const height = source?.naturalHeight || source?.height || 0;
  if (!width || !height || !document?.createElement) return false;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const context = canvas.getContext?.('2d', { willReadFrequently: true });
  if (!context?.getImageData) return false;
  try {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > BLANK_MAX_LEVEL) return false;
    }
    return true;
  } catch {
    return false;
  }
}

let blankOverride = null;
/** Decide blankness in tests (the test DOM cannot draw); null restores it. */
export function _setBlankFrameCheckForTest(check) {
  blankOverride = typeof check === 'function' ? check : null;
}
