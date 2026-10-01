/**
 * Pure helpers for the Ops console. No DOM, no Cesium, no clock.
 */

/**
 * Interpolate a fix array ([t, lat, lon, alt, course, speed] tuples, sorted)
 * at time t. Returns null outside the track, or across a gap longer than
 * maxGapMs (we never invent a path through missing data).
 */
export function interpolateTrack(
  fixes,
  t,
  { maxGapMs = 10 * 60_000, holdMs = 90_000 } = {},
) {
  if (!fixes?.length) return null;
  const first = fixes[0];
  const last = fixes[fixes.length - 1];
  if (t < first[0]) return null;
  if (t >= last[0]) return t - last[0] <= holdMs ? toFix(last, true) : null;
  let lo = 0;
  let hi = fixes.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const a = fixes[lo];
  const b = fixes[hi];
  if (b[0] - a[0] > maxGapMs) return t - a[0] <= holdMs ? toFix(a, true) : null;
  const f = (t - a[0]) / (b[0] - a[0] || 1);
  const lerp = (x, y) =>
    Number.isFinite(x) && Number.isFinite(y)
      ? x + (y - x) * f
      : (x ?? y ?? null);
  let lonA = a[2];
  let lonB = b[2];
  if (Math.abs(lonB - lonA) > 180) lonB += lonB < lonA ? 360 : -360;
  let lon = lonA + (lonB - lonA) * f;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return {
    t,
    lat: lerp(a[1], b[1]),
    lon,
    alt: lerp(a[3], b[3]),
    course: Number.isFinite(b[4]) ? b[4] : (a[4] ?? null),
    speed: lerp(a[5], b[5]),
    held: false,
  };
}

function toFix(r, held) {
  return {
    t: r[0],
    lat: r[1],
    lon: r[2],
    alt: r[3] ?? null,
    course: r[4] ?? null,
    speed: r[5] ?? null,
    held,
  };
}

/** Clamp a view rectangle (degrees) into an API bbox, or null when global. */
export function viewBbox(rect, maxSpanDeg = 30) {
  if (!rect) return null;
  let { west, south, east, north } = rect;
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (east < west) return null; // crosses the antimeridian: ask for global
  south = Math.max(-90, south);
  north = Math.min(90, north);
  if (north - south > maxSpanDeg || east - west > maxSpanDeg) return null;
  return { minLat: south, minLon: west, maxLat: north, maxLon: east };
}

export const bboxParam = (b) =>
  b
    ? [b.minLat, b.minLon, b.maxLat, b.maxLon]
        .map((v) => v.toFixed(5))
        .join(',')
    : '';

/** Short UTC clock "HH:MM:SSZ" and date "YYYY-MM-DD". */
export function utcClock(t) {
  return new Date(t).toISOString().slice(11, 19) + 'Z';
}
export function utcDate(t) {
  return new Date(t).toISOString().slice(0, 10);
}

/** Relative time "3 min ago" / "in 4 min". */
export function ago(t, now) {
  const d = Math.round((now - t) / 1000);
  const a = Math.abs(d);
  const s =
    a < 60
      ? `${a} s`
      : a < 3600
        ? `${Math.round(a / 60)} min`
        : a < 86400
          ? `${Math.round(a / 3600)} h`
          : `${Math.round(a / 86400)} d`;
  return d >= 0 ? `${s} ago` : `in ${s}`;
}

