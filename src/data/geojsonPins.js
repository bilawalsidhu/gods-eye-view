/**
 * @module data/geojsonPins
 * @description The map pins a GeoJSON point stands on, drawn as the default
 * renderer's GeoJSON loader drew them: its pin shape in the marker colour,
 * outlined in that colour brightened, and a simplestyle `marker-symbol`
 * stamped on it in white outlined in black: a single character as bold
 * text, anything longer as that Maki icon from the renderer's assets. A
 * symbol that cannot be drawn leaves the plain pin, as the loader did.
 */

/** The pin's outline, in its own 24-unit box. */
const PIN_PATH =
  'M6.72 0.422L17.28 0.422C18.553 0.422 19.577 1.758 19.577 3.415L19.577 10.973' +
  'C19.577 12.63 18.553 13.966 17.282 13.966L14.386 14.008L11.826 23.578L9.614 14.008' +
  'L6.719 13.965C5.446 13.983 4.422 12.629 4.422 10.972L4.422 3.416C4.423 1.76 5.447 0.423 6.718 0.423Z';

/** A colour channel as a CSS byte, as the default renderer writes one. */
const cssByte = (value) => (value === 1 ? 255 : (value * 256) | 0);

/** `[r, g, b, a]` as the default renderer writes a CSS colour. */
export function pinCss([r, g, b, a]) {
  return a === 1
    ? `rgb(${cssByte(r)},${cssByte(g)},${cssByte(b)})`
    : `rgba(${cssByte(r)},${cssByte(g)},${cssByte(b)},${a})`;
}

/** `rgba` brightened by 0.6, as the pin's outline is. */
const brighter = (rgba) => [
  1 - (1 - rgba[0]) * 0.4,
  1 - (1 - rgba[1]) * 0.4,
  1 - (1 - rgba[2]) * 0.4,
  rgba[3],
];

/** `[r, g, b, a]` as the plain pin has always written it, alpha and all. */
const svgCss = ([r, g, b, a]) =>
  `rgba(${cssByte(r)},${cssByte(g)},${cssByte(b)},${a})`;

/**
 * The plain pin at `size` pixels in `rgba`, as SVG.
 * @param {number[]} rgba
 * @param {number} size
 * @returns {{svg: string}}
 */
export function plainPin(rgba, size) {
  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
      `<path d="${PIN_PATH}" fill="${svgCss(rgba)}" stroke="${svgCss(brighter(rgba))}" stroke-width="0.846"/></svg>`,
  };
}

/**
 * Draw the pin, as the loader's pin builder does.
 * @param {CanvasRenderingContext2D} context
 * @param {number[]} rgba
 * @param {number} size
 */
function drawPin(context, rgba, size) {
  context.save();
  context.scale(size / 24, size / 24);
  context.fillStyle = pinCss(rgba);
  context.strokeStyle = pinCss(brighter(rgba));
  context.lineWidth = 0.846;
  context.beginPath();
  context.moveTo(6.72, 0.422);
  context.lineTo(17.28, 0.422);
  context.bezierCurveTo(18.553, 0.422, 19.577, 1.758, 19.577, 3.415);
  context.lineTo(19.577, 10.973);
  context.bezierCurveTo(19.577, 12.63, 18.553, 13.966, 17.282, 13.966);
  context.lineTo(14.386, 14.008);
  context.lineTo(11.826, 23.578);
  context.lineTo(9.614, 14.008);
  context.lineTo(6.719, 13.965);
  context.bezierCurveTo(5.446, 13.983, 4.422, 12.629, 4.422, 10.972);
  context.lineTo(4.422, 3.416);
  context.bezierCurveTo(4.423, 1.76, 5.447, 0.423, 6.718, 0.423);
  context.closePath();
  context.fill();
  context.stroke();
  context.restore();
}

/**
 * Stamp `image` on the pin's head: only its alpha counts, drawn white with
 * a one-pixel black edge, as the loader's pin builder stamps it.
 * @param {CanvasRenderingContext2D} context
 * @param {{width: number, height: number}} image
 * @param {number} size
 */
