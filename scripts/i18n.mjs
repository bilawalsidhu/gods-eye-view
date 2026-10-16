// Keeps the locale catalogs in step with the code.
//
//   npm run i18n                     check every catalog and find unmarked UI text
//   npm run i18n -- --prune          also drop entries the code no longer uses
//   npm run i18n -- --missing ru     print what ru lacks, as JSON to translate
//
// A translation left as the English fails unless src/i18n/same-as-english.json
// lists it.
//
// Messages are the English literals passed to t(), tn() and msg() in src/,
// plus the markup opted in with data-i18n* in src/ui/templates and index.html.
// It also lists UI text that is not marked at all (see findUnmarked).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(ROOT, 'src/i18n/locales');
const SAME_AS_ENGLISH = path.join(ROOT, 'src/i18n/same-as-english.json');

const STRING = String.raw`'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\`(?:\\.|[^\`\\$])*\``;
const CALL = new RegExp(
  String.raw`\bt\(\s*(${STRING})\s*,\s*\{\s*context:\s*(${STRING})|\b(t|msg)\(\s*(${STRING})|\btn\(\s*[^,]+?,\s*(${STRING})\s*,\s*(${STRING})`,
  'g',
);

function unquote(literal) {
  const body = literal.slice(1, -1);
  return body.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs,
    (_, esc) => {
      if (esc[0] === 'u' || esc[0] === 'x') {
        return String.fromCodePoint(parseInt(esc.replace(/[ux{}]/g, ''), 16));
      }
      return { n: '\n', t: '\t', r: '\r' }[esc] ?? esc;
    },
  );
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
function decodeHtml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      return String.fromCodePoint(
        parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10),
      );
    }
    return ENTITIES[name.toLowerCase()] ?? all;
  });
}

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

function trackedFiles(...pathspecs) {
  return (
    execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ...pathspecs,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter(Boolean)
      // The index still lists a file moved or deleted without git mv / git rm.
      .filter((file) => existsSync(path.join(ROOT, file)))
  );
}

/**
 * Every message the code can ask for.
 * @returns {Map<string, {plural: boolean, one?: string, where: string}>}
 */
export function extractMessages() {
  const messages = new Map();
  const add = (text, where, plural = null) => {
    if (!text) return;
    const known = messages.get(text);
    if (known && Boolean(known.plural) !== Boolean(plural)) {
      throw new Error(
        `${where}: "${text}" is used both as plural and plain text (also ${known.where})`,
      );
    }
    if (!known)
      messages.set(text, { plural: Boolean(plural), one: plural?.one, where });
  };

  const sources = sourceFiles();
  for (const file of sources) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(CALL)) {
      const line = source.slice(0, match.index).split('\n').length;
      const where = `${file}:${line}`;
      if (match[1]) {
        add(`${unquote(match[2])}|${unquote(match[1])}`, where);
      } else if (match[4]) {
        if (match[4][0] === '`' && match[4].includes('${')) continue;
        add(unquote(match[4]), where);
      } else {
        add(unquote(match[6]), where, { one: unquote(match[5]) });
      }
    }
  }

  const markup = trackedFiles('index.html', 'src/ui/templates/*.html');
  const TAG = /<([a-zA-Z][\w-]*)(\s[^>]*?)\/?>([^<]*)/gs;
  for (const file of markup) {
    const html = readFileSync(path.join(ROOT, file), 'utf8');
    for (const [, tag, attrs, text] of html.matchAll(TAG)) {
      const where = `${file} <${tag}>`;
      if (/\sdata-i18n(\s|=|$)/.test(attrs))
        add(normalize(decodeHtml(text)), where);
      for (const [, name] of attrs.matchAll(
        /\sdata-i18n-(title|aria-label|placeholder)\b/g,
      )) {
        const value = attrs.match(new RegExp(String.raw`\s${name}="([^"]*)"`));
        if (value) add(decodeHtml(value[1]), where);
        else
          throw new Error(
            `${where}: data-i18n-${name} without a ${name} attribute`,
          );
      }
    }
  }
  return messages;
}

const hasWords = (text) => /[A-Za-z]{2,}/.test(text);
const lineAt = (source, index) => source.slice(0, index).split('\n').length;

