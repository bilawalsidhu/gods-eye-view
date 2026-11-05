export const NOW = Date.parse('2026-10-21T08:00:00Z');
export const ring = (west = -100, south = 30, size = 10) => [
  [west, south],
  [west + size, south],
  [west + size, south + size],
  [west, south + size],
  [west, south],
];
export const feature = (
  properties = {},
  geometry = { type: 'Polygon', coordinates: [ring()] },
) => ({
  type: 'Feature',
  properties: {
    objectid: 1,
    dn: 3,
    label: 'MRGL', // i18n-ignore: synthetic upstream risk code, not UI copy
    issue: '202610210551',
    valid: '202610211200',
    expire: '202610221200',
    ...properties,
  },
  geometry,
});
export const collection = (...features) => ({
  type: 'FeatureCollection',
  features,
});
export const payload = (...features) => ({
  ...collection(...features),
  fetchedAt: NOW,
});
