/**
 * The map pin GeoJSON points have always been drawn with: a rounded box on
 * a pointed stem, filled with the pin's colour and stroked a brighter
 * shade, drawn the way the default renderer's pin builder draws it (its
 * path, scaled from a 24-pixel design).
 */

/** A colour byte as the default renderer writes it into CSS. */
const byte = (value) => (value === 1 ? 255 : (value * 256) | 0);

/** A renderer colour `[r, g, b, a]` as the default renderer writes it in CSS. */
function css([r, g, b, a = 1]) {
  return a === 1
    ? `rgb(${byte(r)},${byte(g)},${byte(b)})`
    : `rgba(${byte(r)},${byte(g)},${byte(b)},${a})`;
}

/** The colour brightened by `amount` (0..1) toward white, alpha kept. */
function brighten([r, g, b, a = 1], amount) {
  const keep = 1 - amount;
  return [1 - (1 - r) * keep, 1 - (1 - g) * keep, 1 - (1 - b) * keep, a];
}

/** The default renderer's pin outline (`PinBuilder`), on a 24 px square. */
const PIN_PATH =
  'M6.72 0.422L17.28 0.422C18.553 0.422 19.577 1.758 19.577 3.415' +
  'L19.577 10.973C19.577 12.63 18.553 13.966 17.282 13.966L14.386 14.008' +
  'L11.826 23.578L9.614 14.008L6.719 13.965' +
  'C5.446 13.983 4.422 12.629 4.422 10.972L4.422 3.416' +
  'C4.423 1.76 5.447 0.423 6.718 0.423Z';

const pins = new Map();

/**
 * The pin image for a colour and size (pixels square), one per look: a
 * canvas where there is a document, else the same pin as SVG.
 * @param {[number, number, number, number]} color Renderer colour.
 * @param {number} size
 * @returns {import('../../render/contract/draw').ImageRef}
 */
export function cablePinImage(color, size) {
  const fill = css(color);
  const stroke = css(brighten(color, 0.6));
  const key = `cable-pin:${fill}:${stroke}:${size}`;
  let image = pins.get(key);
  if (image) return image;
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.save();
    context.scale(size / 24, size / 24);
    context.fillStyle = fill;
    context.strokeStyle = stroke;
    context.lineWidth = 0.846;
    const path = new Path2D(PIN_PATH);
    context.fill(path);
    context.stroke(path);
    context.restore();
    image = { canvas, key };
  } else {
    image = {
      svg:
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
        `<path d="${PIN_PATH}" fill="${fill}" stroke="${stroke}" stroke-width="0.846"/></svg>`,
    };
  }
  pins.set(key, image);
  return image;
}
