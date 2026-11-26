/**
 * A scene's Stories card thumbnail: captured from the globe, stored as a data
 * URL. The scene document validates with this module, so it reaches no
 * browser globals and no renderer; callers hand it the renderer's frame port,
 * its canvas and a canvas factory.
 */

export const STORY_THUMB_WIDTH = 320;
export const STORY_THUMB_HEIGHT = 180;
export const STORY_THUMB_QUALITY = 0.82;
/** Longest `storyThumb` a scene document accepts, in characters. */
export const STORY_THUMB_MAX_LENGTH = 300000;

const STORY_THUMB_PATTERN =
  /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Whether `value` is a valid `storyThumb`: a base64 JPEG or PNG data URL of
 * at most STORY_THUMB_MAX_LENGTH characters.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStoryThumb(value) {
  return (
    typeof value === 'string' &&
    value.length <= STORY_THUMB_MAX_LENGTH &&
    STORY_THUMB_PATTERN.test(value)
  );
}

/**
 * The centred part of a `width`×`height` source with the target's aspect.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function centreCrop(
  width,
  height,
  targetWidth = STORY_THUMB_WIDTH,
  targetHeight = STORY_THUMB_HEIGHT,
) {
  const aspect = targetWidth / targetHeight;
  const cropWidth = Math.min(width, height * aspect);
  const cropHeight = Math.min(height, width / aspect);
  return {
    x: Math.round((width - cropWidth) / 2),
    y: Math.round((height - cropHeight) / 2),
    width: Math.round(cropWidth),
    height: Math.round(cropHeight),
  };
}

/**
 * Draw the centre crop of `source` into a STORY_THUMB_WIDTH×HEIGHT JPEG data
 * URL, halving in steps so a large canvas downscales smoothly.
 * @param {HTMLCanvasElement} source
 * @param {() => HTMLCanvasElement} createCanvas Makes an empty canvas.
 * @param {string} [credit] Attribution to include in an exported thumbnail.
 * @returns {string}
 */
export function encodeStoryThumb(source, createCanvas, credit = '') {
  const crop = centreCrop(source.width, source.height);
  if (!crop.width || !crop.height) throw new Error('Nothing to capture');
  let image = source;
  let area = crop;
  // Halve until one more halving would undershoot the target.
  while (area.width / 2 >= STORY_THUMB_WIDTH) {
    const step = createCanvas();
    step.width = Math.round(area.width / 2);
    step.height = Math.round(area.height / 2);
    const context = step.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      image,
      area.x,
      area.y,
      area.width,
      area.height,
      0,
      0,
      step.width,
      step.height,
    );
    image = step;
    area = { x: 0, y: 0, width: step.width, height: step.height };
  }
  const out = createCanvas();
  out.width = STORY_THUMB_WIDTH;
  out.height = STORY_THUMB_HEIGHT;
  const context = out.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    STORY_THUMB_WIDTH,
    STORY_THUMB_HEIGHT,
  );
  if (credit) {
    const lines = credit.split(' — ');
    const height = lines.length * 11 + 6;
    const top = STORY_THUMB_HEIGHT - height;
    context.fillStyle = 'rgba(0, 0, 0, 0.8)';
    context.fillRect(0, top, STORY_THUMB_WIDTH, height);
    context.fillStyle = '#fff';
    context.font = '9px sans-serif';
    context.textBaseline = 'top';
    lines.forEach((line, i) =>
      context.fillText(line, 5, top + 3 + i * 11, STORY_THUMB_WIDTH - 10),
    );
  }
  // A very busy view can exceed the limit; lower the quality until it fits.
  for (const quality of [STORY_THUMB_QUALITY, 0.7, 0.55, 0.4]) {
    const url = out.toDataURL('image/jpeg', quality);
    if (isStoryThumb(url)) return url;
  }
  throw new Error('Thumbnail too large');
}

/**
 * Capture the globe as it is drawn now. The WebGL canvas has no
 * preserveDrawingBuffer, so it is read inside the next postRender of the
 * renderer's frame port, while the frame is still in the drawing buffer; a
 * render is requested for it.
 * @param {{frame?: import('../render/contract/frame').FramePort | null,
 *   canvas?: HTMLCanvasElement | null}} globe The renderer's frame port and
 *   the canvas it draws in, as the caller found them for its scene.
 * @param {object} options
 * @param {() => HTMLCanvasElement} options.createCanvas Makes an empty canvas.
 * @param {() => string | null | undefined} [options.creditForFrame] If supplied,
 * the frame must have this attribution before the thumbnail can be copied.
 * @param {number} [options.timeoutMs] Give up when no frame is drawn.
 * @returns {Promise<string>} JPEG data URL.
 */
export function captureStoryThumb(
  { frame, canvas } = {},
  { createCanvas, creditForFrame, timeoutMs = 3000 },
) {
  if (!frame || !canvas) return Promise.reject(new Error('Globe not ready'));
  return new Promise((resolve, reject) => {
    let timer = null;
    const remove = frame.on('postRender', () => {
      remove();
      clearTimeout(timer);
      try {
        const credit = creditForFrame?.();
        resolve(
          creditForFrame && !credit
            ? ''
            : encodeStoryThumb(canvas, createCanvas, credit),
        );
      } catch (error) {
        reject(error);
      }
    });
    timer = setTimeout(() => {
      remove();
      reject(new Error('No frame was drawn'));
    }, timeoutMs);
    frame.requestRender('story-thumb');
  });
}
