import { formatDate, formatRelativeTime, t } from '../../i18n/index.js';
import { formatQuantity } from '../../ui/unitLabels.js';
import { percentOfRange, seaLevelFreshness } from './records.js';

export const SEA_LEVEL_OVERLAY_SOURCE_ID = 'sea-level-stations';
/** Columns in the card's plot of the last 72 hours: two hours each. */
export const SEA_LEVEL_PLOT_COLUMNS = 36;
const PLOT_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const PLOT_GAP = ' ';

/** A level in metres with its unit, or null. */
export function formatSeaLevel(value) {
  if (!Number.isFinite(value)) return null;
  return formatQuantity(value, 'm', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** "12 minutes ago" / "3 hours ago" / "5 days ago" in the active language. */
export function formatSeaLevelAge(ageMs) {
  if (!Number.isFinite(ageMs)) return null;
  const minutes = Math.round(Math.max(0, ageMs) / 60_000);
  if (minutes < 120) return formatRelativeTime(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return formatRelativeTime(-hours, 'hour');
  return formatRelativeTime(-Math.round(hours / 24), 'day');
}

const UTC_TIME = Object.freeze({
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/**
 * A one-line plot of the series: one block per two-hour column, its height
 * the column's mean within this station's own 72-hour range; a column with
 * no reading is a thin gap. Null with fewer than two readings or a flat range.
 * @param {{points: Array<[number, number]>, min: number|null,
 *   max: number|null}} series Normalised series.
 * @param {number} endMs End of the window (the latest reading).
 */
export function seaLevelPlot(series, endMs) {
  const points = series?.points || [];
  const lo = Math.min(...points.map(([, v]) => v));
  const hi = Math.max(...points.map(([, v]) => v));
  if (points.length < 2 || !Number.isFinite(endMs) || !(hi > lo)) return null;
  const span = 72 * 3_600_000;
  const width = span / SEA_LEVEL_PLOT_COLUMNS;
  const start = endMs - span;
  const sums = Array.from({ length: SEA_LEVEL_PLOT_COLUMNS }, () => [0, 0]);
  for (const [ms, value] of points) {
    const column = Math.floor((ms - start) / width);
    if (column < 0 || column >= SEA_LEVEL_PLOT_COLUMNS) continue;
    sums[column][0] += value;
    sums[column][1]++;
  }
  return sums
    .map(([sum, n]) => {
      if (!n) return PLOT_GAP;
      const share = (sum / n - lo) / (hi - lo);
      return PLOT_LEVELS[
        Math.min(PLOT_LEVELS.length - 1, Math.floor(share * PLOT_LEVELS.length))
      ];
    })
    .join('');
}

/** The card's lines about the last 72 hours. */
function seriesLines(series) {
  if (series === undefined) return [t('Loading the last 72 hours…')];
  if (series === null) return [t('Last 72 hours unavailable')];
  if (!series.latest) return [t('No readings in the last 72 hours')];
  const lines = [];
  const plot = seaLevelPlot(series, Date.parse(series.latest.iso));
  if (plot) lines.push(plot);
  lines.push(
    t('Last 72 h: low {min} · high {max}', {
      min: formatSeaLevel(series.min),
      max: formatSeaLevel(series.max),
    }),
  );
  const percent = percentOfRange(series.latest.value, series.min, series.max);
  lines.push(
    percent === null
      ? t('Level flat over the last 72 hours')
      : t('Latest {value} is at {percent}% of that range', {
          value: formatSeaLevel(series.latest.value),
          percent,
        }),
  );
  return lines;
}

/**
 * Build the overlay entry for one selected station. `series` is the trimmed
 * `/api/sea-level/station/<code>` answer, `undefined` while it loads and
 * `null` when it failed. The caller supplies `position`.
 * @param {object} station Layer record (records.js).
 * @param {object|null|undefined} series Normalised series.
 * @param {{ageMs?: number|null, link?: boolean}} [options] The reading's
 *   age now, and whether the card opens the station page.
 * @returns {object} World-overlay entry without `position`.
 */
export function buildSeaLevelCard(
  station,
  series,
  { ageMs = station.ageMs, link = true } = {},
) {
  const band = seaLevelFreshness(ageMs);
  const details = [
    [
      t('SEA LEVEL STATION · IOC {code}', { code: station.code }),
      station.country,
    ]
      .filter(Boolean)
      .join(' · '),
    t(band.label),
  ];
  const age = formatSeaLevelAge(ageMs);
  const level = formatSeaLevel(station.lastValue);
  if (age && level)
    details.push(t('Last reading {value} · {age}', { value: level, age }));
  else details.push(t('No reading reported'));
  const lastMs = Date.parse(station.lastIso);
  if (station.sensor && Number.isFinite(lastMs))
    details.push(
      t('Sensor {sensor} · {time} UTC', {
        sensor: station.sensor,
        time: formatDate(lastMs, UTC_TIME),
      }),
    );
  details.push(...seriesLines(series));
  details.push(
    t('Levels are against this gauge’s own datum; never compare stations'),
  );
  details.push(t('Raw data, not quality controlled'));
  if (link) details.push(t('IOC station page ↗ · click card to open'));
  // i18n-ignore: source credit as the facility names itself
  details.push('IOC Sea Level Station Monitoring Facility (VLIZ)');
  return {
    id: `sea-level-card:${station.code}`,
    selected: true,
    interactive: link,
    ...(link
      ? {
          accessibilityLabel: t('Open {name} on the IOC station page', {
            name: station.name,
          }),
        }
      : undefined),
    title: station.name,
    details,
    accent: band.color,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
