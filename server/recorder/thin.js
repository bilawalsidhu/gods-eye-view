const MIN_GAP_SEC = 30;
const MIN_MOVE_M = 25;
const MIN_TURN_DEG = 10;
const MAX_TRACKED = 100000;
// A parked aircraft or anchored ship still gets a point this often, so replay
// (which treats five minutes of silence as a gap) keeps showing it.
const HEARTBEAT_SEC = 240;

function metersBetween(lat1, lon1, lat2, lon2) {
  const k = Math.PI / 180;
  const dy = (lat2 - lat1) * k * 6371000;
  const dx = (lon2 - lon1) * k * 6371000 * Math.cos(((lat1 + lat2) / 2) * k);
  return Math.hypot(dx, dy);
}

function turnDeg(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Decides which positions are worth saving, per contact. */
export function createThinner({ minGapSec = MIN_GAP_SEC } = {}) {
  /** @type {Map<string,{ts:number,lat:number,lon:number,heading:number|null}>} */
  const last = new Map();
  return function keep(p) {
    const key = `${p.layer}:${p.id}`;
    const prev = last.get(key);
    if (
      prev &&
      (p.ts - prev.ts < minGapSec ||
        (p.ts - prev.ts < HEARTBEAT_SEC &&
          metersBetween(prev.lat, prev.lon, p.lat, p.lon) < MIN_MOVE_M &&
          turnDeg(prev.heading, p.heading) < MIN_TURN_DEG))
    )
      return false;
    last.delete(key);
    last.set(key, { ts: p.ts, lat: p.lat, lon: p.lon, heading: p.heading });
    if (last.size > MAX_TRACKED) last.delete(last.keys().next().value);
    return true;
  };
}
