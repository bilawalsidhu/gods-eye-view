/** Source-specific SVG badges shared by the Geo-Political map and its legend. */
export const GEOPOLITICAL_MARKERS = Object.freeze({
  gdelt: Object.freeze({
    label: 'GDELT',
    color: '#f4b942',
    glyph: 'news',
    meaning: 'News-derived, automatically coded event',
  }),
  acled: Object.freeze({
    label: 'ACLED',
    color: '#f05b53',
    glyph: 'incident',
    meaning: 'Individually coded conflict or political-violence event',
  }),
  ucdp: Object.freeze({
    label: 'UCDP GED',
    color: '#be8bff',
    glyph: 'verified-record',
    meaning: 'Finalized georeferenced armed-conflict event',
  }),
  'ucdp-candidate': Object.freeze({
    label: 'UCDP Candidate',
    color: '#ff91d2',
    glyph: 'candidate-record',
    meaning: 'Preliminary UCDP event; may change before final GED',
  }),
  'hapi-conflict': Object.freeze({
    label: 'HDX HAPI / ACLED',
    color: '#ff995c',
    glyph: 'country-statistics',
    meaning: 'Monthly country aggregate at a reference point, not an incident',
  }),
  reliefweb: Object.freeze({
    label: 'ReliefWeb',
    color: '#36c8db',
    glyph: 'relief-crate',
    meaning:
      'Humanitarian reports referencing a country, not incident locations',
  }),
});

const GLYPHS = Object.freeze({
  news: '<path d="M14 10h14l7 7v21H14z"/><path d="M28 10v8h7M19 23h11M19 28h11M19 33h7"/>',
  incident:
    '<path d="m24 9 3.3 8 7.7-4-2.2 8.3 8.2 2.7-8.2 3 2.2 8.2-7.7-4-3.3 8-3.3-8-7.7 4 2.2-8.2-8.2-3 8.2-2.7-2.2-8.3 7.7 4z"/><circle cx="24" cy="25" r="3.5" fill="#f05b53"/>',
  'verified-record':
    '<path d="M14 10h14l7 7v21H14zM28 10v8h7M19 24h7"/><path d="m20 31 3 3 8-8"/>',
  'candidate-record':
    '<path d="M12 9h13l7 7v15H12zM25 9v8h7M17 21h10"/><circle cx="31" cy="32" r="8" fill="#20232b"/><path d="M31 27v5l3 2"/><circle cx="31" cy="32" r="8"/>',
  'country-statistics':
    '<path d="m10 15 7-5 6 3 5-2 10 6-2 7-5 3-2 10-7-2-2-7-7-4z"/><path d="M19 31h3v5h-3zM25 27h3v9h-3zM31 23h3v13h-3z" fill="#ff995c"/>',
  'relief-crate':
    '<path d="M11 16h26v20H11zM11 22h26M17 16v20M31 16v20"/><path d="M24 23v9M19.5 27.5h9" stroke-width="3.5"/>',
});

const imageCache = new Map();

export function createGeopoliticalMarkerImage(provider) {
  const marker = GEOPOLITICAL_MARKERS[provider];
  if (!marker) throw new TypeError(`Unknown Geo-Political marker: ${provider}`);
  if (imageCache.has(provider)) return imageCache.get(provider);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
    `<circle cx="24" cy="24" r="22" fill="${marker.color}" stroke="#fff" stroke-width="2.5"/>` +
    `<g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[marker.glyph]}</g>` +
    '</svg>';
  const image = `data:image/svg+xml;base64,${btoa(svg)}`;
  imageCache.set(provider, image);
  return image;
}
