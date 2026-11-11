// Optional self-hosted map endpoints. The server reads them from its
// environment and hands the browser only validated values; unset keeps the
// keyless public defaults.

const TILE_PLACEHOLDERS = [/\{z\}/, /\{x\}/, /\{(?:y|reverseY)\}/];

/** An absolute https URL without credentials, as connect-src and img-src allow. */
function isBrowserEndpoint(text) {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * GEV_BASEMAP_URL: an https XYZ tile template such as
 * `https://tiles.example.org/{z}/{x}/{y}.png`. Unset or empty keeps Esri World
 * Imagery. Any other value is refused rather than ignored: falling back to the
 * public basemap would send every viewport to the host the operator set this
 * to avoid.
 * @param {string|undefined} value
 * @returns {string|undefined} the template, unchanged, or undefined for the default
 */
export function basemapUrlSetting(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (
    !isBrowserEndpoint(text) ||
    !TILE_PLACEHOLDERS.every((placeholder) => placeholder.test(text))
  )
    throw new Error(
      'GEV_BASEMAP_URL must be an https URL template containing {z}, {x} and {y} (or {reverseY})',
    );
  return text;
}

/** Re:Earth / Mapterhorn ellipsoidal quantized mesh, CC BY 4.0. */
export const KEYLESS_TERRAIN_URL =
  'https://terrain.reearth.land/cesium-mesh/ellipsoid';

/**
 * GEV_TERRAIN_URL: the https URL of a quantized-mesh terrain (the directory
 * holding `layer.json`). Unset or empty keeps Re:Earth; `none` selects the
 * flat ellipsoid, with no terrain requests at all. Any other value is refused
 * for the same reason as GEV_BASEMAP_URL.
 * @param {string|undefined} value
 * @returns {string|null|undefined} the URL, null for flat, undefined for the default
 */
export function terrainUrlSetting(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (text.toLowerCase() === 'none') return null;
  if (!isBrowserEndpoint(text))
    throw new Error(
      'GEV_TERRAIN_URL must be an https quantized-mesh URL or none',
    );
  return text.replace(/\/+$/, '');
}

/**
 * The upstream for the server's /api/terrain/heights proxy. Point heights are
 * a Re:Earth API, not part of quantized mesh, so only the Re:Earth default
 * keeps one (undefined); an operator terrain or `none` gives null, and the
 * page places objects on its bundled geoid instead of asking a public host.
 * @param {string|null|undefined} terrainUrl a parsed GEV_TERRAIN_URL
 * @returns {null|undefined}
 */
export function terrainHeightsUrl(terrainUrl) {
  return terrainUrl === undefined ? undefined : null;
}
