import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';
import { EMODNET_PAGE_URL } from './records.js';

export const ERA_LABELS = Object.freeze({
  'before-1900': msg('Before 1900'),
  '1900-1945': msg('1900–1945'),
  'after-1945': msg('After 1945'),
  undated: msg('Date unknown'),
});

export const ERA_COLORS = Object.freeze({
  'before-1900': '#c79a5b',
  '1900-1945': '#ff6b5e',
  'after-1945': '#4fc3f7',
  undated: '#9aa7b4',
});

function formatDay(date) {
  const match = /^(-?\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!match) return '';
  return formatDate(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
  );
}

function meters(value) {
  return formatNumber(value, {
    maximumFractionDigits: value < 10 ? 1 : 0,
  });
}

/** How well the position is known, as one card line (or null). */
export function positionLine(record) {
  if (record.positionNote) return t('Position: centre of the protected area');
  const accuracy = record.positionAccuracy;
  if (!Number.isFinite(accuracy)) return null;
  // 1852 m is EMODnet's "within a nautical mile" for old, reported positions.
  if (accuracy >= 1000)
    return t('Position approximate (within about {km} km)', {
      km: formatNumber(accuracy / 1000, { maximumFractionDigits: 1 }),
    });
  return t('Position surveyed (within about {m} m)', { m: meters(accuracy) });
}

/**
 * The link a click on the card opens: the Wikipedia (or Wikidata) page, the
 * wreck's own page when EMODnet lists one, else EMODnet's portal.
 * @param {object} record
 * @returns {string}
 */
export function cardLink(record) {
  return record?.url || EMODNET_PAGE_URL;
}

/**
 * Title and detail lines for one wreck card: deaths first, then when and
 * where, then the ship facts. Victims appear as a count only; free text that
 * refers to a person by a title or role is dropped by a keyword filter (see
 * records.js), which a bare name can still pass.
 * @param {object} record A normalized shipwreck record.
 * @returns {{title: string, details: string[], link: string}}
 */
export function describeShipwreck(record) {
  const titleParts = [t('Shipwreck')];
  if (record.name) titleParts.push(record.name);
  const details = [];
  // Deaths first, right under the title: the fact readers look for.
  const toll = [];
  if (Number.isFinite(record.casualties))
    toll.push(
      t('Fatalities: {count}', { count: formatNumber(record.casualties) }),
    );
  if (record.survivors)
    toll.push(
      t('Survivors: {count}', { count: formatNumber(record.survivors) }),
    );
  if (toll.length) details.push(toll.join(' · '));
  const when =
    formatDay(record.date) ||
    (Number.isInteger(record.year) ? String(record.year) : '') ||
    record.dating ||
    '';
  const where = [when, record.country].filter(Boolean);
  if (where.length) details.push(where.join(' · '));
  if (record.vesselType)
    details.push(t('Vessel: {value}', { value: record.vesselType }));
  if (record.cause)
    details.push(t('What happened: {value}', { value: record.cause }));
  if (Number.isFinite(record.depth))
    details.push(
      record.depthQuality
        ? t('Depth: {m} m ({quality})', {
            m: meters(record.depth),
            quality: record.depthQuality,
          })
        : t('Depth: {m} m', { m: meters(record.depth) }),
    );
  const position = positionLine(record);
  if (position) details.push(position);
  if (record.notes) details.push(t('Notes: {value}', { value: record.notes }));
  if (record.cargo)
    details.push(t('Cargo or finds: {value}', { value: record.cargo }));
  if (record.protected) details.push(t('Protected wreck'));
  const sources =
    record.source === 'wikidata'
      ? record.alsoIn === 'emodnet'
        ? 'Wikidata · EMODnet'
        : 'Wikidata'
      : record.originator
        ? `EMODnet (${record.originator})`
        : 'EMODnet';
  details.push(t('Source: {value}', { value: sources }));
  const link = cardLink(record);
  details.push(
    link === EMODNET_PAGE_URL
      ? t('Click the card to open EMODnet ↗')
      : link.includes('.wikipedia.org/')
        ? t('Click the card to open the article ↗')
        : t('Click the card to open the source ↗'),
  );
  return { title: titleParts.join(' · '), details, link };
}
