export const GMN_DATA_URL = 'https://globalmeteornetwork.org/data/';
export const GMN_SUMMARY_URL =
  'https://globalmeteornetwork.org/data/traj_summary_data/daily/traj_summary_latest_daily.txt';
export const MAX_METEORS = 2000;

const number = (value) => {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const inRange = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;

/** GMN UTC strings have microseconds; retain the original and parse milliseconds explicitly. */
export function parseGmnTime(value) {
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(
      value || '',
    );
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}.${(match[3] || '').padEnd(3, '0').slice(0, 3)}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso ? ms : null;
}

/** Validate a portable trajectory. Heights are kilometres above the WGS84 ellipsoid. */
export function validMeteor(row) {
  return (
    row &&
    /^\d{14}_[A-Za-z0-9]{5}$/.test(row.id) &&
    Number.isFinite(row.time) &&
    parseGmnTime(row.utc) === row.time &&
    [row.begin, row.end].every(
      (p) =>
        p &&
        inRange(p.lat, -90, 90) &&
        inRange(p.lon, -180, 180) &&
        inRange(p.heightKm, 0, 300),
    ) &&
    inRange(row.duration, 0.001, 300) &&
    (row.speedKmS === null || inRange(row.speedKmS, 0.001, 150)) &&
    (row.magnitude === null || inRange(row.magnitude, -40, 30)) &&
    (row.shower === null || /^[A-Za-z0-9]{1,8}$/.test(row.shower)) &&
    Number.isInteger(row.stationCount) &&
    row.stationCount >= 2 &&
    row.stationCount <= 500 &&
    Array.isArray(row.stations) &&
    row.stations.length >= 2 &&
    row.stations.length <= 500 &&
    row.stations.every((s) => /^[A-Z0-9]{3,12}$/.test(s))
  );
}

/** Parse the documented semicolon summary by column names; never guess a changed schema. */
export function parseGmnSummary(text) {
  const lines = String(text)
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex(
    (s) => s.startsWith('#') && s.includes('Unique trajectory;'),
  );
  if (headerIndex < 0) throw new Error('Missing GMN trajectory header');
  const columns = lines[headerIndex]
    .replace(/^#\s*/, '')
    .split(';')
    .map((s) => s.trim());
  const units = (lines[headerIndex + 1] || '')
    .replace(/^#\s*/, '')
    .split(';')
    .map((s) => s.trim());
  const index = (name) => {
    const i = columns.indexOf(name);
    if (i < 0) throw new Error(`Missing GMN column: ${name}`);
    return i;
  };
  const ix = Object.fromEntries(
    [
      'Unique trajectory',
      'LatBeg',
      'LonBeg',
      'HtBeg',
      'LatEnd',
      'LonEnd',
      'HtEnd',
      'Duration',
      'Vavg',
      'Peak',
      'Num',
      'Participating',
    ].map((name) => [name, index(name)]),
  );
  const timeIndex = units.indexOf('UTC Time');
  const showerIndex = units.indexOf('code');
  if (
    timeIndex < 0 ||
    showerIndex < 0 ||
    units[ix.HtBeg] !== 'km' ||
    units[ix.HtEnd] !== 'km'
  )
    throw new Error('Unsupported GMN units');
  const generated =
    /Summary generated on (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)/.exec(
      text,
    );
  const generatedAt = parseGmnTime(generated?.[1]);
  if (generatedAt === null) throw new Error('Missing GMN generation time');
  const records = [];
  const ids = new Set();
  let rejectedCount = 0;
  let dataCount = 0;
  for (const line of lines.slice(headerIndex + 2)) {
    if (line.startsWith('#')) continue;
    if (++dataCount > 50000) throw new Error('GMN row limit exceeded');
    const fields = line.split(';').map((s) => s.trim());
    if (fields.length !== columns.length) {
      rejectedCount++;
      continue;
    }
    const n = (name) => number(fields[ix[name]]);
    const utc = fields[timeIndex];
    const row = {
      id: fields[ix['Unique trajectory']],
      utc,
      time: parseGmnTime(utc),
      shower: fields[showerIndex] === '...' ? null : fields[showerIndex],
      begin: { lat: n('LatBeg'), lon: n('LonBeg'), heightKm: n('HtBeg') },
      end: { lat: n('LatEnd'), lon: n('LonEnd'), heightKm: n('HtEnd') },
      duration: n('Duration'),
      speedKmS: n('Vavg'),
      magnitude: n('Peak'),
      stationCount: n('Num'),
      stations: fields[ix.Participating].split(',').map((s) => s.trim()),
    };
    if (!validMeteor(row) || ids.has(row.id)) {
      rejectedCount++;
      continue;
    }
    ids.add(row.id);
    records.push(row);
  }
  if (dataCount && !records.length)
    throw new Error('No valid GMN trajectories');
  const timeFrom = records.length
    ? Math.min(...records.map((r) => r.time))
    : null;
  const timeTo = records.length
    ? Math.max(...records.map((r) => r.time + r.duration * 1000))
    : null;
  // A lower magnitude is brighter. Stable tie-breaking makes repeated snapshots reproducible.
  records.sort(
    (a, b) =>
      (a.magnitude ?? Infinity) - (b.magnitude ?? Infinity) ||
      b.time - a.time ||
      a.id.localeCompare(b.id),
  );
  return {
    generatedAt,
    timeFrom,
    timeTo,
    totalCount: records.length,
    rejectedCount,
    limited: records.length > MAX_METEORS,
    records: records.slice(0, MAX_METEORS),
  };
}

/** Validate the source envelope before replacing any displayed observations. */
export function validateMeteorSnapshot(payload) {
  if (
    !payload ||
    !Array.isArray(payload.records) ||
    payload.records.length > MAX_METEORS ||
    !Number.isFinite(payload.generatedAt) ||
    !Number.isFinite(payload.fetchedAt) ||
    !Number.isInteger(payload.totalCount) ||
    payload.totalCount < payload.records.length ||
    (payload.records.length === 0 &&
      (payload.totalCount !== 0 ||
        payload.timeFrom !== null ||
        payload.timeTo !== null)) ||
    (payload.records.length > 0 &&
      (!Number.isFinite(payload.timeFrom) ||
        !Number.isFinite(payload.timeTo) ||
        payload.timeFrom > payload.timeTo ||
        !payload.records.every(
          (row) =>
            row?.time >= payload.timeFrom &&
            row.time + row.duration * 1000 <= payload.timeTo,
        ))) ||
    typeof payload.stale !== 'boolean' ||
    !payload.records.every(validMeteor) ||
    new Set(payload.records.map((r) => r.id)).size !== payload.records.length
  )
    throw new Error('Malformed meteor snapshot');
  return payload;
}
