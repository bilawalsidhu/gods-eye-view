import {
  formatDate,
  formatNumber,
  formatRelativeTime,
  msg,
  t,
} from '../../i18n/index.js';
import { formatQuantity, unitLabel } from '../../ui/unitLabels.js';
import { forecastIsCurrent, riverGaugeCategory } from './records.js';

export const RIVER_GAUGE_OVERLAY_SOURCE_ID = 'river-gauges';

/** Flood-stage words in the order NWS lists them, as card pieces. */
const THRESHOLD_PIECES = Object.freeze([
  ['action', msg('action {stage}')],
  ['minor', msg('minor {stage}')],
  ['moderate', msg('moderate {stage}')],
  ['major', msg('major {stage}')],
]);

/** A stage or flow with its unit; unit ids stay as NWPS sends them. */
export function formatGaugeValue(value, unit) {
  if (!Number.isFinite(value)) return null;
  const digits = Math.abs(value) >= 100 ? 0 : 2;
  return formatQuantity(value, unit || '', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

/** "Stage 14.2 ft · Flow 3.1 kcfs", or null with neither. */
export function formatGaugeReading(status) {
  if (!status) return null;
  const pieces = [];
  const stage = formatGaugeValue(status.stage, status.stageUnit);
  const flow = formatGaugeValue(status.flow, status.flowUnit);
  if (stage) pieces.push(t('Stage {value}', { value: stage }));
  if (flow) pieces.push(t('Flow {value}', { value: flow }));
  return pieces.length ? pieces.join(' · ') : null;
}

/** "12 minutes ago" / "in 3 hours" in the active language. */
export function formatGaugeAge(timeMs, nowMs) {
  if (!Number.isFinite(timeMs)) return null;
  const minutes = Math.round((timeMs - nowMs) / 60_000);
  if (Math.abs(minutes) < 120) return formatRelativeTime(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatRelativeTime(hours, 'hour');
  return formatRelativeTime(Math.round(hours / 24), 'day');
}

const UTC_DATE = Object.freeze({
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * The flood-stage line: "Flood stages: minor 13 · moderate 14 · major 18 ft".
 * Stages NWPS does not define are left out; null when none is.
 */
export function formatGaugeThresholds(detail) {
  const unit = detail?.stageUnit || 'ft';
  const pieces = [];
  for (const [category, template] of THRESHOLD_PIECES) {
    const stage = detail?.thresholds?.[category]?.stage;
    if (Number.isFinite(stage))
      pieces.push(
        t(template, {
          stage: formatNumber(stage, { maximumFractionDigits: 2 }),
        }),
      );
  }
  if (!pieces.length) return null;
  return t('Flood stages ({unit}): {stages}', {
    unit: unitLabel(unit),
    stages: pieces.join(' · '),
  });
}

function crestLine(template, crest, unit) {
  const stage = formatGaugeValue(crest?.stage, unit);
  const ms = Date.parse(crest?.time);
  if (!stage || !Number.isFinite(ms)) return null;
  return t(template, { stage, date: formatDate(ms, UTC_DATE) });
}

/**
 * Build the overlay entry for one selected gauge. `detail` is the trimmed
 * `/api/nwps/gauge/<lid>` answer, `undefined` while it loads and `null` when
 * it failed. The caller supplies `position`.
 * @param {object} gauge Layer record (records.js).
 * @param {object|null|undefined} detail Gauge detail.
 * @param {number} nowMs Current epoch milliseconds.
 * @param {{link?: boolean}} [options] Whether the card opens the NWPS page.
 * @returns {object} World-overlay entry without `position`.
 */
export function buildRiverGaugeCard(
  gauge,
  detail,
  nowMs,
  { link = true } = {},
) {
  const category = riverGaugeCategory(gauge.observed.category);
  const details = [];
  details.push(
    [t('RIVER GAUGE · NWS {lid}', { lid: gauge.lid }), gauge.state]
      .filter(Boolean)
      .join(' · '),
  );
  details.push(t(category.label));
  const reading = formatGaugeReading(gauge.observed);
  const observedAge = formatGaugeAge(Date.parse(gauge.observed.time), nowMs);
  if (reading)
    details.push(
      observedAge
        ? t('{reading} · observed {age}', { reading, age: observedAge })
        : reading,
    );
  else details.push(t('No current reading'));
  if (forecastIsCurrent(gauge.forecast)) {
    const forecastCategory = riverGaugeCategory(gauge.forecast.category);
    details.push(
      t('Forecast {reading} · {category} · {when}', {
        // The stage when NWPS forecasts one, else the flow.
        reading:
          formatGaugeValue(gauge.forecast.stage, gauge.forecast.stageUnit) ||
          formatGaugeValue(gauge.forecast.flow, gauge.forecast.flowUnit),
        category: t(forecastCategory.label),
        when: formatGaugeAge(Date.parse(gauge.forecast.time), nowMs) || '',
      }),
    );
  }
  if (detail === undefined) details.push(t('Loading flood stages…'));
  else if (detail === null) details.push(t('Flood stages unavailable'));
  else {
    if (detail.inService === false) details.push(t('Out of service'));
    const thresholds = formatGaugeThresholds(detail);
    details.push(thresholds || t('No flood stages defined'));
    const unit = detail.stageUnit || 'ft';
    const recent = crestLine(
      msg('Recent crest {stage} on {date}'),
      detail.crests?.recent?.[0],
      unit,
    );
    const record = crestLine(
      msg('Highest crest {stage} on {date}'),
      detail.crests?.historic?.[0],
      unit,
    );
    if (recent) details.push(recent);
    if (record && record !== recent) details.push(record);
    if (detail.usgsId) details.push(t('USGS site {id}', { id: detail.usgsId }));
  }
  if (link) details.push(t('NWPS gauge page ↗ · click card to open'));
  // i18n-ignore: source credit as the agency names itself
  details.push('NOAA/NWS National Water Prediction Service');
  return {
    id: `river-gauge-card:${gauge.lid}`,
    selected: true,
    interactive: link,
    ...(link
      ? {
          accessibilityLabel: t('Open {name} on the NWPS gauge page', {
            name: gauge.name,
          }),
        }
      : undefined),
    title: gauge.name,
    details,
    accent: category.color,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
