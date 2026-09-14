/**
 * NOAA NDBC text-feed parsing — pure functions, no Cesium/DOM/network.
 *
 * Upstream: https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt
 * Header (confirmed live 2026-08-28):
 *   #STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
 *   #text deg deg  yr mo day hr mn degT m/s m/s  m  sec sec degT hPa  hPa degC degC degC nmi  ft
 *
 * Quirks this module owns:
 * - `MM` is the missing-value sentinel in EVERY data column — mapped to null,
 *   never NaN, so records stay JSON-safe.
 * - The month column is literally named `MM` and the minute column `mm`;
 *   header names are matched case-sensitively so the two never collide.
 * - This product reports wind in m/s; other NDBC products use knots — the
 *   units row is asserted metric by {@link isLikelyNdbc} so a product swap
 *   fails loudly instead of mis-scaling every wind speed.
 * - Unknown stations / upstream errors come back as HTML, never column text —
 *   {@link isLikelyNdbc} gates parsing.
 * - Station names/types are NOT in the bulk file; they come from
 *   activestations.xml via {@link parseActiveStationsXml} (non-fatal join).
 */

/** Header fields that must all be present for a payload to count as NDBC latest_obs. */
const REQUIRED_HEADER_FIELDS = ['STN', 'LAT', 'LON', 'YYYY', 'MM', 'DD', 'hh', 'mm', 'WVHT', 'WSPD'];

/**
 * Numeric cell → finite number; the `MM` sentinel, blanks, and garbage → null.
 * @param {string|undefined} value - Raw whitespace-split cell.
 * @returns {?number}
 */
export function mmOrNull(value) {
  if (value === undefined || value === '' || value === 'MM') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // PTDY reports "-0.0" for falling-then-steady pressure; JSON serializes -0
  // as "0", which would break record round-trips, so normalize it away.
  return Object.is(number, -0) ? 0 : number;
}

/**
 * Cheap "is this actually NDBC latest_obs text?" check. HTML error pages
 * (first non-whitespace char `<`) fail it; the header line must carry the
 * expected station/time/measurement fields and the units row must be metric
 * (`m/s`) — see the product-swap quirk in the module header.
 * @param {string} text - Raw upstream response body.
 * @returns {boolean}
 */
export function isLikelyNdbc(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimStart();
  if (!trimmed || trimmed[0] !== '#') return false;
  const lines = trimmed.split('\n');
  const header = headerFields(lines[0]);
  if (!REQUIRED_HEADER_FIELDS.every((required) => header.includes(required))) return false;
  const unitsLine = lines[1] ?? '';
  return unitsLine.trimStart().startsWith('#') && unitsLine.includes('m/s');
}

/**
 * Parse an NDBC latest_obs bulk payload into flat per-station records.
 *
 * Tolerates CRLF, trailing newlines, and malformed rows (skipped — a row
 * needs a station id, finite lat/lon, and a parseable UTC observation time).
 * A header-only payload parses to `[]`. Non-NDBC input (HTML/error text —
 * see {@link isLikelyNdbc}) returns `null` so callers can distinguish
 * "no observations" from "upstream failure".
 *
 * @param {string} text - Raw latest_obs payload.
 * @returns {?Array<{stationId: string, lat: number, lon: number, timeMs: number,
 *   windDirDeg: ?number, windSpeedMs: ?number, gustMs: ?number, waveHeightM: ?number,
 *   dominantPeriodS: ?number, avgPeriodS: ?number, waveDirDeg: ?number,
 *   pressureHpa: ?number, pressureTendencyHpa: ?number, airTempC: ?number,
 *   sstC: ?number, dewPointC: ?number, visibilityNmi: ?number, tideFt: ?number}>}
 *   Records, or null for non-NDBC payloads.
 */
