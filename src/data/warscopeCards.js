/**
 * WarScope conflict-event cards — collapsed/expanded text summaries with an
 * outbound source link (no scraped article thumbnails).
 */

export const WARSCOPE_OVERLAY_SOURCE_ID = 'warscope-events';
export const WARSCOPE_OVERLAY_COHORT_LIMIT = 48;
export const WARSCOPE_OVERLAY_COLLISION_CAPACITY = 24;

/** Cards appear when zoomed in; fade out toward global overview altitudes. */
export const WARSCOPE_CARD_FADE_START_M = 350_000;
export const WARSCOPE_CARD_FADE_END_M = 1_600_000;

const EVENT_COLORS = Object.freeze({
  battles: '#ff3344',
  'explosions/remote violence': '#ff7722',
  protests: '#ffcc33',
  riots: '#ff9933',
  'strategic developments': '#66aaff',
});

/** @param {string} eventType */
export function eventAccentColor(eventType) {
  const key = String(eventType || '').trim().toLowerCase();
  return EVENT_COLORS[key] || '#c8d0dc';
}

/** @param {string} title @param {number} [max=42] */
export function compactEventTitle(title, max = 42) {
  const text = String(title || 'Conflict event').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

/**
 * Compact a publisher URL for card detail text (hostname + short path).
 * @param {string} sourceUrl
 * @param {number} [max=56]
 * @returns {string}
 */
export function compactSourceLink(sourceUrl, max = 56) {
  const raw = String(sourceUrl || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const path = url.pathname === '/' ? '' : url.pathname;
    const text = `${url.hostname}${path}`;
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
  } catch {
    if (raw.length <= max) return raw;
    return `${raw.slice(0, Math.max(0, max - 1)).trim()}…`;
  }
}

/**
 * @param {object} event
 * @param {boolean} expanded
 * @returns {string[]}
 */
export function buildWarscopeCardDetails(event, expanded) {
  const lines = [];
  const typeLine = [event.eventType, event.subEventType].filter(Boolean).join(' · ');
  if (typeLine) lines.push(typeLine);
  const place = [event.region, event.country].filter(Boolean).join(', ');
  if (place) lines.push(place);
  if (event.date) lines.push(event.date);
  if (Number(event.fatalities) > 0) lines.push(`${event.fatalities} reported fatalities`);
  if (event.source) lines.push(`Source: ${event.source}`);
  if (!expanded) {
    lines.push('Click card to expand');
    return lines;
  }
  const notes = String(event.notes || '').trim();
  if (notes) {
    lines.push(notes.length > 120 ? `${notes.slice(0, 119).trim()}…` : notes);
  }
  const link = compactSourceLink(event.sourceUrl);
  if (link) lines.push(`Open source: ${link}`);
  lines.push('Click card to collapse');
  return lines;
}

/**
 * @param {object} event
 * @param {boolean} [expanded=false]
 * @returns {number}
 */
export function eventOverlayPriority(event, expanded = false) {
  const fatalities = Math.max(0, Number(event?.fatalities) || 0);
  const quality = Number(event?.quality) || 0;
  let priority = Math.round(fatalities * 1000 + quality * 100);
  if (expanded) priority += 1_000_000;
  return priority;
}

/**
 * Keep expanded cards and the highest-priority ambient cards within the cap.
 * @param {Array<{id:string,priority:number}>} entries
 * @param {Set<string>|Array<string>} expandedIds
 * @param {number} [limit=WARSCOPE_OVERLAY_COHORT_LIMIT]
 */
export function selectWarscopeOverlayCohort(
  entries,
  expandedIds,
  limit = WARSCOPE_OVERLAY_COHORT_LIMIT,
) {
  const expanded = expandedIds instanceof Set
    ? expandedIds
    : new Set(Array.isArray(expandedIds) ? expandedIds : []);
  const cap = Math.max(0, Math.min(
    WARSCOPE_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  const pinned = [];
  const ambient = [];
  for (const entry of entries) {
    if (expanded.has(entry.id)) pinned.push(entry);
    else ambient.push(entry);
  }
  ambient.sort((a, b) => b.priority - a.priority || String(a.id).localeCompare(String(b.id)));
  const ambientCap = Math.max(0, cap - pinned.length);
  return [...pinned, ...ambient.slice(0, ambientCap)];
}

/**
 * @param {object} input
 * @param {object} input.event Normalized WarScope event.
 * @param {object} input.position Cesium Cartesian3 anchor.
 * @param {boolean} [input.expanded=false]
 */
export function createWarscopeOverlayEntry({
  event,
  position,
  expanded = false,
} = {}) {
  if (!event?.id || !position) return null;
  const accent = eventAccentColor(event.eventType);
  const priority = eventOverlayPriority(event, expanded);
  const title = compactEventTitle(event.title);
  const sourceUrl = String(event.sourceUrl || '').trim();
  const activate = sourceUrl && /^https?:\/\//i.test(sourceUrl)
    ? () => {
      try {
        window.open(sourceUrl, '_blank', 'noopener,noreferrer');
        return true;
      } catch {
        return false;
      }
    }
    : null;

  return {
    id: String(event.id),
    position,
    accent,
    priority,
    interactive: true,
    collisionGroup: 'warscope-event',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    verticalOnly: true,
    placement: 'above',
    gapPx: 10,
    altitudeFadeStart: WARSCOPE_CARD_FADE_START_M,
    altitudeFadeEnd: WARSCOPE_CARD_FADE_END_M,
    maxDistance: 4_000_000,
    accessibilityLabel: `${title}, ${event.country || 'global event'}`,
    activate,
    variant: 'card',
    paintLane: 'ambient-card',
    title,
    details: buildWarscopeCardDetails(event, expanded),
  };
}
