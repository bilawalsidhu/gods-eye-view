/** Billboard glyphs as SVG data URLs: the image cone, the 360° ring and the position marker. */

const px = (n) => Number(n.toFixed(2));

function svg(size, body) {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;
}

/** A filled wedge from the centre, pointing "up", `halfAngle` radians wide. */
function wedge(size, radius, halfAngle, color, opacity) {
  const c = size / 2;
  const dx = px(radius * Math.sin(halfAngle));
  const dy = px(radius * Math.cos(halfAngle));
  const r = px(radius);
  return `<path d="M${c} ${c}L${px(c - dx)} ${px(c - dy)}A${r} ${r} 0 0 1 ${px(c + dx)} ${px(c - dy)}Z" fill="${color}" fill-opacity="${opacity}"/>`;
}

function ring(size, radius, color, width, opacity) {
  return `<circle cx="${size / 2}" cy="${size / 2}" r="${px(radius)}" fill="none" stroke="${color}" stroke-width="${px(width)}" stroke-opacity="${opacity}"/>`;
}

function dot(size, radius, color, outline, width) {
  return `<circle cx="${size / 2}" cy="${size / 2}" r="${px(radius)}" fill="${color}" stroke="${outline}" stroke-width="${px(width)}"/>`;
}

/** Cone glyph pointing "up"; rotate the billboard by the compass angle. */
export function imageConeGlyph({
  size = 32,
  color = '#e8eaed',
  pano = false,
} = {}) {
  const shape = pano
    ? ring(size, size * 0.4, color, Math.max(1.5, size * 0.09), 0.5)
    : wedge(size, size * 0.46, 0.62, color, 0.42);
  return svg(
    size,
    shape +
      dot(
        size,
        size * 0.16,
        color,
        'rgba(10,10,15,0.85)',
        Math.max(1, size * 0.05),
      ),
  );
}

/** Marker for the image the viewer currently shows. */
export function positionMarkerGlyph({ size = 44, color = '#ffb300' } = {}) {
  return svg(
    size,
    wedge(size, size * 0.48, 0.55, color, 0.55) +
      dot(size, size * 0.2, color, '#0a0a0f', 2) +
      ring(size, size * 0.3, color, 1.5, 0.8),
  );
}