const VOID_TAGS = new Set(
  'area base br col embed hr img input link meta source track wbr'.split(' '),
);
const SKIP_TAGS = new Set(['script', 'style', 'svg', 'code', 'pre', 'title']);

/**
 * User-visible markup text without data-i18n*. Skipped, with everything
 * inside: translate="no" (text that stays as is, as in HTML),
 * data-i18n-runtime (code sets this text through t()), and icons
 * (aria-hidden, Material Symbols).
 */
export function unmarkedMarkup(file, html) {
  const found = [];
  const source = html.replace(/<!--[\s\S]*?-->|<![^>]*>/g, (c) =>
    c.replace(/[^\n]/g, ' '),
  );
  const TOKEN =
    /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
  const stack = [];
  const skipping = () => stack.at(-1)?.skip === true;
  for (const match of source.matchAll(TOKEN)) {
    const [, closing, rawTag, attrs = '', selfClosing, text] = match;
    if (text !== undefined) {
      const top = stack.at(-1);
      const value = normalize(decodeHtml(text));
      if (!skipping() && hasWords(value) && !top?.marked)
        found.push({
          where: `${file}:${lineAt(source, match.index)}`,
          text: value,
        });
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (closing) {
      const at = stack.map((entry) => entry.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    const skip =
      skipping() ||
      SKIP_TAGS.has(tag) ||
      /\stranslate="no"/.test(attrs) ||
      /\sdata-i18n-runtime\b/.test(attrs) ||
      /\saria-hidden="true"/.test(attrs) ||
      /class="[^"]*material-symbols/.test(attrs);
    if (!skip) {
      for (const [, name, value] of attrs.matchAll(
        /\s(title|aria-label|placeholder)="([^"]*)"/g,
      )) {
        if (
          hasWords(value) &&
          !new RegExp(String.raw`\sdata-i18n-${name}\b`).test(attrs)
        )
          found.push({
            where: `${file}:${lineAt(source, match.index)}`,
            text: `${name}="${decodeHtml(value)}"`,
          });
      }
    }
    if (!VOID_TAGS.has(tag) && !selfClosing)
      stack.push({ tag, skip, marked: /\sdata-i18n(\s|=|$)/.test(attrs) });
  }
  return found;
}

