/**
 * Longest analyte name a card line carries before it is elided. The portal's
 * vocabulary includes entries like "Nitrogen, mixed forms (NH3), (NH4),
 * organic, (NO2) and (NO3)", which alone is wider than the card.
 */
export const ANALYTE_LABEL_MAX = 22;

/**
 * Short forms for portal names that are unreadable at card width.
 *
 * Only exact, standard equivalences belong here — each key is the portal's own
 * spelling and each value is what that determination is universally called.
 * Anything not listed is elided rather than renamed, because inventing a
 * shorter name for a determination is a claim about what was measured. The
 * unabbreviated name stays on the entity's context properties either way.
 */
const ANALYTE_ALIASES = new Map([
  [
    'nitrogen, mixed forms (nh3), (nh4), organic, (no2) and (no3)',
    'Total nitrogen',
  ],
  ['inorganic nitrogen (nitrate and nitrite)', 'Nitrate + nitrite'],
  ['ammonia and ammonium', 'Ammonia/ammonium'],
  ['kjeldahl nitrogen', 'Kjeldahl N'],
  ['specific conductance', 'Conductance'],
  ['temperature, water', 'Water temp'],
  ['phosphorus as p', 'Phosphorus'],
  ['total dissolved solids', 'Dissolved solids'],
  ['escherichia coli', 'E. coli'],
]);

/**
 * The most recent measurement per analyte.
 *
 * A monitoring site is sampled repeatedly, so a raw slice of its results shows
 * the same characteristic several times over — six card lines spent on two
 * substances. Keeping the newest row per characteristic makes six lines mean
 * six different things, which is what the operator is reading the card for.
 * @param {Array<object>} measurements Normalized measurements, newest first.
 * @returns {Array<object>} One measurement per characteristic.
 */
export function latestPerAnalyte(measurements) {
  const byCharacteristic = new Map();
  for (const measurement of Array.isArray(measurements) ? measurements : []) {
    const key = String(measurement?.characteristic || '').trim();
    if (!key) continue;
    const previous = byCharacteristic.get(key);
    if (
      !previous ||
      String(measurement.sampledAt || '') > String(previous.sampledAt || '')
    )
      byCharacteristic.set(key, measurement);
  }
  return [...byCharacteristic.values()];
}

/** @param {string} name Analyte name. @returns {string} Card-width label. */
export function analyteLabel(name) {
  const raw = String(name || '').trim();
  const alias = ANALYTE_ALIASES.get(raw.toLowerCase());
  const text = (alias || raw).toUpperCase();
  if (text.length <= ANALYTE_LABEL_MAX) return text;
  return `${text.slice(0, ANALYTE_LABEL_MAX - 1).trimEnd()}…`;
}

/**
 * Normalize only the case of the litre symbol and micro prefix.
 *
 * Deliberately not a unit conversion: `mg/l as N` keeps its qualifier, because
 * "as N" changes what the number means.
 * @param {?string} unit Reported unit.
 * @returns {string} Display unit.
 */
export function displayUnit(unit) {
  return String(unit || '')
    .replace(/\bug\//g, 'µg/')
    .replace(/\/l\b/g, '/L');
}

/**
 * Lay out detected analytes as a fixed-width table.
 *
 * Monospace plus padding is what makes a column of concentrations scannable;
 * ragged `NAME · value` lines force the reader to find each number separately.
 * @param {Array<object>} detected Detected measurements.
 * @returns {Array<string>} Aligned card lines.
 */
export function alignedValueLines(detected) {
  const rows = detected.map((measurement) => ({
    label: analyteLabel(measurement.characteristic),
    value: String(measurement.value),
    unit: displayUnit(measurement.unit),
  }));
  const labelWidth = Math.max(0, ...rows.map((row) => row.label.length));
  const valueWidth = Math.max(0, ...rows.map((row) => row.value.length));
  return rows.map((row) =>
    `${row.label.padEnd(labelWidth)}  ${row.value.padStart(valueWidth)} ${row.unit}`.trimEnd(),
  );
}

/**
 * Build the body of a selected site's card.
 *
 * Detections lead and non-detects collapse into one count. A non-detect is
 * still reported — it is evidence of absence at a stated limit — but spending
 * four of six lines on "NOT DETECTED" buries the numbers the operator opened
 * the card to read.
 * @param {Array<object>} measurements Normalized measurements for one site.
 * @param {number} limit Maximum detected analytes to list.
 * @returns {Array<string>} Card body lines.
 */
export function cardBodyLines(measurements, limit) {
  const distinct = latestPerAnalyte(measurements);
  if (!distinct.length) return ['No results in window'];
  const detected = distinct.filter((measurement) => measurement.detected);
  const notDetected = distinct.length - detected.length;
  const shown = detected.slice(0, limit);
  const lines = alignedValueLines(shown);
  if (detected.length > limit)
    lines.push(`+${detected.length - limit} more detected`);
  if (!detected.length)
    lines.push(`No detections across ${notDetected} analytes`);
  else if (notDetected)
    lines.push(
      `${notDetected} further ${notDetected === 1 ? 'analyte' : 'analytes'} not detected`,
    );
  return lines;
}