function drawIcon(context, image, size) {
  const imageSize = size / 2.5;
  let sizeX = imageSize;
  let sizeY = imageSize;
  if (image.width > image.height)
    sizeY = imageSize * (image.height / image.width);
  else if (image.width < image.height)
    sizeX = imageSize * (image.width / image.height);
  const x = Math.round((size - sizeX) / 2);
  const y = Math.round((7 / 24) * size - sizeY / 2);

  context.globalCompositeOperation = 'destination-out';
  context.drawImage(image, x - 1, y, sizeX, sizeY);
  context.drawImage(image, x, y - 1, sizeX, sizeY);
  context.drawImage(image, x + 1, y, sizeX, sizeY);
  context.drawImage(image, x, y + 1, sizeX, sizeY);

  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = 'rgb(0,0,0)';
  context.fillRect(x - 1, y - 1, sizeX + 2, sizeY + 2);

  context.globalCompositeOperation = 'destination-out';
  context.drawImage(image, x, y, sizeX, sizeY);

  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = 'rgb(255,255,255)';
  context.fillRect(x - 1, y - 2, sizeX + 2, sizeY + 2);
}

/**
 * `text` written white on a canvas just big enough for it, in `font`, as
 * the default renderer writes text to a canvas.
 * @param {(width: number, height: number) => HTMLCanvasElement} makeCanvas
 * @param {string} text
 * @param {string} font
 */
function textCanvas(makeCanvas, text, font) {
  const canvas = makeCanvas(1, 1);
  let context = canvas.getContext('2d', { willReadFrequently: true });
  context.font = font;
  const metrics = context.measureText(text);
  const blank = !/\S/.test(text);
  const ascent = blank ? 0 : Math.round(metrics.actualBoundingBoxAscent);
  const descent = blank ? 0 : Math.round(metrics.actualBoundingBoxDescent);
  const height = blank ? 0 : Math.max(ascent + descent, 1);
  const x = blank ? 0 : Math.round(metrics.actualBoundingBoxLeft);
  canvas.width = Math.ceil(metrics.width) + x;
  canvas.height = height;
  // Resizing a canvas resets its context's state.
  context = canvas.getContext('2d', { willReadFrequently: true });
  context.font = font;
  context.lineJoin = 'round';
  context.lineWidth = 1;
  context.imageSmoothingEnabled = false;
  context.fillStyle = 'rgb(255,255,255)';
  context.fillText(text, x, ascent);
  return canvas;
}

