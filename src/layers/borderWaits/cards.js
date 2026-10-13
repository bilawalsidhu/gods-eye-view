/** Presentation model for border wait crossings. Pure — no Cesium types. */

export const BORDER_WAITS_OVERLAY_SOURCE_ID = 'border-waits';
export const BORDER_WAITS_LABEL_COHORT_LIMIT = 96;
export const BORDER_WAITS_LABEL_COLLISION_CAPACITY = 48;

/** Legend bands in display order; `test` receives a normalized row. */
export const DELAY_BANDS = Object.freeze([
  Object.freeze({
    key: 'short',
    label: 'Under 15 min',
    color: '#34c759',
    test: (minutes) => minutes < 15,
  }),
  Object.freeze({
    key: 'moderate',
    label: '15–29 min',
    color: '#ffcc00',
    test: (minutes) => minutes < 30,
  }),
  Object.freeze({
    key: 'long',
    label: '30–59 min',
    color: '#ff9500',
    test: (minutes) => minutes < 60,
  }),
  Object.freeze({
    key: 'severe',
    label: '60 min or more',
    color: '#ff3b30',
    test: () => true,
  }),
]);
export const CLOSED_COLOR = '#8e8e93';
export const UNREPORTED_COLOR = '#5ac8fa';

/** True when CBP reports the whole crossing, or its headline lanes, closed. */
export function isClosed(row) {
  return row.portStatus === 'closed' || row.delayStatus === 'lanes closed';
}

/** CSS colour for a crossing: closed, unreported, or its delay band. */
export function delayColor(row) {
  if (isClosed(row)) return CLOSED_COLOR;
  if (!Number.isFinite(row.delayMinutes)) return UNREPORTED_COLOR;
  return DELAY_BANDS.find((band) => band.test(row.delayMinutes)).color;
}

/** The legend band key for a crossing, matching delayColor. */
export function delayBandKey(row) {
  if (isClosed(row)) return 'closed';
  if (!Number.isFinite(row.delayMinutes)) return 'unreported';
  return DELAY_BANDS.find((band) => band.test(row.delayMinutes)).key;
}

/** Display name: CBP's crossing name, or the port name when it has none. */
export function crossingTitle(row) {
  if (!row.crossing || row.crossing.toLowerCase() === row.port.toLowerCase())
    return row.port;
  return `${row.port} · ${row.crossing}`;
}

const MODE_NAMES = Object.freeze({
  passenger: 'Cars',
  pedestrian: 'Walk',
  commercial: 'Trucks',
});
const KIND_NAMES = Object.freeze({
  standard: '',
  'nexus-sentri': ' NEXUS/SENTRI',
  ready: ' Ready',
  fast: ' FAST',
});

/** One card line per reported lane, e.g. "Cars NEXUS/SENTRI · 5 min · 3 open". */
export function laneLine(lane) {
  const name = `${MODE_NAMES[lane.mode] ?? lane.mode}${KIND_NAMES[lane.kind] ?? ''}`;
  if (lane.status === 'lanes closed') return `${name} · closed`;
  if (lane.status === 'update pending') return `${name} · update pending`;
  const parts = [name];
  parts.push(
    Number.isFinite(lane.delayMinutes)
      ? `${lane.delayMinutes} min`
      : lane.status,
  );
  if (Number.isFinite(lane.lanesOpen)) parts.push(`${lane.lanesOpen} open`);
  return parts.join(' · ');
}

/**
 * Build the overlay-host entry for one selected crossing. The caller supplies
 * `position` (Cartesian) separately — this model stays JSON-safe for tests.
 * @param {Object} row - Normalized crossing row (see records.js).
 * @param {{stale?: boolean}} [extras]
 * @returns {Object} World-overlay entry without `position`.
 */
export function buildCrossingCard(row, { stale = false } = {}) {
  const origin = row.border === 'mexico' ? 'Mexico' : 'Canada';
  const details = [
    row.portStatus === 'closed'
      ? `Port closed · into the U.S. from ${origin}`
      : `Into the U.S. from ${origin}`,
  ];
  for (const lane of row.lanes) details.push(laneLine(lane));
  if (!row.lanes.length) details.push('No lane waits reported');
  const updated = row.lanes.find((lane) => lane.updated)?.updated;
  const timing = [];
  if (updated) timing.push(`updated ${updated}`);
  if (row.hours) timing.push(row.hours);
  if (timing.length) details.push(timing.join(' · '));
  if (row.notice)
    details.push(
      row.notice.length > 140 ? `${row.notice.slice(0, 139)}…` : row.notice,
    );
  if (stale) details.push('CBP unreachable · showing the last update');
  return {
    id: `border-waits-card:${row.id}`,
    selected: true,
    interactive: false,
    title: `BORDER · ${crossingTitle(row)}`,
    details,
    accent: delayColor(row),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Ambient label text: the headline wait, "closed" or nothing. */
export function labelText(row) {
  if (isClosed(row)) return 'closed';
  if (!Number.isFinite(row.delayMinutes)) return null;
  return `${row.delayMinutes} min`;
}

/**
 * Ambient minute labels above each crossing, longest waits first. Crossings
 * with nothing to say get no label.
 * @param {Array<Object>} rows
 * @returns {Array<Object>} Entries without `position`, each keyed by row id.
 */
export function selectLabelCohort(
  rows,
  limit = BORDER_WAITS_LABEL_COHORT_LIMIT,
) {
  return rows
    .map((row) => ({ row, title: labelText(row) }))
    .filter(({ title }) => title)
    .sort(
      (a, b) =>
        (b.row.delayMinutes ?? -1) - (a.row.delayMinutes ?? -1) ||
        a.row.id.localeCompare(b.row.id),
    )
    .slice(0, limit)
    .map(({ row, title }) => ({
      id: `border-waits-label:${row.id}`,
      rowId: row.id,
      variant: 'label',
      title,
      accent: delayColor(row),
      priority: Number.isFinite(row.delayMinutes) ? row.delayMinutes : 0,
      collisionGroup: 'ambient-label',
      paintLane: 'ambient-label',
      interactive: false,
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
      gapPx: 12,
      verticalOnly: true,
      placement: 'above',
    }));
}
