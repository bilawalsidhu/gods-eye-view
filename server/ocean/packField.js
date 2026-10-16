/**
 * @file Convert a `gev-ocean-field` v1 payload (row 0 south, `null` gaps)
 * into the wind layer's manifest plus a headerless little-endian Float32
 * body (`u` then `v`, row 0 north). Pure; no I/O.
 *
 * @module server/ocean/packField
 */

/** @const {number} Finite no-data sentinel written into BOTH components. */
export const NO_DATA = -9999;

/**
 * @param {Object} payload - A `gev-ocean-field` v1 payload with `status: 'ok'`.
 * @param {{tier: string, bbox: Object, fetchedAt: number, gridUrl: string}} options
 * @returns {{manifest: Object, bytes: Uint8Array}}
 */
export function packFieldManifest(payload, { tier, bbox, fetchedAt, gridUrl }) {
  if (!payload || payload.status !== 'ok' || !payload.grid)
    throw new Error(`cannot pack an ${payload?.status ?? 'absent'} payload`);
  const { lat0, lon0, dLat, dLon, nLat, nLon } = payload.grid;
  const count = nLat * nLon;
  const values = new Float32Array(count * 2);
  const speeds = [];
  for (let row = 0; row < nLat; row += 1) {
    const source = nLat - 1 - row; // row 0 of the body is the northern edge
    for (let col = 0; col < nLon; col += 1) {
      const k = source * nLon + col;
      const u = payload.u[k];
      const v = payload.v[k];
      if ((u == null) !== (v == null))
        throw new Error(`u and v must be null together at cell ${k}`);
      const out = row * nLon + col;
      if (u == null) {
        values[out] = NO_DATA;
        values[count + out] = NO_DATA;
        continue;
      }
      values[out] = u;
      values[count + out] = v;
      speeds.push(Math.hypot(u, v));
    }
  }
  speeds.sort((a, b) => a - b);
  const n = speeds.length;
  const speed = {
    medianMs: n ? speeds[n >> 1] : 0,
    p95Ms: n ? speeds[Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1))] : 0,
    maxMs: n ? speeds[n - 1] : 0,
    validCells: n,
    totalCells: count,
  };
  const provenance = payload.provenance ?? {};
  const validAtMs = Number.isFinite(provenance.validAtMs)
    ? provenance.validAtMs
    : payload.generatedAtMs;
  const manifest = {
    schemaVersion: 1,
    field: 'ocean-currents',
    tier,
    cycle: {
      validIso: new Date(validAtMs).toISOString(),
      runIso: null,
      forecastHour: null,
    },
    fetchedAt,
    level: 'surface',
    units: 'm/s',
    grid: {
      nx: nLon,
      ny: nLat,
      lo1: lon0,
      la1: lat0 + (nLat - 1) * dLat,
      dx: dLon,
      dy: dLat,
    },
    bbox: {
      latMin: bbox.latMin,
      latMax: bbox.latMax,
      lonMin: bbox.lonMin,
      lonMax: bbox.lonMax,
    },
    noData: NO_DATA,
    speed,
    provenance,
    stale: Boolean(provenance.stale),
    unavailable: false,
    reason: null,
    gridUrl,
  };
  return { manifest, bytes: new Uint8Array(values.buffer) };
}

/** Inverse of {@link packFieldManifest} for tests: row 0 south, `null` gaps. */
export function unpackFieldManifest(manifest, bytes) {
  const { nx, ny, lo1, la1, dx, dy } = manifest.grid;
  const count = nx * ny;
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, count * 2);
  const u = new Array(count).fill(null);
  const v = new Array(count).fill(null);
  for (let row = 0; row < ny; row += 1) {
    const target = ny - 1 - row;
    for (let col = 0; col < nx; col += 1) {
      const a = values[row * nx + col];
      if (a === manifest.noData) continue;
      u[target * nx + col] = a;
      v[target * nx + col] = values[count + row * nx + col];
    }
  }
  return {
    grid: { lat0: la1 - (ny - 1) * dy, lon0: lo1, dLat: dy, dLon: dx, nLat: ny, nLon: nx },
    u,
    v,
  };
}
