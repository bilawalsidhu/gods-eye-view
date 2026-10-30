/**
 * @module layers/copernicusEms/model
 *
 * Copernicus Emergency Management Service activations, normalized. Pure — no
 * Cesium, no network.
 *
 * WHAT THIS FEED IS: a list of civil-protection activations, each with a
 * hazard category, a disaster-risk-management phase and a point centroid.
 * It is NOT live telemetry of an emergency, and it carries no damage
 * figures. The layer shows WHERE an activation is and WHAT KIND it is.
 */
// A portable export (package.json): no i18n here. The labels stay English
// data; the Layers panel shows them translated.
const msg = (text) => text;

export const COPERNICUS_OVERLAY_SOURCE_ID = 'copernicus-ems';
export const COPERNICUS_OVERLAY_COHORT_LIMIT = 32;
export const COPERNICUS_OVERLAY_COLLISION_CAPACITY = 24;

/**
 * The layer's own description of what it shows, so the row states the
 * coverage and the nature of the data.
 */
export const COPERNICUS_DESCRIPTION = msg(
  'European civil-protection activations · Copernicus EMS (Europe + beyond)',
);

/**
 * The disaster-risk-management phases, in the order they escalate.
 */
export const COPERNICUS_PHASES = Object.freeze([
  Object.freeze({ id: 'preparedness', label: msg('Preparedness') }),
  Object.freeze({ id: 'monitoring', label: msg('Monitoring') }),
  Object.freeze({ id: 'alert', label: msg('Alert') }),
  Object.freeze({ id: 'response', label: msg('Response') }),
  Object.freeze({ id: 'recovery', label: msg('Recovery') }),
]);

/**
 * The hazard categories, with the colour each is drawn in.
 */
export const COPERNICUS_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'flood', label: msg('Flood'), color: '#4cc9f0' }),
  Object.freeze({ id: 'fire', label: msg('Fire'), color: '#ff6b35' }),
  Object.freeze({
    id: 'earthquake',
    label: msg('Earthquake'),
    color: '#ffd43b',
  }),
  Object.freeze({ id: 'storm', label: msg('Storm'), color: '#a78bfa' }),
  Object.freeze({ id: 'landslide', label: msg('Landslide'), color: '#c9a227' }),
  Object.freeze({ id: 'drought', label: msg('Drought'), color: '#e9c46a' }),
  Object.freeze({
    id: 'volcanic',
    label: msg('Volcanic activity'),
    color: '#f77f00',
  }),
  Object.freeze({ id: 'chemical', label: msg('Chemical'), color: '#48cae4' }),
  Object.freeze({
    id: 'biological',
    label: msg('Biological'),
    color: '#80ed99',
  }),
  Object.freeze({ id: 'other', label: msg('Other'), color: '#adb5bd' }),
]);

/** The colour used for a category the palette does not name. */
export const COPERNICUS_UNKNOWN_COLOR = '#adb5bd';

/**
 * How long an activation counts as NEW.
 *
 * The feed publishes an activation time and a last-update time, so a card
 * can say whether the activation is fresh or has been running for days.
 */
export const COPERNICUS_NEW_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * The status of one activation, as the card's badge shows it.
 *
 * The three states are the ones the feed can support: an activation the
 * operator has closed, one still running, and one that has only just been
 * raised. The window is the model's own, so the badge and the layer agree.
 *
 * @param {object|null|undefined} activation A normalized activation.
 * @param {number} [now] The reference time, for the test clock.
 * @returns {'new'|'ongoing'|'closed'} The activation status.
 */
export function copernicusActivationStatus(activation, now = Date.now()) {
  if (!activation) return 'ongoing';
  if (activation.closed === true) return 'closed';
  const started = Date.parse(activation.activationTime || '');
  if (!Number.isFinite(started)) return 'ongoing';
  return now - started <= COPERNICUS_NEW_WINDOW_MS ? 'new' : 'ongoing';
}

/** The label for an activation status. */
export function copernicusActivationStatusLabel(status) {
  if (status === 'closed') return msg('Closed');
  if (status === 'new') return msg('New');
  return msg('Ongoing');
}

/** Accent colour for a hazard category slug. */
export function copernicusCategoryColor(slug) {
  const key = String(slug ?? '')
    .trim()
    .toLowerCase();
  const found = COPERNICUS_CATEGORIES.find((entry) => entry.id === key);
  return found ? found.color : COPERNICUS_UNKNOWN_COLOR;
}

