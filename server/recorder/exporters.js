const esc = (s) =>
  String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const iso = (ts) => new Date(ts * 1000).toISOString();
const FIELDS = ['ts', 'id', 'layer', 'lat', 'lon', 'alt', 'heading', 'speed'];

/** First and last point of a track, and stretches with no observations. */
export function summarizeTrack(points, gapSec = 300) {
  const gaps = [];
  for (let i = 1; i < points.length; i++)
    if (points[i].ts - points[i - 1].ts > gapSec)
      gaps.push({ from: points[i - 1].ts, to: points[i].ts });
  return {
    count: points.length,
    first: points[0] ?? null,
    last: points[points.length - 1] ?? null,
    gaps,
  };
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  // A leading = + - @ would run as a formula in a spreadsheet.
  // Numbers are left alone so a negative coordinate keeps its sign.
  const safe = typeof v === 'string' && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function byContact(points) {
  const groups = new Map();
  for (const p of points) {
    const key = `${p.layer}:${p.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.values()];
}

/** Returns { type, ext, body } for csv, json, geojson or gpx. */
export function exportPoints(points, format) {
  if (format === 'csv')
    return {
      type: 'text/csv; charset=utf-8',
      ext: 'csv',
      body: [
        FIELDS.join(','),
        ...points.map((p) => FIELDS.map((f) => csvCell(p[f])).join(',')),
      ].join('\n'),
    };
  if (format === 'geojson')
    return {
      type: 'application/geo+json',
      ext: 'geojson',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: byContact(points).map((track) => ({
          type: 'Feature',
          properties: { id: track[0].id, layer: track[0].layer },
          geometry: {
            type: 'LineString',
            coordinates: track.map((p) =>
              p.alt == null ? [p.lon, p.lat] : [p.lon, p.lat, p.alt],
            ),
          },
          times: track.map((p) => iso(p.ts)),
        })),
      }),
    };
  if (format === 'gpx')
    return {
      type: 'application/gpx+xml',
      ext: 'gpx',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="God's Eye View" xmlns="http://www.topografix.com/GPX/1/1">
${byContact(points)
  .map(
    (track) =>
      `<trk><name>${esc(track[0].id)}</name><type>${esc(track[0].layer)}</type><trkseg>
${track
  .map(
    (p) =>
      `<trkpt lat="${p.lat}" lon="${p.lon}">${p.alt == null ? '' : `<ele>${p.alt}</ele>`}<time>${iso(p.ts)}</time></trkpt>`,
  )
  .join('\n')}
</trkseg></trk>`,
  )
  .join('\n')}
</gpx>`,
    };
  return {
    type: 'application/json; charset=utf-8',
    ext: 'json',
    body: JSON.stringify({ points }),
  };
}
