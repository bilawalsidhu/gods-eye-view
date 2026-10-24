import {
  formatDate,
  formatNumber,
  formatRelativeTime,
  msg,
  t,
  tn,
} from '../../i18n/index.js';

/**
 * Impact bands, strongest first. Colour means what the work does to the
 * lanes, never traffic speed. Open-lane and unreported work is drawn thin and
 * faint so the closures stand out from the long-running roadworks.
 */
export const WORK_ZONE_BANDS = Object.freeze([
  Object.freeze({
    id: 'closed',
    label: msg('Road closed'),
    color: '#ff453a',
    impacts: ['all-lanes-closed'],
    width: 5,
    alpha: 0.95,
    pixelSize: 9,
  }),
  Object.freeze({
    id: 'lanes',
    label: msg('Lanes closed'),
    color: '#ff9f0a',
    impacts: [
      'some-lanes-closed',
      'some-lanes-closed-merge-left',
      'some-lanes-closed-merge-right',
      'some-lanes-closed-split',
    ],
    width: 4,
    alpha: 0.9,
    pixelSize: 8,
  }),
  Object.freeze({
    id: 'controlled',
    label: msg('One lane alternating, flagging or signal'),
    color: '#ffd60a',
    impacts: ['alternating-one-way', 'flagging', 'temporary-traffic-signal'],
    width: 4,
    alpha: 0.85,
    pixelSize: 7,
  }),
  Object.freeze({
    id: 'open',
    label: msg('Lanes open or shifted'),
    color: '#8fb3d9',
    impacts: [
      'all-lanes-open',
      'all-lanes-open-shift-left',
      'all-lanes-open-shift-right',
    ],
    width: 2.5,
    alpha: 0.55,
    pixelSize: 5,
  }),
  Object.freeze({
    id: 'unknown',
    label: msg('Impact not reported'),
    color: '#a8a8a8',
    impacts: ['unknown'],
    width: 2,
    alpha: 0.45,
    pixelSize: 5,
  }),
  Object.freeze({
    id: 'detour',
    label: msg('Detour route'),
    color: '#bf5af2',
    impacts: [],
    width: 3,
    alpha: 0.8,
    pixelSize: 6,
    dashed: true,
  }),
]);

const BAND_BY_IMPACT = new Map(
  WORK_ZONE_BANDS.flatMap((band) =>
    band.impacts.map((impact) => [impact, band]),
  ),
);

/** The band an event draws in: detours by type, work zones by impact. */
export function workZoneBand(event) {
  if (event?.type === 'detour') return WORK_ZONE_BANDS.at(-1);
  return BAND_BY_IMPACT.get(event?.impact) ?? BAND_BY_IMPACT.get('unknown');
}

const IMPACT_LABELS = Object.freeze({
  'all-lanes-closed': msg('All lanes closed'),
  'some-lanes-closed': msg('Some lanes closed'),
  'some-lanes-closed-merge-left': msg('Some lanes closed, merge left'),
  'some-lanes-closed-merge-right': msg('Some lanes closed, merge right'),
  'some-lanes-closed-split': msg('Some lanes closed, traffic split'),
  'alternating-one-way': msg('One lane, alternating directions'),
  flagging: msg('Flagging operation'),
  'temporary-traffic-signal': msg('Temporary traffic signal'),
  'all-lanes-open': msg('All lanes open'),
  'all-lanes-open-shift-left': msg('All lanes open, shifted left'),
  'all-lanes-open-shift-right': msg('All lanes open, shifted right'),
  unknown: msg('Lane impact not reported'),
});

const DIRECTION_LABELS = Object.freeze({
  northbound: msg('NORTHBOUND'),
  eastbound: msg('EASTBOUND'),
  southbound: msg('SOUTHBOUND'),
  westbound: msg('WESTBOUND'),
  'inner-loop': msg('INNER LOOP'),
  'outer-loop': msg('OUTER LOOP'),
});

