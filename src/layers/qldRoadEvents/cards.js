/**
 * Presentation model for QLDTraffic road events: per-category style, marker
 * glyphs and the selected-event card. Pure — no Cesium types.
 */

export const QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID = 'qld-road-events';
export const QLDTRAFFIC_URL = 'https://qldtraffic.qld.gov.au/';

const DARK = '#10161d';

// Glyphs are white strokes/fills on a 32×32 badge. Paths rather than text so
// the marker never depends on a font being available to the canvas.
const GLYPHS = {
  crash:
    '<path d="M11 11 21 21M21 11 11 21" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>',
  flooding:
    '<path d="M8 13q2-2 4 0t4 0 4 0 4 0M8 19q2-2 4 0t4 0 4 0 4 0" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  hazard:
    '<path d="M16 8.5v9" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><circle cx="16" cy="22.5" r="2" fill="#fff"/>',
  congestion:
    '<path d="M10 11h12M10 16h12M10 21h12" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>',
  'special-event':
    '<path d="m16 8.5 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z" fill="#fff"/>',
  roadworks:
    '<path d="M16 10.5 21 21H11z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>',
  other: '<circle cx="16" cy="16" r="3.4" fill="#fff"/>',
};

/**
 * Per-category presentation. `rank` orders categories by urgency (legend
 * order, card priority); roadworks are deliberately small, translucent and
 * dashed so hundreds of long-running works do not swamp the incidents.
 */
export const QLD_ROAD_EVENT_STYLES = Object.freeze({
  crash: Object.freeze({
    label: 'Crash',
    color: '#ff3b30',
    rank: 6,
    scale: 0.95,
    lineWidth: 5,
    lineAlpha: 0.9,
    shape: 'circle',
  }),
  flooding: Object.freeze({
    label: 'Flooding',
    color: '#2f8fff',
    rank: 5,
    scale: 0.95,
    lineWidth: 5,
    lineAlpha: 0.9,
    shape: 'circle',
  }),
  hazard: Object.freeze({
    label: 'Hazard',
    color: '#ffab00',
    rank: 4,
    scale: 0.8,
    lineWidth: 4,
    lineAlpha: 0.85,
    shape: 'circle',
  }),
  congestion: Object.freeze({
    label: 'Congestion',
    color: '#ff6d00',
    rank: 3,
    scale: 0.8,
    lineWidth: 4,
    lineAlpha: 0.85,
    shape: 'circle',
  }),
  'special-event': Object.freeze({
    label: 'Special event',
    color: '#b388ff',
    rank: 2,
    scale: 0.8,
    lineWidth: 4,
    lineAlpha: 0.85,
    shape: 'circle',
  }),
  roadworks: Object.freeze({
    label: 'Roadworks',
    color: '#b59a6d',
    rank: 1,
    scale: 0.55,
    lineWidth: 2.5,
    lineAlpha: 0.5,
    shape: 'diamond',
    dashed: true,
    fade: true,
  }),
  other: Object.freeze({
    label: 'Other',
    color: '#9aa4ad',
    rank: 0,
    scale: 0.6,
    lineWidth: 2.5,
    lineAlpha: 0.6,
    shape: 'circle',
  }),
});

/** Style for a category, falling back to `other`. */
export function qldRoadEventStyle(category) {
  return QLD_ROAD_EVENT_STYLES[category] || QLD_ROAD_EVENT_STYLES.other;
}

const glyphCache = new Map();

/**
 * SVG data URI for a category's marker badge (cached; same string per call).
 * @param {string} category - One of QLD_ROAD_EVENT_CATEGORIES.
 * @returns {string}
 */
export function qldRoadEventGlyph(category) {
  const key = QLD_ROAD_EVENT_STYLES[category] ? category : 'other';
  let uri = glyphCache.get(key);
  if (uri) return uri;
  const style = QLD_ROAD_EVENT_STYLES[key];
  const badge =
    style.shape === 'diamond'
      ? `<path d="M16 2 30 16 16 30 2 16z" fill="${style.color}" stroke="${DARK}" stroke-width="2"/>`
      : `<circle cx="16" cy="16" r="13" fill="${style.color}" stroke="${DARK}" stroke-width="2.5"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${badge}${GLYPHS[key]}</svg>`;
  uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  glyphCache.set(key, uri);
  return uri;
}

function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Australia/Brisbane',
});

function clip(value, limit = 180) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * Build the overlay-host entry for one selected event. The caller supplies
 * `position` (Cartesian) separately so this stays JSON-safe for tests. The
 * card always links to QLDTraffic, the authoritative live source.
 * @param {object} event - Normalized record (see records.js).
 * @param {number} nowMs - Current epoch milliseconds.
 * @returns {object} World-overlay entry without `position`.
 */
export function buildQldRoadEventCard(event, nowMs) {
  const style = qldRoadEventStyle(event.category);
  const kind = [];
  if (event.subtype) kind.push(event.subtype);
  if (event.dueTo) kind.push(`due to ${event.dueTo.toLowerCase()}`);
  if (event.priority) kind.push(`${event.priority} priority`);

  const place = [];
  if (event.road) place.push(event.road);
  if (event.locality) place.push(event.locality);
  if (event.localGovernmentArea && event.localGovernmentArea !== event.locality)
    place.push(event.localGovernmentArea);

  const impact = [];
  if (event.direction)
    impact.push(
      event.towards
        ? `${event.direction} towards ${event.towards}`
        : event.direction,
    );
  if (event.impactSubtype || event.impactType)
    impact.push(event.impactSubtype || event.impactType);
  if (event.delay) impact.push(event.delay);

  const timing = [];
  const updated = formatAge(nowMs - event.lastUpdatedMs);
  if (event.lastUpdatedMs != null && updated)
    timing.push(`updated ${updated} ago`);
  if (Number.isFinite(event.startMs) && event.startMs <= nowMs)
    timing.push(`since ${DATE_FORMAT.format(event.startMs)}`);
  if (event.providedBy) timing.push(event.providedBy);

  const details = [];
  if (kind.length) details.push(kind.join(' · '));
  if (place.length) details.push(place.join(' · '));
  if (impact.length) details.push(impact.join(' · '));
  if (event.description) details.push(clip(event.description));
  if (event.advice) details.push(`Advice: ${clip(event.advice, 140)}`);
  if (timing.length) details.push(timing.join(' · '));
  details.push('QLDTraffic ↗ · click card to open');

  const label = (event.type || style.label).toUpperCase();
  const title = `${label} · ${event.road || event.locality || 'Queensland road'}`;
  return {
    id: `qld-road-event-card:${event.id}`,
    selected: true,
    interactive: true,
    accessibilityLabel: `Open QLDTraffic for ${title}`,
    title,
    details,
    accent: style.color,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
