/** Canvas billboard glyphs (image cone, pano ring, position marker); no Cesium needed. */

const _cache = new Map();

/** A square canvas glyph drawn once per key, centred at (c, c). */
function cachedGlyph(key, size, draw) {
  if (_cache.has(key)) return _cache.get(key);
  const element = document.createElement('canvas');
  element.width = size;
  element.height = size;
  draw(element.getContext('2d'), size / 2);
  _cache.set(key, element);
  return element;
}

/** A filled wedge from the centre, pointing "up", `halfAngle` radians wide. */
function wedge(ctx, c, radius, halfAngle, color, alpha) {
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.arc(c, c, radius, -Math.PI / 2 - halfAngle, -Math.PI / 2 + halfAngle);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function ring(ctx, c, radius, color, width, alpha) {
  ctx.beginPath();
  ctx.arc(c, c, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function dot(ctx, c, radius, color, outline, width) {
  ctx.beginPath();
  ctx.arc(c, c, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = width;
  ctx.strokeStyle = outline;
  ctx.stroke();
}

/** Cone glyph pointing "up"; rotate the billboard by the compass angle. */
export function imageConeGlyph({
  size = 32,
  color = '#e8eaed',
  pano = false,
} = {}) {
  return cachedGlyph(`cone:${size}:${color}:${pano}`, size, (ctx, c) => {
    if (pano) ring(ctx, c, size * 0.4, color, Math.max(1.5, size * 0.09), 0.5);
    else wedge(ctx, c, size * 0.46, 0.62, color, 0.42);
    dot(
      ctx,
      c,
      size * 0.16,
      color,
      'rgba(10,10,15,0.85)',
      Math.max(1, size * 0.05),
    );
  });
}

/** Marker for the image the viewer currently shows. */
export function positionMarkerGlyph({ size = 44, color = '#ffb300' } = {}) {
  return cachedGlyph(`pos:${size}:${color}`, size, (ctx, c) => {
    wedge(ctx, c, size * 0.48, 0.55, color, 0.55);
    dot(ctx, c, size * 0.2, color, '#0a0a0f', 2);
    ring(ctx, c, size * 0.3, color, 1.5, 0.8);
  });
}
