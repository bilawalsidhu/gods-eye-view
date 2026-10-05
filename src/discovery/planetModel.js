export const PLANETS = Object.freeze({
  moon: {
    id: 'moon',
    qid: 'Q405',
    labels: { en: 'Moon', fr: 'Lune' },
    radiusKm: 1737.4,
    texture: '/planetary/moon.jpg',
    width: 2048,
    height: 1024,
    sourceUrl: 'https://svs.gsfc.nasa.gov/4720/',
    credit: 'NASA/GSFC/SVS, Ernie Wright; LRO/LROC/LOLA teams',
    note: 'Processed overview color map, with filled polar areas; visual use, not quantitative analysis.',
    centralLongitude: 0,
  },
  mars: {
    id: 'mars',
    qid: 'Q111',
    labels: { en: 'Mars', fr: 'Mars' },
    radiusKm: 3389.5,
    texture: '/planetary/mars.jpg',
    width: 1440,
    height: 720,
    sourceUrl: 'https://science.nasa.gov/3d-resources/mars/',
    credit: 'Courtesy NASA/JPL-Caltech; Viking images processed at USGS',
    note: 'Viking-based processed global texture; spherical overview, no elevation model.',
    centralLongitude: 0,
  },
});
export function longitudeEast(value) {
  if (!Number.isFinite(value) || Math.abs(value) > 360)
    throw new TypeError('Longitude must be finite within ±360°.');
  return ((((value + 180) % 360) + 360) % 360) - 180;
}
export function planetPoint(card, body) {
  const planet = PLANETS[body];
  const c = card?.coordinate;
  if (
    !planet ||
    card?.body !== body ||
    !c ||
    !Number.isFinite(c.lat) ||
    Math.abs(c.lat) > 90 ||
    ![
      `http://www.wikidata.org/entity/${planet.qid}`,
      `https://www.wikidata.org/entity/${planet.qid}`,
    ].includes(c.globe)
  )
    throw new TypeError('Card coordinates do not belong to this body.');
  return { lat: c.lat, lon: longitudeEast(c.lon) };
}
const radians = (value) => (value * Math.PI) / 180;
const degrees = (value) => (value * 180) / Math.PI;
export function sphereVector({ lat, lon }) {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90)
    throw new TypeError('Invalid latitude.');
  const longitude = radians(longitudeEast(lon)),
    latitude = radians(lat);
  return [
    Math.sin(longitude) * Math.cos(latitude),
    Math.sin(latitude),
    Math.cos(longitude) * Math.cos(latitude),
  ];
}
export function cameraBasis({ lat, lon }) {
  const l = radians(longitudeEast(lon)),
    p = radians(lat);
  return {
    right: [Math.cos(l), 0, -Math.sin(l)],
    up: [-Math.sin(p) * Math.sin(l), Math.cos(p), -Math.sin(p) * Math.cos(l)],
    forward: sphereVector({ lat, lon }),
  };
}
const dot = (a, b) =>
  a.reduce((sum, value, index) => sum + value * b[index], 0);
/** Orthographic projection and picking share this body basis, independent of Earth services. */
export function projectPlanetPoint(
  point,
  center,
  { width, height, zoom = 0.85 },
) {
  const basis = cameraBasis(center),
    vector = sphereVector(point),
    aspect = width / height;
  const x = (((dot(vector, basis.right) * zoom) / aspect + 1) * width) / 2,
    y = ((1 - dot(vector, basis.up) * zoom) * height) / 2;
  return {
    x,
    y,
    visible:
      dot(vector, basis.forward) > 0 &&
      x >= 0 &&
      x <= width &&
      y >= 0 &&
      y <= height,
  };
}
export function pickPlanetPoint(x, y, center, { width, height, zoom = 0.85 }) {
  const px = (((2 * x) / width - 1) * (width / height)) / zoom,
    py = (1 - (2 * y) / height) / zoom,
    r2 = px * px + py * py;
  if (r2 > 1) return null;
  const z = Math.sqrt(1 - r2),
    basis = cameraBasis(center);
  const vector = basis.right.map(
    (v, i) => v * px + basis.up[i] * py + basis.forward[i] * z,
  );
  return {
    lat: degrees(Math.asin(Math.max(-1, Math.min(1, vector[1])))),
    lon: longitudeEast(degrees(Math.atan2(vector[0], vector[2]))),
  };
}
export function planetViewUrl(card) {
  planetPoint(card, card.body);
  return `/planet.html?body=${card.body}&site=${encodeURIComponent(card.id)}`;
}