/** Lowercase slug id from a display name, unique against `taken`. */
export function slugId(name, taken = []) {
  const base =
    String(name || 'item')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'item';
  const used = new Set(taken);
  if (!used.has(base) && /^[a-z0-9]/.test(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const id = `${base}-${i}`.replace(/^-/, 'x');
    if (!used.has(id)) return id;
  }
  return `${base}-${Date.now() % 100000}`;
}

/**
 * Parse watchlist entry text like "air abc123", "air label:N911",
 * "sea 366999999", "space 25544" (one per line).
 */
export function parseEntries(text) {
  const entries = [];
  const errors = [];
  for (const raw of String(text || '').split(/\n|,/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(air|sea|space)\s+(?:(label):)?\s*([A-Za-z0-9 -]{1,16})$/i.exec(
      line,
    );
    if (!m) {
      errors.push(line);
      continue;
    }
    const domain = m[1].toLowerCase();
    if (m[2]) entries.push({ domain, label: m[3].trim().toUpperCase() });
    else entries.push({ domain, id: m[3].trim().toLowerCase() });
  }
  return { entries, errors };
}

export const formatEntry = (e) =>
  `${e.domain} ${e.label ? `label:${e.label}` : e.id}`;

/**
 * Build a rule payload from the console's form fields.
 * @param {Record<string,string>} f Raw form values.
 */
export function ruleFromForm(f) {
  const num = (v) =>
    v === '' || v === undefined || v === null ? undefined : Number(v);
  const params = {};
  switch (f.kind) {
    case 'fence-enter':
    case 'fence-exit':
      params.fenceId = f.fenceId;
      break;
    case 'fence-dwell':
      params.fenceId = f.fenceId;
      params.minutes = num(f.minutes);
      break;
    case 'squawk':
      if (f.codes) params.codes = f.codes.split(/[\s,]+/).filter(Boolean);
      break;
    case 'dark':
      params.minutes = num(f.minutes);
      break;
    case 'appear':
      params.gapMinutes = num(f.minutes);
      break;
    case 'speed':
    case 'altitude':
      if (num(f.min) !== undefined) params.min = num(f.min);
      if (num(f.max) !== undefined) params.max = num(f.max);
      break;
    case 'loiter':
      params.radiusM = num(f.radiusKm) * 1000;
      params.minutes = num(f.minutes);
      break;
    case 'overhead':
      params.fenceId = f.fenceId;
      if (num(f.minElevDeg) !== undefined)
        params.minElevDeg = num(f.minElevDeg);
      if (num(f.leadMinutes) !== undefined)
        params.leadMinutes = num(f.leadMinutes);
      break;
  }
  const scope = {};
  if (f.watchlistId) scope.watchlistId = f.watchlistId;
  if (f.domain) scope.domain = f.domain;
  return {
    name: f.name,
    kind: f.kind,
    severity: f.severity || 'info',
    scope,
    params,
    channels: f.channelId ? [f.channelId] : [],
  };
}

/** Which form fields a rule kind uses (drives the console form). */
export const RULE_FIELDS = Object.freeze({
  'fence-enter': ['fenceId', 'watchlistId', 'domain'],
  'fence-exit': ['fenceId', 'watchlistId', 'domain'],
  'fence-dwell': ['fenceId', 'minutes', 'watchlistId', 'domain'],
  squawk: ['codes', 'watchlistId'],
  dark: ['watchlistId', 'minutes'],
  appear: ['watchlistId', 'minutes'],
  speed: ['min', 'max', 'watchlistId', 'domain'],
  altitude: ['min', 'max', 'watchlistId'],
  loiter: ['radiusKm', 'minutes', 'watchlistId'],
  overhead: ['fenceId', 'watchlistId', 'minElevDeg', 'leadMinutes'],
});

/** Great-circle radius between two clicked points, metres. */
export function radiusBetween(a, b) {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Fence payload from clicked points. */
export function fenceFromClicks(mode, points, name) {
  if (mode === 'circle') {
    if (points.length < 2) return null;
    const radiusM = Math.round(radiusBetween(points[0], points[1]));
    return {
      name,
      shape: {
        type: 'circle',
        center: [points[0].lon, points[0].lat],
        radiusM,
      },
    };
  }
  if (points.length < 3) return null;
  return {
    name,
    shape: { type: 'polygon', coords: points.map((p) => [p.lon, p.lat]) },
  };
}

/** SVG path for an uptime sparkline (values 0..1, nulls break the line). */
export function sparklinePath(series, width, height) {
  if (!series?.length) return '';
  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const span = t1 - t0 || 1;
  let d = '';
  let pen = false;
  for (const p of series) {
    if (p.uptime === null || p.uptime === undefined) {
      pen = false;
      continue;
    }
    const x = series.length === 1 ? width / 2 : ((p.t - t0) / span) * width;
    const y = height - p.uptime * height;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Coverage cell colour by overlap count. */
export function coverageColor(count) {
  if (count <= 0) return null;
  if (count === 1) return [0, 212, 255, 0.28];
  if (count === 2) return [240, 166, 60, 0.38];
  return [255, 92, 92, 0.45];
}

/** Escape text for innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
}
