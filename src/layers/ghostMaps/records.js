// Pure helpers for GhostMaps placemarks: description tables to plain fields,
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
  for (const row of source.matchAll(
    /<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr\s*>/gi,
  )) {
    const cells = [
      ...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi),
    ].map((cell) => cell[1]);
    if (cells.length !== 2) continue;
    const label = htmlToText(cells[0]);
    const value = htmlToText(cells[1]);
    if (!label || SKIPPED_LABELS.has(label.toLowerCase())) continue;
    if (EMPTY_VALUES.has(value.toLowerCase())) continue;
    addLinks(cells[1]);
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
