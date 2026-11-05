import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';
import { CENIPA_REPORTS_URL } from './records.js';

export const KIND_LABELS = Object.freeze({
  accident: msg('Accident'),
  'serious-incident': msg('Serious incident'),
});

export const KIND_COLORS = Object.freeze({
  accident: '#ff4d4d',
  'serious-incident': '#ffa53a',
});

const SMALL_WORDS = new Set([
  'a',
  'ao',
  'as',
  'com',
  'da',
  'das',
  'de',
  'do',
  'dos',
  'e',
  'em',
  'na',
  'nas',
  'no',
  'nos',
  'para',
  'por',
]);
const SMALL_WORDS_EXCEPT_FIRST = new Set([...SMALL_WORDS, 'o', 'os', 'ou']);

const ACRONYMS = new Set(['ATC', 'GPS', 'IFR', 'ILS', 'TCAS', 'VFR']);

/**
 * CENIPA writes its values in capitals ("PERDA DE CONTROLE EM VOO"); show them
 * in sentence case. The words stay CENIPA's (Portuguese data).
 * @param {string|null} value
 * @returns {string}
 */
export function sourceText(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (value !== value.toUpperCase()) return value.trim();
  const words = value.trim().split(/\s+/);
  return words
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word;
      const lower = word.toLowerCase();
      return index === 0
        ? lower.charAt(0).toUpperCase() + lower.slice(1)
        : lower;
    })
    .join(' ');
}

/**
 * Names (cities, makers) in capitals read as titles: "SÃO PAULO" → "São Paulo".
 * @param {string|null} value
 * @returns {string}
 */
export function nameText(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (value !== value.toUpperCase()) return value.trim();
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) =>
      index > 0 && SMALL_WORDS_EXCEPT_FIRST.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/** "PRNDN" → "PR-NDN": five-letter marks read with the nationality prefix. */
export function formatRegistration(value) {
  if (typeof value !== 'string') return '';
  const mark = value.trim().toUpperCase();
  return /^[A-Z]{5}$/.test(mark)
    ? `${mark.slice(0, 2)}-${mark.slice(2)}`
    : mark;
}

function aircraftName(plane) {
  const model = [nameText(plane.maker), plane.model].filter(Boolean).join(' ');
  return plane.icaoType && plane.model !== plane.icaoType
    ? `${model} (${plane.icaoType})`
    : model;
}

function formatDay(date) {
  const match = /^(-?\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!match) return '';
  return formatDate(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
  );
}

/**
 * The link a click on the card opens: the Wikipedia article when there is
 * one, else CENIPA's final-report page when a report is published.
 * @param {object} record
 * @returns {string|null}
 */
export function cardLink(record) {
  if (record?.url) return record.url;
  if (record?.source === 'cenipa' && record.report) return CENIPA_REPORTS_URL;
  return null;
}

/**
 * Title and detail lines for one accident card. Only technical facts: there
 * are no people's names in the record.
 * @param {object} record A normalized air-accident record.
 * @returns {{title: string, details: string[], link: string|null}}
 */
export function describeAirAccident(record) {
  const plane = record.aircraft?.[0] || null;
  const titleParts = [t(KIND_LABELS[record.kind] || KIND_LABELS.accident)];
  if (record.name) titleParts.push(record.name);
  else if (plane) {
    const mark = formatRegistration(plane.registration);
    if (mark) titleParts.push(mark);
    if (plane.model) titleParts.push(plane.model);
  }
  const details = [];
  const where = [
    formatDay(record.date),
    record.time || '',
    [nameText(record.city), record.state].filter(Boolean).join('/'),
    record.aerodrome,
  ].filter(Boolean);
  if (where.length) details.push(where.join(' · '));
  for (const item of record.aircraft || []) {
    const name = aircraftName(item);
    const mark = formatRegistration(item.registration);
    if (name || mark)
      details.push(
        t('Aircraft: {value}', {
          value: [mark, name].filter(Boolean).join(' · '),
        }),
      );
  }
  if (plane?.operation)
    details.push(
      t('Operation: {value}', { value: sourceText(plane.operation) }),
    );
  if (plane?.phase)
    details.push(
      t('Flight phase: {value}', { value: sourceText(plane.phase) }),
    );
  if (plane?.damage)
    details.push(t('Damage: {value}', { value: sourceText(plane.damage) }));
  if (record.operator)
    details.push(t('Operator: {value}', { value: record.operator }));
  if (record.fatalities !== null && record.fatalities !== undefined)
    details.push(
      t('Fatalities: {count}', { count: formatNumber(record.fatalities) }),
    );
  if (record.injuries)
    details.push(
      t('Injured: {count}', { count: formatNumber(record.injuries) }),
    );
  if (record.events?.length)
    details.push(
      t('What happened: {value}', {
        value: record.events
          .map((event) => sourceText(event.label))
          .join(' · '),
      }),
    );
  if (record.investigation === 'finished')
    details.push(
      record.report
        ? t('Investigation finished · final report {number}', {
            number: record.report,
          })
        : t('Investigation finished'),
    );
  else if (record.investigation === 'active')
    details.push(t('Investigation in progress'));
  if (record.approximate)
    details.push(t('Approximate position (aerodrome reference point)'));
  const link = cardLink(record);
  details.push(
    record.source === 'cenipa'
      ? t('Source: CENIPA (Brazil)')
      : t('Source: Wikidata'),
  );
  if (link)
    details.push(
      link === CENIPA_REPORTS_URL
        ? t('Click the card to open CENIPA final reports ↗')
        : t('Click the card to open the article ↗'),
    );
  return { title: titleParts.join(' · '), details, link };
}
