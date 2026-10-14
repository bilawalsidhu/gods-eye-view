/**
 * NOAA National Data Buoy Center (NDBC) Real-Time Observations Parser.
 *
 * Source: https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt
 * Format: Space-delimited table with two header rows starting with '#'
 * Missing values are represented as 'MM'.
 *
 * Header columns:
 * #STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
 */

function parseNumber(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || s === 'MM') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse and normalize NOAA NDBC latest_obs.txt raw text.
 * @param {string} text - Raw text from https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt
 * @returns {Array<Object>|null} List of validated station records, or null if malformed.
 */
export function parseNdbcLatestObs(text) {
  if (typeof text !== 'string') return null;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 3) return null;

  // Validate header starts with #STN
  const header = lines[0].trim();
  if (!header.startsWith('#STN')) return null;

  const records = [];
  const seenIds = new Set();

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const cols = line.split(/\s+/);
    if (cols.length < 5) continue;

    const id = cols[0];
    if (!id || seenIds.has(id)) continue;

    const lat = parseNumber(cols[1]);
    const lon = parseNumber(cols[2]);

    // Coordinates must be finite and within valid geographic bounds
    if (
      lat == null ||
      lon == null ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      continue;
    }

    const year = parseNumber(cols[3]);
    const month = parseNumber(cols[4]);
    const day = parseNumber(cols[5]);
    const hour = parseNumber(cols[6]);
    const minute = parseNumber(cols[7]);

    let timeMs = null;
    let timeIso = null;
    if (
      year != null &&
      month != null &&
      day != null &&
      hour != null &&
      minute != null
    ) {
      timeMs = Date.UTC(year, month - 1, day, hour, minute);
      if (Number.isFinite(timeMs)) {
        timeIso = new Date(timeMs).toISOString();
      } else {
        timeMs = null;
      }
    }

    const windDirDeg = parseNumber(cols[8]);
    const windSpeedMps = parseNumber(cols[9]);
    const windGustMps = parseNumber(cols[10]);
    const waveHeightM = parseNumber(cols[11]);
    const wavePeriodSec = parseNumber(cols[12]);
    const avgWavePeriodSec = parseNumber(cols[13]);
    const waveDirDeg = parseNumber(cols[14]);
    const pressureHpa = parseNumber(cols[15]);
    const pressureTendencyHpa = parseNumber(cols[16]);
    const airTempC = parseNumber(cols[17]);
    const waterTempC = parseNumber(cols[18]);
    const dewpointC = parseNumber(cols[19]);
    const visibilityNmi = parseNumber(cols[20]);
    const tideFt = parseNumber(cols[21]);

    seenIds.add(id);
    records.push({
      id,
      lat,
      lon,
      timeMs,
      timeIso,
      windDirDeg,
      windSpeedMps,
      windGustMps,
      waveHeightM,
      wavePeriodSec,
      avgWavePeriodSec,
      waveDirDeg,
      pressureHpa,
      pressureTendencyHpa,
      airTempC,
      waterTempC,
      dewpointC,
      visibilityNmi,
      tideFt,
    });
  }

  return records;
}

/**
 * Normalize an already-parsed JSON station array or validate snapshot payload.
 * @param {Array<Object>|{stations: Array<Object>}} payload
 * @returns {Array<Object>|null}
 */
export function normalizeOceanStationSnapshot(payload) {
  const list = Array.isArray(payload) ? payload : payload?.stations;
  if (!Array.isArray(list)) return null;

  const valid = [];
  const seenIds = new Set();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id =
      typeof item.id === 'string'
        ? item.id.trim()
        : String(item.id || '').trim();
    if (!id || seenIds.has(id)) continue;

    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      continue;
    }

    const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

    seenIds.add(id);
    valid.push({
      id,
      lat,
      lon,
      timeMs: numOrNull(item.timeMs),
      timeIso: typeof item.timeIso === 'string' ? item.timeIso : null,
      windDirDeg: numOrNull(item.windDirDeg),
      windSpeedMps: numOrNull(item.windSpeedMps),
      windGustMps: numOrNull(item.windGustMps),
      waveHeightM: numOrNull(item.waveHeightM),
      wavePeriodSec: numOrNull(item.wavePeriodSec),
      avgWavePeriodSec: numOrNull(item.avgWavePeriodSec),
      waveDirDeg: numOrNull(item.waveDirDeg),
      pressureHpa: numOrNull(item.pressureHpa),
      pressureTendencyHpa: numOrNull(item.pressureTendencyHpa),
      airTempC: numOrNull(item.airTempC),
      waterTempC: numOrNull(item.waterTempC),
      dewpointC: numOrNull(item.dewpointC),
      visibilityNmi: numOrNull(item.visibilityNmi),
      tideFt: numOrNull(item.tideFt),
    });
  }

  return valid;
}
