/**
 * Path import: a small, bounded XML scanner.
 *
 * GPX and KML are both XML, and the browser has `DOMParser` for that. It is not
 * used here on purpose: this half of the import has to run under `node --test`
 * with no DOM, and a person's own track file is untrusted input that should be
 * read by something with stated limits. The scanner builds a plain element tree
 * and nothing else — no DTD processing, no custom entity expansion (so no
 * entity-expansion blow-up), and a hard ceiling on nodes and depth.
 *
 * Element names are reduced to their lower-cased LOCAL name: `gx:Track` and
 * `kml:Placemark` read as `track` and `placemark`, so a namespace prefix chosen
 * by the exporting app does not decide whether a file imports.
 *
 * No Cesium, no DOM.
 */

/** Hard ceiling on elements in one file. A day-long 1 Hz track is ~90k points. */
export const MAX_XML_NODES = 400000;
/** Nesting ceiling. Real GPX/KML is under ten deep; folders nest a little more. */
export const MAX_XML_DEPTH = 64;

/** A refusal the importer can explain to the person, keyed by a stable code. */
export class PathImportError extends Error {
  /**
   * @param {string} code Stable machine-readable reason.
   * @param {string} message One line a person can act on.
   */
  constructor(code, message) {
    super(message);
    this.name = 'PathImportError';
    this.code = code;
  }
}

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/**
 * Decode the five predefined entities and numeric character references. Any
 * other entity is left as written: expanding document-declared entities is the
 * mechanism behind entity-expansion attacks, and no track file needs it.
 * @param {string} text
 * @returns {string}
 */
export function decodeXmlText(text) {
  if (!text || text.indexOf('&') < 0) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Scan XML text into an element tree.
 * @param {string} source
 * @param {{maxNodes?: number, maxDepth?: number}} [limits]
 * @returns {{name: string, attrs: Record<string, string>, children: object[], text: string}}
 *   A synthetic `#document` node whose children are the top-level elements.
 */
export function scanXml(
  source,
  { maxNodes = MAX_XML_NODES, maxDepth = MAX_XML_DEPTH } = {},
) {
  const text = String(source ?? '').replace(/^﻿/, '');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let nodes = 0;
  let at = 0;
  const end = text.length;
  const malformed = (what) =>
    new PathImportError(
      'malformed-xml',
      `The file is not valid XML (${what}).`,
    );

  while (at < end) {
    const open = text.indexOf('<', at);
    const top = stack[stack.length - 1];
    if (open < 0) {
      if (top !== root) top.text += decodeXmlText(text.slice(at));
      break;
    }
    if (open > at && top !== root)
      top.text += decodeXmlText(text.slice(at, open));

    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      if (close < 0) throw malformed('unterminated comment');
      at = close + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open + 9);
      if (close < 0) throw malformed('unterminated CDATA section');
      if (top !== root) top.text += text.slice(open + 9, close);
      at = close + 3;
      continue;
    }
    if (text.startsWith('<?', open)) {
      const close = text.indexOf('?>', open + 2);
      if (close < 0) throw malformed('unterminated processing instruction');
      at = close + 2;
      continue;
    }
    if (text.startsWith('<!', open)) {
      // A DOCTYPE, skipped whole. Its internal subset may hold `>` inside
      // brackets, so the end is the first `>` outside them.
      at = skipDeclaration(text, open);
      if (at < 0) throw malformed('unterminated declaration');
      continue;
    }

    const close = tagEnd(text, open + 1);
    if (close < 0) throw malformed('unterminated tag');
    const body = text.slice(open + 1, close);
    at = close + 1;

    if (body[0] === '/') {
      const name = localName(body.slice(1));
      if (top === root || top.name !== name)
        throw malformed(`unexpected closing tag </${name}>`);
      stack.pop();
      continue;
    }

    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const head = /^[^\s/]+/.exec(inner);
    if (!head) throw malformed('empty tag');
    nodes += 1;
    if (nodes > maxNodes)
      throw new PathImportError(
        'too-large',
        `The file has more than ${maxNodes.toLocaleString('en-US')} elements.`,
      );
    const node = {
      name: localName(head[0]),
      attrs: parseAttributes(inner.slice(head[0].length)),
      children: [],
      text: '',
    };
    top.children.push(node);
    if (!selfClosing) {
      if (stack.length > maxDepth)
        throw new PathImportError(
          'too-deep',
          `The file nests elements more than ${maxDepth} deep.`,
        );
      stack.push(node);
    }
  }

  if (stack.length !== 1)
    throw malformed(`<${stack[stack.length - 1].name}> is never closed`);
  return root;
}

/** `gx:Track` → `track`. */
function localName(raw) {
  const name = raw.trim();
  const colon = name.lastIndexOf(':');
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

/** Index of the `>` that ends the tag starting at `from`, honouring quoted values. */
function tagEnd(text, from) {
  let quote = '';
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

/** Index just past a `<!...>` declaration, honouring an internal `[...]` subset. */
function skipDeclaration(text, from) {
  let depth = 0;
  for (let i = from + 2; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '>' && depth === 0) return i + 1;
  }
  return -1;
}

/** Attributes by lower-cased local name; later duplicates do not replace earlier ones. */
function parseAttributes(raw) {
  const attrs = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(raw);
  while (match) {
    const name = localName(match[1]);
    if (!(name in attrs)) attrs[name] = decodeXmlText(match[2] ?? match[3]);
    match = pattern.exec(raw);
  }
  return attrs;
}

/** Direct children of `node` with the given local name. */
export function childrenNamed(node, name) {
  return (node?.children || []).filter((child) => child.name === name);
}

/** First direct child of `node` with the given local name, or null. */
export function firstChild(node, name) {
  return (node?.children || []).find((child) => child.name === name) ?? null;
}

/**
 * Every descendant of `node` with the given local name, in document order.
 * Iterative, so a deep file cannot exhaust the call stack.
 */
export function descendantsNamed(node, name) {
  const found = [];
  const pending = [...(node?.children || [])].reverse();
  while (pending.length) {
    const current = pending.pop();
    if (current.name === name) found.push(current);
    for (let i = current.children.length - 1; i >= 0; i -= 1)
      pending.push(current.children[i]);
  }
  return found;
}

/** Trimmed text of a direct child, or '' when it is absent. */
export function childText(node, name) {
  return (firstChild(node, name)?.text || '').trim();
}
