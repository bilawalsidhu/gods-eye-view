// The images of imported points (UTILITIES ▸ Import), without Cesium: the
// map pin Cesium's PinBuilder drew for a GeoJSON point or a KML placemark
// without an icon, and each point's look composed onto one square sprite
// whose centre is the point (src/data/geoImportDisplay.js), so the pin's
// tip, a KML hot spot or an icon's sub-region lands where Cesium put it.

import { MAX_ICON_SIDE } from './geoImportLimits.js';

/** Cesium.Color's CSS form of rgba in 0..1 (its float-to-byte conversion). */
export function cssOf([red, green, blue, alpha = 1]) {
  const byte = (v) => (v === 1 ? 255 : (v * 256) | 0);
  const rgb = `${byte(red)},${byte(green)},${byte(blue)}`;
  return alpha === 1 ? `rgb(${rgb})` : `rgba(${rgb},${alpha})`;
}

/** Cesium.Color#brighten. */
const brighten = ([red, green, blue, alpha = 1], magnitude) => {
  const keep = 1 - magnitude;
  return [
    1 - (1 - red) * keep,
    1 - (1 - green) * keep,
    1 - (1 - blue) * keep,
    alpha,
  ];
};

/**
 * Draw Cesium's map pin (PinBuilder's drawPin, from its Assets/Textures/
 * pin.svg) of `color` (rgba in 0..1) into a `size` square at the context's
 * origin.
 */
export function drawPin(context, color, size) {
  context.save();
  context.scale(size / 24, size / 24);
  context.fillStyle = cssOf(color);
  context.strokeStyle = cssOf(brighten(color, 0.6));
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
 * Where an icon draws around its point, in CSS pixels, as Cesium placed the
 * billboard: `width` × `height` (the icon's own size when the record gives
 * none) times `scale`, centred on the point (`origin: 'center'`) or standing
 * on it (`'bottom'`), then moved by `offsetPx` (+y down). Returns the box's
 * centre ([x, y] from the point) and size, and the side of the square
 * sprite centred on the point that holds it.
 * @param {object} icon An imported point's icon (src/data/geoImportRecords.js).
 * @param {{ width: number, height: number }} [natural] The image's own size.
 */
export function iconBox(icon, natural) {
  const pinSize = icon.image?.pin ? icon.image.pinSize : 0;
  const ownWidth = icon.subRegion?.[2] || natural?.width || pinSize || 32;
  const ownHeight = icon.subRegion?.[3] || natural?.height || pinSize || 32;
  const scale = icon.scale ?? 1;
  const width = (icon.widthPx ?? ownWidth) * scale;
  const height = (icon.heightPx ?? ownHeight) * scale;
  const [dx, dy] = icon.offsetPx ?? [0, 0];
  const center = [dx, dy - (icon.origin === 'bottom' ? height / 2 : 0)];
  const side =
    2 *
    Math.max(
      Math.abs(center[0]) + width / 2,
      Math.abs(center[1]) + height / 2,
      0.5,
    );
  return { center, width, height, side };
}

/**
 * Compose one icon onto a square canvas centred on its point (see iconBox).
 * `image` is the decoded image of a `url` icon (ignored for a pin);
 * `ratio` canvas pixels per CSS pixel. Returns the canvas and the sprite's
 * side in CSS pixels.
 */
export function composeIcon(
  icon,
  { image, createCanvas, ratio = 1, maxSide = MAX_ICON_SIDE } = {},
) {
  const natural = image
    ? {
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      }
    : undefined;
  const box = iconBox(icon, natural);
  // At least one canvas pixel per icon pixel, at most 512 a side.
  const k = Math.min(ratio, maxSide / box.side);
  const canvas = createCanvas();
  canvas.width = Math.max(1, Math.ceil(box.side * k));
  canvas.height = canvas.width;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Imported icons need a canvas');
  const x = (box.side / 2 + box.center[0] - box.width / 2) * k;
  const y = (box.side / 2 + box.center[1] - box.height / 2) * k;
  if (icon.image?.pin) {
    // PinBuilder draws the pin at its own size; the billboard then
    // stretches that canvas over the box.
    context.translate(x, y);
    context.scale(
      box.width / icon.image.pinSize,
      box.height / icon.image.pinSize,
    );
    context.scale(k, k);
    drawPin(context, icon.image.pin, icon.image.pinSize);
  } else if (image) {
    const [sx, sy, sw, sh] = icon.subRegion ?? [
      0,
      0,
      natural.width,
      natural.height,
    ];
    // Cesium's imageSubRegion counts y up from the image's bottom.
    const top = icon.subRegion ? natural.height - sy - sh : sy;
    context.drawImage(
      image,
      sx,
      top,
      sw,
      sh,
      x,
      y,
      box.width * k,
      box.height * k,
    );
  }
  return { canvas, side: box.side };
}
