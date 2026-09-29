/**
 * EASA Conflict Zone Information Bulletin (CZIB) records.
 *
 * EASA publishes its bulletins as a JSON export (status, title, the
 * countries each bulletin names, issue, revision and validity dates) and as
 * an RSS feed whose links carry the bulletin number. The two are joined on
 * the Drupal node id. Both are pure text here: no geometry crosses the proxy.
 */

export const CZIB_ORIGIN = 'https://www.easa.europa.eu';
/** The public CZIB list; bulletin pages live below it. */
export const CZIB_LIST_URL = `${CZIB_ORIGIN}/en/domains/air-operations/czibs`;
export const CZIB_STATUSES = Object.freeze(['active', 'withdrawn']);

const MAX_TEXT = 160;
const MAX_COUNTRIES = 24;
const MAX_FEED_ITEMS = 500;
const SLUG = /^[a-z0-9-]{1,64}$/;
const NUMBER = /^(sib-|czib-)?(\d{4})-(\d{2})(?:-?r(\d{1,3}))?$/i;
const ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/** Decode the HTML entities EASA leaves in its export ("People&#039;s"). */
export function decodeEntities(value) {
  return String(value).replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi,
    (match, name) => {
      if (name[0] === '#') {
        const code =
          name[1] === 'x' || name[1] === 'X'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[name.toLowerCase()] ?? match;
    },
  );
}

/** Plain text: tags dropped, entities decoded, whitespace collapsed. */
const text = (value, max = MAX_TEXT) =>
  typeof value === 'string'
    ? decodeEntities(value.replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

/** EASA stamps: `2017-03-31T00:00:00+0300`, or ISO with a colon. */
export function parseCzibStamp(value) {
  if (typeof value !== 'string') return null;
  const stamp = value.trim().replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(stamp))
    return null;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : null;
}

/** A `dd/mm/yyyy` validity date as UTC midnight of that day. */
export function parseCzibDay(value) {
  const match = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(
    typeof value === 'string' ? value : '',
  );
  if (!match) return null;
  const [day, month, year] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  return date.getUTCDate() === day && date.getUTCMonth() === month - 1
    ? ms
    : null;
}

/** The revision stamp EASA wraps in `<time datetime="…">`. */
function revisionStamp(value) {
  if (typeof value !== 'string') return null;
  const attribute = /datetime="([^"]+)"/.exec(value);
  return parseCzibStamp(attribute ? attribute[1] : text(value));
}

/** "Airspace of the Russian Federation" → "Russian Federation". */
export function czibAreaName(title) {
  return title.replace(/^Airspace of (?:the )?/i, '') || title;
}

/**
 * Whether the title names only part of a country: "Pakistan – Baluchistan
 * and …", "Yemen – Sana'a Flight Information Region", "Egypt, North Sinai
 * Governorate". Multi-country titles such as "Middle East (Iran, Iraq)" are
 * not partial.
 */
export function isPartialArea(area) {
  return /\s[–—-]\s/.test(area) || /^[^,(]+, /.test(area);
}

/** The bulletin number and canonical page for an RSS link, or null. */
export function czibLink(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  if (url.origin !== CZIB_ORIGIN || url.search || url.hash) return null;
  const match = /^\/(?:en\/)?domains\/air-operations\/czibs\/([^/]+)\/?$/.exec(
    url.pathname,
  );
  const slug = match?.[1].toLowerCase();
  if (!slug || !SLUG.test(slug)) return null;
  const parts = NUMBER.exec(slug);
  return {
    url: `${CZIB_LIST_URL}/${slug}`,
    number: parts
      ? `${parts[1]?.toLowerCase() === 'sib-' ? 'SIB' : 'CZIB'}-${parts[2]}-${parts[3]}${parts[4] ? `R${Number(parts[4])}` : ''}`
      : '',
  };
}

/**
 * Parse the CZIB RSS feed into node id → { url, number }. The guid is
 * "<node id> on <date>". Returns null when the text is not an RSS channel.
 */
export function parseCzibFeed(xml) {
  if (typeof xml !== 'string' || !/<rss[\s>]/.test(xml)) return null;
  const links = new Map();
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const item of items.slice(0, MAX_FEED_ITEMS)) {
    const nid = /<guid[^>]*>\s*(\d{1,9}) on /.exec(item)?.[1];
    const link = /<link>([^<]*)<\/link>/.exec(item)?.[1];
    const parsed = nid && link ? czibLink(decodeEntities(link)) : null;
    if (parsed && !links.has(nid)) links.set(nid, parsed);
  }
  return links;
}

