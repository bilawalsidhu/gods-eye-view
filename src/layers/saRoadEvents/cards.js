/**
 * Presentation model for Traffic SA road events: kind colours and labels,
 * Adelaide-time formatting and the selected-event overlay card. Pure — no
 * Cesium types, and nothing here builds markup: the overlay host draws every
 * line as text, so upstream strings are never interpreted as HTML.
 */
import { msg, t } from '../../i18n/index.js';

export const SA_ROAD_EVENTS_OVERLAY_SOURCE_ID = 'sa-road-events';
export const SA_ROAD_EVENTS_TIME_ZONE = 'Australia/Adelaide';

const KIND_COLORS = Object.freeze({
  incident: '#ff3b30',
  collision: '#ff2d78',
  flooding: '#2f9bff',
  waterworks: '#18c5b1',
  works24: '#ffab00',
  works: '#e6d04a',
  closure: '#ff3b30',
  detour: '#8a7dff',
  unknown: '#9aa4ad',
});

/**
 * English display labels per kind, in legend order (most urgent first). They
 * are `msg()` keys: pass one through `t()` where it is shown.
 */
export const SA_ROAD_EVENT_KIND_LABELS = Object.freeze({
  incident: msg('Incident'),
  collision: msg('Collision'),
  flooding: msg('Flooding'),
  waterworks: msg('Emergency waterworks'),
  closure: msg('Road closure'),
  detour: msg('Detour'),
  works24: msg('24 h roadworks'),
  works: msg('Roadworks'),
  unknown: msg('Other'),
});

/**
 * Colour for a road-event kind (point or line), as a CSS hex string.
 * @param {string} kind - A point or line kind from records.js.
 * @returns {string} Incident red, collision pink, flooding blue, emergency
 *   waterworks teal, 24 h roadworks amber, roadworks yellow, closure red,
 *   detour violet, anything else grey.
 */
export function roadEventColor(kind) {
  return KIND_COLORS[kind] || KIND_COLORS.unknown;
}

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: SA_ROAD_EVENTS_TIME_ZONE,
  weekday: 'short',
  day: '2-digit',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const ZONE = new Intl.DateTimeFormat('en-AU', {
  timeZone: SA_ROAD_EVENTS_TIME_ZONE,
  timeZoneName: 'short',
});
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function zoneName(ms) {
  const name =
    ZONE.formatToParts(ms).find(({ type }) => type === 'timeZoneName')?.value ||
    '';
  // Some engines only know the numeric form for this zone.
  if (/^GMT\+10:30$/.test(name)) return 'ACDT';
  if (/^GMT\+9:30$/.test(name)) return 'ACST';
  return name;
}

function adelaideParts(ms) {
  const parts = Object.fromEntries(
    PARTS.formatToParts(ms).map(({ type, value }) => [type, value]),
  );
  return { ...parts, zone: zoneName(ms) };
}

/**
 * "HH:MM ACDT" for an instant, in Adelaide local time (24 h clock).
 * @param {number} ms - UTC epoch milliseconds.
 * @returns {string|null} null when ms is not a finite instant.
 */
export function formatAdelaideClock(ms) {
  if (!Number.isFinite(ms)) return null;
  const p = adelaideParts(ms);
  return `${p.hour}:${p.minute} ${p.zone}`;
}

/**
 * "Thu 01 Oct 08:00 PM ACDT" for an instant, in Adelaide local time. The
 * year is appended only when it differs from `nowMs`' year, so multi-year
 * works are unambiguous without cluttering today's events.
 * @param {number} ms - UTC epoch milliseconds.
 * @param {number} [nowMs] - Reference instant for the year rule.
 * @returns {string|null} null when ms is not a finite instant.
 */
export function formatAdelaideDateTime(ms, nowMs = Date.now()) {
  if (!Number.isFinite(ms)) return null;
  const p = adelaideParts(ms);
  const hour24 = Number(p.hour);
  const hour12 = String(hour24 % 12 || 12).padStart(2, '0');
  const period = hour24 < 12 ? 'AM' : 'PM';
  const year =
    Number.isFinite(nowMs) && adelaideParts(nowMs).year !== p.year
      ? ` ${p.year}`
      : '';
  return `${p.weekday} ${p.day} ${MONTHS[Number(p.month) - 1]}${year} ${hour12}:${p.minute} ${period} ${p.zone}`;
}

/** Widest card line in characters; the overlay host does not wrap text. */
const CARD_LINE_CHARS = 64;
const MAX_DETAIL_LINES = 14;

