/**
 * The wind arrow billboard image.
 *
 * One white arrowhead pointing screen-up at rotation 0, tinted per station
 * through `billboard.color` so a single texture serves the whole network.
 *
 * It is returned as a memoised data URL, not as a canvas: `Billboard.image`
 * assigns a fresh texture-atlas id to every non-string source, so handing the
 * same canvas to hundreds of billboards still makes Cesium upload and repack
 * hundreds of identical textures. A stable URL is keyed once and shared.
 * `cockpitContactDotImage` records the same finding.
 */

const SIZE = 32;

/** A white arrowhead pointing up, as a data URL. Null without a document. */
export function windArrowImage(doc = globalThis.document) {
  if (windArrowImage._dataUrl) return windArrowImage._dataUrl;
  const canvas = doc?.createElement?.('canvas');
  const context = canvas?.getContext?.('2d');
  if (!context) return null;
  canvas.width = SIZE;
  canvas.height = SIZE;
  context.clearRect(0, 0, SIZE, SIZE);

  // A barbed head rather than a plain triangle: the notch gives a clear nose
  // at small sizes, where an equilateral triangle reads as an untilted blob.
  // It fills the canvas, because the billboard is sized in screen pixels and
  // any margin here is margin paid at every zoom.
  context.beginPath();
  context.moveTo(16, 1.5);
  context.lineTo(30, 30.5);
  context.lineTo(16, 23);
  context.lineTo(2, 30.5);
  context.closePath();
  context.fillStyle = 'rgba(255, 255, 255, 1)';
  context.fill();
  // A dark rim keeps the head readable over snow and over bright rock alike,
  // and survives the per-station tint because multiplying black stays black.
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  context.stroke();

  windArrowImage._dataUrl = canvas.toDataURL('image/png');
  return windArrowImage._dataUrl;
}

/** Drop the memoised image. For tests that swap the document. */
export function resetWindArrowImage() {
  windArrowImage._dataUrl = undefined;
}
