/**
 * The NASA/JPL fireball API returns a `fields` header plus row arrays rather
 * than named objects — build a column index from `fields` instead of
 * assuming position, so a future upstream reorder degrades to "column
 * missing" (rejected) rather than silently reading the wrong value.
 */
function columnIndex(fields) {
  if (!Array.isArray(fields)) return null;
  const index = {};
  for (const [i, name] of fields.entries()) {
    if (typeof name === 'string' && name) index[name] = i;
  }
  const required = ['date', 'lat', 'lat-dir', 'lon', 'lon-dir'];
  if (required.some((name) => !(name in index))) return null;
  return index;
}

function signedCoordinate(magnitude, dir, positiveDir) {
  const value = Number(magnitude);
  if (!Number.isFinite(value)) return null;
  const normalizedDir = typeof dir === 'string' ? dir.trim().toUpperCase() : '';
  if (
    normalizedDir !== positiveDir &&
    normalizedDir !== oppositeDir(positiveDir)
  )
    return null;
  return normalizedDir === positiveDir ? value : -value;
}

function oppositeDir(positiveDir) {
  return positiveDir === 'N'
    ? 'S'
    : positiveDir === 'S'
      ? 'N'
      : positiveDir === 'E'
        ? 'W'
        : 'E';
}

/** Parse "YYYY-MM-DD HH:MM:SS" (UTC, per the API docs) into epoch ms. */
function parseUtcTimestamp(text) {
  if (typeof text !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    text.trim(),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(ms) ? ms : null;
}

function finiteOrNull(value) {
  // Number(null) is 0 and Number('') is 0 — both are the API's actual
  // "not reported" spellings, so they must fail this check explicitly
  // rather than surviving Number() coercion as a false zero.
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Validate a complete snapshot before it can replace displayed fireballs. */
export function normalizeFireballSnapshot(payload) {
  if (!Array.isArray(payload?.data)) return null;
  const index = columnIndex(payload.fields);
  if (!index) return null;
  const col = (row, name) => (name in index ? row[index[name]] : undefined);
  const rows = [];
  const ids = new Set();
  for (const [rowIndex, row] of payload.data.entries()) {
    if (!Array.isArray(row)) return null;
    const timeMs = parseUtcTimestamp(col(row, 'date'));
    const lat = signedCoordinate(col(row, 'lat'), col(row, 'lat-dir'), 'N');
    const lon = signedCoordinate(col(row, 'lon'), col(row, 'lon-dir'), 'E');
    if (
      timeMs === null ||
      lat === null ||
      Math.abs(lat) > 90 ||
      lon === null ||
      Math.abs(lon) > 180
    )
      return null;
    const stableId = `${col(row, 'date')}-${col(row, 'lat')}${col(row, 'lat-dir')}-${col(row, 'lon')}${col(row, 'lon-dir')}`;
    // Duplicate identity within one snapshot means the upstream shape changed
    // under us — fail the whole snapshot rather than silently dropping one.
    if (ids.has(stableId)) return null;
    ids.add(stableId);
    rows.push({
      stableId,
      timeMs,
      lat,
      lon,
      // Total radiated energy, 1e10 Joules (JPL's primary reported value).
      energyE10J: finiteOrNull(col(row, 'energy')),
      // Approximate total impact energy, kilotons of TNT — the closest
      // analogue to earthquake magnitude for sizing/coloring this layer.
      impactEnergyKt: finiteOrNull(col(row, 'impact-e')),
      altitudeKm: finiteOrNull(col(row, 'alt')),
      velocityKmS: finiteOrNull(col(row, 'vel')),
    });
  }
  return rows;
}
