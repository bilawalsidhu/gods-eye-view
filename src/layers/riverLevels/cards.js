/** Card and label models for river gauges. Pure — no Cesium types. */

import { msg, t } from '../../i18n/index.js';
import {
  RIVER_LEVEL_PROVIDERS,
  formatLevel,
  formatTrend,
  readingIsLate,
  riverBandById,
  riverBandSeverity,
  sparkline,
  trendDirection,
} from './model.js';
import { alertLevelsFor } from './alerts.js';

export const RIVER_LEVELS_OVERLAY_SOURCE_ID = 'river-levels';
export const RIVER_LEVELS_CARD_SOURCE_ID = 'river-levels-card';
export const RIVER_LEVELS_LABEL_COHORT_LIMIT = 40;
export const RIVER_LEVELS_LABEL_COLLISION_CAPACITY = 28;

const ARROWS = Object.freeze({ rising: '▲', falling: '▼', steady: '▬' });

/** Trend glyph for a rate in cm/h, or '' when unknown. */
export function trendGlyph(cmPerHour) {
  return ARROWS[trendDirection(cmPerHour)] || '';
}

const ageText = (observedMs, now) => {
  const minutes = Math.max(0, Math.floor((now - observedMs) / 60_000));
  if (minutes < 60) return t('{minutes} min ago', { minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 48
    ? t('{hours} h ago', { hours })
    : t('{days} d ago', { days: Math.floor(hours / 24) });
};

/** Reference lines, in the order a reader scans a gauge board. */
const REFERENCE_LABELS = Object.freeze([
  ['recordLow', msg('Record low {value}')],
  ['mean', msg('Mean {value}')],
  ['watch', msg('Watch {value}')],
  ['warning', msg('Warning {value}')],
  ['flood', msg('Flood {value}')],
  ['recordHigh', msg('Record high {value}')],
]);

/**
 * The always-on label for one gauge: name, level, trend.
 * @returns {object} World-overlay entry without `position`.
 */
export function buildRiverLevelLabel(station) {
  const band = riverBandById(station.band);
  const glyph = trendGlyph(station.trend);
  return {
    id: `river-level:${station.id}`,
    variant: 'label',
    title: `${station.name} · ${formatLevel(station.level)}${glyph ? ` ${glyph}` : ''}`,
    accent: band.color,
    // Floods first, then record lows, then the fastest-moving rivers.
    priority:
      riverBandSeverity(station.band) * 1000 +
      Math.min(999, Math.round(Math.abs(station.trend ?? 0) * 10)),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 12,
    verticalOnly: true,
    placement: 'above',
    // Labels belong to a regional view, not the whole hemisphere.
    maxDistance: 2_500_000,
  };
}

/** Keep the most severe labels, with stable identity as the tie-break. */
export function selectRiverLabelCohort(
  entries,
  limit = RIVER_LEVELS_LABEL_COHORT_LIMIT,
) {
  return (entries || [])
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, Math.max(0, limit));
}

/**
 * The card for a selected gauge.
 * @param {object} station Normalized station (source.js).
 * @param {{points?: Array<[number, number]>, partial?: boolean, trend?: number|null}|null} series
 *   Recent readings, or null while they load. Its trend stands in until the
 *   next snapshot carries one.
 * @param {number} [now]
 * @returns {object} World-overlay entry without `position`.
 */
export function buildRiverLevelCard(
  station,
  series = null,
  now = Date.now(),
  alertLevel = null,
) {
  const band = riverBandById(station.band);
  const provider = RIVER_LEVEL_PROVIDERS[station.provider];
  const details = [];

  const where = [station.river, station.nativeName, provider?.network]
    .filter(Boolean)
    .join(' · ');
  if (where) details.push(where);

  const reading = [formatLevel(station.level)];
  const trend = Number.isFinite(station.trend)
    ? station.trend
    : Number.isFinite(series?.trend)
      ? series.trend
      : null;
  const glyph = trendGlyph(trend);
  const rate = formatTrend(trend);
  if (glyph && rate) reading.push(`${glyph} ${rate}`);
  reading.push(
    readingIsLate(station, now)
      ? t('Late reading · {age}', { age: ageText(station.observedMs, now) })
      : ageText(station.observedMs, now),
  );
  details.push(reading.join(' · '));

  const refs = REFERENCE_LABELS.filter(
    ([key]) => station.refs?.[key] !== undefined,
  )
    .map(([key, label]) => t(label, { value: formatLevel(station.refs[key]) }))
    .join(' · ');
  if (refs) details.push(refs);

  const points = series?.points || [];
  if (points.length >= 2) {
    const spanHours = Math.max(
      1,
      Math.round((points.at(-1)[0] - points[0][0]) / 3_600_000),
    );
    details.push(
      `${sparkline(points, 24)} ${
        series.partial
          ? t('{hours} h seen by this server', { hours: spanHours })
          : t('last {hours} h', { hours: spanHours })
      }`,
    );
  } else if (series === null) {
    details.push(t('Loading recent readings…'));
  }

  // The card is not clickable; the alert itself is set in the Weather panel.
  if (alertLevel)
    details.push(
      t('Alert at {level}', { level: t(riverBandById(alertLevel).label) }),
    );
  else if (alertLevelsFor(station).length)
    details.push(t('Level alert: Weather panel'));

  details.push(t('Local gauge zero · not comparable between gauges'));
  details.push(t('Raw data · not quality controlled'));

  return {
    id: `river-level-card:${station.id}`,
    selected: true,
    interactive: false,
    title: `${t(band.label).toUpperCase()} · ${station.name}`,
    details,
    accent: band.color,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 18,
    verticalOnly: true,
    placement: 'above',
  };
}
