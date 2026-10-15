export function inUkBounds(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 49.8 &&
    lat <= 61 &&
    lon >= -8.6 &&
    lon <= 2
  );
}
export const text = (value, limit = 1600) =>
  String(value ?? '')
    .replace(/\u0000/g, '')
    .slice(0, limit);
export function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function isoTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && value < 1e11) value *= 1000;
  if (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value)
  )
    value += 'Z';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function readingAge(time, now = Date.now(), staleMs = 3600000) {
  const at = Date.parse(time);
  if (!Number.isFinite(at)) return 'Time not supplied';
  if (at > now + 300000) return 'Source time is in the future';
  return now - at > staleMs
    ? 'Old observation / update'
    : 'Recent observation / update';
}
function point(lat, lon) {
  return inUkBounds(lat, lon) ? { lat, lon } : {};
}
function xmlText(value) {
  return text(
    String(value ?? '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim(),
  );
}
export function rssRows(xml, fallbackUrl) {
  if (typeof xml !== 'string' || !/<rss\b/i.test(xml))
    throw new Error('Unexpected RSS response');
  const rows = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    if (rows.length >= 5000) {
      Object.defineProperty(rows, 'truncated', { value: true });
      break;
    }
    const item = match[1];
    const field = (name) =>
      xmlText(
        item.match(
          new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'),
        )?.[1],
      );
    const coords = field('georss:point').split(/\s+/).map(Number);
    rows.push({
      id: field('guid') || String(rows.length),
      name: field('title'),
      details: field('description'),
      time: isoTime(field('pubDate')),
      url: safeLink(field('link')) || fallbackUrl,
      ...point(coords[0], coords[1]),
    });
  }
  return rows;
}
export function normalizeUkFeed(id, data, extra = {}) {
  let rows;
  if (id === 'ea-floods')
    rows = (data.items || []).map((r) => ({
      id: r.floodAreaID,
      name: text(r.description),
      details: `${text(r.severity)} · ${text(r.message)}`,
      time: isoTime(r.timeMessageChanged),
      url: `https://check-for-flooding.service.gov.uk/target-area/${encodeURIComponent(r.floodAreaID)}`,
    }));
  else if (id === 'ea-rivers') {
    const readings = new Map((extra.items || []).map((r) => [r.measure, r]));
    rows = (data.items || []).flatMap((r) => {
      if (!inUkBounds(r.lat, r.long) || !Array.isArray(r.measures)) return [];
      const measure =
        r.measures.find(
          (m) => m.parameter === 'level' && readings.has(m['@id']),
        ) || r.measures.find((m) => m.parameter === 'level');
      if (!measure) return [];
      const reading = readings.get(measure['@id']);
      return [
        {
          id: r.stationReference,
          name: text(r.label),
          details: `${text(r.riverName)} · ${Number.isFinite(reading?.value) ? `${reading.value} ${text(measure.unitName)}` : 'No current reading supplied'} · ${text(r.town)}`,
          time: isoTime(reading?.dateTime),
          url: safeLink(r['@id']),
          ...point(r.lat, r.long),
        },
      ];
    });
  } else if (id === 'sepa-rivers')
    rows = (data.features || []).map((f) => ({
      id: f.properties?.station_no,
      name: text(f.properties?.station_name),
      details: `${Number.isFinite(f.properties?.ts_value) ? f.properties.ts_value + ' m' : 'No reading supplied'} · river/tidal gauge · source quality code ${text(f.properties?.q_code)}`,
      time: isoTime(f.properties?.timestamp),
      url: 'https://waterlevels.sepa.org.uk/',
      ...point(f.geometry?.coordinates?.[1], f.geometry?.coordinates?.[0]),
    }));
  else if (id === 'air')
    rows = data
      .map((f) => {
        const c = f.geometry?.coordinates || [];
        // This service actually supplies latitude first, despite its GeoJSON wrapper.
        const p = inUkBounds(c[0], c[1])
          ? point(c[0], c[1])
          : point(c[1], c[0]);
        return {
          id: String(f.properties?.id),
          name: text(f.properties?.label),
          details:
            'Station catalogue entry; current operation and freshness are established only by its last observation',
          series: Object.keys(f.properties?.timeseries || {})
            .filter((id) => /^\d{1,12}$/.test(id))
            .slice(0, 8),
          url: 'https://uk-air.defra.gov.uk/',
          ...p,
        };
      })
      .filter((r) => Number.isFinite(r.lat));
  else if (id === 'weather')
    rows = data
      .filter((r) => /^EG[A-Z]{2}$/.test(r.icaoId) && inUkBounds(r.lat, r.lon))
      .map((r) => ({
        id: r.icaoId,
        name: `${text(r.name)} (${r.icaoId})`,
        details: `${Number.isFinite(r.temp) ? r.temp + ' °C' : 'Temperature unavailable'} · wind ${text(r.wspd)} kt · ${text(r.rawOb)}`,
        time: isoTime(r.obsTime),
        url: `https://aviationweather.gov/data/metar/?id=${encodeURIComponent(r.icaoId)}`,
        ...point(r.lat, r.lon),
      }));
  else if (id === 'london-roads')
    rows = data.map((r) => {
      let coords = [];
      try {
        coords = JSON.parse(r.point);
      } catch {}
      return {
        id: r.id,
        name: text(r.location || r.comments, 160),
        details: `${text(r.severity)} · ${text(r.comments)} ${text(r.currentUpdate)}`,
        time: isoTime(r.lastModifiedTime),
        url: 'https://tfl.gov.uk/traffic/status/',
        ...point(coords[1], coords[0]),
      };
    });
  else if (id === 'london-rail')
    rows = data.map((r) => ({
      id: r.id,
      name: text(r.name),
      details: (r.lineStatuses || [])
        .map(
          (s) =>
            `${text(s.statusSeverityDescription)}${s.reason ? ': ' + text(s.reason) : ''}`,
        )
        .join(' · '),
      url: 'https://tfl.gov.uk/tube-dlr-overground/status/',
    }));
  else throw new Error('Unknown feed');
  if (!Array.isArray(rows)) throw new Error('Unexpected feed shape');
  return rows.slice(0, 10000).map((r, i) => ({
    ...r,
    id: text(r.id || i, 100),
    name: text(r.name, 250),
    details: text(r.details),
    time: r.time || null,
  }));
}
