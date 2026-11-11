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
