import { formatDate, formatNumber, t } from '../../i18n/index.js';
import { ASN_RECORD_URL } from './records.js';

export const ACCIDENT_COLOR = '#ff4d4d';

function formatDay(date) {
  const match = /^(-?\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!match) return '';
  return formatDate(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
  );
}

/** "Wikipedia article", "ASN record" or "Wikidata item" for the card link. */
function linkText(url) {
  if (url.startsWith('https://en.wikipedia.org/'))
    return t('Click the card to open the article ↗');
  if (url.startsWith(ASN_RECORD_URL))
    return t('Click the card to open the Aviation Safety Network record ↗');
  return t('Click the card to open the Wikidata item ↗');
}

/**
 * Title and detail lines for one accident card. Only technical facts: the
 * record holds no people's names.
 * @param {object} record A normalized air-accident record.
 * @returns {{title: string, details: string[], link: string|null}}
 */
export function describeAirAccident(record) {
  const title =
    record.name ||
    [t('Air accident'), record.aircraft].filter(Boolean).join(' · ');
  const details = [];
  // Deaths first, right under the title: the fact readers look for.
  const toll = [];
  if (Number.isInteger(record.fatalities))
    toll.push(
      t('Fatalities: {count}', { count: formatNumber(record.fatalities) }),
    );
  if (record.injuries)
    toll.push(t('Injured: {count}', { count: formatNumber(record.injuries) }));
  if (record.survivors)
    toll.push(
      t('Survivors: {count}', { count: formatNumber(record.survivors) }),
    );
  if (toll.length) details.push(toll.join(' · '));
  const where = [formatDay(record.date), record.place, record.country].filter(
    // The country is often the place's own name ("Taiwan · Taiwan").
    (part, index, all) => part && all.indexOf(part) === index,
  );
  if (where.length) details.push(where.join(' · '));
  const route =
    record.origin && record.destination
      ? `${record.origin} → ${record.destination}`
      : record.origin
        ? t('departed from {value}', { value: record.origin })
        : record.destination
          ? t('bound for {value}', { value: record.destination })
          : '';
  if (record.flight || route)
    details.push(
      [
        record.flight ? t('Flight {value}', { value: record.flight }) : '',
        route ? t('Route: {value}', { value: route }) : '',
      ]
        .filter(Boolean)
        .join(' · '),
    );
  // Wikidata gives one registration for the event; it names the aircraft
  // only when there is a single one.
  const single = record.aircraft && !record.aircraft.includes(' / ');
  const aircraft = [single ? record.registration : null, record.aircraft]
    .filter(Boolean)
    .join(' · ');
  if (aircraft) details.push(t('Aircraft: {value}', { value: aircraft }));
  if (record.operator)
    details.push(t('Operator: {value}', { value: record.operator }));
  if (record.approximate)
    details.push(
      record.place
        ? t('Approximate position: placed at {place}', { place: record.place })
        : t('Approximate position'),
    );
  details.push(t('Source: Wikidata'));
  const link = record.url || null;
  if (link) details.push(linkText(link));
  return { title, details, link };
}
