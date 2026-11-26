/**
 * Hourly means on the US AQI's averaging periods: the NowCast for particles
 * and ozone, and a running 8-hour mean. Pure and portable: no network, scene
 * or UI imports.
 *
 * Sources:
 * - US EPA, Technical Assistance Document for the Reporting of Daily Air
 *   Quality – the Air Quality Index (AQI), section "How the NowCast is
 *   calculated": the PM NowCast (PM2.5 and PM10 alike) and its missing-data
 *   rule, and the ozone NowCast it describes and links.
 * - US EPA, O3-NowCast (https://github.com/USEPA/O3-NowCast), the method and
 *   R code that document cites for ozone: `GetNowcast.r` (the decision tree)
 *   and `NowcastFun.r` (the regression, the surrogate and the imputation).
 *
 * A series is an array of hourly means, oldest first, its last entry the
 * current hour, NaN (or null) where an hour is missing or invalid.
 */

/** One hour in milliseconds. */
export const HOUR_MS = 3_600_000;
/** Hours the PM NowCast reads. */
export const PM_NOWCAST_HOURS = 12;
/** Hours the ozone NowCast reads: a two-week rolling window. */
export const OZONE_NOWCAST_HOURS = 336;
/**
 * Hours an ozone NowCast may need: its window, ending up to two hours
 * before the current one when the current hour is missing.
 */
export const OZONE_SERIES_HOURS = OZONE_NOWCAST_HOURS + 2;

const valid = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The hourly series of `count` hours ending at the hour that ends at
 * `endMs`, from `hours` (`[{endMs, value}]`, value null when invalid). An
 * hour's place is its end time rounded to the hour from `endMs`, so series
 * offset from UTC hours (half-hour zones) line up too.
 */
export function hourlySeries(hours, endMs, count) {
  const series = new Array(count).fill(NaN);
  for (const { endMs: end, value } of hours) {
    const ago = Math.round((endMs - end) / HOUR_MS);
    if (ago >= 0 && ago < count && valid(value))
      series[count - 1 - ago] = value;
  }
  return series;
}

/**
 * The PM NowCast of a series, or null without enough data. Steps 1-7 of the
 * document's PM method over the last 12 hours: the weight factor is one
 * minus the range over the maximum, at least 0.5; each hour weighs the
 * factor to the power of its hours ago. Two of the last three hours must be
 * valid.
 */
export function pmNowCast(series) {
  const hours = series.slice(-PM_NOWCAST_HOURS);
  if (hours.slice(-3).filter(valid).length < 2) return null;
  const values = hours.filter(valid);
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max <= 0) return 0;
  const weight = Math.max(0.5, 1 - (max - min) / max);
  let sum = 0;
  let weights = 0;
  hours.forEach((value, i) => {
    if (!valid(value)) return;
    const factor = weight ** (hours.length - 1 - i);
    sum += factor * value;
    weights += factor;
  });
  return sum / weights;
}

/**
 * The mean of the last 8 hours, or null when fewer than 6 of them (75 %)
 * are valid: the data-completeness rule the EPA applies to 8-hour averages.
 */
