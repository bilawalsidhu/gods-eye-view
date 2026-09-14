// inputAccessibleNames.test.mjs — the PR #216 invariant: every form control
// in index.html (input, select, textarea) carries an accessible name —
// aria-label, aria-labelledby, an associated <label for>, or a wrapping
// <label>. Static and quote-aware so multi-line tags (radio-tuner-slider)
// parse correctly; hidden controls are exempt because they are not exposed
// to the accessibility tree at all. Complements the runtime qa-a11y axe run,
// which cannot catch controls added later without a browser.
import { readSource } from './testSupport/readSource.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = readSource('../index.html', import.meta.url);

/** Extract full opening tags for a tag name, tracking quotes so `>` inside
 *  an attribute value cannot truncate the match. */
function extractOpenTags(source, tagName) {
  const tags = [];
  const open = new RegExp(`<${tagName}\\b`, 'g');
  for (let match = open.exec(source); match; match = open.exec(source)) {
    let i = match.index + match[0].length;
    let quote = null;
    while (i < source.length) {
      const ch = source[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      i += 1;
    }
    tags.push({ tag: source.slice(match.index, i + 1), index: match.index });
    open.lastIndex = i + 1;
  }
  return tags;
}

function attr(tag, name) {
  // Boolean attributes (hidden, disabled, …) are presence-checks: '' when
  // bare, null when absent.
  const m = tag.match(new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*("([^"]*)"|'([^']*)'))?(?=[\\s>])`, 'i'));
  return m ? (m[2] ?? m[3] ?? '') : null;
}

/** Regions between <label …> and </label> (labels do not nest here). */
function labelRegions(source) {
  const regions = [];
  const scan = /<label\b[^>]*>|<\/label>/g;
  let open = null;
  for (let m = scan.exec(source); m; m = scan.exec(source)) {
    if (m[0].startsWith('<label')) {
      open = m.index;
    } else if (open !== null) {
      regions.push({ start: open, end: m.index + m[0].length, source: source.slice(open, m.index + m[0].length) });
      open = null;
    }
  }
  return regions;
}

const LABEL_REGIONS = labelRegions(html);
const LABEL_FOR_IDS = new Set(
  extractOpenTags(html, 'label')
    .map(({ tag }) => attr(tag, 'for'))
    .filter(Boolean),
);

/** The accessible name the control resolves to, or null when it has none. */
function accessibleName(control) {
  const { tag, index } = control;
  if (attr(tag, 'hidden') !== null || attr(tag, 'type')?.toLowerCase() === 'hidden') return 'hidden (exempt)';
  const ariaLabel = attr(tag, 'aria-label');
  if (ariaLabel && ariaLabel.trim()) return `aria-label "${ariaLabel.trim()}"`;
  const labelledBy = attr(tag, 'aria-labelledby');
  if (labelledBy && labelledBy.trim()) return `aria-labelledby "${labelledBy.trim()}"`;
  const id = attr(tag, 'id');
  if (id && LABEL_FOR_IDS.has(id)) return `label[for="${id}"]`;
  const wrapping = LABEL_REGIONS.find((r) => r.start < index && index < r.end);
  if (wrapping) {
    // The wrapping label must contribute text of its own — an aria-hidden
    // span (or nothing) inside the label is not a name.
    const text = wrapping.source
      .replace(/<[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/[^>]*>/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return `wrapping <label> ("${text}")`;
  }
  return null;
}

const CONTROLS = [
  ...extractOpenTags(html, 'input'),
  ...extractOpenTags(html, 'select'),
  ...extractOpenTags(html, 'textarea'),
];

test('every form control in index.html carries an accessible name (PR #216)', () => {
  assert.ok(CONTROLS.length >= 12, `expected the real control census (found ${CONTROLS.length})`);
  const unnamed = CONTROLS.filter((control) => accessibleName(control) === null);
  assert.deepEqual(
    unnamed.map(({ tag }) => tag.slice(0, 80)),
    [],
    'these form controls have no accessible name — add aria-label, aria-labelledby, '
    + 'a <label for>, or a wrapping <label>',
  );
});

test('census snapshot: every control and the naming mechanism it resolves by', () => {
  const census = CONTROLS.map((control) => {
    const id = attr(control.tag, 'id') || attr(control.tag, 'type') || control.tag.slice(0, 30);
    return `${id} → ${accessibleName(control)}`;
  });
  // Pinned verbatim so a control whose naming mechanism silently changes is
  // visible in the diff, and so a new control's line must be added knowingly
  // (the first test above still catches an unnamed addition).
  assert.deepEqual(census, [
    'cockpit-radio-volume → aria-label "Cockpit Radio volume"',
    'detection-density-slider → aria-label "Detection label density"',
    'detection-fade-slider → aria-label "Detection fade distance"',
    'detection-opacity-slider → aria-label "Detection opacity outside the keyhole"',
    'scope-feather-slider → aria-label "Scope edge feather"',
    'bloom-intensity-slider → aria-label "Bloom intensity"',
    'sharpen-intensity-slider → aria-label "Sharpening intensity"',
    'location-search → aria-label "Search any location"',
    'scene-import-file → hidden (exempt)',
    'context-radio-mini-volume → aria-label "Compact Radio volume"',
    'radio-tuner-slider → aria-label "Tune available internet radio stations"',
    'radio-volume → aria-label "Radio volume"',
    'checkbox → wrapping <label> ("Don\'t show this again")',
    'hud-layout-select → aria-label "HUD layout"',
    'cctv-camera-select → aria-label "CCTV camera"',
    'scene-select → aria-label "Scene recipe"',
    'radio-filter → aria-label "Filter stations by station tag"',
  ]);
});
