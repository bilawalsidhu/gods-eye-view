/**
 * @module layers/transit/stationModel
 * @description The French passenger-station network, normalized. Pure — no
 * Cesium, no network.
 *
 * The SNCF Open Data catalogue `gares-de-voyageurs` dataset — 2 792 passenger
 * stations with their positions, coloured by the rail segment (`segment_drg`)
 * they belong to. It is the STATION NETWORK, not live train telemetry: the
 * SNCF catalogue publishes no live vehicle-position dataset (the datasets that
 * sound like one carry zero records, and the GTFS zip is a schedule), so
 * nothing here may be described as a live train position.
 *
 * A portable export (package.json): no i18n here. The labels stay English
 * data; the Layers panel shows them translated.
 */
const msg = (text) => text;

/**
 * The overlay source the station labels are published under. It is the
 * Transit's OWN id, not the removed standalone layer's, so the labels live in
 * the same overlay namespace the Transit row already owns.
 */
export const TRANSIT_STATIONS_OVERLAY_SOURCE_ID = 'transit-stations';

/** How many station labels are published at once. */
export const TRANSIT_STATIONS_OVERLAY_COHORT_LIMIT = 48;

/** How many labels may share the same collision slot. */
export const TRANSIT_STATIONS_OVERLAY_COLLISION_CAPACITY = 32;

/**
 * The colours the rail segments are drawn in. The network segments
 * (`segment_drg`) group the stations by rail administration; each gets its
 * own colour so the map reads as a network rather than a scatter.
 */
export const TRANSIT_STATION_SEGMENT_COLORS = Object.freeze({
  A: '#4cc9f0',
  B: '#ffd43b',
  C: '#80ed99',
  D: '#ff6b35',
  E: '#a78bfa',
  F: '#f77f00',
});

/** The colour used for a segment the palette does not name. */
export const TRANSIT_STATION_UNKNOWN_COLOR = '#adb5bd';

/**
 * The visual class a station is drawn in.
 *
 * The SNCF catalogue publishes a station's position, name, short code, UIC
 * code and rail segment. It publishes NO passenger count, no service
 * frequency and no capacity, so the class is built only from what it does
 * publish:
 *
 *  - the RANK: a station with a public short code is a principal station in
 *    the operator's own catalogue; a station without one is a local station;
 *  - the SEGMENT: the administrative grouping (`segment_drg`) the catalogue
 *    puts the station in, which keeps the per-segment palette as the base of
 *    every colour.
 *
 * The rank is the stronger signal, so it decides the class id and the label;
 * the segment decides the hue. The two together are the classification:
 *
 *    principal + segment A   -> 'principal:A'
 *    local    + segment A   -> 'local:A'
 *    principal + no segment  -> 'principal:other'
 *
 * The class COLOUR is the segment's palette colour for a principal station
 * and the same hue muted towards the neutral grey for a local station, so
 * the map reads as a network of principal stations with their local stations
 * around them. The legend paints the very same hex.
 */
export const TRANSIT_STATION_RANK_PRINCIPAL = 'principal';
export const TRANSIT_STATION_RANK_LOCAL = 'local';

/** The two ranks, in legend order. */
export const TRANSIT_STATION_RANKS = Object.freeze([
  Object.freeze({ id: TRANSIT_STATION_RANK_PRINCIPAL }),
  Object.freeze({ id: TRANSIT_STATION_RANK_LOCAL }),
]);

/** The label templates the legend shows for each rank. */
const TRANSIT_STATION_RANK_LABELS = Object.freeze({
  [TRANSIT_STATION_RANK_PRINCIPAL]: msg('Principal station ({segment})'),
  [TRANSIT_STATION_RANK_LOCAL]: msg('Local station ({segment})'),
});

/** The label used when the catalogue names no segment for the station. */
export const TRANSIT_STATION_UNNAMED_SEGMENT_LABEL = msg('Unnamed segment');

/**
 * The muted colour a local station is drawn in: the segment's own hue,
 * mixed towards the neutral grey so the principal stations stay readable.
 *
 * @param {string} hex The segment's palette colour.
 * @returns {string} The muted hex.
 */
