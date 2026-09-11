// Signal coordinates are WGS84. Timing is never inferred from OSM or traffic flow.
export const SIGNAL_LIMIT = 4000;
export const MAX_SIGNAL_AGE_MS = 5000;
const finite = Number.isFinite;

export function signalBounds(lat, lon, radius = 0.025) {
  if (!finite(lat) || !finite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
  const south = Math.max(-90, lat - radius);
  const north = Math.min(90, lat + radius);
  const west = lon - radius;
  const east = lon + radius;
  if (west < -180) return [{ south, north, west: west + 360, east: 180 }, { south, north, west: -180, east }];
  if (east > 180) return [{ south, north, west, east: 180 }, { south, north, west: -180, east: east - 360 }];
  return [{ south, north, west, east }];
}

export function signalQuery(boxes) {
  return '[out:json][timeout:20];(' + boxes.map(({ south, west, north, east }) => {
    const bbox = `${south},${west},${north},${east}`;
    return `node[highway=traffic_signals](${bbox});node[highway=crossing][crossing=traffic_signals](${bbox});node[highway=crossing]["crossing:signals"=yes](${bbox});`;
  }).join('') + ');out body;';
}

export function parseSignalLocations(payload) {
  if (!Array.isArray(payload?.elements) || payload.remark) throw new Error('Incomplete traffic-light map response');
  const seen = new Map();
  for (const node of payload.elements) {
    const tags = node?.tags || {};
    if (node?.type !== 'node' || !Number.isSafeInteger(node.id) || node.id <= 0
      || !finite(node.lat) || !finite(node.lon) || Math.abs(node.lat) > 90 || Math.abs(node.lon) > 180) continue;
    if (tags.highway !== 'traffic_signals' && !(tags.highway === 'crossing'
      && (tags.crossing === 'traffic_signals' || tags['crossing:signals'] === 'yes'))) continue;
    seen.set(`osm:${node.id}`, {
      id: `osm:${node.id}`, lat: node.lat, lon: node.lon,
      name: String(tags.name || tags.ref || `Traffic light ${node.id}`).slice(0, 120),
      movement: String(tags['traffic_signals:direction'] || tags.direction || 'Direction unspecified').slice(0, 80),
      source: 'OpenStreetMap',
    });
  }
  return { signals: [...seen.values()].slice(0, SIGNAL_LIMIT), total: seen.size, truncated: seen.size > SIGNAL_LIMIT };
}

// serverTimeEpochMs must be sampled by the feed while handling this request.
// Anchoring to a monotonic clock avoids client wall-clock adjustments. The full
// round trip bounds network/proxy latency; it is included in displayed uncertainty.
export function parseSignalSnapshot(payload, startedMs, receivedMs) {
  if (!finite(startedMs) || !finite(receivedMs) || receivedMs < startedMs
    || !finite(payload?.serverTimeEpochMs) || payload.serverTimeEpochMs <= 0
    || !finite(payload.clockUncertaintyMs) || payload.clockUncertaintyMs < 0
    || !Array.isArray(payload.signals) || payload.signals.length > SIGNAL_LIMIT) {
    throw new Error('Invalid traffic-light timing response');
  }
  const signals = new Map();
  const duplicates = new Set();
  for (const signal of payload.signals) {
    if (!signal || typeof signal.id !== 'string' || !signal.id || signal.id.length > 160) continue;
    if (signals.has(signal.id) || duplicates.has(signal.id)) {
      signals.delete(signal.id);
      duplicates.add(signal.id);
      continue;
    }
    if (!finite(signal.lat) || !finite(signal.lon) || Math.abs(signal.lat) > 90 || Math.abs(signal.lon) > 180
      || typeof signal.source !== 'string' || !signal.source.trim()
      || typeof signal.movement !== 'string' || !signal.movement.trim()
      || !['red', 'yellow', 'green', 'red-yellow', 'flashing-yellow', 'flashing-green', 'off', 'unknown'].includes(signal.state)
      || !finite(signal.observedAtEpochMs) || signal.observedAtEpochMs <= 0 || signal.observedAtEpochMs > 8.64e15) continue;
    if (signal.observationOnly !== true && (!finite(signal.validUntilEpochMs)
      || signal.validUntilEpochMs <= signal.observedAtEpochMs
      || !finite(signal.uncertaintyMs) || signal.uncertaintyMs < 0
      || !finite(signal.resolutionMs) || signal.resolutionMs < 1
      || (signal.changeAtEpochMs != null && (!finite(signal.changeAtEpochMs)
        || signal.changeAtEpochMs <= signal.observedAtEpochMs)))) continue;
    signals.set(signal.id, { ...signal, name: String(signal.name || signal.id).slice(0, 120),
      source: signal.source.slice(0, 120), movement: signal.movement.slice(0, 80) });
  }
  return {
    signals, receivedMs,
    coverage: typeof payload.coverage === 'string' ? payload.coverage.slice(0, 220) : '',
    pollAfterMs: finite(payload.pollAfterMs) ? Math.min(30000, Math.max(1000, payload.pollAfterMs)) : 1000,
    truncated: payload.truncated === true,
    epochAtReceiveMs: payload.serverTimeEpochMs + (receivedMs - startedMs) / 2,
    uncertaintyMs: payload.clockUncertaintyMs + (receivedMs - startedMs) / 2,
  };
}

export function signalPresentation(signal, snapshot, nowMs) {
  const unknown = { state: 'unknown', countdown: 'Timing unavailable', remainingMs: null, uncertaintyMs: null };
  if (!signal || !snapshot || !finite(nowMs) || nowMs < snapshot.receivedMs) return unknown;
  const elapsed = nowMs - snapshot.receivedMs;
  const now = snapshot.epochAtReceiveMs + elapsed;
  if (signal.observationOnly === true) {
    const age = now - signal.observedAtEpochMs;
    const uncertainty = snapshot.uncertaintyMs;
    if (age < 0 || age + uncertainty >= MAX_SIGNAL_AGE_MS || elapsed >= MAX_SIGNAL_AGE_MS) {
      return { ...unknown, observationOnly: true,
        countdown: `Last report: ${signal.state.toUpperCase()} at ${new Date(signal.observedAtEpochMs).toISOString()}; current state unknown` };
    }
    return { state: signal.state, observationOnly: true, remainingMs: null, uncertaintyMs: null,
      countdown: `Reported ~${(age / 1000).toFixed(1)} s ago · countdown unavailable` };
  }
  // Include source quantization and modest monotonic-clock drift (100 ppm).
  const uncertainty = snapshot.uncertaintyMs + signal.uncertaintyMs + signal.resolutionMs / 2 + elapsed * 0.0001;
  const end = Math.min(signal.validUntilEpochMs, signal.observedAtEpochMs + MAX_SIGNAL_AGE_MS,
    signal.changeAtEpochMs ?? Infinity);
  if (elapsed >= MAX_SIGNAL_AGE_MS || now - uncertainty < signal.observedAtEpochMs || now + uncertainty >= end) return unknown;
  if (signal.state === 'unknown') return unknown;
  const remainingMs = signal.changeAtEpochMs == null ? null : signal.changeAtEpochMs - now;
  const digits = Math.max(0, Math.min(3, Math.ceil(-Math.log10(signal.resolutionMs / 1000))));
  return { state: signal.state, remainingMs, uncertaintyMs: Math.ceil(uncertainty),
    countdown: remainingMs == null ? 'Countdown unavailable'
      : `${(remainingMs / 1000).toFixed(digits)} s ±${Math.ceil(uncertainty)} ms (estimate)` };
}
