import { t, formatNumber, formatDate } from '../../i18n/index.js';
import { recordColor } from './model.js';

/** One selected source record; values stay as mapped and links derive only from validated IDs. */
export function transmissionCard(row, timestamp) {
  const details = [
    row.voltageState === 'unknown'
      ? t('Voltage unknown — not tagged in OSM')
      : t('Voltage: {voltage} kV', {
          voltage: row.voltages.map((v) => formatNumber(v / 1000)).join(' / '),
        }),
  ];
  if (row.operator)
    details.push(t('Operator: {operator}', { operator: row.operator }));
  if (row.representativePoint)
    details.push(t('Representative point of a mapped substation area'));
  if (row.overlappingAreas.length)
    details.push(
      t('Overlapping OSM areas: {ids}', {
        ids: row.overlappingAreas.join(', '),
      }),
    );
  details.push(
    t('OSM snapshot: {date}', {
      date: formatDate(Date.parse(timestamp), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    }),
  );
  details.push(t('{id} · OpenStreetMap ↗', { id: row.id }));
  return {
    id: `transmission-card:${row.id}`,
    title:
      row.name ||
      (row.kind === 'line' ? t('Transmission line') : t('Substation')),
    details,
    accent: recordColor(row),
    selected: true,
    interactive: true,
    priority: Number.MAX_SAFE_INTEGER,
    accessibilityLabel: t('Open {id} on OpenStreetMap', { id: row.id }),
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
