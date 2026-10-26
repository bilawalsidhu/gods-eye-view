import { t } from '../../i18n/index.js';
export const BSEE_SOURCE_URL = 'https://www.data.bsee.gov/Main/Mapping.aspx';
export const OFFSHORE_COLORS = Object.freeze({surface: '#ffb454', subsea: '#63d9ef', unknown: '#b9c1cc'});
export function platformTitle(record) {
  return `${record.area || 'BSEE'} ${record.block || record.complexId} · ${record.name || record.structureNumber}`;
}
export function platformKind(record) {
  if (record.kind === 'surface') return t('Surface structure');
  if (record.kind === 'subsea') return t('Subsea structure');
  return t('Structure type unknown');
}
export function platformDetails(record, metadata) {
  return [
    `${platformKind(record)}${record.typeCode ? ` · ${record.typeCode}` : ''}`,
    t('BSEE complex {complex}, structure {structure}', {complex: record.complexId, structure: record.structureNumber}),
    t('Installed: {date}', {date: record.installed || t('Unknown')}),
    t('No removal date recorded; production status unknown'),
    `${record.lat.toFixed(5)}, ${record.lon.toFixed(5)} · WGS84`,
    t('U.S. Gulf federal waters · snapshot {date}', {date: metadata.releaseDate}),
    t('BSEE inventory · open source'),
  ];
}