const DATE_TIME = Object.freeze({
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});
const DATE_ONLY = Object.freeze({
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const YEAR_MS = 365 * 24 * 3600_000;

/** A start or end time: date and time when near, the date alone when far. */
function when(value, now) {
  return formatDate(
    value,
    Math.abs(value - now) > 60 * 24 * 3600_000 ? DATE_ONLY : DATE_TIME,
  );
}

/** The schedule line, or '' when the feed gives neither end. */
export function scheduleLine(event, now = Date.now()) {
  const { start, end } = event;
  if (start !== null && end !== null) {
    // Producers write far-off placeholder ends (Indiana: years ahead).
    if (end - now > 3 * YEAR_MS)
      return t('Since {start}, no firm end date', { start: when(start, now) });
    return t('{start} to {end}', {
      start: when(start, now),
      end: when(end, now),
    });
  }
  if (start !== null) return t('From {start}', { start: when(start, now) });
  if (end !== null) return t('Until {end}', { end: when(end, now) });
  return '';
}

/** "Updated 3 hours ago", in the largest unit that fits. */
export function updatedLine(updated, now = Date.now()) {
  if (updated === null) return '';
  const seconds = Math.round((updated - now) / 1000);
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size)
      return t('Updated {ago}', {
        ago: formatRelativeTime(Math.round(seconds / size), unit),
      });
  return t('Updated {ago}', { ago: formatRelativeTime(0, 'minute') });
}

/** Word-wrap feed text for the card, which draws one line per entry. */
export function wrapText(text, width = 60, maxLines = 3) {
  if (!text) return [];
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const piece = word.length > width ? `${word.slice(0, width - 1)}…` : word;
    if (!line) line = piece;
    else if (line.length + 1 + piece.length <= width) line += ` ${piece}`;
    else {
      lines.push(line);
      line = piece;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (line && lines.length === maxLines) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] =
      last.length >= width ? `${last.slice(0, width - 1)}…` : `${last}…`;
  }
  return lines;
}

/** The card a selected event opens: road, direction, impact, dates, text. */
export function workZoneCardModel(event, { publisher, now = Date.now() }) {
  const band = workZoneBand(event);
  const kind = [
    event.type === 'detour' ? t('DETOUR') : t('WORK ZONE'),
    event.start !== null && event.start > now ? t('UPCOMING') : '',
    DIRECTION_LABELS[event.direction]
      ? t(DIRECTION_LABELS[event.direction])
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const details = [
    kind,
    event.type === 'work-zone'
      ? t(IMPACT_LABELS[event.impact] ?? IMPACT_LABELS.unknown)
      : '',
    scheduleLine(event, now),
    event.workers === true
      ? t('Workers present')
      : event.workers === false
        ? t('No workers present')
        : '',
    // Feed text stays as published; it is drawn as text, never markup.
    ...wrapText(event.description),
    updatedLine(event.updated, now),
    // i18n-ignore: the publisher's name and the standard it publishes in
    `${publisher} · WZDx`,
  ].filter(Boolean);
  return {
    title: event.roads.length ? event.roads.join(' / ') : t('Unnamed road'),
    details,
    accent: band.color,
    cardStyle: 'tactical',
    selected: true,
    leaderStyle: 'elbow',
    anchorRadiusPx: 7,
    anchorRadiusScale: null,
  };
}

/**
 * The row's feed line: how many feeds are live and which are stale or
 * unreachable, in the shapes translateFeedError already reads.
 */
export function feedSummary(feeds) {
  const live = feeds.filter((feed) => feed.status === 'live').length;
  const stale = feeds.filter((feed) => feed.status === 'stale');
  const down = feeds.filter((feed) => feed.status === 'unavailable');
  const names = (list) => list.map((feed) => feed.name).join(', ');
  return [
    `${live} ${live === 1 ? 'feed' : 'feeds'} live`,
    stale.length
      ? `${stale.length === 1 ? 'feed' : 'feeds'} ${names(stale)} stale`
      : '',
    down.length
      ? `${down.length === 1 ? 'feed' : 'feeds'} ${names(down)} unreachable`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Legend rows with counts, the first carrying the colour note. */
export function workZoneLegend(events) {
  const counts = new Map();
  for (const event of events) {
    const band = workZoneBand(event);
    counts.set(band.id, (counts.get(band.id) ?? 0) + 1);
  }
  return WORK_ZONE_BANDS.map((band, index) => ({
    label: t(band.label),
    color: band.color,
    count: counts.get(band.id) ?? 0,
    ...(index === 0
      ? {
          blurb: t(
            'Colour shows what the work does to the lanes, not traffic speed. Ended work and work starting more than a week ahead is left out.',
          ),
        }
      : {}),
  }));
}

/** "3,970 work zones" for the row. */
export function workZoneCountLabel(count) {
  return tn(count, '{count} work zone', '{count} work zones', {
    count: formatNumber(count),
  });
}
