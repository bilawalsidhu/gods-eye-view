/**
 * Solunar card formatting: the clock times, the spot, the day rows and the
 * rating rule the card shows. Pure text helpers with no DOM and no sky math,
 * so the view renders them while it renders the store's presentation.
 */
import { formatDate, t } from '../i18n/index.js';

/** Clock time in the spot's zone, rounded to the minute like an almanac. */
export function formatClock(ms, zone, hour12) {
  const rounded = Math.round(ms / 60_000) * 60_000;
  return formatDate(rounded, {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    // hour12:false alone gives "24:05" for 00:05 in some locales
    ...(hour12 ? { hour12: true } : { hourCycle: 'h23' }),
  });
}

/** The times of one event, or "none" when it does not happen that day. */
export function formatList(list, zone, hour12) {
  return list.length
    ? list.map((ms) => formatClock(ms, zone, hour12)).join(' · ')
    : t('none');
}

export const formatLatLon = (latDeg, lonDeg) =>
  `${Math.abs(latDeg).toFixed(3)}°${latDeg >= 0 ? 'N' : 'S'} ${Math.abs(lonDeg).toFixed(3)}°${lonDeg >= 0 ? 'E' : 'W'}`;

/** The stars of a rating, filled ones first, out of the day's maximum. */
export const starsText = (n, max) =>
  '★'.repeat(n) + '☆'.repeat(Math.max(0, max - n));

/** The day's heading: its weekday and date in the spot's own zone. */
export const dayTitle = (day, zone) =>
  formatDate(day.startMs + (day.endMs - day.startMs) / 2, {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

/** The moon's phase, in the page's language. */
const PHASE_LABEL = {
  'New Moon': () => t('New Moon'),
  'Waxing Crescent': () => t('Waxing Crescent'),
  'First Quarter': () => t('First Quarter'),
  'Waxing Gibbous': () => t('Waxing Gibbous'),
  'Full Moon': () => t('Full Moon'),
  'Waning Gibbous': () => t('Waning Gibbous'),
  'Last Quarter': () => t('Last Quarter'),
  'Waning Crescent': () => t('Waning Crescent'),
};

/**
 * The phase the sky math named, in the page's language.
 * @param {string} phase One of the eight phase names.
 */
export const phaseLabel = (phase) => (PHASE_LABEL[phase] ?? (() => phase))();

/** What makes a window: the moon's transit, its rise or its set. */
const WINDOW_SOURCE_LABEL = {
  upper: () => t('Moon overhead'),
  lower: () => t('Moon underfoot'),
  rise: () => t('Moonrise'),
  set: () => t('Moonset'),
};

/**
 * The reason a window falls where it does, in the page's language.
 * @param {string} source One of upper, lower, rise or set.
 */
export const windowSourceLabel = (source) =>
  (WINDOW_SOURCE_LABEL[source] ?? (() => source))();

/**
 * The rating rule under the week, in the page's language.
 * @param {{near: number, close: number, hours: number}} rule The rule's
 *   numbers, as the card owner published them.
 */
export const ruleLines = (rule) => [
  t(
    'Moon: new or full moon within {near} day = 2 points, within {close} days = 1 point.',
    { near: rule.near, close: rule.close },
  ),
  t('Dawn and dusk: {hours} h either side of sunrise and of sunset.', {
    hours: rule.hours,
  }),
  t(
    'Fishing: +1 for dawn and +1 for dusk when a major window (moon overhead or underfoot, about 2 h) overlaps it.',
  ),
  t(
    'Hunting: +1 for dawn and +1 for dusk when any window (major, or minor at moonrise or moonset, about 1 h) overlaps it.',
  ),
  t('Stars = points, at least 1 and at most 4.'),
  t(
    'Computed in your browser from the Sun and Moon positions. No outside data is used.',
  ),
];

/**
 * One day of the card as the view renders it: its heading, its rating and
 * the rows of times and windows, each with the text the card shows.
 * @param {object} day A day, as the card owner published it.
 * @param {string} zone The spot's own time zone.
 * @param {boolean} hour12 Whether the clock shows 12 hours.
 * @param {number} maxStars The most stars a day may carry.
 */
export function dayCard(day, zone, hour12, maxStars) {
  const windowRow = (kind, label, cls) => {
    const list = day.windows.filter((window) => window.kind === kind);
    return {
      key: kind,
      cls,
      label,
      none: !list.length,
      value: list.length
        ? list
            .map(
              (window) =>
                `${formatClock(window.startMs, zone, hour12)} – ${formatClock(window.endMs, zone, hour12)} (${windowSourceLabel(window.source)})`,
            )
            .join('\n')
        : t('none'),
    };
  };
  const timeRow = (key, label, cls, list) => ({
    key,
    cls,
    label,
    none: !list.length,
    value: formatList(list, zone, hour12),
  });
  const rate = (key, label, count) => ({
    key,
    label,
    count,
    glyphs: starsText(count, maxStars),
    aria: t('{label}: {stars} of {max} stars', {
      label,
      stars: count,
      max: maxStars,
    }),
  });
  return {
    date: day.date,
    title: dayTitle(day, zone),
    phase: `${phaseLabel(day.phase)} · ${t('{percent}% lit', { percent: Math.round(day.illumination * 100) })}`,
    stars: [
      rate('hunting', t('Hunting'), day.huntingStars),
      rate('fishing', t('Fishing'), day.fishingStars),
    ],
    windows: [
      windowRow('major', t('Major window'), 'gev-sl-major'),
      windowRow('minor', t('Minor window'), 'gev-sl-minor'),
    ],
    times: [
      timeRow('sunrise', t('Sunrise'), 'gev-sl-sunrise', day.sunrise),
      timeRow('sunset', t('Sunset'), 'gev-sl-sunset', day.sunset),
      timeRow('moonrise', t('Moonrise'), 'gev-sl-moonrise', day.moonrise),
      timeRow('moonset', t('Moonset'), 'gev-sl-moonset', day.moonset),
      timeRow('upper', t('Moon overhead'), 'gev-sl-upper', day.moonUpper),
      timeRow('lower', t('Moon underfoot'), 'gev-sl-lower', day.moonLower),
    ],
  };
}
