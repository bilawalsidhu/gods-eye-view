// NTCIP 1203 MULTI to plain text for the message-sign card and its spoken
// label. Faces are MnDOT's own rendered GIFs, so nothing here lays out or
// draws a sign: it keeps only the page and line structure, joins column
// runs with two spaces, and reports whether the message has a graphic so a
// graphic-only message still counts as lit. Server-importable: no DOM,
// Cesium or i18n catalogs (callers pass translated labels in).

export const MAX_MULTI_CHARS = 4096;
const MAX_PAGES = 8;
const MAX_LINES_PER_PAGE = 8;
const MAX_LINE_CHARS = 64;
const CARD_LINE_CHARS = 44;
const MAX_CARD_LINES = 12;
const COLUMN_GAP = '  ';

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidi embedding, override and isolate marks.
const BIDI_MARKS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Feed text with control characters as spaces and bidi marks removed, so
 * MnDOT text can't reorder or hide what the card shows. */
export const stripUnsafeText = (text) =>
  String(text ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(BIDI_MARKS, '');

const cleanRun = (text) =>
  stripUnsafeText(text)
    .replace(/\s{3,}/g, COLUMN_GAP)
    .trim();

/**
 * Parse MULTI into pages of text lines.
 * @param {unknown} multi Raw MULTI from IRIS sign_message.
 * @returns {{ pages: string[][], hasGraphic: boolean, visibleChars: number }}
 */
export function parseMultiText(multi) {
  const source =
    typeof multi === 'string' ? multi.slice(0, MAX_MULTI_CHARS) : '';
  const pages = [];
  let lines = [];
  let runs = [];
  let run = '';
  let hasGraphic = false;

  const endRun = () => {
    const text = cleanRun(run);
    if (text) runs.push(text);
    run = '';
  };
  const endLine = () => {
    endRun();
    if (runs.length) lines.push(runs.join(COLUMN_GAP));
    runs = [];
  };
  const endPage = () => {
    endLine();
    // Flashing messages repeat their text on each page; read it once.
    const previous = pages.at(-1);
    const repeat = previous && previous.join('\n') === lines.join('\n');
    if (lines.length && !repeat) pages.push(lines);
    lines = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '[' && source[i + 1] === '[') {
      run += '[';
      i += 1;
    } else if (char === ']' && source[i + 1] === ']') {
      run += ']';
      i += 1;
    } else if (char === '[') {
      const close = source.indexOf(']', i + 1);
      if (close < 0) break; // Unclosed tag: the rest is not text.
      const tag = source
        .slice(i + 1, close)
        .trim()
        .toLowerCase();
      i = close;
      if (/^nl\d*$/.test(tag) || tag.startsWith('tr')) endLine();
      else if (tag === 'np') endPage();
      else if (/^jl\d*$/.test(tag)) endRun();
      else if (/^g\d/.test(tag)) hasGraphic = true;
    } else {
      run += char;
    }
  }
  endPage();

  const capped = pages
    .slice(0, MAX_PAGES)
    .map((page) =>
      page
        .slice(0, MAX_LINES_PER_PAGE)
        .map((line) => line.slice(0, MAX_LINE_CHARS).trimEnd()),
    );
  const visibleChars = capped
    .flat()
    .reduce((sum, line) => sum + line.replace(/\s/g, '').length, 0);
  return { pages: capped, hasGraphic, visibleChars };
}

function wrapLine(line, width) {
  if (line.length <= width) return [line];
  const wrapped = [];
  let current = '';
  for (let word of line.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (current) wrapped.push(current);
      current = '';
      wrapped.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      wrapped.push(current);
      current = word;
    }
  }
  if (current) wrapped.push(current);
  return wrapped;
}

/**
 * Card detail lines: page headers when there are several pages, each line
 * wrapped to the card width, at most MAX_CARD_LINES with an ellipsis.
 * @param {{ pages: string[][], hasGraphic: boolean }} parsed
 * @param {{ pageLabel: (n: number, total: number) => string, graphicOnly: string }} labels
 * @returns {string[]}
 */
export function cardLines(parsed, labels) {
  const { pages, hasGraphic } = parsed;
  if (!pages.length) return hasGraphic ? [labels.graphicOnly] : [];
  const lines = [];
  pages.forEach((page, index) => {
    if (pages.length > 1) lines.push(labels.pageLabel(index + 1, pages.length));
    for (const line of page) lines.push(...wrapLine(line, CARD_LINE_CHARS));
  });
  if (lines.length <= MAX_CARD_LINES) return lines;
  const kept = lines.slice(0, MAX_CARD_LINES);
  const last = kept[MAX_CARD_LINES - 1];
  kept[MAX_CARD_LINES - 1] = `${last.slice(0, CARD_LINE_CHARS - 1)}…`;
  return kept;
}

/**
 * One sentence for screen readers: lines joined with commas, pages
 * prefixed with their number.
 * @param {{ pages: string[][], hasGraphic: boolean }} parsed
 * @param {{ pageLabel: (n: number, total: number) => string, graphicOnly: string }} labels
 * @returns {string}
 */
export function spokenText(parsed, labels) {
  const { pages, hasGraphic } = parsed;
  if (!pages.length) return hasGraphic ? labels.graphicOnly : '';
  const pageText = (page) =>
    page.map((line) => line.replace(/\s+/g, ' ')).join(', ');
  if (pages.length === 1) return pageText(pages[0]);
  return pages
    .map(
      (page, index) =>
        `${labels.pageLabel(index + 1, pages.length)}: ${pageText(page)}`,
    )
    .join('. ');
}