/** The renderer's script on the page, and the folder it is served from. */
const RENDERER_SCRIPT = /((?:.*\/)|^)Cesium\.js(?:\?|#|$)/;

/**
 * Where the renderer's assets are served, as the renderer finds them: the
 * `CESIUM_BASE_URL` global, else the folder of its script on the page; null
 * when neither says (a renderer bundled as modules, which finds them from
 * its own module address).
 */
function assetBase() {
  const document = globalThis.document;
  let base = globalThis.CESIUM_BASE_URL;
  if (typeof base !== 'string' || !base) {
    base = null;
    for (const script of document?.getElementsByTagName?.('script') ?? []) {
      const found = RENDERER_SCRIPT.exec(script.getAttribute?.('src') ?? '');
      if (found) {
        base = found[1];
        break;
      }
    }
  }
  if (base === null) return null;
  // The renderer reads its base as a folder, slash or not; a script beside
  // the page is in the page's own folder.
  if (base === '') base = './';
  else if (!base.endsWith('/')) base += '/';
  try {
    return new URL(base, document?.baseURI).href;
  } catch {
    return null;
  }
}

/**
 * The Maki icon `id` from the renderer's assets, or null when it cannot be
 * loaded.
 * @param {string} id
 * @param {AbortSignal} [signal]
 * @returns {Promise<ImageBitmap|null>}
 */
export async function loadMaki(id, signal) {
  const base = assetBase();
  if (!base || typeof globalThis.createImageBitmap !== 'function') return null;
  try {
    const url = new URL(
      `Assets/Textures/maki/${encodeURIComponent(id)}.png`,
      base,
    );
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) return null;
    return await globalThis.createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

/** A canvas on the page, when there is one to draw on. */
function documentCanvas(width, height) {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Makes the pins a set of points stands on. Symbols are loaded first
 * (`load`), so the pins can then be made at once (`pin`).
 * @param {object} [options]
 * @param {(width: number, height: number) => HTMLCanvasElement} [options.makeCanvas]
 *   Default: a canvas on the page; without a page every pin is plain.
 * @param {(id: string, signal?: AbortSignal) => Promise<object|null>} [options.loadIcon]
 *   A Maki icon by id. Default: from the renderer's assets.
 */
export function createGeojsonPins({ makeCanvas, loadIcon = loadMaki } = {}) {
  const canvasFor =
    makeCanvas ??
    (typeof globalThis.document?.createElement === 'function'
      ? documentCanvas
      : null);
  /** Maki icons by id; null for one that failed. */
  const icons = new Map();
  const pins = new Map();

  return {
    /** Let go of every pin and icon made so far. */
    clear() {
      icons.clear();
      pins.clear();
    },

    /**
     * Load the icons `symbols` need. One that fails stays the plain pin.
     * @param {Iterable<unknown>} symbols `marker-symbol` values.
     * @param {{signal?: AbortSignal}} [options] Ends the loads early.
     */
    async load(symbols, { signal } = {}) {
      if (!canvasFor) return;
      const wanted = new Set();
      for (const symbol of symbols)
        if (isIconSymbol(symbol) && !icons.has(String(symbol)))
          wanted.add(String(symbol));
      await Promise.all(
        [...wanted].map(async (id) => {
          const icon = await Promise.resolve()
            .then(() => loadIcon(id, signal))
            .catch(() => null);
          // An aborted load is not a missing icon: a later load asks again.
          if (!signal?.aborted) icons.set(id, icon ?? null);
        }),
      );
    },

    /**
     * The pin for a marker: its colour, size and symbol (none for the
     * plain pin). One image per distinct marker, shared.
     * @param {{color: number[], size: number, symbol?: unknown}} marker
     * @returns {import('../render/contract/draw').ImageRef}
     */
    pin({ color, size, symbol }) {
      const drawn = hasSymbol(symbol) && canvasFor ? symbol : undefined;
      const key = JSON.stringify([stampKey(drawn), color, size]);
      let image = pins.get(key);
      if (!image) {
        image = symbolPin(drawn, color, size) ?? plainPin(color, size);
        pins.set(key, image);
      }
      return image;
    },
  };

  function symbolPin(symbol, color, size) {
    if (symbol === undefined) return null;
    let stamp;
    if (isIconSymbol(symbol)) {
      stamp = icons.get(String(symbol));
      if (!stamp) return null;
    } else
      stamp = textCanvas(
        canvasFor,
        symbol.toUpperCase(),
        `bold ${size}px sans-serif`,
      );
    const canvas = canvasFor(size, size);
    const context = canvas.getContext('2d');
    drawPin(context, color, size);
    drawIcon(context, stamp, size);
    return {
      canvas,
      key: `geojson-pin:${JSON.stringify([stampKey(symbol), color, size])}`,
    };
  }
}

/** Whether a `marker-symbol` asks for a symbol, as the loader reads one. */
const hasSymbol = (symbol) => symbol !== undefined && symbol !== null;

/**
 * What a symbol stamps, as the loader's pin builder told its pins apart:
 * text by its upper-cased character, an icon by its id.
 */
const stampKey = (symbol) =>
  symbol === undefined
    ? null
    : isIconSymbol(symbol)
      ? ['icon', String(symbol)]
      : ['text', symbol.toUpperCase()];

/** Whether a symbol is an icon (anything but a single-character string). */
const isIconSymbol = (symbol) =>
  hasSymbol(symbol) && !(typeof symbol === 'string' && symbol.length === 1);