function muteStationColor(hex) {
  const value = String(hex || '').trim();
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return TRANSIT_STATION_UNKNOWN_COLOR;
  const int = Number.parseInt(match[1], 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  const neutral = 0xad; // the unknown-segment grey, component by component
  const mix = (channel) => Math.round(channel * 0.45 + neutral * 0.55);
  const muted = (mix(r) << 16) | (mix(g) << 8) | mix(b);
  return `#${muted.toString(16).padStart(6, '0')}`;
}

/** The muted counterpart of the unknown-segment grey. */
export const TRANSIT_STATION_UNKNOWN_LOCAL_COLOR = muteStationColor(
  TRANSIT_STATION_UNKNOWN_COLOR,
);

/**
 * The segment key of a station: the catalogue's segment letter, uppercased,
 * or 'other' when the catalogue names none (or one the palette does not).
 *
 * The catalogue's `segment_drg` is a SEMICOLON-SEPARATED LIST, not a single
 * letter: as of 2026-10-28 it publishes exactly nine values - A, B, C, and
 * the six multi-membership forms 'A;A', 'A;B', 'A;B;A', 'B;A', 'B;B', 'B;C'.
 * A station in more than one rail network (Paris Gare du Nord is 'A;B;A')
 * belongs to several, so the FIRST listed segment is its primary one and
 * the one the palette paints it in. Reading the whole string as one key
 * sent every one of those ten stations - including Paris Gare du Nord,
 * Paris Gare de Lyon, Paris Austerlitz, Paris Montparnasse and Avignon TGV
 * - to the neutral 'other' colour, which is exactly the grey the map must
 * not use for a station the catalogue names.
 *
 * @param {string|null|undefined} segment
 * @returns {string}
 */
export function transitStationSegmentKey(segment) {
  const parts = String(segment ?? '')
    .split(';')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  for (const part of parts) {
    if (TRANSIT_STATION_SEGMENT_COLORS[part]) return part;
  }
  return 'other';
}

/**
 * The visual class of one station. This is the ONE classification: the map
 * colours a pin from it and the row legend counts from it, so a station's
 * colour and the class that counts it cannot disagree.
 *
 * @param {{shortCode?: string|null, segment?: string|null}} station
 * @returns {{id: string, rank: string, segment: string, label: string,
 *   segmentLabel: string, color: string}}
 */
export function transitStationClass(station) {
  const segment = transitStationSegmentKey(station?.segment);
  const rank = String(station?.shortCode ?? '').trim()
    ? TRANSIT_STATION_RANK_PRINCIPAL
    : TRANSIT_STATION_RANK_LOCAL;
  const base =
    segment === 'other'
      ? TRANSIT_STATION_UNKNOWN_COLOR
      : TRANSIT_STATION_SEGMENT_COLORS[segment];
  const color =
    rank === TRANSIT_STATION_RANK_PRINCIPAL
      ? base
      : segment === 'other'
        ? TRANSIT_STATION_UNKNOWN_LOCAL_COLOR
        : muteStationColor(base);
  const segmentLabel =
    segment === 'other'
      ? TRANSIT_STATION_UNNAMED_SEGMENT_LABEL
      : msg(`Segment ${segment}`);
  return {
    id: `${rank}:${segment}`,
    rank,
    segment,
    label: TRANSIT_STATION_RANK_LABELS[rank],
    segmentLabel,
    color,
  };
}

/**
 * The rail segments, in the order the legend shows them.
 *
 * The catalogue field is the SNCF network's own administrative grouping of
 * the passenger stations. The catalogue does NOT publish what each letter
 * means in so many words, so the legend names the segment by its CODE and
 * does not invent a service name for it: a legend that claimed a high-speed
 * service for a segment the operator never called one would be a claim the
 * data cannot support.
 *
 * The colours are the ones the map already draws the segments in, so the
 * legend and the map cannot drift apart.
 */
export const TRANSIT_STATION_SEGMENTS = Object.freeze([
  Object.freeze({
    id: 'A',
    label: msg('Segment A'),
    color: TRANSIT_STATION_SEGMENT_COLORS.A,
  }),
  Object.freeze({
    id: 'B',
    label: msg('Segment B'),
    color: TRANSIT_STATION_SEGMENT_COLORS.B,
  }),
  Object.freeze({
    id: 'C',
    label: msg('Segment C'),
    color: TRANSIT_STATION_SEGMENT_COLORS.C,
  }),
  Object.freeze({
    id: 'D',
    label: msg('Segment D'),
    color: TRANSIT_STATION_SEGMENT_COLORS.D,
  }),
  Object.freeze({
    id: 'E',
    label: msg('Segment E'),
    color: TRANSIT_STATION_SEGMENT_COLORS.E,
  }),
  Object.freeze({
    id: 'F',
    label: msg('Segment F'),
    color: TRANSIT_STATION_SEGMENT_COLORS.F,
  }),
]);

/**
 * The legend entries for the station network: one per visual class actually
 * present, with the live count of the stations in it.
 *
 * The counts come from transitStationClass, the ONE classification the map
 * colours its pins from, so a legend entry and the pins it describes cannot
 * disagree. The entries are ordered principal first, then local, and within
 * a rank by the catalogue's segment order.
 *
 * @param {Array<object>} stations The station rows currently drawn.
 * @returns {Array<{id: string, label: string, segmentLabel: string,
 *   color: string, count: number}>}
 */
export function transitStationSegments(stations = []) {
  const counts = new Map();
  const classes = new Map();
  for (const station of Array.isArray(stations) ? stations : []) {
    const classification = transitStationClass(station);
    counts.set(classification.id, (counts.get(classification.id) || 0) + 1);
    if (!classes.has(classification.id))
      classes.set(classification.id, classification);
  }
  const segmentOrder = new Map(
    TRANSIT_STATION_SEGMENTS.map((segment, index) => [segment.id, index]),
  );
  const entries = [...classes.values()].sort((a, b) => {
    const rankDelta =
      TRANSIT_STATION_RANKS.findIndex((rank) => rank.id === a.rank) -
      TRANSIT_STATION_RANKS.findIndex((rank) => rank.id === b.rank);
    if (rankDelta) return rankDelta;
    const aSegment = segmentOrder.get(a.segment) ?? segmentOrder.size;
    const bSegment = segmentOrder.get(b.segment) ?? segmentOrder.size;
    if (aSegment !== bSegment) return aSegment - bSegment;
    return a.id.localeCompare(b.id);
  });
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    segmentLabel: entry.segmentLabel,
    color: entry.color,
    count: counts.get(entry.id) || 0,
  }));
}