function countryList(value) {
  const seen = new Set();
  for (const part of text(value, 1000).split(',')) {
    const name = part.trim().slice(0, 64);
    if (name && seen.size < MAX_COUNTRIES) seen.add(name);
  }
  return [...seen];
}

/**
 * Normalize one export entry, or null when it lacks a node id, a known
 * status or a title.
 */
export function normalizeCzibEntry(entry, links = new Map()) {
  const id = String(entry?.Nid ?? '');
  if (!/^\d{1,9}$/.test(id)) return null;
  const status = String(entry.status || '').toLowerCase();
  if (!CZIB_STATUSES.includes(status)) return null;
  const title = text(entry.name);
  if (!title) return null;
  const area = czibAreaName(title);
  const link = links.get(id) || null;
  return {
    id,
    number: link?.number || '',
    title,
    area,
    partial: isPartialArea(area),
    status,
    countries: countryList(entry.country),
    issuedMs: parseCzibStamp(entry.issued_date),
    revisedMs: revisionStamp(entry.updated),
    validUntilMs: parseCzibDay(entry.valid_until_date),
    validity: text(entry.field_easa_valid_until_descr),
    url: link?.url || null,
  };
}

/** Most recently revised first. */
export function compareCzibBulletins(a, b) {
  const at = (bulletin) => bulletin.revisedMs ?? bulletin.issuedMs ?? 0;
  return at(b) - at(a) || a.id.localeCompare(b.id);
}

/**
 * Normalize the EASA JSON export, joined to the feed links. Returns null
 * when the payload is not the export shape.
 */
export function normalizeCzibExport(payload, links = new Map()) {
  if (!Array.isArray(payload?.conflict_zones)) return null;
  const byId = new Map();
  for (const entry of payload.conflict_zones) {
    const record = normalizeCzibEntry(entry, links);
    if (record && !byId.has(record.id)) byId.set(record.id, record);
  }
  return [...byId.values()].sort(compareCzibBulletins);
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/** A bulletin page URL is kept only below the EASA CZIB list. */
function pageUrl(value) {
  if (typeof value !== 'string' || !value.startsWith(`${CZIB_LIST_URL}/`))
    return null;
  return SLUG.test(value.slice(CZIB_LIST_URL.length + 1)) ? value : null;
}

/**
 * Validate records that crossed the proxy boundary. Only the fields
 * `normalizeCzibEntry` produces survive, re-checked; a row without an id, a
 * known status or a title is dropped.
 */
export function sanitizeCzibBulletins(rows) {
  if (!Array.isArray(rows)) return null;
  const seen = new Set();
  const bulletins = [];
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : '';
    const title = text(row?.title);
    if (
      !/^\d{1,9}$/.test(id) ||
      seen.has(id) ||
      !CZIB_STATUSES.includes(row.status) ||
      !title
    )
      continue;
    seen.add(id);
    const area = czibAreaName(title);
    bulletins.push({
      id,
      number: /^(?:CZIB|SIB)-\d{4}-\d{2}(?:R\d{1,3})?$/.test(row.number)
        ? row.number
        : '',
      title,
      area,
      partial: isPartialArea(area),
      status: row.status,
      countries: Array.isArray(row.countries)
        ? [
            ...new Set(
              row.countries
                .map((name) => text(name, 64))
                .filter(Boolean)
                .slice(0, MAX_COUNTRIES),
            ),
          ]
        : [],
      issuedMs: finiteOrNull(row.issuedMs),
      revisedMs: finiteOrNull(row.revisedMs),
      validUntilMs: finiteOrNull(row.validUntilMs),
      validity: text(row.validity),
      url: pageUrl(row.url),
    });
  }
  return bulletins.sort(compareCzibBulletins);
}
