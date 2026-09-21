/**
 * Minimal RFC 4180 reader for Water Quality Portal result rows.
 *
 * Result search is only dependable as CSV, so the parsing lives here rather
 * than in the browser: the client contract stays JSON and no caller has to
 * handle quoted embedded commas, CRLF, or escaped quotes.
 * @param {string} text CSV document.
 * @param {number} maxRows Row ceiling, excluding the header.
 * @returns {Array<Record<string, string>>} Parsed rows keyed by header name.
 */
export function parseWaterQualityCsv(text, maxRows) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let header = null;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (!header) header = row;
    else if (row.length > 1 || row[0] !== '')
      rows.push(
        Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])),
      );
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') pushField();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      pushRow();
      if (rows.length >= maxRows) return rows;
    } else field += char;
  }
  if (field !== '' || row.length) pushRow();
  return rows.slice(0, maxRows);
}

/**
 * Normalize one result row into a measurement.
 *
 * A non-detect is information, not a missing value: rows carrying a detection
 * condition keep `detected: false` and their reporting limit rather than being
 * dropped, so "looked and found nothing" never reads the same as "never looked".
 * @param {Record<string, string>} row Parsed CSV row.
 * @returns {?object} Measurement, or null when the row carries no usable analyte.
 */
export function normalizeMeasurement(row) {
  const characteristic = String(row.CharacteristicName || '').trim();
  if (!characteristic) return null;
  const raw = String(row.ResultMeasureValue ?? '').trim();
  const value = raw === '' ? null : Number(raw);
  const condition = String(row.ResultDetectionConditionText || '').trim();
  const limit = Number(row['DetectionQuantitationLimitMeasure/MeasureValue']);
  if (value === null && !condition) return null;
  return {
    characteristic,
    value: Number.isFinite(value) ? value : null,
    unit:
      String(row['ResultMeasure/MeasureUnitCode'] || '').trim() ||
      String(
        row['DetectionQuantitationLimitMeasure/MeasureUnitCode'] || '',
      ).trim() ||
      null,
    sampledAt: String(row.ActivityStartDate || '').trim() || null,
    detected: Number.isFinite(value),
    detectionCondition: condition || null,
    detectionLimit: Number.isFinite(limit) ? limit : null,
    medium: String(row.ActivityMediaName || '').trim() || null,
  };
}
