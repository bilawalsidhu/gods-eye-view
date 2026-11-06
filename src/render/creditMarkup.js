/**
 * @module render/creditMarkup
 * @description A credit written as HTML markup, as engines and older layer
 * code carry it, read as the contract's plain credit data
 * (`src/render/contract/credits.d.ts`): its text, the first link and the
 * first image. Markup with more than one link keeps only the first.
 *
 * A plain reading, no DOM: it runs in Node and in workers. A link or logo
 * of a scheme that could run script is dropped.
 */

/** The schemes a credit may link to, and load its logo from. */
export const LINK_SCHEMES = Object.freeze(['https:', 'http:', 'mailto:']);
export const LOGO_SCHEMES = Object.freeze(['https:', 'http:', 'data:']);

/**
 * A URL of one of `schemes`, resolved against the page, or null.
 * @param {string} value
 * @param {readonly string[]} schemes
 * @returns {string|null}
 */
export function safeUrl(value, schemes) {
  try {
    const base = globalThis.location?.href ?? 'https://invalid.invalid/';
    const url = new URL(value, base);
    if (!schemes.includes(url.protocol)) return null;
    if (url.protocol === 'data:' && !/^data:image\//i.test(url.href))
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** A tag's inside, quoted attribute values allowed to hold `>`. */
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const ANCHOR = new RegExp(`<a\\b${TAG_BODY}>`, 'i');
const IMAGE = new RegExp(`<img\\b${TAG_BODY}>`, 'i');
const ANY_TAG = new RegExp(`<${TAG_BODY}>`, 'g');

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  ndash: '–',
  mdash: '—',
};

/** Character references decoded; unknown named ones are left as written. */
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref) => {
    if (ref[0] !== '#') return ENTITIES[ref.toLowerCase()] ?? whole;
    const code =
      ref[1] === 'x' || ref[1] === 'X'
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** An attribute's value in one start tag, decoded. */
function attribute(tag, name) {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  ).exec(tag);
  return match ? decode(match[1] ?? match[2] ?? match[3]) : undefined;
}

/**
 * @param {string} html
 * @returns {{text: string, href?: string, logoUrl?: string}} A logo with no
 *   text around it is named by its title or alt text.
 */
export function creditFromMarkup(html) {
  const markup = String(html ?? '');
  const anchor = ANCHOR.exec(markup)?.[0];
  const image = IMAGE.exec(markup)?.[0];
  let text = decode(
    markup
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(ANY_TAG, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (!text && image)
    text = attribute(image, 'title') ?? attribute(image, 'alt') ?? '';
  const credit = { text };
  const href = anchor && attribute(anchor, 'href');
  if (href && safeUrl(href, LINK_SCHEMES)) credit.href = href;
  const logoUrl = image && attribute(image, 'src');
  if (logoUrl && safeUrl(logoUrl, LOGO_SCHEMES)) credit.logoUrl = logoUrl;
  return credit;
}
