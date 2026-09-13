import mgrs from 'mgrs';

/**
 * Parses degrees, minutes, seconds string into decimal degrees.
 * @param {string} str
 * @returns {number | null}
 */
function parseDms(str) {
  const dmsRegex = /^(-?\d+(?:\.\d+)?)[°\s]+(?:(\d+(?:\.\d+)?)[′'\s]+)?(?:(\d+(?:\.\d+)?)[″"\s]*)?([NSEWnsew])?$/;
  const match = str.trim().match(dmsRegex);
  if (!match) return null;

  const degrees = parseFloat(match[1]);
  const minutes = match[2] ? parseFloat(match[2]) : 0;
  const seconds = match[3] ? parseFloat(match[3]) : 0;
  const direction = match[4]?.toUpperCase();

  let dec = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  if (degrees < 0 || direction === 'S' || direction === 'W') {
    dec = -dec;
  }
  return dec;
}

/**
 * Parse a single coordinate component (lat or lon), decimal or directional.
 * @param {string} component
 * @returns {number | null}
 */
function parseCoordinateComponent(component) {
  const trimmed = component.trim();
  if (!trimmed) return null;

  // 1. Check DMS format
  if (/[°'"]/.test(trimmed)) {
    const dmsVal = parseDms(trimmed);
    if (dmsVal !== null && !Number.isNaN(dmsVal)) return dmsVal;
  }

  // 2. Cardinal prefix/suffix with decimal, e.g. "N 43.1731", "43.1731N", "79.0384W"
  const cardinalMatch = trimmed.match(/^([NSEWnsew])?\s*(-?\d+(?:\.\d+)?)\s*([NSEWnsew])?$/);
  if (cardinalMatch) {
    const dir = (cardinalMatch[1] || cardinalMatch[3] || '').toUpperCase();
    let val = parseFloat(cardinalMatch[2]);
    if (Number.isNaN(val)) return null;
    if (dir === 'S' || dir === 'W') val = -Math.abs(val);
    else if (dir === 'N' || dir === 'E') val = Math.abs(val);
    return val;
  }

  // 3. Plain decimal number
  const num = parseFloat(trimmed);
  return Number.isFinite(num) ? num : null;
}

/**
 * Format decimal coordinates into clean user-facing label.
 * @param {number} lat
 * @param {number} lng
 * @returns {string}
 */
export function formatCoordinateLabel(lat, lng) {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lngDir = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lng).toFixed(4)}° ${lngDir}`;
}

/**
 * Parse a coordinate query string into { lat, lng, label }.
 * Supports decimal degrees, directional notation, DMS, and MGRS.
 * @param {string} query
 * @returns {{ lat: number, lng: number, label: string } | null}
 */
export function parseCoordinateQuery(query) {
  if (typeof query !== 'string') return null;
  const q = query.trim();
  if (!q || q.length < 3) return null;

  // 1. Try MGRS parsing (e.g. "33UXP0500444998" or "18TWN0512")
  if (/^\d{1,2}[A-Za-z]\s*[A-Za-z]{2}\s*\d{2,10}$/.test(q)) {
    try {
      const mgrsLib = mgrs.default || mgrs;
      const point = mgrsLib.toPoint(q.replace(/\s+/g, ''));
      if (Array.isArray(point) && point.length >= 2) {
        const [lon, lat] = point;
        if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
          return {
            lat,
            lng: lon,
            label: `${q.toUpperCase()} (${formatCoordinateLabel(lat, lon)})`,
          };
        }
      }
    } catch {
      // Not a valid MGRS, fall through
    }
  }

  // 2. Delimiter split: comma, semicolon, or slash
  let parts = null;
  if (/[,;/]/.test(q)) {
    parts = q.split(/[,;/]/).map((s) => s.trim()).filter(Boolean);
  } else {
    // Space split if exactly two numbers or two directional coordinates
    const spaceTokens = q.split(/\s+/).filter(Boolean);
    if (spaceTokens.length === 2) {
      parts = spaceTokens;
    } else if (spaceTokens.length === 4 && /[NSEWnsew]/.test(q)) {
      if (['N', 'S', 'E', 'W'].includes(spaceTokens[0].toUpperCase())) {
        parts = [`${spaceTokens[0]} ${spaceTokens[1]}`, `${spaceTokens[2]} ${spaceTokens[3]}`];
      } else {
        parts = [`${spaceTokens[0]} ${spaceTokens[1]}`, `${spaceTokens[2]} ${spaceTokens[3]}`];
      }
    }
  }

  if (!parts || parts.length !== 2) return null;

  const lat = parseCoordinateComponent(parts[0]);
  const lng = parseCoordinateComponent(parts[1]);

  if (lat === null || lng === null) return null;

  // Bounds check
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return {
    lat,
    lng,
    label: formatCoordinateLabel(lat, lng),
  };
}
