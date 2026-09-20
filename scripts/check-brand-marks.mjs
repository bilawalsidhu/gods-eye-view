#!/usr/bin/env node
/**
 * Brand-mark boundary — exactly ONE OnDemand brand mark per header surface.
 *
 *   node scripts/check-brand-marks.mjs            # exits 1 on any violation
 *
 * Rule (docs/BRANDING.md §4 "One brand mark per surface", 2026-09-20):
 *   1. Every rendered brand mark — an element that ships one of the brand logo
 *      assets (`/brand/mark*.svg`, `/brand/logo-*.svg`, `/brand/logo-*.png`) or
 *      carries a brand-logo class (`brand-logo`, `brand-wordmark*`,
 *      `brand-loader-wordmark`) — MUST carry the `data-brand-mark` attribute.
 *   2. No single markup file (each header surface owns its own template:
 *      scene-chrome.html → `#title-bar`, hud-loading.html → `#loading-screen`)
 *      may render more than one brand mark.
 * Favicons (`<link rel="icon">`), the web manifest and `og:image` metadata are
 * asset references, not rendered marks, and are ignored.
 *
 * Runs as part of `npm run check:boundaries`; the pure helpers are covered by
 * src/tooling/brandMarks.test.mjs and re-used by src/iconGlyphBoundary.test.mjs
 * against the assembled application markup.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Asset paths whose presence on an element makes it a rendered brand mark. */
const BRAND_ASSET =
  /\/brand\/(?:mark(?:-light|-dark)?\.svg|mark\.png|logo-(?:light|dark|black)\.(?:svg|png))/i;
/** Class names reserved for brand-mark containers. */
const BRAND_CLASS =
  /\bbrand-(?:logo|wordmark(?:-logo)?|loader-wordmark|mark)\b/;
/** Elements that can render an image; `link`/`meta` never render. */
const RENDER_TAG = /^(?:img|picture|source|svg|span|div|a|figure|object|use)$/i;

/**
 * Find every rendered brand mark in a markup/source text.
 * Nested elements of ONE mark (`<picture>` + `<source>` + `<img>`, or a
 * `<span data-logo-src>` wrapping its `<img>`) are collapsed into a single
 * mark keyed by the outermost element.
 * @param {string} text HTML or JS source.
 * @returns {{ line: number, tag: string, snippet: string, hasAttribute: boolean }[]}
 */
export function scanBrandMarks(text) {
  const marks = [];
  const source = String(text ?? '');
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let match;
  let openMark = null; // { end: index at which the current mark's container closes }
  while ((match = tagRe.exec(source))) {
    const [full, tag, attrs] = match;
    if (!RENDER_TAG.test(tag)) continue;
    const isBrand = BRAND_ASSET.test(attrs) || BRAND_CLASS.test(attrs);
    if (!isBrand) continue;
    const line = source.slice(0, match.index).split('\n').length;
    const hasAttribute = /\bdata-brand-mark\b/.test(attrs);
    const lower = tag.toLowerCase();
    // A child asset (source/img/svg) of the container we already counted.
    if (openMark && match.index < openMark.end) {
      openMark.mark.hasAttribute ||= hasAttribute;
      continue;
    }
    const mark = {
      line,
      tag: lower,
      snippet: full.slice(0, 160),
      hasAttribute,
    };
    marks.push(mark);
    if (
      lower === 'picture' ||
      lower === 'span' ||
      lower === 'div' ||
      lower === 'a' ||
      lower === 'figure'
    ) {
      const close = source.indexOf(`</${lower}>`, match.index);
      openMark = {
        mark,
        end: close === -1 ? match.index + full.length : close,
      };
    } else {
      openMark = null;
    }
  }
  return marks;
}

/**
 * Evaluate the two rules over a list of { file, text } records.
 * @returns {{ violations: string[], marks: Record<string, ReturnType<typeof scanBrandMarks>> }}
 */
export function checkBrandMarks(records) {
  const violations = [];
  const marks = {};
  for (const { file, text } of records) {
    const found = scanBrandMarks(text);
    if (!found.length) continue;
    marks[file] = found;
    if (found.length > 1) {
      violations.push(
        `${file}: renders ${found.length} brand marks (lines ${found.map((m) => m.line).join(', ')}) — exactly one brand mark per header surface`,
      );
    }
    for (const m of found) {
      if (!m.hasAttribute) {
        violations.push(
          `${file}:${m.line}: brand mark <${m.tag}> is rendered without data-brand-mark — ${m.snippet}`,
        );
      }
    }
  }
  return { violations, marks };
}

/** Markup and renderer sources that can ship a brand mark (tests excluded). */
export function brandMarkSourceFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (
        /\.(?:html|js|mjs)$/.test(entry.name) &&
        !/\.test\.mjs$/.test(entry.name)
      )
        out.push(abs);
    }
  };
  visit(path.join(root, 'src'));
  for (const rel of ['index.html']) {
    const abs = path.join(root, rel);
    try {
      if (statSync(abs).isFile()) out.push(abs);
    } catch {}
  }
  const pub = path.join(root, 'public');
  try {
    for (const name of readdirSync(pub))
      if (name.endsWith('.html')) out.push(path.join(pub, name));
  } catch {}
  return out
    .sort()
    .map((abs) => ({
      file: path.relative(root, abs).split(path.sep).join('/'),
      text: readFileSync(abs, 'utf8'),
    }));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { violations, marks } = checkBrandMarks(brandMarkSourceFiles(root));
  const files = Object.keys(marks);
  console.log(
    `Checked brand marks: ${files.length} file(s) render a brand mark (${files
      .map((f) => `${f} ×${marks[f].length}`)
      .join(', ')}).`,
  );
  if (violations.length) {
    console.error(`Brand-mark boundary violations (${violations.length}):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exitCode = 1;
  }
}
