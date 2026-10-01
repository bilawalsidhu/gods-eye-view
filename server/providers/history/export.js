/**
 * Track export formats. Pure functions over fix arrays (oldest first).
 */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Neutralize spreadsheet formula injection from feed-supplied labels.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function tracksToGeoJson(groups) {
  return {
    type: 'FeatureCollection',
    features: groups.map(({ asset, fixes }) => ({
      type: 'Feature',
      properties: {
        domain: asset.domain,
        id: asset.id,
        label: asset.label ?? null,
        start: fixes[0] ? new Date(fixes[0].t).toISOString() : null,
        end: fixes.length ? new Date(fixes.at(-1).t).toISOString() : null,
        times: fixes.map((f) => f.t),
      },
      geometry: {
        type: 'LineString',
        coordinates: fixes.map((f) =>
          Number.isFinite(f.alt) ? [f.lon, f.lat, f.alt] : [f.lon, f.lat],
        ),
      },
    })),
  };
}

export function tracksToCsv(groups) {
  const lines = ['domain,id,label,time_utc,lat,lon,alt_m,speed,course,squawk'];
  for (const { asset, fixes } of groups)
    for (const f of fixes)
      lines.push(
        [
          asset.domain,
          asset.id,
          asset.label,
          new Date(f.t).toISOString(),
          f.lat,
          f.lon,
          f.alt,
          f.speed,
          f.course,
          f.squawk,
        ]
          .map(csvCell)
          .join(','),
      );
  return lines.join('\n') + '\n';
}

export function tracksToKml(groups) {
  const placemarks = groups
    .map(({ asset, fixes }) => {
      const whens = fixes.map((f) => `<when>${new Date(f.t).toISOString()}</when>`).join('');
      const coords = fixes
        .map((f) => `<gx:coord>${f.lon} ${f.lat} ${Number.isFinite(f.alt) ? f.alt : 0}</gx:coord>`)
        .join('');
      return `<Placemark><name>${esc(asset.label || asset.id)}</name><description>${esc(`${asset.domain} ${asset.id}`)}</description><gx:Track><altitudeMode>absolute</altitudeMode>${whens}${coords}</gx:Track></Placemark>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>God's Eye View export</name>${placemarks}</Document></kml>`;
}

export const EXPORT_TYPES = Object.freeze({
  geojson: { type: 'application/geo+json', ext: 'geojson' },
  csv: { type: 'text/csv; charset=utf-8', ext: 'csv' },
  kml: { type: 'application/vnd.google-earth.kml+xml', ext: 'kml' },
});

export function renderExport(format, groups) {
  if (format === 'geojson') return JSON.stringify(tracksToGeoJson(groups));
  if (format === 'csv') return tracksToCsv(groups);
  if (format === 'kml') return tracksToKml(groups);
  return null;
}
