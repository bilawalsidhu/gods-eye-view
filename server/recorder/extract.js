const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function point(layer, id, lat, lon, alt, heading, speed, ts) {
  if (!id || num(lat) === null || num(lon) === null) return null;
  return {
    id: String(id),
    layer,
    lat,
    lon,
    alt: num(alt),
    heading: num(heading),
    speed: num(speed),
    ts,
  };
}

/** Positions from an /api/flights body (OpenSky state vectors). */
export function aircraftPoints(body, nowSec) {
  const out = [];
  for (const s of Array.isArray(body?.states) ? body.states : []) {
    if (!Array.isArray(s)) continue;
    const p = point(
      'air',
      s[0],
      s[6],
      s[5],
      s[13] ?? s[7],
      s[10],
      s[9],
      num(s[3]) ?? nowSec,
    );
    if (p) out.push(p);
  }
  return out;
}

/** Positions from an /api/military body (adsb.lol v2 `ac` rows). */
export function militaryPoints(body, nowSec) {
  const out = [];
  for (const a of Array.isArray(body?.ac) ? body.ac : []) {
    const alt =
      num(a?.alt_geom) ??
      (num(a?.alt_baro) === null ? null : a.alt_baro * 0.3048);
    const speed = num(a?.gs) === null ? null : a.gs * 0.514444;
    const p = point(
      'mil',
      a?.hex,
      a?.lat,
      a?.lon,
      alt,
      a?.track,
      speed,
      nowSec,
    );
    if (p) out.push(p);
  }
  return out;
}

/** Positions from AIS rows (aisStreamRows). */
export function vesselPoints(rows, nowSec) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const p = point(
      'vessel',
      r?.mmsi,
      r?.lat,
      r?.lon,
      null,
      r?.heading ?? r?.course,
      r?.speed,
      nowSec,
    );
    if (p) out.push(p);
  }
  return out;
}

/** Positions from /api/local-receivers/aircraft (the operator's own receivers). */
export function localReceiverPoints(body, nowSec) {
  const out = [];
  for (const r of Array.isArray(body?.records) ? body.records : []) {
    if (!r || num(r.lat) === null || num(r.lon) === null) continue;
    const ts =
      num(r.lastPositionAt) === null
        ? nowSec
        : Math.floor(r.lastPositionAt / 1000);
    const alt = num(r.altitudeFt) === null ? null : r.altitudeFt * 0.3048;
    const speed =
      num(r.groundSpeedKt) === null ? null : r.groundSpeedKt * 0.514444;
    const p = point('local', r.icao, r.lat, r.lon, alt, r.trackDeg, speed, ts);
    if (p) out.push(p);
  }
  return out;
}
