/**
 * Small, self-contained SVG badges used as Cesium billboards for Cyber data.
 * Keeping the artwork in SVG makes the marks crisp at map scale without
 * exposing or depending on a browser icon font inside Cesium's scene.
 */
const GLYPHS = {
  origin:
    '<circle cx="24" cy="17" r="6"/><path d="M11 39c.8-7 5.4-11 13-11s12.2 4 13 11v2H11z"/>',
  target:
    '<circle cx="24" cy="24" r="10" fill="none" stroke="white" stroke-width="3"/><circle cx="24" cy="24" r="2.5"/><path d="M24 5v9M24 34v9M5 24h9M34 24h9" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"/>',
  both: '<path d="M24 10 37 15v9c0 9-5.7 15-13 19-7.3-4-13-10-13-19v-9z" fill="#202431" stroke="white" stroke-width="2.5"/><path d="m17 18 14 14m0-14L17 32" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"/><path d="m15 16 4 1-2 4zm18 0-4 1 2 4zM15 34l4-1-2-4zm18 0-4-1 2-4z"/>',
  shodan:
    '<g fill="#202431" stroke="white" stroke-width="1.5"><rect x="11" y="12" width="26" height="7" rx="2"/><rect x="11" y="21" width="26" height="7" rx="2"/><rect x="11" y="30" width="26" height="7" rx="2"/></g><g fill="#ffd34e"><circle cx="16" cy="15.5" r="1.4"/><circle cx="16" cy="24.5" r="1.4"/><circle cx="16" cy="33.5" r="1.4"/></g><path d="M21 15.5h11M21 24.5h11M21 33.5h11" stroke="white" stroke-width="1.5" stroke-linecap="round"/>',
  ioda: '<circle cx="24" cy="24" r="15" fill="none" stroke="white" stroke-width="2.5"/><path d="M9.5 24h12m5 0h12M24 9c5 4 7 9 7 15s-2 11-7 15c-5-4-7-9-7-15s2-11 7-15z" fill="none" stroke="white" stroke-width="1.8"/><path d="m14 35 20-22" stroke="#14242a" stroke-width="6"/><path d="m14 35 20-22" stroke="white" stroke-width="2.8" stroke-linecap="round"/>',
};

const cache = new Map();

/** Return a data URI for a clickable map marker and its matching legend key. */
export function createCyberMarkerImage(kind, color) {
  if (!GLYPHS[kind]) throw new TypeError(`Unknown Cyber marker: ${kind}`);
  const key = `${kind}:${color}`;
  if (cache.has(key)) return cache.get(key);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">` +
    `<circle cx="24" cy="24" r="22" fill="${color}" stroke="white" stroke-width="2.5"/>` +
    `<g fill="white" stroke="white" stroke-linejoin="round">${GLYPHS[kind]}</g></svg>`;
  const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  cache.set(key, image);
  return image;
}
