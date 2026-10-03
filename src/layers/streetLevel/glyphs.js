/**
 * Canvas glyphs for billboards: a camera cone for images, a ring for
 * panoramas and a position marker for the street-level viewer. Pure canvas
 * drawing so it can run without Cesium.
 */

const _cache = new Map();

function canvas(size) {
  const element = document.createElement('canvas');
  element.width = size;
  element.height = size;
  return element;
}

/** Cone glyph pointing "up"; rotate the billboard by the compass angle. */
export function imageConeGlyph({
  size = 32,
  color = '#e8eaed',
  pano = false,
} = {}) {
  const key = `cone:${size}:${color}:${pano}`;
  if (_cache.has(key)) return _cache.get(key);
  const element = canvas(size);
  const ctx = element.getContext('2d');
  const c = size / 2;
  if (!pano) {
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, size * 0.46, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.42;
    ctx.fill();
    ctx.globalAlpha = 1;
  } else {
    ctx.beginPath();
    ctx.arc(c, c, size * 0.4, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(1.5, size * 0.09);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.arc(c, c, size * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.05);
  ctx.strokeStyle = 'rgba(10,10,15,0.85)';
  ctx.stroke();
  _cache.set(key, element);
  return element;
}

/** Pulsing-looking marker for the image the viewer currently shows. */
export function positionMarkerGlyph({ size = 44, color = '#ffb300' } = {}) {
  const key = `pos:${size}:${color}`;
  if (_cache.has(key)) return _cache.get(key);
  const element = canvas(size);
  const ctx = element.getContext('2d');
  const c = size / 2;
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.arc(c, c, size * 0.48, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0a0a0f';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c, c, size * 0.3, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.8;
  ctx.stroke();
  _cache.set(key, element);
  return element;
}