/** The label for a hazard category slug. */
export function copernicusCategoryLabel(slug) {
  const key = String(slug ?? '')
    .trim()
    .toLowerCase();
  const found = COPERNICUS_CATEGORIES.find((entry) => entry.id === key);
  if (found) return found.label;
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : msg('Other');
}

/** The label for a disaster-risk-management phase id. */
export function copernicusPhaseLabel(phase) {
  const key = String(phase ?? '')
    .trim()
    .toLowerCase();
  const found = COPERNICUS_PHASES.find((entry) => entry.id === key);
  if (found) return found.label;
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : msg('Unknown');
}

/**
 * Parse a WKT POINT centroid into lon/lat.
 *
 * The upstream writes the centroid as `POINT (lon lat)` — longitude FIRST,
 * which is the opposite of the usual GeoJSON order and an easy way to place
 * a hazard in the wrong hemisphere.
 *
 * @param {string|null|undefined} wkt The WKT string.
 * @returns {{lon: number, lat: number}|null} Null when unparsable.
 */
export function parseCentroid(wkt) {
  const text = String(wkt ?? '').trim();
  const pattern =
    /^POINT\s*\(\s*([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s*\)$/i;
  const match = pattern.exec(text);
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return { lon, lat };
}

/**
 * Validate the proxy's activation payload.
 *
 * Atomic: a structurally broken payload returns null so the caller keeps
 * its last good snapshot. An activation without a usable centroid is
 * skipped, since one unplaceable activation is not evidence the payload is
 * broken.
 *
 * @param {object} payload The proxy's JSON body.
 * @returns {{activations: Array<object>, total: number}|null} Null when
 *   malformed.
 */
export function normalizeCopernicusActivations(payload) {
  if (!Array.isArray(payload?.activations)) return null;
  const activations = [];
  const seen = new Set();
  for (const raw of payload.activations) {
    const id = String(raw?.id ?? '').trim();
    const lon = Number(raw?.lon);
    const lat = Number(raw?.lat);
    if (!id || seen.has(id)) continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    seen.add(id);
    const category =
      String(raw?.category ?? '')
        .trim()
        .toLowerCase() || 'other';
    const phase =
      String(raw?.phase ?? '')
        .trim()
        .toLowerCase() || null;
    activations.push({
      id,
      code: String(raw?.code ?? '').trim() || null,
      name: String(raw?.name ?? '').trim() || id,
      category,
      categoryLabel: copernicusCategoryLabel(category),
      color: copernicusCategoryColor(category),
      phase,
      phaseLabel: phase ? copernicusPhaseLabel(phase) : null,
      closed: raw?.closed === true,
      country: String(raw?.country ?? '').trim() || null,
      countries: Array.isArray(raw?.countries)
        ? raw.countries
            .map((entry) => String(entry ?? '').trim())
            .filter(Boolean)
        : [],
      lon,
      lat,
      activationTime: String(raw?.activationTime ?? '').trim() || null,
      lastUpdate: String(raw?.lastUpdate ?? '').trim() || null,
      aoiCount: Number.isFinite(Number(raw?.aoiCount))
        ? Number(raw.aoiCount)
        : null,
      productCount: Number.isFinite(Number(raw?.productCount))
        ? Number(raw.productCount)
        : null,
    });
  }
  const total = Number(payload?.total);
  return {
    activations,
    total: Number.isFinite(total) && total >= 0 ? total : activations.length,
  };
}

/**
 * Map one activation to a JSON-safe analyst record.
 * @param {object|null|undefined} raw
 * @param {number} [index=0]
 * @returns {object}
 */
export function mapCopernicusRecord(raw, index = 0) {
  const text = (value) => {
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
  };
  const num = (value) => (Number.isFinite(value) ? value : null);
  return {
    id: text(raw?.id) || `EMS-${String(index).padStart(4, '0')}`,
    code: text(raw?.code),
    name: text(raw?.name),
    category: text(raw?.category),
    phase: text(raw?.phase),
    country: text(raw?.country),
    closed: raw?.closed === true,
    lat: num(raw?.lat),
    lon: num(raw?.lon),
  };
}

/**
 * Build the source-owned presentation for one activation label.
 * @param {object} input
 * @returns {object}
 */
export function createCopernicusOverlayEntry({ id, position, title, accent }) {
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
export function selectCopernicusOverlayCohort(
  entries,
  limit = COPERNICUS_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(COPERNICUS_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, cap);
}
