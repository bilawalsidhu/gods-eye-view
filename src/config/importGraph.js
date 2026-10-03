/**
 * Static import-graph walker (Phase 15A — docs/PLAN.md).
 *
 * Answers one question without a build: which modules does the main entry pull
 * in statically, and how much source do they weigh? The boot-payload work uses
 * this to rank lazy-load seams, and `src/main.importgraph.test.mjs` uses the
 * same closure to FAIL the suite if a seam module ever re-enters the main
 * entry's static graph — chunk discipline enforced at test time, not by
 * whoever remembers to eyeball the build output.
 *
 * Deliberately regex-based, not an AST parser: the app's imports are all
 * literal specifiers, so statement-anchored scans see the whole static edge
 * set with zero dependencies. Statements are matched at line starts and
 * comments are stripped first — prose like "downloaded from 'x'" or a
 * doc-comment mentioning `import('egm96-universal')` must never become a
 * phantom edge in a file the guard polices.
 *
 * Byte weights are SOURCE bytes (comments included, pre-minification) — used
 * for ranking and budget context, never reported as bundle bytes.
 *
 * @module config/importGraph
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** `import x from '…'` / `export { x } from '…'`, anchored to line starts. */
const FROM_STATEMENT_RE = /^[ \t]*(?:import|export)[^;'"]*?from[ \t]*['"]([^'"{}]+)['"]/gm;
/** Bare side-effect `import '…';`. */
const SIDE_EFFECT_RE = /^[ \t]*import[ \t]*['"]([^'"{}]+)['"][ \t]*;?[ \t]*$/gm;
/** Literal dynamic `import('…')`. */
const DYNAMIC_RE = /\bimport\([ \t]*['"]([^'"{}]+)['"][ \t]*\)/g;

/**
 * A single-pass lexeme scrubber: blanks comment text and the contents of
 * every string/template literal EXCEPT import specifiers (the string right
 * after `from`, a bare `import`, or `import(`), which are the only strings
 * the statement regexes below need intact.
 *
 * One pass over all lexeme kinds is required, not sequential regexes: a
 * `/*` inside a string is not a comment, and an apostrophe in a comment is
 * not a string — each naive ordering corrupts the other's input and would
 * either hide a real edge (a guard false-negative) or invent one. Template
 * interpolations (`` `a${code}b` ``) recurse back into code mode with brace
 * tracking, so code inside them is scanned and prose around it is not.
 *
 * Newlines are preserved everywhere (the statement regexes are line-anchored).
 *
 * @param {string} source Module source text.
 * @returns {string} Source with non-code text blanked; same length, same lines.
 */
function scrubNonCode(source) {
  const CODE = 0;
  const LINE_COMMENT = 1;
  const BLOCK_COMMENT = 2;
  const TEMPLATE = 3;
  const out = [];
  // Only the trailing characters of emitted CODE decide whether a string is
  // an import specifier (`from '…'` / `import '…'` / `import('…')`), so the
  // keep-test reads a small rolling tail instead of re-joining the whole
  // output per string literal — O(1) amortized per lexeme.
  const SPECIFIER_TAIL_RE = /(?:\bfrom|\bimport)\s*(?:\(\s*)?$/;
  let tail = '';
  const emitCode = (text) => {
    out.push(text);
    tail = (tail + text).slice(-80);
  };
  const templateStack = [];
  const interpBraces = [];
  let braces = 0;
  let mode = CODE;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : '';
    if (mode === CODE) {
      if (ch === '/' && next === '/') {
        mode = LINE_COMMENT;
        emitCode('  ');
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        mode = BLOCK_COMMENT;
        emitCode('  ');
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        // Keep the contents only when this string is an import specifier:
        // `from '…'`, a bare side-effect `import '…'`, or `import('…')`.
        const keep = SPECIFIER_TAIL_RE.test(tail);
        const quote = ch;
        emitCode(quote);
        i += 1;
        while (i < n && source[i] !== quote) {
          if (source[i] === '\\') {
            emitCode(keep ? source[i] : '  ');
            i += 2;
            continue;
          }
          out.push(keep ? source[i] : (source[i] === '\n' ? '\n' : ' '));
          i += 1;
        }
        if (i < n) emitCode(quote);
        i += 1;
        continue;
      }
      if (ch === '`') {
        mode = TEMPLATE;
        emitCode(ch);
        i += 1;
        continue;
      }
      if (ch === '{') braces += 1;
      if (ch === '}') {
        if (interpBraces.length && braces === interpBraces.at(-1) + 1) {
          // Closing an interpolation: return to the enclosing template at
          // the brace depth recorded when the `${` opened.
          braces = interpBraces.pop();
          mode = templateStack.pop();
          out.push(ch);
          i += 1;
          continue;
        }
        braces -= 1;
      }
      emitCode(ch);
      i += 1;
      continue;
    }
    if (mode === LINE_COMMENT) {
      if (ch === '\n') {
        mode = CODE;
        out.push(ch);
      } else {
        out.push(' ');
      }
      i += 1;
      continue;
    }
    if (mode === BLOCK_COMMENT) {
      if (ch === '*' && next === '/') {
        mode = CODE;
        out.push('  ');
        i += 2;
        continue;
      }
      out.push(ch === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }
    // TEMPLATE: blank prose, preserve structure, recurse into ${code}.
    if (ch === '\\') {
      out.push('  ');
      i += 2;
      continue;
    }
    if (ch === '`') {
      mode = CODE;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '$' && next === '{') {
      templateStack.push(TEMPLATE);
      interpBraces.push(braces);
      braces += 1;
      mode = CODE;
      out.push('${');
      i += 2;
      continue;
    }
    out.push(ch === '\n' ? '\n' : ' ');
    i += 1;
  }
  return out.join('');
}

/**
 * Whether a specifier names something outside the repo (bare package,
 * protocol URL, or Vite's `?url` assets) and therefore forms no repo edge.
 * @param {string} specifier Raw import specifier.
 * @returns {boolean} True when the specifier cannot resolve to a repo file.
 */
function isExternalSpecifier(specifier) {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/**
 * Resolve a relative specifier to a repo file the way ESM does: exact path
 * first, then the `.js`/`.mjs` extensions, then a directory `index.js`.
 *
 * @param {string} specifier Import path starting with `.` or `/`.
 * @param {string} importerFile Absolute path of the importing module.
 * @param {string} rootDir Repo root `/`-prefixed specifiers resolve against.
 * @returns {string|null} Absolute path of the resolved file, or null.
 */
export function resolveSpecifier(specifier, importerFile, rootDir) {
  const base = specifier.startsWith('/')
    ? resolve(rootDir, `.${specifier}`)
    : resolve(dirname(importerFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, resolve(base, 'index.js')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // raced unlink — treat as missing
    }
  }
  return null;
}

/**
 * Parse one module's import edges. Static and literal-dynamic edges are
 * classified by import form: `import('…')` marks a dynamic edge (the boundary
 * a bundler cuts a chunk at); everything else is static.
 *
 * @param {string} file Absolute path of the module to read.
 * @param {string} rootDir Repo root used to resolve `/`-prefixed specifiers.
 * @returns {{bytes: number, staticDeps: string[], dynamicDeps: string[],
 *   externals: string[]}} Source size in bytes (raw, comments included);
 *   resolved absolute dependency paths per edge kind; unresolved (external)
 *   specifiers of both kinds.
 */
export function readModule(file, rootDir) {
  const source = readFileSync(file, 'utf8');
  const bare = scrubNonCode(source);
  const staticDeps = [];
  const dynamicDeps = [];
  const externals = [];
  /**
   * Route one specifier to its edge list (or the external set when it does
   * not resolve inside the repo).
   * @param {string} specifier Raw import specifier.
   * @param {boolean} dynamic Whether the edge came from a dynamic `import()`.
   * @returns {void}
   */
  const classify = (specifier, dynamic) => {
    if (isExternalSpecifier(specifier)) {
      externals.push(specifier);
      return;
    }
    const resolved = resolveSpecifier(specifier, file, rootDir);
    if (!resolved) {
      externals.push(specifier);
      return;
    }
    (dynamic ? dynamicDeps : staticDeps).push(resolved);
  };
  for (const match of bare.matchAll(FROM_STATEMENT_RE)) classify(match[1], false);
  for (const match of bare.matchAll(SIDE_EFFECT_RE)) classify(match[1], false);
  for (const match of bare.matchAll(DYNAMIC_RE)) classify(match[1], true);
  return { bytes: Buffer.byteLength(source), staticDeps, dynamicDeps, externals };
}

/**
 * Walk the STATIC import graph from an entry file — exactly the module set a
 * bundler places in the entry chunk, because dynamic `import()` edges are cut
 * at the walk boundary. `dynamicOnly` reports, per visited module, the
 * resolved targets of its dynamic imports that are NOT in the static closure
 * (the true chunk exits).
 *
 * @param {string} entryFile Absolute path of the entry module (e.g. src/main.js).
 * @param {string} rootDir Repo root; `/`-prefixed specifiers resolve against it.
 * @returns {{files: Map<string, {bytes: number, staticDeps: string[],
 *   dynamicDeps: string[], externals: string[]}>, dynamicOnly: Map<string,
 *   string[]>, externals: Set<string>}} Visited modules keyed by absolute
 *   path; chunk-exit targets per module; every external specifier seen.
 *   Cycles terminate naturally (a visited module is not revisited).
 */
export function staticImportGraph(entryFile, rootDir) {
  const files = new Map();
  const externals = new Set();
  const visit = (file) => {
    if (files.has(file)) return;
    const module = readModule(file, rootDir);
    files.set(file, module);
    for (const specifier of module.externals) externals.add(specifier);
    for (const dep of module.staticDeps) visit(dep);
  };
  visit(resolve(entryFile));
  const dynamicOnly = new Map();
  for (const [file, module] of files) {
    const exits = module.dynamicDeps.filter((dep) => !files.has(dep));
    if (exits.length) dynamicOnly.set(file, exits);
  }
  return { files, dynamicOnly, externals };
}

/**
 * Attribute the entry's static closure to its DIRECT imports — the seams a
 * refactor can actually cut. Each row carries:
 *   - `directBytes`: the module's own source weight.
 *   - `closureBytes`: everything reachable through it (shared code counted
 *     again, so rows can overlap).
 *   - `exclusiveBytes`: the honest "cut this edge and this much source leaves
 *     the entry chunk" number — first-root attribution in import order, so a
 *     module imported earlier keeps its shared dependencies charged to it.
 *
 * @param {string} entryFile Absolute entry path.
 * @param {string} rootDir Repo root.
 * @param {{exclude?: (path: string) => boolean}} [options] Optional predicate
 *   dropping files from `totalBytes` accounting (row ranking still walks them).
 * @returns {{entry: string, totalBytes: number, rows: Array<{file: string,
 *   directBytes: number, closureBytes: number, exclusiveBytes: number}>}}
 *   Rows in the entry's import order (attribution order), sorted by
 *   `exclusiveBytes` descending.
 */
export function rankEntryImports(entryFile, rootDir, { exclude = null } = {}) {
  const { files } = staticImportGraph(entryFile, rootDir);
  const entryPath = resolve(entryFile);
  const entry = files.get(entryPath);
  const closureOf = (file) => {
    const seen = new Set([file]);
    const queue = [file];
    while (queue.length) {
      const module = files.get(queue.pop());
      if (!module) continue;
      for (const dep of module.staticDeps) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        queue.push(dep);
      }
    }
    return seen;
  };
  const attributed = new Set([entryPath]);
  const rows = (entry?.staticDeps || []).map((file) => {
    const closure = closureOf(file);
    const module = files.get(file);
    let exclusiveBytes = attributed.has(file) ? 0 : module.bytes;
    for (const member of closure) {
      if (member === file || attributed.has(member)) continue;
      attributed.add(member);
      exclusiveBytes += files.get(member)?.bytes ?? 0;
    }
    attributed.add(file);
    return {
      file,
      directBytes: module.bytes,
      closureBytes: [...closure].reduce((sum, member) => sum + (files.get(member)?.bytes ?? 0), 0),
      exclusiveBytes,
    };
  });
  rows.sort((a, b) => b.exclusiveBytes - a.exclusiveBytes);
  let totalBytes = 0;
  for (const [file, module] of files) {
    if (exclude && exclude(file)) continue;
    totalBytes += module.bytes;
  }
  return { entry: entryPath, totalBytes, rows };
}
