/** Card models and colour rules for the South Australian fire layer. Pure — no Cesium types. */
import { msg, t, tn } from '../../i18n/index.js';
import { zoneOffsetMs } from './records.js';

export const SA_FIRE_OVERLAY_SOURCE_ID = 'sa-fire-incidents';

const ADELAIDE = 'Australia/Adelaide';
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

/**
 * CSS colour for an incident status. Kept deliberately small and isolated so
 * the palette is easy to tune; unknown or missing statuses are grey.
 * @param {?string} status - Upstream status (Going, Contained, Controlled, Safe).
 * @returns {string} CSS colour.
 */
export function incidentStatusColor(status) {
  switch (
    String(status ?? '')
      .trim()
      .toLowerCase()
  ) {
    case 'going':
      return '#ff4a1c';
    case 'contained':
      return '#ffa000';
    case 'controlled':
      return '#ffe03d';
    case 'safe':
      return '#4caf50';
    default:
      return '#9e9e9e';
  }
}

/** Legend bands, in severity order; the last band collects every other status. */
export const INCIDENT_STATUS_BANDS = Object.freeze([
  { status: 'Going', label: msg('Going') }, // i18n-ignore: feed value; `label` is shown
  { status: 'Contained', label: msg('Contained') }, // i18n-ignore: feed value; `label` is shown
  { status: 'Controlled', label: msg('Controlled') }, // i18n-ignore: feed value; `label` is shown
  { status: 'Safe', label: msg('Safe') }, // i18n-ignore: feed value; `label` is shown
  { status: null, label: msg('Other / unknown') },
]);

/** Band label (English; show it through t()) for a status, case-insensitive, matching INCIDENT_STATUS_BANDS. */
export function incidentStatusBand(status) {
  const key = String(status ?? '')
    .trim()
    .toLowerCase();
  return (
    INCIDENT_STATUS_BANDS.find((band) => band.status?.toLowerCase() === key)
      ?.label ?? msg('Other / unknown')
  );
}

/** Marker size tier: L1 → 1, L2 → 2, L3 → 3; unknown levels use the smallest. */
export function incidentLevelRank(level) {
  const rank = Number(/^L([1-3])$/i.exec(String(level ?? '').trim())?.[1]);
  return rank || 1;
}

/** Warning colour by Australian Warning System category (red, orange, yellow). */
export function warningCategoryColor(category) {
  const key = String(category ?? '').toLowerCase();
  if (key.includes('emergency')) return '#bf0000';
  if (key.includes('watch')) return '#ff8040';
  if (key.includes('advice')) return '#f5ec3d';
  return '#9e9e9e';
}

/** Offset label for Adelaide at an instant: ACDT (+10:30), ACST (+9:30), else a raw offset. */
function adelaideParts(ms) {
  if (!Number.isFinite(ms)) return null;
  const offset = zoneOffsetMs(ms, ADELAIDE);
  if (offset === null) return null;
  const wall = new Date(ms + offset);
  const pad = (value) => String(value).padStart(2, '0');
  const zone =
    offset === 37800000
      ? 'ACDT'
      : offset === 34200000
        ? 'ACST'
        : `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 3600000))}:${pad(Math.floor((Math.abs(offset) % 3600000) / 60000))}`;
  return {
    date: `${wall.getUTCDate()} ${MONTHS[wall.getUTCMonth()]}`,
    time: `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`,
    zone,
  };
}

/** "19:30 ACDT" in Adelaide local time, or null for a missing/invalid instant. */
export function formatAdelaideTime(ms) {
  const parts = adelaideParts(ms);
  return parts ? `${parts.time} ${parts.zone}` : null;
}

/** "13 Oct 19:30 ACDT" in Adelaide local time, or null. */
export function formatAdelaideDateTime(ms) {
  const parts = adelaideParts(ms);
  return parts ? `${parts.date} ${parts.time} ${parts.zone}` : null;
}

