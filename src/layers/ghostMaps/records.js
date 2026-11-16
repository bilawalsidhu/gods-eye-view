// Pure helpers for GhostMaps placemarks: report fields and event dates,
// KML colors, and card text wrapping. Strings in, data out — description
// markup is only ever read as text, never inserted into the page.

const ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

/** Decode the HTML character references ArcGIS and Google Earth emit. */
export function decodeHtmlEntities(text) {
  return String(text ?? '').replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi,
    (whole, ref) => {
      if (ref[0] === '#') {
        const code =
          ref[1] === 'x' || ref[1] === 'X'
            ? parseInt(ref.slice(2), 16)
            : parseInt(ref.slice(1), 10);
        return code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : '';
      }
      return ENTITIES[ref.toLowerCase()] ?? whole;
    },
  );
}

/** Markup to one line of plain text. */
export function htmlToText(html) {
  return decodeHtmlEntities(
    String(html ?? '')
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

const EMPTY_VALUES = new Set(['', '<null>', 'null', 'n/a', '-', '<blank>']);
// ArcGIS writes geometry type and internal ids into every popup table.
const SKIPPED_LABELS = new Set(['shape', 'objectid', 'fid', 'globalid']);
const MAX_FIELDS = 24;
const MAX_VALUE = 600;
const MAX_LINKS = 6;

// Use the same leaf rows for report cards and event dates, without the card's
// field-count/value-length limits affecting the age filter.
function* descriptionRows(source) {
  for (const row of source.matchAll(
    /<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr\s*>/gi,
  )) {
    const cells = [
      ...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi),
    ].map((cell) => cell[1]);
    if (cells.length === 2)
      yield {
        label: htmlToText(cells[0]),
        value: htmlToText(cells[1]),
        markup: cells[1],
      };
  }
}

export const GHOSTMAPS_DEFAULT_AGE_DAYS = 7;
export const GHOSTMAPS_AGE_OPTIONS = Object.freeze([1, 3, 7, 14, 30, null]);

/** ArcGIS US dates (optionally with a time) and ISO dates, interpreted in UTC
 * when no zone is supplied. A date without a time means the whole UTC day, so
 * it resolves to the day's last millisecond: "1d" still shows yesterday's
 * reports. Reject calendar rollovers instead of guessing. */
export function parseGhostMapsEventDate(value) {
  const input = String(value ?? '').trim();
  const us =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM))?$/i.exec(
      input,
    );
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(
      input,
    );
  if (!us && !iso) return null;
  const year = Number(us ? us[3] : iso[1]);
  const month = Number(us ? us[1] : iso[2]);
  const day = Number(us ? us[2] : iso[3]);
  let hour = Number(us?.[4] ?? iso?.[4] ?? 0);
  const minute = Number(us?.[5] ?? iso?.[5] ?? 0);
  const second = Number(us?.[6] ?? iso?.[6] ?? 0);
  if (us?.[7]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (us[7].toUpperCase() === 'PM' ? 12 : 0);
  }
  const at = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(at);
  if (
    year < 1900 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  if (iso?.[4]) {
    const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(input) ? input : `${input}Z`;
    const parsed = Date.parse(zoned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return us?.[4] ? at : at + 86400_000 - 1;
}

/** The event's date, never its report/upload date or dates mentioned in prose. */
export function ghostMapsEventDate(description) {
  const rows = [
    ...descriptionRows(
      String(description ?? '').replace(
        /<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi,
        ' ',
      ),
    ),
  ];
  for (const name of ['dateofevent', 'eventdate', 'date']) {
    for (const { label, value } of rows) {
      if (label.toLowerCase().replace(/[\s_]+/g, '') !== name) continue;
      const at = parseGhostMapsEventDate(value);
      if (at !== null) return at;
    }
  }
  return null;
}

/** Unknown and future dates stay visible; only a confirmed old event expires. */
export function isGhostMapsEventExpired(
  dateMs,
  now = Date.now(),
  ageDays = GHOSTMAPS_DEFAULT_AGE_DAYS,
) {
  return (
    ageDays !== null &&
    Number.isFinite(dateMs) &&
    dateMs < now - ageDays * 86400_000
  );
}

/**
 * Fields and links from a placemark description. ArcGIS "popup" exports are a
 * two-column table (label, value); anything else becomes one unlabelled field.
 * @param {string} html Description as written in the KML (CDATA text).
 * @returns {{fields: Array<{label: string, value: string}>, links: string[]}}
 */
export function parseDescriptionFields(html) {
  const source = String(html ?? '').replace(
    /<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
  const fields = [];
  const links = [];
  const addLinks = (markup) => {
    for (const match of markup.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      const url = decodeHtmlEntities(match[1]).trim();
      if (/^https?:\/\/[^\s]+$/i.test(url) && !links.includes(url))
        links.push(url);
    }
  };
  // Innermost rows only: ArcGIS nests the field table inside an outer row,
  // and only leaf rows with exactly two cells are label/value pairs.
  for (const { label, value, markup } of descriptionRows(source)) {
    if (!label || SKIPPED_LABELS.has(label.toLowerCase())) continue;
    if (EMPTY_VALUES.has(value.toLowerCase())) continue;
    addLinks(markup);
    // A bare research link is carried by `links`; the card does not need
    // the URL twice.
    if (/^https?:\/\/\S+$/i.test(value)) continue;
    if (fields.length < MAX_FIELDS)
      fields.push({ label, value: value.slice(0, MAX_VALUE) });
  }
  if (!fields.length && !links.length) {
    const text = htmlToText(source);
    if (text) fields.push({ label: '', value: text.slice(0, MAX_VALUE) });
    addLinks(source);
  }
  return { fields, links: links.slice(0, MAX_LINKS) };
}

/**
 * KML `aabbggrr` to `[r, g, b, a]` in 0..1, or null.
 * @param {string} text
 * @returns {?number[]}
 */
export function kmlColor(text) {
  const hex = String(text ?? '')
    .trim()
    .replace(/^#/, '');
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null;
  const byte = (at) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return [byte(6), byte(4), byte(2), byte(0)];
}

/**
 * Greedy word wrap for canvas card lines; overlong words are cut.
 * @param {string} text
 * @param {number} width Characters per line.
 * @param {number} maxLines Lines kept; the last ends with an ellipsis when cut.
 * @returns {string[]}
 */
export function wrapCardText(text, width = 56, maxLines = 4) {
  const lines = [];
  let line = '';
  let cut = false;
  for (let word of String(text ?? '')
    .split(/\s+/)
    .filter(Boolean)) {
    while (word.length > width) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    if (lines.length >= maxLines) {
      cut = true;
      break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  else if (line) cut = true;
  const kept = lines.slice(0, maxLines);
  if (cut && kept.length) {
    const last = kept[kept.length - 1];
    kept[kept.length - 1] = `${last.slice(0, width - 1)}…`;
  }
  return kept;
}

/** Field labels ArcGIS writes CamelCase; show them as words. */
export function fieldLabel(label) {
  return String(label ?? '')
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}
