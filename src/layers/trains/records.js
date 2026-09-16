/** Decode the Amtraker payload into plain train records. Pure and pinnable. */

const COMPASS_DEG = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

/** Compass word → bearing in degrees, or null for anything else. */
export function trainHeadingDeg(value) {
  const bearing =
    COMPASS_DEG[
      String(value ?? '')
        .trim()
        .toUpperCase()
    ];
  return bearing === undefined ? null : bearing;
}

function textOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

/**
 * Map the Amtraker v3 payload ({trainNum: [train, ...], ...}) to records.
 * Only Active trains with usable coordinates render — Predeparture trains
 * sit at their origin station and would paint phantom positions. Returns
 * null for a structurally invalid payload so the caller treats it as a
 * failure, never as an authoritative empty map; an empty object is a valid
 * quiet network (overnight, few trains run).
 */
export function normalizeTrainsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  const byId = new Map();
  for (const group of Object.values(payload)) {
    if (!Array.isArray(group)) continue;
    for (const train of group) {
      if (!train || typeof train !== 'object') continue;
      const trainId = textOrNull(train.trainID);
      if (!trainId) continue;
      if (train.trainState !== 'Active') continue;
      if (
        !Number.isFinite(train.lat) ||
        Math.abs(train.lat) > 90 ||
        !Number.isFinite(train.lon) ||
        Math.abs(train.lon) > 180
      )
        continue;
      byId.set(`train:${trainId}`, {
        id: `train:${trainId}`,
        trainNum: textOrNull(train.trainNum) || textOrNull(train.trainNumRaw),
        routeName: textOrNull(train.routeName) || 'Train',
        lat: train.lat,
        lon: train.lon,
        velocityMph: Number.isFinite(train.velocity)
          ? Math.max(0, Math.round(train.velocity))
          : null,
        headingDeg: trainHeadingDeg(train.heading),
        nextStation: textOrNull(train.eventName),
        origin: textOrNull(train.origName),
        destination: textOrNull(train.destName),
        // "12 Minutes Late" / "On Time" — the operator's own wording.
        timeliness:
          textOrNull(train.trainTimely) || textOrNull(train.statusMsg),
        // Amtrak's lateness color (green → red). Validated so arbitrary
        // upstream text can never reach a CSS color parser.
        accent: /^#[0-9a-fA-F]{6}$/.test(String(train.iconColor ?? ''))
          ? train.iconColor
          : null,
        provider: textOrNull(train.provider) || 'Amtrak',
        updatedAt: textOrNull(train.lastValTS) || textOrNull(train.updatedAt),
      });
    }
  }
  return [...byId.values()];
}
