import { readFileSync } from 'node:fs';

/**
 * Newline-agnostic source reader for the source-pin tests (issue #88, PLAN
 * Phase 7). ~86 tests regex source text; with `.gitattributes` enforcing LF
 * that is already safe in any git checkout, but tests also run outside git
 * (archives, exported worktrees, editor save-hooks) where CRLF can reappear.
 * This reader pins the anchors to the LF shape the repo actually stores.
 *
 * @param {string} relativeSpec module specifier relative to `importerUrl`
 * @param {string} importerUrl the calling test's `import.meta.url`
 * @returns {string} file text with CRLF/CR folded to LF
 */
export function readSource(relativeSpec, importerUrl) {
  return normalizeEol(readFileSync(new URL(relativeSpec, importerUrl), 'utf8'));
}

/**
 * Fold CRLF and bare CR to LF.
 * @param {string} text - Source text as read from disk, in any EOL flavor.
 * @returns {string} The same text with every line ending normalized to `\n`.
 */
export function normalizeEol(text) {
  return text.replaceAll(/\r\n?/g, '\n');
}
