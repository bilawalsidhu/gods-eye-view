import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';

export const ECLIPSE_KINDS = Object.freeze([
  'total',
  'annular',
  'hybrid',
  'partial',
  'lunar-total',
  'lunar-partial',
  'lunar-penumbral',
]);

/** One colour per kind of eclipse, for the path and the legend. */
export const KIND_COLORS = Object.freeze({
  total: '#ffd166',
  annular: '#ff7b3d',
  hybrid: '#d58cff',
  partial: '#8fb4d9',
  'lunar-total': '#e5533d',
  'lunar-partial': '#ff9ec4',
  'lunar-penumbral': '#c9d3e0',
});

export const KIND_LABELS = Object.freeze({
  total: msg('Total solar eclipse'),
  annular: msg('Annular solar eclipse'),
  hybrid: msg('Hybrid solar eclipse'),
  partial: msg('Partial solar eclipse'),
  'lunar-total': msg('Total lunar eclipse'),
  'lunar-partial': msg('Partial lunar eclipse'),
  'lunar-penumbral': msg('Penumbral lunar eclipse'),
});

export const KIND_SHORT_LABELS = Object.freeze({
  total: msg('Total'),
  annular: msg('Annular'),
  hybrid: msg('Hybrid'),
  partial: msg('Partial'),
  'lunar-total': msg('Total lunar'),
  'lunar-partial': msg('Partial lunar'),
  'lunar-penumbral': msg('Penumbral lunar'),
});

/**
 * An eclipse's kind in a list that already says whether it is the Sun's or
 * the Moon's: one word, so the line fits.
 */
export const KIND_LIST_LABELS = Object.freeze({
  ...KIND_SHORT_LABELS,
  'lunar-total': msg('Total'),
  'lunar-partial': msg('Partial'),
  'lunar-penumbral': msg('Penumbral'),
});

const DAY_OF_YEAR = Object.freeze({
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const DAY = Object.freeze({
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const CLOCK = Object.freeze({
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** The eclipse's day, as the catalogue dates it (UTC). */
export const eclipseDay = (eclipse) => formatDate(eclipse.greatestMs, DAY);

/** The eclipse's day without its year, for a list that gives the year. */
export const eclipseDayOfYear = (eclipse) =>
  formatDate(eclipse.greatestMs, DAY_OF_YEAR);

/** A time as "10:06 UTC". */
export const utcClock = (ms) =>
  t('{time} UTC', { time: formatDate(ms, CLOCK) });

/** Seconds as minutes and seconds. */
export function durationText(seconds) {
  const whole = Math.round(seconds);
  return t('{minutes} min {seconds} s', {
    minutes: formatNumber(Math.floor(whole / 60)),
    seconds: formatNumber(whole % 60),
  });
}

/** Minutes as hours and minutes. */
export function minutesText(minutes) {
  const whole = Math.round(minutes);
  return whole < 60
    ? t('{minutes} min', { minutes: formatNumber(whole) })
    : t('{hours} h {minutes} min', {
        hours: formatNumber(Math.floor(whole / 60)),
        minutes: formatNumber(whole % 60),
      });
}

/** Title and detail lines for one lunar eclipse: when, and how long each phase lasts. */
function describeLunarEclipse(eclipse) {
  const details = [
    t('Greatest eclipse: {time}', { time: utcClock(eclipse.greatestMs) }),
  ];
  if (eclipse.totalMinutes > 0)
    details.push(
      t('Totality: {duration}', {
        duration: minutesText(eclipse.totalMinutes),
      }),
    );
  if (eclipse.partialMinutes > 0)
    details.push(
      t('In the umbra: {duration}', {
        duration: minutesText(eclipse.partialMinutes),
      }),
    );
  details.push(
    t('Whole eclipse: {duration}', {
      duration: minutesText(eclipse.penumbralMinutes),
    }),
  );
  details.push(t('Saros series {number}', { number: eclipse.saros }));
  details.push(t('Predictions: Espenak and Meeus, NASA’s GSFC'));
  return {
    title: `${t(KIND_LABELS[eclipse.kind])} · ${eclipseDay(eclipse)}`,
    details,
  };
}

/**
 * Title and detail lines for one eclipse: when, how long the central phase
 * lasts at its longest, how wide the path is, and the source.
 * @returns {{title: string, details: string[]}}
 */
export function describeEclipse(eclipse) {
  if (eclipse.body === 'lunar') return describeLunarEclipse(eclipse);
  const details = [
    t('Greatest eclipse: {time}', { time: utcClock(eclipse.greatestMs) }),
  ];
  if (eclipse.centralDurationSeconds > 0)
    details.push(
      eclipse.kind === 'annular'
        ? t('Annularity: up to {duration}', {
            duration: durationText(eclipse.centralDurationSeconds),
          })
        : t('Totality: up to {duration}', {
            duration: durationText(eclipse.centralDurationSeconds),
          }),
    );
  if (eclipse.pathWidthKm > 0)
    details.push(
      t('Path width: {km} km', {
        km: formatNumber(Math.round(eclipse.pathWidthKm)),
      }),
    );
  if (eclipse.kind === 'partial')
    details.push(
      t('At most {percent}% of the Sun’s diameter covered', {
        percent: formatNumber(Math.round(eclipse.magnitude * 100)),
      }),
    );
  details.push(t('Saros series {number}', { number: eclipse.saros }));
  details.push(t('Predictions: Espenak and Meeus, NASA’s GSFC'));
  return {
    title: `${t(KIND_LABELS[eclipse.kind])} · ${eclipseDay(eclipse)}`,
    details,
  };
}

/** The label at the point of greatest eclipse: its kind and longest duration. */
export function greatestLabel(eclipse) {
  const kind = t(KIND_SHORT_LABELS[eclipse.kind]);
  if (eclipse.body === 'lunar')
    return eclipse.totalMinutes > 0
      ? `${kind} · ${minutesText(eclipse.totalMinutes)}`
      : kind;
  return eclipse.centralDurationSeconds > 0
    ? `${kind} · ${durationText(eclipse.centralDurationSeconds)}`
    : kind;
}