/**
 * The Transit row's own description of what it shows. The row states the
 * coverage and the nature of the data, so the merged layer is not
 * mistaken for live train telemetry: the SNCF catalogue publishes none.
 */
export const TRANSIT_STATION_DESCRIPTION = msg(
  'Live transit vehicles and the French passenger-station network (2 792 SNCF stations) — the stations are a network, not live train positions',
);

/**
 * Accent colour for a rail segment id.
 *
 * @param {string|null|undefined} segment
 * @returns {string} Hex colour.
 */
export function transitStationSegmentColor(segment) {
  const key = transitStationSegmentKey(segment);
  return TRANSIT_STATION_SEGMENT_COLORS[key] || TRANSIT_STATION_UNKNOWN_COLOR;
}

/**
 * Validate a proxy payload into a list of station rows.
 *
 * Atomic: a structurally broken payload returns null so the caller keeps its
 * last good snapshot. A station missing coordinates is skipped, since one
 * unusable station is not evidence the payload is broken.
 *
 * @param {object} payload The proxy's JSON body.
 * @returns {{stations: Array<object>, total: number}|null} Null when
 *   malformed.
 */
export function normalizeTransitStationPayload(payload) {
  if (!Array.isArray(payload?.stations)) return null;
  const stations = [];
  const seen = new Set();
  for (const raw of payload.stations) {
    const id = String(raw?.id ?? '').trim();
    const lon = Number(raw?.lon);
    const lat = Number(raw?.lat);
    if (!id) continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const segment =
      String(raw?.segment ?? '')
        .trim()
        .toUpperCase() || null;
    stations.push({
      id,
      name: String(raw?.name ?? '').trim() || id,
      shortCode: String(raw?.shortCode ?? '').trim() || null,
      uic: String(raw?.uic ?? '').trim() || null,
      lon,
      lat,
      segment,
      color: transitStationSegmentColor(segment),
    });
  }
  const total = Number(payload?.total);
  return {
    stations,
    total: Number.isFinite(total) && total >= 0 ? total : stations.length,
  };
}

/**
 * Map one station to a JSON-safe analyst record.
 *
 * @param {object|null|undefined} raw
 * @param {number} [index=0]
 * @returns {object}
 */
export function mapTransitStationRecord(raw, index = 0) {
  const text = (value) => {
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
  };
  const num = (value) => (Number.isFinite(value) ? value : null);
  return {
    id: text(raw?.id) || `SNCF-${String(index).padStart(4, '0')}`,
    name: text(raw?.name),
    shortCode: text(raw?.shortCode),
    uic: text(raw?.uic),
    segment: text(raw?.segment),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
  };
}

/**
 * Build the source-owned presentation for one station label.
 *
 * @param {object} input
 * @returns {object}
 */
export function createTransitStationOverlayEntry({
  id,
  position,
  title,
  accent,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    priority: 0,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep a bounded cohort of labels, with stable identity as the tie-break. */
export function selectTransitStationOverlayCohort(
  entries,
  limit = TRANSIT_STATIONS_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(
      TRANSIT_STATIONS_OVERLAY_COHORT_LIMIT,
      Math.floor(Number(limit) || 0),
    ),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, cap);
}
