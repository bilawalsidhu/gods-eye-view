/** The native tactical card measures one string per line in its monospace font.
 * Supply bounded lines locally; do not change other layers' card layout.
 * Source URLs remain canonical in context metadata, with display-only breaks.
 */
export function wrapWellCardLine(value, limit = 68) {
  let text = String(value).trim();
  const lines = [];
  while (text.length > limit) {
    let cut = text.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    lines.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  if (text) lines.push(text);
  return lines;
}

/** Leave room for native tactical-card padding at the current canvas width.
 * The tracked detail font is 11px monospace; 7.2px per column is conservative.
 */
export function wellCardColumns(canvasWidth) {
  return Number.isFinite(canvasWidth) && canvasWidth > 0
    ? Math.max(16, Math.min(68, Math.floor((canvasWidth - 32) / 7.2)))
    : 68;
}

/** Legacy USGS packs omit per-record source; never invent an agency label. */
export function wellRecordLabel(record) {
  return [record.source, record.metadata?.sourceRecordId || record.id]
    .filter(Boolean)
    .join(' ');
}

/** Display-only identity; frozen source names and quality flags remain evidence. */
export function wellDisplayName(record) {
  return record.source === 'USGWD'
    ? `USGWD ${record.metadata?.sourceRecordId || record.id}`
    : typeof record.name === 'string'
      ? record.name
      : record.id;
}
export function visibleWellWarnings(record, details) {
  const warnings = details.warnings ?? [];
  return record.source === 'USGWD'
    ? warnings.filter(
        (line) => !String(line).startsWith('Location unverified;'),
      )
    : warnings;
}

/** Citizen-facing facts from admitted fields only; source quantities are historical reports. */
export function historicalWellCardLines(record) {
  const lines = [];
  for (const [field, label, unit] of [
    ['Well Depth (Feet)', 'Well depth', 'ft'],
    ['Well Capacity (GPM)', 'Reported capacity', 'gal/min'],
    ['Screen Depth (Feet)', 'Screen depth', 'ft'],
    ['Length of Screen (Feet)', 'Screen length', 'ft'],
  ]) {
    const q = record.metadata?.quantities?.[field];
    if (
      q?.quality === 'valid' &&
      q.unit === unit &&
      Number.isFinite(q.value) &&
      q.value >= 0
    )
      lines.push(
        `${label}: ${q.value.toLocaleString('en-US', { maximumSignificantDigits: 21 })} ${unit}`,
      );
  }
  for (const [field, label] of [
    ['Year Well was Constructed', 'Constructed'],
    ['Year Reported', 'Reported'],
  ]) {
    const year = record.metadata?.sourceYears?.[field];
    if (year?.precision === 'year' && /^[0-9]{4}$/.test(year.year))
      lines.push(`${label}: ${year.year}`);
  }
  if (!lines.length)
    lines.push('No usable size or capacity details available.');
  lines.push('Historical source record; not current performance.');
  lines.push(`Source: USGWD ${record.metadata?.sourceRecordId || record.id}`);
  return lines;
}
