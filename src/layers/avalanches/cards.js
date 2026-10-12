import { dayLabel } from './dates.js';
import { dangerLevel, dangerTrend } from './model.js';
import { PATH_COLOR } from './policy.js';

export const AVALANCHE_OVERLAY_SOURCE_ID = 'avalanches';

/** Characters per card line before wrapping; the card font is monospace. */
const LINE_CHARS = 46;
const MAX_TEXT_LINES = 4;

/**
 * Wrap prose into card lines, ending with an ellipsis when it runs over.
 * @param {?string} text Prose.
 * @returns {Array<string>} Lines.
 */
export function wrapLines(text, width = LINE_CHARS, max = MAX_TEXT_LINES) {
  const words = String(text ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
      if (lines.length === max) break;
    } else line = line ? `${line} ${word}` : word;
  }
  if (lines.length < max && line) lines.push(line);
  else if (lines.length === max && words.length)
    lines[max - 1] = `${lines[max - 1].slice(0, width - 1)}…`;
  return lines;
}

const TREND = { '-1': ' ↓', 0: '', 1: ' ↑' };

/**
 * A region's card: its rating for the day on screen and the days after it,
 * marked as forecasts where they are, then the forecaster's summary.
 * @param {{id:string, name:string, days:Array<object>}} region Forecast region.
 * @param {Array<number>} ratings Rating per window day.
 * @param {Array<{date:string, forecast:boolean}>} days Window days.
 * @param {number} day Window day on screen.
 * @returns {{title:string, details:Array<string>, accent:string}}
 */
export function regionCard(region, ratings, days, day) {
  const details = [];
  for (let index = day; index < Math.min(days.length, day + 3); index++) {
    const level = ratings[index];
    const scale = dangerLevel(level);
    const rating = level ? `${level} ${scale.label}` : 'No rating';
    const trend = TREND[dangerTrend(ratings, index)];
    const when = days[index].forecast ? ' (forecast)' : '';
    details.push(
      `${dayLabel(days[index].date).padEnd(11)}${rating}${trend}${when}`,
    );
  }
  const summary = region.days.find(
    (entry) => entry.date === days[day].date,
  )?.text;
  if (summary) details.push('', ...wrapLines(summary));
  details.push('', 'Varsom · NVE');
  return {
    title: region.name,
    details,
    accent: dangerLevel(ratings[day])?.color ?? '#9aa4ad',
  };
}

const OSLO_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Oslo',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * An observed avalanche's card: what it was, when, how it released, how far
 * it ran, and who reported it — regObs asks for the observer to be named.
 * @param {object} observation Normalized observation.
 * @returns {{title:string, details:Array<string>, accent:string}}
 */
export function observationCard(observation) {
  const size = observation.size ? ` · ${observation.size}` : '';
  const details = [`${OSLO_TIME.format(new Date(observation.time))} (Norway)`];
  if (observation.type) details.push(observation.type);
  if (observation.trigger) details.push(observation.trigger);
  const { startElevationM: from, stopElevationM: to } = observation;
  if (from !== null && to !== null)
    details.push(`Release ${from} m → runout ${to} m (${from - to} m drop)`);
  else if (from !== null) details.push(`Release at ${from} m`);
  if (!observation.stop) details.push('Release point only; no runout drawn');
  if (observation.region) details.push(observation.region);
  details.push(
    '',
    `regObs${observation.observer ? ` · ${observation.observer}` : ''}`,
  );
  return {
    title: `Avalanche${size}`,
    details,
    accent: PATH_COLOR,
  };
}

/**
 * Overlay entry for the selected card.
 * @param {string} id Entry id.
 * @param {{title:string, details:Array<string>, accent:string}} card Card content.
 * @param {object} position Cesium.Cartesian3 anchor.
 * @param {?Function} activate Opens the source page, when there is one.
 * @returns {object} World-overlay entry.
 */
export function cardEntry(id, card, position, activate = null) {
  return {
    id,
    position,
    variant: 'selected',
    title: card.title,
    details: card.details,
    accent: card.accent,
    selected: true,
    protected: true,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 18,
    leaderOffsetPx: 12,
    horizonCull: true,
    terrainOcclusion: false,
    interactive: Boolean(activate),
    ...(activate
      ? { activate, accessibilityLabel: `${card.title}: open source page` }
      : {}),
  };
}

/** @param {Array<Array<[number, number]>>} polygons Region polygons. @returns {{lon:number, lat:number}} Card anchor: centre of the largest outer ring. */
export function regionAnchor(polygons) {
  let best = null;
  for (const [outer] of polygons)
    if (!best || outer.length > best.length) best = outer;
  const points = best ?? [[0, 0]];
  const sum = points.reduce(
    (total, [lon, lat]) => [total[0] + lon, total[1] + lat],
    [0, 0],
  );
  return { lon: sum[0] / points.length, lat: sum[1] / points.length };
}