/** Upstream text is ALL-CAPS for places and types; render it in title case. */
function titleCase(text) {
  return String(text)
    .toLowerCase()
    .replace(
      /(^|[\s/(-])([a-z])/g,
      (_, lead, letter) => lead + letter.toUpperCase(),
    );
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Greedy word wrap into at most `maxLines` lines (the last ends in an ellipsis if cut). */
export function wrapCardText(text, width = 48, maxLines = 4) {
  const lines = [];
  let line = '';
  const words = String(text ?? '')
    .split(/\s+/)
    .filter(Boolean);
  for (let word of words) {
    if (word.length > width) word = `${word.slice(0, width - 1)}…`;
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = truncate(`${lines[maxLines - 1]} …`, width);
  }
  return lines;
}

/**
 * Overlay entry for one selected incident. The caller supplies `position`
 * (Cartesian); the model stays JSON-safe for tests.
 * @param {Object} row - Normalized incident row (see records.js).
 * @param {{feedTime?: ?number, warning?: ?Object}} [extras] - Feed time and any linked warning.
 * @returns {Object} World-overlay entry without `position`.
 */
export function buildIncidentCard(
  row,
  { feedTime = null, warning = null } = {},
) {
  const facts = [row.status, row.level, row.agency].filter(Boolean);
  const place = [
    row.fireBanDistrict ? titleCase(row.fireBanDistrict) : null,
    row.region ? t('Region {region}', { region: row.region }) : null,
  ].filter(Boolean);
  const resources = [];
  if (row.ground != null)
    resources.push(tn(row.ground, '{count} ground', '{count} ground'));
  if (row.aircraft != null)
    resources.push(tn(row.aircraft, '{count} aircraft', '{count} aircraft'));
  if (row.messageCount != null)
    resources.push(tn(row.messageCount, '{count} message', '{count} messages'));

  const details = [];
  if (facts.length) details.push(facts.join(' · '));
  if (place.length) details.push(place.join(' · '));
  const reported = formatAdelaideDateTime(row.reportedTime);
  details.push(
    reported
      ? t('Reported {time}', { time: reported })
      : t('Reported time unknown'),
  );
  if (resources.length) details.push(resources.join(' · '));
  if (warning)
    details.push(
      t('Warning: {category}', {
        category: truncate(warning.category || t('Active'), 40),
      }),
    );
  const feed = formatAdelaideTime(feedTime);
  if (feed) details.push(t('Feed updated {time}', { time: feed }));

  const title = `${row.type ? titleCase(row.type) : t('Incident')} · ${
    row.name ? titleCase(row.name) : row.id
  }`;
  return {
    id: `sa-fire-incident-card:${row.id}`,
    selected: true,
    interactive: false,
    title: truncate(title, 48),
    details,
    accent: incidentStatusColor(row.status),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Overlay entry for one selected warning. All text is untrusted and is only
 * ever painted as canvas text (never HTML); long text is wrapped and capped.
 * @param {Object} row - Normalized warning row.
 * @param {{feedTime?: ?number, incident?: ?Object}} [extras]
 * @returns {Object} World-overlay entry without `position`.
 */
export function buildWarningCard(
  row,
  { feedTime = null, incident = null } = {},
) {
  const heading = row.headline || row.name || t('Warning');
  const details = [];
  const body = row.description || row.longDescription;
  if (row.name && row.name !== heading) details.push(truncate(row.name, 48));
  if (body) details.push(...wrapCardText(body, 48, 4));
  const expires = formatAdelaideDateTime(row.expiryTime);
  details.push(
    expires ? t('Expires {time}', { time: expires }) : t('No expiry set'),
  );
  const updated = formatAdelaideDateTime(row.editedTime ?? row.createdTime);
  if (updated) details.push(t('Updated {time}', { time: updated }));
  if (incident)
    details.push(
      incident.name
        ? t('Incident {id} · {name}', {
            id: incident.id,
            name: titleCase(incident.name),
          })
        : t('Incident {id}', { id: incident.id }),
    );
  const feed = formatAdelaideTime(feedTime);
  if (feed) details.push(t('Feed updated {time}', { time: feed }));
  if (row.link) details.push(t('More information ↗ · click card to open'));

  const title = `${row.category || t('Warning')} · ${heading}`;
  return {
    id: `sa-fire-warning-card:${row.id}`,
    selected: true,
    interactive: Boolean(row.link),
    ...(row.link
      ? {
          accessibilityLabel: t('Open {title} on cfs.sa.gov.au', {
            title: truncate(title, 60),
          }),
        }
      : undefined),
    title: truncate(title, 48),
    details,
    accent: warningCategoryColor(row.category),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
