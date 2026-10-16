/** Card model for one selected weather warning. Pure — no Cesium types. */
import { formatDate, msg, t } from '../../i18n/index.js';

export const WARNING_OVERLAY_SOURCE_ID = 'weather-warnings';

const LEVEL_ACCENTS = Object.freeze({
  yellow: '#ffd60a',
  orange: '#ff8c00',
  red: '#ff3b30',
});

/** CSS accent for a MET awareness level (mirrors the fill). */
export function warningAccent(level) {
  return LEVEL_ACCENTS[level] ?? LEVEL_ACCENTS.yellow;
}

/** Shoelace area (degree², sign dropped) — relative sizes only. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/**
 * Anchor point for the warning card: the vertex mean of the largest
 * polygon's outer ring. Degrees, so callers own the Cartesian conversion.
 * @param {Array<Array<Array<[number, number]>>>} polygons Normalized rows' polygons.
 * @returns {{lon: number, lat: number}}
 */
export function warningAnchorDegrees(polygons) {
  let best = null;
  let bestArea = -1;
  for (const rings of polygons) {
    const area = ringArea(rings[0]);
    if (area > bestArea) {
      bestArea = area;
      best = rings[0];
    }
  }
  let lon = 0;
  let lat = 0;
  const count = best.length - 1;
  for (let i = 0; i < count; i++) {
    lon += best[i][0];
    lat += best[i][1];
  }
  return { lon: lon / count, lat: lat / count };
}

const pad2 = (value) => String(value).padStart(2, '0');
const UTC_DAY = Object.freeze({
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const LEVEL_FACTS = Object.freeze({
  yellow: msg('yellow level'),
  orange: msg('orange level'),
  red: msg('red level'),
});

/** `Oct 11 12:00Z` in English for epoch milliseconds; null when not finite. */
function utcStamp(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return `${formatDate(date, UTC_DAY)} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}Z`;
}

/** Validity line: "in effect until …" once started, else "from … to …". */
function validity(row, nowMs) {
  const onset = utcStamp(row.onset);
  const expires = utcStamp(row.expires);
  if (Number.isFinite(row.onset) && row.onset > nowMs && onset)
    return expires
      ? t('from {start} to {end}', { start: onset, end: expires })
      : t('from {start}', { start: onset });
  return expires ? t('in effect until {end}', { end: expires }) : null;
}

/** Keep card lines short; MET descriptions can run to several sentences. */
function clip(value, max = 90) {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/**
 * Build the overlay-host entry for one selected warning. The caller supplies
 * `position` (Cartesian) separately — this model stays JSON-safe for tests.
 * @param {object} row Normalized warning row (see records.js).
 * @param {number} nowMs Current epoch milliseconds.
 * @returns {object} World-overlay entry without `position`.
 */
export function buildWarningCard(row, nowMs) {
  const facts = [
    LEVEL_FACTS[row.level] ? t(LEVEL_FACTS[row.level]) : row.level,
  ];
  if (row.area) facts.push(row.area);
  facts.push(
    row.domain === 'marine'
      ? t('sea', { context: 'warning area' })
      : t('land', { context: 'warning area' }),
  );
  const details = [facts.join(' · ')];
  const when = validity(row, nowMs);
  if (when) details.push(when);
  const description = clip(row.description);
  if (description) details.push(description);
  const instruction = clip(row.instruction);
  if (instruction) details.push(instruction);
  const publisher = (row.source ?? 'met') === 'met' ? 'MET Norway' : 'Varsom';
  if (row.web)
    details.push(t('{publisher} ↗ · click card to open', { publisher }));
  const title = t('WARNING · {event}', {
    event: row.eventName || row.event || t('Weather'),
  });
  return {
    id: `weather-warning-card:${row.stableId}`,
    selected: true,
    interactive: Boolean(row.web),
    ...(row.web
      ? {
          accessibilityLabel: t('Open {title} on {publisher}', {
            title,
            publisher,
          }),
        }
      : undefined),
    title,
    details,
    accent: warningAccent(row.level),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
