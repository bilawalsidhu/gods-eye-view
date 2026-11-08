const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;

/** Reject malformed snapshots rather than replacing the last good display. */
export function normalizeVolcanoes(payload) {
  if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw new Error('Malformed USGS volcano response');
  const ids = new Set();
  return payload.features.map((feature) => {
    const p = feature?.properties;
    const c = feature?.geometry?.coordinates;
    const id = String(p?.vnum || p?.volcanoCd || '');
    if (feature?.geometry?.type !== 'Point' || !Array.isArray(c) || !finite(c[0], -180, 180) || !finite(c[1], -90, 90) || !id || ids.has(id) || typeof p.volcanoName !== 'string') throw new Error('Malformed USGS volcano response');
    ids.add(id);
    return { id, lon: c[0], lat: c[1], name: p.volcanoName, alert: typeof p.alertLevel === 'string' ? p.alertLevel : 'Unknown', color: typeof p.colorCode === 'string' ? p.colorCode : 'Unknown', region: typeof p.region === 'string' ? p.region : '', date: typeof p.alertDate === 'string' ? p.alertDate : '' };
  });
}

/** OVATION's longitude is 0–359 degrees; preserve all grid cells and forecast time. */
export function normalizeAurora(payload) {
  const time = payload?.['Forecast Time'];
  if (typeof time !== 'string' || !Number.isFinite(Date.parse(time)) || !Array.isArray(payload.coordinates) || payload.coordinates.length === 0 || payload.coordinates.length > 65160) throw new Error('Malformed NOAA aurora response');
  const seen = new Set();
  const rows = payload.coordinates.map((c) => {
    if (!Array.isArray(c) || c.length !== 3 || !Number.isInteger(c[0]) || !finite(c[0], 0, 359) || !Number.isInteger(c[1]) || !finite(c[1], -90, 90) || !finite(c[2], 0, 100)) throw new Error('Malformed NOAA aurora response');
    const key = c[0] * 181 + c[1];
    if (seen.has(key)) throw new Error('Malformed NOAA aurora response');
    seen.add(key);
    return { lon: c[0] >= 180 ? c[0] - 360 : c[0], lat: c[1], probability: c[2] };
  });
  return { forecastTime: time, rows };
}

export function createPublicFeedSource(kind, { fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const normalize = kind === 'volcanoes' ? normalizeVolcanoes : kind === 'aurora' ? normalizeAurora : null;
  if (!normalize) throw new TypeError('Unknown public feed');
  return { async getSnapshot({ signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(`/api/public-feeds/${kind}`, { signal });
    if (!response.ok) throw new Error(`${kind} HTTP ${response.status}`);
    const payload = await response.json();
    signal?.throwIfAborted();
    return normalize(payload);
  } };
}