// Where a string becomes UI text. Each pattern ends where the value starts.
const JS_SINKS = [
  /\.(?:textContent|innerText|innerHTML|outerHTML|title|placeholder|ariaLabel)\s*=(?!=)\s*/g,
  /\bsetAttribute\(\s*['"](?:title|aria-label|aria-valuetext|placeholder|alt)['"]\s*,\s*/g,
  /\b(?:createTextNode|insertAdjacentText)\(\s*(?:['"][a-z]+['"]\s*,\s*)?/g,
  /\binsertAdjacentHTML\(\s*['"][a-z]+['"]\s*,\s*/g,
  // Also showToast?.(…) and this._showToast(…).
  /\b_?(?:showToast|toast|setHint|announce|say)(?:\?\.)?\(\s*/g,
  // `status` values are often codes ('ok', 'auth-failed'); visibleText drops
  // those, so only readable text is reported. A name right after `?` is a
  // ternary branch (`ok ? status : 'Fallback'`), not a property.
  /(?:^|[{,\s])(?<!\?\s*)(?:label|title|tooltip|placeholder|hint|ariaLabel|accessibilityLabel|caption|subtitle|kicker|emptyText|blurb|countLabel|status|loadingLabel|statusMessage)\s*:\s*/gm,
];
// Layer status set by assignment: this._error = …, stats.lastError = …,
// error = … (a layer factory keeps its status in `let error`). Not checked:
// the declaration itself (`const error = …`, `let status = …`) and a default
// value in a parameter list or destructuring (see defaultValue).
const ASSIGNMENT_SINK =
  /(?<![\w$])(?<!\b(?:const|let|var)\s+)_?(?:error|lastError|loadingLabel|statusMessage|status)\s*(?:\?\?|\|\|)?=(?![=>])\s*/g;
JS_SINKS.push(ASSIGNMENT_SINK);

/**
 * Whether `name = value` at `nameStart` is a default (`(status = 'idle') =>`,
 * `const { error = '…' } = options`): it follows `(`, `[`, `{` or `,` and its
 * value ends at `,` or a closing bracket. An assignment statement ends at `;`.
 */
function defaultValue(source, nameStart, valueStart) {
  const before = source.slice(0, nameStart).trimEnd().at(-1);
  if (!before || !'([{,'.includes(before)) return false;
  const end = valueStart + expressionAt(source, valueStart).length;
  const after = source.slice(end).trimStart()[0];
  return Boolean(after) && ',)]}'.includes(after);
}
const MARKERS = /\b(?:t|tn|msg)\(/y;

/** The expression starting at `start`, up to its end at bracket depth 0. */
function expressionAt(source, start) {
  let depth = 0;
  let i = start;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(source, i);
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ';' || c === ',')) break;
    else if (depth === 0 && c === '\n') {
      const next = source.slice(i + 1).match(/^\s*(\S\S?)/)?.[1] ?? '';
      const before = source.slice(start, i).trimEnd().at(-1) ?? '';
      if (!/^(\?|:|\+|\.|&&|\|\|)/.test(next) && !/[?:+=&|(,]/.test(before))
        break;
    }
  }
  return source.slice(start, i);
}

function skipString(source, i) {
  const quote = source[i];
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === '\\') j++;
    else if (quote === '`' && source[j] === '$' && source[j + 1] === '{') {
      let depth = 1;
      for (j += 2; j < source.length && depth; j++) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}') depth--;
        else if ('\'"`'.includes(source[j])) j = skipString(source, j);
      }
      j--;
    } else if (source[j] === quote) return j;
    else if (quote !== '`' && source[j] === '\n') return j;
  }
  return source.length;
}

/** String literals that sit in value position: not inside any call or index,
 * not compared, and not already passed to t/tn/msg. */
function valueLiterals(expression) {
  const literals = [];
  let callDepth = 0;
  const stack = [];
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (c === '(' || c === '[') {
      const isCall = c === '[' || /[\w$\]\)]\s*$/.test(expression.slice(0, i));
      stack.push(isCall);
      if (isCall) callDepth++;
      continue;
    }
    if (c === ')' || c === ']') {
      if (stack.pop()) callDepth--;
      continue;
    }
    MARKERS.lastIndex = i;
    if (MARKERS.test(expression)) {
      stack.push(true);
      callDepth++;
      i = MARKERS.lastIndex - 1;
      continue;
    }
    if (c !== "'" && c !== '"' && c !== '`') continue;
    const end = skipString(expression, i);
    const literal = expression.slice(i, end + 1);
    const before = expression.slice(0, i).trimEnd();
    const after = expression.slice(end + 1).trimStart();
    const compared =
      /(===|!==|==|!=|\bcase|\bin)$/.test(before) ||
      /^(===|!==|==|!=|in\b)/.test(after);
    if (callDepth === 0 && !compared) literals.push(literal);
    i = end;
  }
  return literals;
}

/** The text a literal shows: static template parts, HTML tags removed. */
function visibleText(literal, html) {
  let body = literal.slice(1, -1).replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ' ');
  if (html) {
    const attrs = [
      ...body.matchAll(/\s(?:title|aria-label|placeholder|alt)="([^"]*)"/g),
    ].map((m) => m[1]);
    body = decodeHtml([body.replace(/<[^>]*>/g, ' '), ...attrs].join(' '));
  }
  const text = normalize(body);
  if (!hasWords(text)) return null;
  if (/\{[^{}]*:[^{}]*\}|^[\w-]+\s*:\s*[^;]+;/.test(text)) return null; // CSS
  if (/^(?:rgba?|hsla?)\(|\b\d+px\b/.test(text)) return null; // colours, fonts
  if (/^[a-z0-9_.:/-]+$/.test(text) || /^https?:/.test(text)) return null;
  return text;
}

/** Blank out comments, keeping strings and line numbers intact. */
function withoutComments(source) {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(source, i);
      out += source.slice(i, end + 1);
      i = end;
    } else if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else out += c;
  }
  return out;
}