export function eightHourMean(series) {
  const values = series.slice(-8).filter(valid);
  return values.length >= 6
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

/** `generateSurrogate`: 0.85 × the latest of the last three hours + 4.5 ppb. */
function surrogate(series) {
  for (let ago = 0; ago < 3; ago++) {
    const value = series[series.length - 1 - ago];
    if (valid(value)) return value * 0.85 + 4.5;
  }
  return null;
}

/** The longest run of missing hours (`get.max.na.stream`). */
function longestGap(series) {
  let longest = 0;
  let run = 0;
  for (const value of series) {
    run = valid(value) ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

/**
 * Missing hours filled by a weighted moving average (`imputeTS::na_ma`, the
 * package defaults the code uses: 4 hours each side, weights halving with
 * each hour away, the window widened until it holds two valid hours).
 */
function imputed(series) {
  const n = series.length;
  return series.map((value, i) => {
    if (valid(value)) return value;
    for (let k = 4; k < n; k++) {
      let sum = 0;
      let weights = 0;
      let count = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++)
        if (valid(series[j])) {
          const weight = 1 / 2 ** Math.abs(j - i);
          sum += weight * series[j];
          weights += weight;
          count++;
        }
      if (count >= 2) return sum / weights;
    }
    return NaN;
  });
}

/**
 * Centred 8-hour means, the regression's target: hours -4 to +3 around each
 * hour, at most 2 of the 8 missing; NaN where the window runs off the series.
 */
function centredMeans(series) {
  return series.map((_, i) => {
    if (i < 4 || i + 3 >= series.length) return NaN;
    const values = series.slice(i - 4, i + 4).filter(valid);
    return values.length >= 6
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : NaN;
  });
}

/**
 * Least squares with an intercept by Householder QR with column pivoting:
 * the fit `pls::mvr` reaches with every component, which the code takes.
 * Columns that add nothing (within rounding) get no weight.
 * @returns {(row: number[]) => number} The fitted prediction.
 */
function leastSquares(rows, targets) {
  const m = rows.length;
  const p = rows[0].length;
  const means = new Array(p).fill(0);
  for (const row of rows) for (let j = 0; j < p; j++) means[j] += row[j] / m;
  const target = targets.reduce((sum, y) => sum + y, 0) / m;
  const a = rows.map((row) => row.map((x, j) => x - means[j]));
  const b = targets.map((y) => y - target);
  const order = [...Array(p).keys()];
  const norms = order.map((j) => a.reduce((sum, row) => sum + row[j] ** 2, 0));
  const scale = Math.max(...norms, 0);
  let rank = 0;
  for (let k = 0; k < Math.min(m, p); k++) {
    let best = k;
    for (let j = k + 1; j < p; j++) if (norms[j] > norms[best]) best = j;
    if (!(norms[best] > scale * 1e-20) || norms[best] <= 0) break;
    if (best !== k) {
      for (const row of a) [row[k], row[best]] = [row[best], row[k]];
      [norms[k], norms[best]] = [norms[best], norms[k]];
      [order[k], order[best]] = [order[best], order[k]];
    }
    let length = 0;
    for (let i = k; i < m; i++) length += a[i][k] ** 2;
    length = Math.sqrt(length);
    if (!(length > Math.sqrt(scale) * 1e-10)) break;
    const alpha = a[k][k] > 0 ? -length : length;
    const v = new Array(m).fill(0);
    for (let i = k; i < m; i++) v[i] = a[i][k];
    v[k] -= alpha;
    let vv = 0;
    for (let i = k; i < m; i++) vv += v[i] ** 2;
    if (vv > 0) {
      for (let j = k; j < p; j++) {
        let dot = 0;
        for (let i = k; i < m; i++) dot += v[i] * a[i][j];
        const f = (2 * dot) / vv;
        for (let i = k; i < m; i++) a[i][j] -= f * v[i];
      }
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i] * b[i];
      const f = (2 * dot) / vv;
      for (let i = k; i < m; i++) b[i] -= f * v[i];
    }
    rank = k + 1;
    for (let j = k + 1; j < p; j++) norms[j] -= a[k][j] ** 2;
  }
  const coefficients = new Array(p).fill(0);
  for (let k = rank - 1; k >= 0; k--) {
    let sum = b[k];
    for (let j = k + 1; j < rank; j++) sum -= a[k][j] * coefficients[j];
    coefficients[k] = sum / a[k][k];
  }
  const weights = new Array(p).fill(0);
  order.forEach((column, k) => {
    weights[column] = coefficients[k];
  });
  return (row) =>
    row.reduce((sum, x, j) => sum + weights[j] * (x - means[j]), target);
}

/** Hours of lagged values the regression reads (`pls.window`). */
const REGRESSION_HOURS = 96;

/**
 * `GetNowcast` for one window of exactly OZONE_NOWCAST_HOURS hours ending
 * at the current hour; `earlier` is the window ending one hour before, for
 * when the current hour is missing.
 */
function ozoneWindow(series, earlier) {
  const count = series.filter(valid).length;
  if (!count) return null;
  // Less than 75 % of the window, a gap of more than 7 hours, or more than
  // a quarter of the target means missing: the surrogate.
  if (count < Math.ceil(0.75 * OZONE_NOWCAST_HOURS)) return surrogate(series);
  if (longestGap(series) > 7) return surrogate(series);
  const means = centredMeans(series);
  const targets = means.slice(REGRESSION_HOURS - 1);
  if (targets.filter((y) => !valid(y)).length / targets.length > 0.25)
    return surrogate(series);
  if (series.every((value) => !valid(value) || value === 0)) return 0;
  // The current hour missing: the NowCast of the hour before, else of two
  // hours before, else none.
  if (!valid(series.at(-1))) return earlier ? earlier() : null;
  const filled = imputed(series);
  const lagged = (end) => filled.slice(end - REGRESSION_HOURS + 1, end + 1);
  const rows = [];
  const ys = [];
  for (let end = REGRESSION_HOURS - 1; end < series.length; end++)
    if (valid(means[end])) {
      rows.push(lagged(end));
      ys.push(means[end]);
    }
  if (!rows.length) return null;
  const value = leastSquares(rows, ys)(lagged(series.length - 1));
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

/**
 * The ozone NowCast in ppb of a series in ppb, or null: EPA's ozone method
 * as `GetNowcast.r` runs it over the last 336 hours. With enough data, a
 * regression of each hour's centred 8-hour mean on the 96 hours up to it,
 * fitted over the window, predicts the current hour's; otherwise the
 * surrogate, 0.85 × the latest of the last three hours + 4.5 ppb. A missing
 * current hour takes the NowCast of one, then two, hours before. The result
 * stands for an 8-hour average.
 */
export function ozoneNowCast(series) {
  const nowcastAt = (end, stepsBack) => {
    const hours = series.slice(
      Math.max(0, end - OZONE_NOWCAST_HOURS),
      Math.max(0, end),
    );
    const padded = [
      ...new Array(OZONE_NOWCAST_HOURS - hours.length).fill(NaN),
      ...hours,
    ];
    return ozoneWindow(
      padded,
      stepsBack < 2 ? () => nowcastAt(end - 1, stepsBack + 1) : null,
    );
  };
  return nowcastAt(series.length, 0);
}
