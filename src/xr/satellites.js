import { twoline2satrec, propagate, gstime, eciToGeodetic } from 'satellite.js';

/** Propagated catalog positions are predictions, never labeled live telemetry. */
export function satelliteContacts(text, date = new Date()) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const records = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith('1 ') || !lines[i + 1].startsWith('2 ')) continue;
    const first = lines[i],
      second = lines[++i];
    try {
      const satrec = twoline2satrec(first, second);
      const result = propagate(satrec, date);
      if (!result?.position || satrec.error) continue;
      const geo = eciToGeodetic(result.position, gstime(date));
      const lat = (geo.latitude * 180) / Math.PI,
        lon = (geo.longitude * 180) / Math.PI;
      if (![lat, lon, geo.height].every(Number.isFinite) || geo.height < 0)
        continue;
      records.push({
        id: String(satrec.satnum),
        name: lines[i - 2]?.startsWith('2 ')
          ? `NORAD ${satrec.satnum}`
          : (lines[i - 2] || `NORAD ${satrec.satnum}`).replace(/^0 /, ''),
        lat,
        lon,
        altitudeM: geo.height * 1000,
        layer: 'satellites',
        detail: `Predicted orbit · ${geo.height.toFixed(0)} km altitude`,
        observedAtMs: date.getTime(),
      });
    } catch {
      /* A bad catalog entry cannot poison other orbit predictions. */
    }
  }
  if (!records.length) throw new Error('No usable orbital elements');
  return records;
}
