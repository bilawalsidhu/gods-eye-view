/**
 * Geofence webhook: builds structured JSON payload and dispatches HTTP POST
 * on confirmed boundary breach (outside->inside).
 *
 * Pure, testable. No DOM.
 *
 * URL policy: https only (the app's Content-Security-Policy connect-src
 * allows https:/wss:/ws: but not plain http:), no embedded credentials, and
 * no loopback/link-local/private literal IPs — a webhook must never be
 * pointed at this device or the local network.
 */

export const WEBHOOK_TIMEOUT_MS = 10000;

/** Knots to metres per second (same factor the vessel layer uses). */
export const KNOTS_TO_MPS = 0.514444;

/** The unit every breach payload reports speed in. */
export const SPEED_UNIT_MPS = 'm/s';

function isBlockedIpv4(parts) {
  const [a, b] = parts;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  if (a === 0) return true; // "this network" 0.0.0.0/8
  return false;
}

function parseIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/** Expand an IPv6 literal into 8 hextets, or null when it is not IPv6. */
function parseIpv6(host) {
  if (!host.includes(':')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = [...head];
  if (halves.length === 2) {
    // An embedded dotted quad occupies two hextets.
    const width = (list) =>
      list.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
    const fill = 8 - width(head) - width(tail);
    if (fill < 1) return null;
    for (let i = 0; i < fill; i += 1) groups.push('0');
    groups.push(...tail);
  }
  if (groups.length > 8) return null;
  const hextets = [];
  for (const group of groups) {
    if (group.includes('.')) {
      const v4 = parseIpv4(group);
      if (!v4) return null;
      hextets.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    hextets.push(parseInt(group, 16));
  }
  return hextets.length === 8 ? hextets : null;
}

function isBlockedIpv6(hextets) {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = hextets;
  const allZero = hextets.every((g) => g === 0);
  if (allZero) return true; // :: (unspecified)
  if (g7 === 1 && hextets.slice(0, 7).every((g) => g === 0)) return true; // ::1
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  // IPv4-mapped ::ffff:a.b.c.d — judge the embedded address.
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0xffff
  ) {
    return isBlockedIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  return false;
}

function isBlockedHost(hostname) {
  // URL keeps IPv6 brackets on hostname ("[::1]").
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  const host = bare.replace(/\.$/, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = parseIpv4(host);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(host);
  if (v6) return isBlockedIpv6(v6);
  return false;
}

export function isValidWebhookUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return false;
  }
  // https only: the app's CSP connect-src has no plain http:.
  if (u.protocol !== 'https:') return false;
  // No embedded credentials (https://user:pass@host/path).
  if (u.username || u.password) return false;
  if (isBlockedHost(u.hostname)) return false;
  return true;
}

/**
 * Speed in metres per second, or null when no known-unit field is present.
 * Knots (vessels, local ADS-B) are converted; bare `speed`/`velocity` are
 * ignored on purpose — their unit depends on the layer, and a mislabeled
 * value is worse than none.
 */
export function extractSpeedMps(entity) {
  if (!entity) return null;
  const raw = entity._raw ?? entity;
  const mps = [
    raw?.speedMps,
    raw?.velocityMps,
    raw?.reportedSpeedMps,
    entity.speedMps,
    entity.velocityMps,
  ];
  for (const v of mps) {
    if (Number.isFinite(v)) return v;
  }
  const kts = [raw?.speedKts, entity.speedKts];
  for (const v of kts) {
    if (Number.isFinite(v)) return v * KNOTS_TO_MPS;
  }
  return null;
}

export function buildBreachPayload(
  entity,
  { now = () => new Date().toISOString() } = {},
) {
  const raw = entity?._raw ?? {};
  const entityId =
    entity?.id ??
    raw.icao24 ??
    raw.mmsi ??
    entity?.icao24 ??
    entity?.mmsi ??
    'unknown';
  const lon = entity?.lon ?? raw.lon ?? raw.longitude;
  const lat = entity?.lat ?? raw.latitude;
  return {
    entityId: String(entityId),
    timestamp: now(),
    coordinates: {
      lon: Number.isFinite(lon) ? lon : null,
      lat: Number.isFinite(lat) ? lat : null,
    },
    speedMps: extractSpeedMps(entity),
    speedUnit: SPEED_UNIT_MPS,
    layer: entity?.layerKey ?? null,
  };
}

export async function dispatchBreach(
  url,
  payload,
  fetchImpl = fetch,
  { timeoutMs = WEBHOOK_TIMEOUT_MS } = {},
) {
  const trimmed = String(url || '').trim();
  if (!isValidWebhookUrl(trimmed)) {
    throw new Error('Invalid webhook URL');
  }
  const wait =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : WEBHOOK_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), wait);
  // A hanging webhook must not keep a node process (or test runner) alive.
  if (typeof timer === 'object' && typeof timer.unref === 'function') {
    timer.unref();
  }
  try {
    const res = await fetchImpl(trimmed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Webhook POST failed: ${res.status}`);
    }
    return res;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Webhook POST timed out after ${wait}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