export function parseNdbcLatestObs(text) {
  if (!isLikelyNdbc(text)) return null;
  const lines = text.trimStart().split('\n');

  // Column index by header NAME (case-sensitive: month `MM` vs minute `mm`)
  // so the parser survives column reordering across product revisions.
  const header = headerFields(lines[0]);
  const col = new Map(header.map((name, i) => [name, i]));
  const iStn = col.get('STN');
  const iLat = col.get('LAT');
  const iLon = col.get('LON');
  const iYear = col.get('YYYY');
  const iMonth = col.get('MM');
  const iDay = col.get('DD');
  const iHour = col.get('hh');
  const iMinute = col.get('mm');

  const records = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < header.length) continue; // malformed row — skip

    const stationId = parts[iStn];
    if (!stationId || stationId === 'MM') continue;
    const lat = mmOrNull(parts[iLat]);
    const lon = mmOrNull(parts[iLon]);
    if (lat === null || lon === null) continue;
    const timeMs = observationMsUtc(parts[iYear], parts[iMonth], parts[iDay], parts[iHour], parts[iMinute]);
    if (!Number.isFinite(timeMs)) continue;

    records.push({
      stationId,
      lat,
      lon,
      timeMs,
      windDirDeg: mmOrNull(parts[col.get('WDIR')]),
      windSpeedMs: mmOrNull(parts[col.get('WSPD')]),
      gustMs: mmOrNull(parts[col.get('GST')]),
      waveHeightM: mmOrNull(parts[col.get('WVHT')]),
      dominantPeriodS: mmOrNull(parts[col.get('DPD')]),
      avgPeriodS: mmOrNull(parts[col.get('APD')]),
      waveDirDeg: mmOrNull(parts[col.get('MWD')]),
      pressureHpa: mmOrNull(parts[col.get('PRES')]),
      pressureTendencyHpa: mmOrNull(parts[col.get('PTDY')]),
      airTempC: mmOrNull(parts[col.get('ATMP')]),
      sstC: mmOrNull(parts[col.get('WTMP')]),
      dewPointC: mmOrNull(parts[col.get('DEWP')]),
      visibilityNmi: mmOrNull(parts[col.get('VIS')]),
      tideFt: mmOrNull(parts[col.get('TIDE')]),
    });
  }
  return records;
}

/**
 * Parse NDBC activestations.xml into a Map of station metadata by id.
 * Regex attribute extraction on self-closing `<station …/>` elements — no
 * XML dependency; garbage input yields an empty Map because the name/type
 * join is decorative and must never take the observation feed down.
 * @param {string} xml - Raw activestations.xml body.
 * @returns {Map<string, {id: string, lat: number, lon: number, name: string,
 *   type: string, met: boolean, currents: boolean}>}
 */
export function parseActiveStationsXml(xml) {
  const stations = new Map();
  if (typeof xml !== 'string' || !xml.includes('<station ')) return stations;
  const elements = xml.match(/<station\s[^>]*\/>/g) ?? [];
  for (const element of elements) {
    const id = attr(element, 'id');
    const lat = Number(attr(element, 'lat'));
    const lon = Number(attr(element, 'lon'));
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stations.set(id, {
      id,
      lat,
      lon,
      name: decodeXmlEntities(attr(element, 'name')),
      type: attr(element, 'type'),
      met: attr(element, 'met') === 'y',
      currents: attr(element, 'currents') === 'y',
    });
  }
  return stations;
}

/** Header line → field names with the leading `#` stripped from the first. */
function headerFields(line) {
  return String(line ?? '').trim().replace(/^#/, '').split(/\s+/);
}

/**
 * Convert the five latest_obs date columns (UTC) into epoch milliseconds.
 * Returns NaN when any column is missing/`MM` or out of range.
 */
function observationMsUtc(year, month, day, hour, minute) {
  const y = mmOrNull(year);
  const mo = mmOrNull(month);
  const d = mmOrNull(day);
  const h = mmOrNull(hour);
  const mi = mmOrNull(minute);
  if (y === null || mo === null || d === null || h === null || mi === null) return NaN;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return NaN;
  return Date.UTC(y, mo - 1, d, h, mi);
}

/** Attribute value from a serialized XML element, '' when absent. */
function attr(element, name) {
  const match = element.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : '';
}

/** Minimal XML entity decode for display names (&amp; &lt; &gt; &quot; &apos;). */
function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
