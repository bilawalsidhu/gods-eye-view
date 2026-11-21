import { formatNumber, t } from '../../i18n/index.js';

/**
 * The tracked card measures one string per line in its monospace font, so
 * long lines are broken here rather than in the shared card layout.
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

/**
 * Columns that fit the card at this canvas width. The detail font is 11px
 * monospace; 7.2px per column leaves room for the card's padding.
 */
export function wellCardColumns(canvasWidth) {
  return Number.isFinite(canvasWidth) && canvasWidth > 0
    ? Math.max(16, Math.min(68, Math.floor((canvasWidth - 32) / 7.2)))
    : 68;
}

/** Short name for lists: the dataset and its own record id. */
export function wellLabel(record) {
  return `USGWD ${record.recordId}`;
}

/** Card lines in the UI language, from the fields the record actually has. */
export function wellCardLines(record) {
  const number = (value) => formatNumber(value, { maximumFractionDigits: 2 });
  const lines = [];
  if (record.depthFt !== null)
    lines.push(t('Well depth: {value} ft', { value: number(record.depthFt) }));
  if (record.capacityGpm !== null)
    lines.push(
      t('Reported capacity: {value} gal/min', {
        value: number(record.capacityGpm),
      }),
    );
  if (record.screenDepthFt !== null)
    lines.push(
      t('Screen depth: {value} ft', { value: number(record.screenDepthFt) }),
    );
  if (record.screenLengthFt !== null)
    lines.push(
      t('Screen length: {value} ft', { value: number(record.screenLengthFt) }),
    );
  if (record.constructedYear)
    lines.push(t('Constructed: {year}', { year: record.constructedYear }));
  if (record.reportedYear)
    lines.push(t('Reported: {year}', { year: record.reportedYear }));
  if (!lines.length)
    lines.push(t('No size or capacity details in this record.'));
  if (record.state) lines.push(record.state);
  lines.push(t('Historical record; not current conditions.'));
  lines.push(t('Source: {value}', { value: wellLabel(record) }));
  return lines;
}