export function unmarkedScript(file, original) {
  const found = [];
  const lines = original.split('\n');
  const source = withoutComments(original);
  const ignored = (line) =>
    /i18n-ignore/.test(lines[line - 1] ?? '') ||
    /i18n-ignore/.test(lines[line - 2] ?? '');
  for (const sink of JS_SINKS) {
    sink.lastIndex = 0;
    for (const match of source.matchAll(sink)) {
      const start = match.index + match[0].length;
      const line = lineAt(source, start);
      if (ignored(line)) continue;
      if (sink === ASSIGNMENT_SINK && defaultValue(source, match.index, start))
        continue;
      const html = /HTML/.test(match[0]);
      for (const literal of valueLiterals(expressionAt(source, start))) {
        const text = visibleText(literal, html);
        if (text) found.push({ where: `${file}:${line}`, text });
      }
    }
  }
  return found;
}

/**
 * UI text that is not marked for translation: markup without data-i18n* and
 * string literals that reach the page without t(), tn() or msg().
 * Opt-outs: see unmarkedMarkup; in code, `// i18n-ignore` on or above the line.
 * @returns {{where: string, text: string}[]}
 */
export function findUnmarked() {
  const found = [];
  for (const file of trackedFiles('index.html', 'src/ui/templates/*.html'))
    found.push(
      ...unmarkedMarkup(file, readFileSync(path.join(ROOT, file), 'utf8')),
    );
  for (const file of sourceFiles().filter(
    (name) => !NOT_UI.some((pattern) => pattern.test(name)),
  ))
    found.push(
      ...unmarkedScript(file, readFileSync(path.join(ROOT, file), 'utf8')),
    );
  const seen = new Set();
  return found.filter(({ where, text }) => {
    const key = `${where}\0${text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Text that never reaches the page as UI: tool results and descriptions for
// AI clients (MCP and the voice model).
const NOT_UI = [/^src\/tools\//];

function sourceFiles() {
  return trackedFiles(
    'src/*.js',
    'src/*.mjs',
    'src/**/*.js',
    'src/**/*.mjs',
  ).filter(
    (file) =>
      !file.startsWith('src/i18n/') &&
      !/\.test\.mjs$|\/testSupport\//.test(file),
  );
}

const placeholders = (text) =>
  [...String(text).matchAll(/\{([A-Za-z0-9_]+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

export function catalogPath(locale) {
  return path.join(LOCALES_DIR, `${locale}.json`);
}

export function readCatalog(locale) {
  return JSON.parse(readFileSync(catalogPath(locale), 'utf8'));
}

export function shippedLocales() {
  return trackedFiles('src/i18n/locales/*.json').map((file) =>
    path.basename(file, '.json'),
  );
}

/** Messages a locale keeps exactly as in English, on purpose. */
export function readSameAsEnglish(locale) {
  const lists = JSON.parse(readFileSync(SAME_AS_ENGLISH, 'utf8'));
  return new Set(lists[locale] || []);
}

/** The English a message shows: its text without the "context|" prefix. */
const englishOf = (text) => text.slice(text.indexOf('|') + 1);

/** A translation with nothing to show: t() falls back to English for it. */
const blank = (value) => value.trim() === '';

/** Words to read, beyond {placeholders}, codes and punctuation. */
const hasLetters = (value) => /\p{L}{2}/u.test(value.replace(/\{[^}]*\}/g, ''));

const STILL_ENGLISH = (text, locale) =>
  `"${text}" is still English: translate it, or list it under "${locale}" in src/i18n/same-as-english.json`;

/**
 * Compare one catalog with the extracted messages.
 * @param {Set<string>} [sameAsEnglish] Messages allowed to read as English.
 * @returns {{missing: string[], stale: string[], errors: string[]}}
 */
export function checkCatalog(
  locale,
  catalog,
  messages,
  sameAsEnglish = readSameAsEnglish(locale),
) {
  const categories = new Intl.PluralRules(locale).resolvedOptions()
    .pluralCategories;
  const missing = [];
  const errors = [];
  for (const [text, info] of messages) {
    if (!Object.hasOwn(catalog, text)) {
      missing.push(text);
      continue;
    }
    const entry = catalog[text];
    if (info.plural) {
      if (!entry || typeof entry !== 'object') {
        errors.push(`"${text}" needs plural forms ${categories.join('/')}`);
        continue;
      }
      const english = new Set([info.one, englishOf(text)]);
      const stillEnglish = [];
      for (const category of categories) {
        const form = entry[category];
        if (typeof form !== 'string')
          errors.push(`"${text}" lacks the "${category}" form`);
        else if (blank(form))
          errors.push(`"${text}" [${category}] is empty: translate it`);
        else if (placeholders(form) !== placeholders(text))
          errors.push(`"${text}" [${category}] placeholders differ: ${form}`);
        else if (english.has(form) && hasLetters(form))
          stillEnglish.push(category);
      }
      if (stillEnglish.length && !sameAsEnglish.has(text))
        errors.push(
          `${STILL_ENGLISH(text, locale)} (forms ${stillEnglish.join('/')})`,
        );
    } else if (typeof entry !== 'string') {
      errors.push(`"${text}" must be a string`);
    } else if (blank(entry)) {
      errors.push(`"${text}" is empty: translate it`);
    } else if (placeholders(entry) !== placeholders(text)) {
      errors.push(`"${text}" placeholders differ: ${entry}`);
    } else if (
      entry === englishOf(text) &&
      hasLetters(entry) &&
      !sameAsEnglish.has(text)
    ) {
      errors.push(STILL_ENGLISH(text, locale));
    }
  }
  const stale = Object.keys(catalog).filter((text) => !messages.has(text));
  return { missing, stale, errors };
}

/**
 * What `--missing <locale>` prints: every missing entry, ready to translate.
 * A template, not a translation: the check rejects a string left empty and a
 * plural form left as the English.
 */
export function missingTemplate(locale, catalog, messages) {
  const categories = new Intl.PluralRules(locale).resolvedOptions()
    .pluralCategories;
  const out = {};
  for (const text of checkCatalog(locale, catalog, messages, new Set())
    .missing) {
    const info = messages.get(text);
    out[text] = info.plural
      ? Object.fromEntries(
          categories.map((category) => [
            category,
            category === 'one' ? info.one : text,
          ]),
        )
      : '';
  }
  return out;
}

function main(args) {
  const messages = extractMessages();
  const missingFor = args.includes('--missing')
    ? args[args.indexOf('--missing') + 1]
    : null;
  if (missingFor) {
    const out = missingTemplate(missingFor, readCatalog(missingFor), messages);
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  let failed = false;
  for (const locale of shippedLocales()) {
    let catalog = readCatalog(locale);
    const { missing, stale, errors } = checkCatalog(locale, catalog, messages);
    if (args.includes('--prune') && stale.length) {
      catalog = Object.fromEntries(
        Object.entries(catalog).filter(([text]) => messages.has(text)),
      );
      writeFileSync(
        catalogPath(locale),
        `${JSON.stringify(catalog, null, 2)}\n`,
      );
      console.log(`${locale}: pruned ${stale.length} unused entries`);
    } else if (stale.length) {
      failed = true;
      console.log(
        `${locale}: ${stale.length} entries the code no longer uses (npm run i18n -- --prune):`,
      );
      for (const text of stale) console.log(`  ${JSON.stringify(text)}`);
    }
    if (missing.length) {
      failed = true;
      console.log(
        `${locale}: ${missing.length} missing (npm run i18n -- --missing ${locale}):`,
      );
      for (const text of missing)
        console.log(`  ${JSON.stringify(text)}  ${messages.get(text).where}`);
    }
    for (const error of errors) {
      failed = true;
      console.log(`${locale}: ${error}`);
    }
    if (!missing.length && !stale.length && !errors.length) {
      console.log(`${locale}: ${messages.size} messages, complete`);
    }
  }
  const unmarked = findUnmarked();
  if (unmarked.length) {
    failed = true;
    console.log(
      `${unmarked.length} UI strings not marked for translation (see docs/I18N.md):`,
    );
    for (const { where, text } of unmarked)
      console.log(`  ${where}  ${JSON.stringify(text)}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