/**
 * Break one detail string into lines of at most `width` characters at word
 * boundaries (a single over-long word is hard-cut).
 * @param {string} value - Detail text.
 * @param {number} [width] - Maximum characters per line.
 * @returns {string[]} Wrapped lines.
 */
export function wrapCardLine(value, width = CARD_LINE_CHARS) {
  const lines = [];
  let line = '';
  for (const word of String(value).split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line) lines.push(line);
  return lines;
}

const clip = (value, limit) =>
  value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;

function speedText(value) {
  if (!value) return null;
  return /^\d{1,3}$/.test(value) ? t('{speed} km/h', { speed: value }) : value;
}

function streetList(names, suburb) {
  const streets = names.join(' / ');
  if (streets && suburb) return `${streets} (${suburb})`;
  return streets || suburb || null;
}

function timingLines(record, nowMs) {
  const lines = [];
  const start = formatAdelaideDateTime(record.startMs, nowMs);
  const end = formatAdelaideDateTime(record.endMs, nowMs);
  if (start) lines.push(t('Start: {time}', { time: start }));
  lines.push(t('End: {time}', { time: end || t('not published') }));
  return lines;
}

/** "Feed updated 14:20 ACDT", flagged when the proxy is serving old data. */
export function feedUpdatedText(feedUpdatedMs, stale = false) {
  const clock = formatAdelaideClock(feedUpdatedMs);
  if (!clock) return t('Feed time unavailable');
  return stale
    ? t('Feed updated {time} · STALE, source unreachable', { time: clock })
    : t('Feed updated {time}', { time: clock });
}

function pointDetails(record, nowMs) {
  const details = [];
  if (record.description) details.push(clip(record.description, 300));
  const where = [
    record.road && record.sideStreet
      ? t('{road} at {sideStreet}', {
          road: record.road,
          sideStreet: record.sideStreet,
        })
      : record.road || record.sideStreet,
    record.suburb,
  ].filter(Boolean);
  if (where.length) details.push(where.join(' · '));
  const traffic = [];
  if (record.direction)
    traffic.push(t('Direction: {direction}', { direction: record.direction }));
  if (record.lanesClosed)
    traffic.push(t('Lanes closed: {lanes}', { lanes: record.lanesClosed }));
  const speed = speedText(record.speedLimit);
  if (speed) traffic.push(t('Speed limit: {speed}', { speed }));
  if (traffic.length) details.push(traffic.join(' · '));
  details.push(...timingLines(record, nowMs));
  return details;
}

function lineDetails(record, nowMs) {
  const details = [];
  if (record.details) details.push(clip(record.details, 360));
  if (record.road) details.push(record.road);
  const from = streetList(record.startStreets, record.startSuburb);
  const to = streetList(record.endStreets, record.endSuburb);
  if (from && to) details.push(t('From {from} to {to}', { from, to }));
  else if (from || to) details.push(t('At {place}', { place: from || to }));
  details.push(...timingLines(record, nowMs));
  return details;
}

/**
 * Build the overlay-host entry for one selected road event (a point record
 * or a closure/detour line record). The caller supplies `position`
 * (Cartesian) separately so this stays JSON-safe for tests.
 * @param {object} record - Normalized point or line record (see records.js).
 * @param {{nowMs?: number, feedUpdatedMs?: number, stale?: boolean}} [context]
 * @returns {object} World-overlay entry without `position`.
 */
export function buildSaRoadEventCard(
  record,
  { nowMs = Date.now(), feedUpdatedMs = null, stale = false } = {},
) {
  const isLine = Array.isArray(record.lines);
  const label = t(
    SA_ROAD_EVENT_KIND_LABELS[record.kind] || SA_ROAD_EVENT_KIND_LABELS.unknown,
  );
  const place = isLine
    ? record.road
    : record.road || record.sideStreet || record.suburb;
  const details = [
    ...(isLine ? lineDetails(record, nowMs) : pointDetails(record, nowMs)),
    feedUpdatedText(feedUpdatedMs, stale),
  ]
    .flatMap((entry) => entry.split('\n'))
    .flatMap((entry) => wrapCardLine(entry));
  if (details.length > MAX_DETAIL_LINES) {
    details.length = MAX_DETAIL_LINES - 1;
    details.push('…');
  }
  const title = clip(
    `${label.toUpperCase()} · ${place || t('South Australia')}`,
    CARD_LINE_CHARS,
  );
  return {
    id: `sa-road-event-card:${isLine ? 'line' : 'point'}:${record.id}`,
    selected: true,
    interactive: false,
    title,
    details,
    accent: roadEventColor(record.kind),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
