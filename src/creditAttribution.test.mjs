import { readStylesheet } from './testSupport/readStylesheet.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The Omnibar's desktop footer (src/ui/styles/omnibar-dock.css) is part of
// the cascade below like every other stylesheet; its rules carry the
// Omnibar scope, so they are modelled as a layout of their own.
const omnibarCss = readStylesheet(
  path.join(ROOT, 'src/ui/styles/omnibar-dock.css'),
);
const css = readStylesheet(path.join(ROOT, 'style.css'));

/*
 * Required-attribution keep-out pin.
 *
 * Google Maps Platform and Cesium both require the credit line to stay visible
 * whenever their content is on screen, so this pin FAILS CLOSED: any cascade
 * construct it cannot resolve exactly is an explicit failure naming the
 * construct, never a silent skip. An earlier version modelled `bottom` only and
 * ignored specificity, importance, shorthands and media nesting — four
 * independent behaviour-breaking mutations passed it.
 */

const REM_PX = 16;

// Rendered sizes the stylesheet cannot supply. Measured live at
// 600/700/800/830/900px viewports by qa-shots/quickwins/credit-probe.mjs and
// re-measured on every run of that sweep. The CSS inputs that determine them
// are guarded below, because a change there invalidates the constant.
const CREDIT_HEIGHT_PX = 28;
const COMPACT_DOCK_HEIGHT_PX = 62;

// Clear air the notice must keep above it. The stylesheet aims for 12px.
const MIN_CLEARANCE_PX = 8;

// ── CSS model ───────────────────────────────────────────────────────────────

/** Mask bracket/paren contents so combinator splitting cannot land inside them. */
function maskGroups(selector) {
  let out = '';
  let depth = 0;
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1;
    out += depth > 0 && char === ' ' ? '_' : char;
    if (char === ')' || char === ']') depth -= 1;
  }
  return out;
}

/** Split on a delimiter that is not inside brackets or parentheses. */
function splitTopLevel(text, delimiter) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (char === delimiter && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

/** The final compound of a complex selector — the element the rule positions. */
function lastCompound(part) {
  const masked = maskGroups(part);
  let cut = -1;
  for (let i = 0; i < masked.length; i += 1) {
    if (' >+~'.includes(masked[i])) cut = i;
  }
  return part.slice(cut + 1);
}

function compareSpecificity(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** CSS specificity as [ids, classes, types]. `:where()` contributes nothing. */
function specificity(selector) {
  let ids = 0;
  let classes = 0;
  let types = 0;
  let rest = selector;
  for (;;) {
    const match = rest.match(/:(not|is|has|where|matches)\(/);
    if (!match) break;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < rest.length; i += 1) {
      if (rest[i] === '(') depth += 1;
      else if (rest[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end > 0, `unbalanced functional pseudo-class in "${selector}"`);
    if (match[1] !== 'where') {
      let best = [0, 0, 0];
      for (const argument of splitTopLevel(rest.slice(open + 1, end), ',')) {
        const inner = specificity(argument.trim());
        if (compareSpecificity(inner, best) > 0) best = inner;
      }
      ids += best[0];
      classes += best[1];
      types += best[2];
    }
    rest = rest.slice(0, match.index) + rest.slice(end + 1);
  }
  ids += (rest.match(/#[\w-]+/g) || []).length;
  classes += (rest.match(/\.[\w-]+/g) || []).length;
  classes += (rest.match(/\[[^\]]*\]/g) || []).length;
  types += (rest.match(/::[\w-]+/g) || []).length;
  classes += (rest.replace(/::[\w-]+/g, '').match(/:[\w-]+/g) || []).length;
  types += (
    rest.replace(/\[[^\]]*\]/g, '').match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) || []
  ).length;
  return [ids, classes, types];
}

/** Collapse whitespace and the padding inside brackets of a selector. */
const tidySelector = (part) =>
  part
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')');

/**
 * A nested selector resolved against its parent rule's selectors, as CSS
 * nesting does: `&` stands for the parent, and a selector without one is a
 * descendant of it.
 */
function nestSelectors(parents, head) {
  const own = splitTopLevel(head, ',').map(tidySelector).filter(Boolean);
  if (!parents) return own;
  return parents.flatMap((parent) =>
    own.map((part) =>
      part.includes('&') ? part.replaceAll('&', parent) : `${parent} ${part}`,
    ),
  );
}

/**
 * Flatten style.css into rules carrying their raw media stack. Nested style
 * rules (CSS nesting) and media queries nested in a rule are resolved to
 * full selectors, so a nested rule is modelled like any other.
 */
function flattenRules(source) {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  // Open blocks, innermost last: media queries and style rules.
  const stack = [];
  const mediaStack = () =>
    stack.filter((frame) => frame.media).map((frame) => frame.media);
  const parentRule = () =>
    [...stack].reverse().find((frame) => frame.rule)?.rule || null;
  const declare = (text) => {
    const rule = parentRule();
    const trimmed = text.trim();
    if (!rule || !trimmed) return;
    const colon = trimmed.indexOf(':');
    if (colon < 0) return;
    const value = trimmed.slice(colon + 1).trim();
    rule.decls.push({
      prop: trimmed.slice(0, colon).trim().toLowerCase(),
      value: value.replace(/\s*!important$/i, '').trim(),
      important: /!important\s*$/i.test(value),
    });
  };
  let index = 0;
  let prelude = '';
  while (index < src.length) {
    const char = src[index];
    if (char === '{') {
      const head = prelude.replace(/\s+/g, ' ').trim();
      prelude = '';
      index += 1;
      if (head.startsWith('@media')) {
        stack.push({ media: head.slice('@media'.length).trim() });
        continue;
      }
      if (head.startsWith('@')) {
        let level = 1;
        while (index < src.length && level > 0) {
          if (src[index] === '{') level += 1;
          else if (src[index] === '}') level -= 1;
          index += 1;
        }
        continue;
      }
      const rule = {
        order: rules.length,
        media: mediaStack(),
        parts: nestSelectors(parentRule()?.parts, head),
        decls: [],
      };
      rules.push(rule);
      stack.push({ rule });
      continue;
    }
    if (char === ';') {
      declare(prelude);
      prelude = '';
      index += 1;
      continue;
    }
    if (char === '}') {
      // The last declaration of a block may omit its semicolon.
      declare(prelude);
      prelude = '';
      stack.pop();
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  assert.equal(stack.length, 0, 'unbalanced braces in style.css');
  return rules;
}

const RULES = flattenRules(css);

// ── What the model understands ──────────────────────────────────────────────

// Selectors that position a modelled element's OWN box. Anything else that
// positions one of these elements is an unmodelled construct and fails.
const RECOGNIZED = new Set([
  // credit
  '#cesium-credits',
  'body:not(.ui-clean-view):not(.recording-mode) #cesium-credits',
  "body:not(.ui-clean-view):not(.recording-mode):is(.hud-minimal-active *, #intel-hud[data-variant='minimal'].active) #cesium-credits",
  'body.ui-clean-view #cesium-credits',
  'body.recording-mode #cesium-credits',
  // dock
  '#command-dock',
  // rail
  '#right-context-rail',
  '#right-context-rail.layout-focus',
  '#right-context-rail[data-rail-measuring]',
]);

const DOCKED_RAIL = 'body.context-docked #right-context-rail';

// The Omnibar layout: the scopes its stylesheet nests every rule in. The dock
// scope applies at every width while the Omnibar and the voice control share
// the dock; the desktop scope, which places the credits and corners around
// it, applies on the desktop shell (above the 720px phone breakpoint).
// Outside them the legacy layout below governs.
const OMNIBAR_DOCK_SCOPE =
  'body:not(.cockpit-mode):not(.scene-playback-mode):not(.ui-clean-view):not(.recording-mode):where(.has-omnibar.dock-has-voice *)';
const OMNIBAR_SCOPE =
  'body:not(.mobile-shell):not(.cockpit-mode):not(.scene-playback-mode):not(.ui-clean-view):not(.recording-mode):where(.has-omnibar.dock-has-voice *)';
const OMNIBAR = Object.freeze({
  dock: `${OMNIBAR_DOCK_SCOPE} #command-dock`,
  credit: `${OMNIBAR_SCOPE} :is(#cesium-credits, #gev-credits)`,
  minimalCredit: `${OMNIBAR_SCOPE}:is(.hud-minimal-active *, #intel-hud[data-variant='minimal'].active) :is(#cesium-credits, #gev-credits)`,
  minimalRail: `${OMNIBAR_SCOPE}:not(.context-docked):is(.hud-minimal-active *, #intel-hud[data-variant='minimal'].active) #right-context-rail`,
});
// What each Omnibar-scope rule may set on a modelled box; the Omnibar
// clearance test resolves every one of them through the full cascade.
const OMNIBAR_RECOGNIZED = new Map([
  [OMNIBAR.dock, new Set(['top', 'bottom', 'height', 'min-height'])],
  [OMNIBAR.credit, new Set(['bottom'])],
  [OMNIBAR.minimalCredit, new Set(['bottom'])],
  [OMNIBAR.minimalRail, new Set(['max-height'])],
]);
const OMNIBAR_MIN_WIDTH = 721;
const ELEMENT_KEYS = [
  '#cesium-credits',
  '#command-dock',
  '#right-context-rail',
];

// Any of these on a modelled element's own box changes the geometry this pin
// reasons about, so each occurrence must be recognized and vetted.
const GUARDED_PROPS = new Set([
  'bottom',
  'top',
  'inset',
  'inset-block',
  'inset-block-end',
  'inset-inline',
  'inset-inline-end',
  'margin',
  'margin-bottom',
  'margin-block',
  'margin-block-end',
  'all',
  'height',
  'min-height',
  'max-height',
  'position',
  'transform',
  'translate',
  'scale',
  'zoom',
]);

// Custom properties allowed inside a modelled offset, each proven
// non-negative below. The world timeline's lift raises the dock and the
// credit together, so it moves no gap.
const VETTED_VARS = new Set(['--world-timeline-lift']);
// Custom properties CSS sets to a fixed length besides their 0 default. The
// clearance checks run at each length CSS gives them, not only at 0.
const FIXED_LENGTH_VARS = new Set(['--world-timeline-lift']);
const LIFTS_PX = [0, 66, 80];
let liftPx = 0;
function eachLift(check) {
  for (const lift of LIFTS_PX) {
    liftPx = lift;
    try {
      check(lift);
    } finally {
      liftPx = 0;
    }
  }
}

/** Rules whose final compound targets a modelled element (pseudo-elements aside). */
function ownBoxEntries() {
  const entries = [];
  for (const rule of RULES) {
    for (const part of rule.parts) {
      const compound = lastCompound(part);
      if (!ELEMENT_KEYS.some((key) => compound.includes(key))) continue;
      if (compound.includes('::')) continue; // a pseudo-element is its own box
      // The phone shell is its own layout; mobileShell.test.mjs pins its
      // attribution clearance.
      if (part.startsWith('body.mobile-shell')) continue;
      // So is Stories, with GEV's chrome stepped aside; storiesCredit.test.mjs
      // pins its attribution placement.
      if (
        /^body\.stories-mode:not\(#gs-a\):not\(#gs-b\) #(cesium|gev)-credits$/.test(
          part,
        )
      )
        continue;
      entries.push({ rule, part });
    }
  }
  return entries;
}

/** A media condition the model can resolve, or null. */
function parseMediaCondition(condition) {
  const match = /^\(max-width:\s*(\d+)px\)$/.exec(condition.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Whether a rule applies at `width`. Only ever asked of rules that already
 * match a modelled selector, so an unresolvable condition there is a genuine
 * hole in the model and fails rather than being skipped.
 */
function appliesAt(rule, width, label) {
  return rule.media.every((condition) => {
    const maxWidth = parseMediaCondition(condition);
    assert.ok(
      maxWidth !== null,
      `unmodelled media condition "${condition}" gates ${label}`,
    );
    return width <= maxWidth;
  });
}

/** Resolve `prop` by real cascade order: importance, then specificity, then source. */
function resolve(candidates, prop, width, label) {
  let winner = null;
  for (const rule of RULES) {
    if (!rule.parts.some((part) => candidates.includes(part))) continue;
    if (!appliesAt(rule, width, label)) continue;
    for (const part of rule.parts) {
      if (!candidates.includes(part)) continue;
      for (const decl of rule.decls) {
        if (decl.prop !== prop) continue;
        const contender = {
          decl,
          part,
          order: rule.order,
          spec: specificity(part),
        };
        if (!winner) {
          winner = contender;
          continue;
        }
        const byImportance =
          Number(contender.decl.important) - Number(winner.decl.important);
        const bySpecificity = compareSpecificity(contender.spec, winner.spec);
        if (
          byImportance > 0 ||
          (byImportance === 0 && bySpecificity > 0) ||
          (byImportance === 0 &&
            bySpecificity === 0 &&
            contender.order > winner.order)
        ) {
          winner = contender;
        }
      }
    }
  }
  assert.ok(winner, `no "${prop}" resolves for ${label} at ${width}px`);
  return winner;
}

/** Evaluate a length. Anything the model cannot resolve exactly fails loudly. */
function toPx(value, viewportHeight, where) {
  const trimmed = value.trim();
  // The larger of its lengths, each resolved the same way.
  if (/^max\(.*\)$/.test(trimmed))
    return Math.max(
      ...splitTopLevel(trimmed.slice(4, -1), ',').map((part) =>
        toPx(part, viewportHeight, where),
      ),
    );
  const inner = /^calc\(/.test(trimmed) ? trimmed.slice(5, -1) : trimmed;
  // A calc() is a whole term of its own, resolved below; nowhere else.
  for (const term of splitTopLevel(inner, '+'))
    assert.doesNotMatch(
      term.trim().replace(/^calc\(.*\)$/, ''),
      /\bcalc\(/,
      `nested calc() in ${where}: "${value}"`,
    );
  assert.doesNotMatch(
    inner,
    /\b(min|max|clamp|env|attr|round|mod)\(/,
    `unmodelled function in ${where}: "${value}"`,
  );
  assert.doesNotMatch(
    inner,
    /[*/]/,
    `unmodelled operator in ${where}: "${value}"`,
  );
  assert.doesNotMatch(
    inner,
    /\s-\s/,
    `unmodelled subtraction in ${where}: "${value}"`,
  );
  let total = 0;
  for (const raw of splitTopLevel(inner, '+')) {
    const term = raw.trim();
    if (!term) continue;
    // A calc() of its own, as a term ("calc(var(--omnibar-credits-clear) +
    // 2px)" once substituted).
    if (/^calc\(.*\)$/.test(term)) {
      total += toPx(term, viewportHeight, where);
      continue;
    }
    // The credit line's own height (src/ui/creditLineHeight.js), at the
    // height this pin models it at.
    if (/^var\(--credit-line-height\b/.test(term)) {
      total += CREDIT_HEIGHT_PX;
      continue;
    }
    if (term.startsWith('var(')) {
      const name = term.slice(4, term.lastIndexOf(')')).split(',')[0].trim();
      assert.ok(
        VETTED_VARS.has(name),
        `unvetted custom property ${name} in ${where}: "${value}"`,
      );
      if (name === '--world-timeline-lift') total += liftPx;
      continue; // proven non-negative; 0 is the conservative floor
    }
    assert.match(
      term,
      /^-?[\d.]+(px|rem|vh)$/,
      `unmodelled length term "${term}" in ${where}: "${value}"`,
    );
    const number = Number.parseFloat(term);
    if (term.endsWith('rem')) total += number * REM_PX;
    else if (term.endsWith('vh')) total += (number * viewportHeight) / 100;
    else total += number;
  }
  return total;
}

const WIDTHS = [
  1440, 1024, 980, 900, 830, 800, 760, 721, 720, 700, 640, 600, 480, 375,
];
const HEIGHTS = [500, 560, 640, 700, 800, 900, 1000, 1080, 1200, 1440, 1600];

const CREDIT_SELECTORS = [
  '#cesium-credits',
  'body:not(.ui-clean-view):not(.recording-mode) #cesium-credits',
];
const MINIMAL_HUD_CREDIT =
  "body:not(.ui-clean-view):not(.recording-mode):is(.hud-minimal-active *, #intel-hud[data-variant='minimal'].active) #cesium-credits";
function creditTopPx(width, height) {
  const bottom = resolve(CREDIT_SELECTORS, 'bottom', width, 'credit');
  return toPx(bottom.decl.value, height, 'credit bottom') + CREDIT_HEIGHT_PX;
}

// ── Fail-closed guards ──────────────────────────────────────────────────────

test('the specificity calculator itself is pinned', () => {
  const cases = [
    ['#cesium-credits', [1, 0, 0]],
    [
      'body:not(.ui-clean-view):not(.recording-mode) #cesium-credits',
      [1, 2, 1],
    ],
    ['#command-dock > #gev-voice-control', [2, 0, 0]],
    [
      "#command-dock #gev-voice-control[data-status='error']:not(.error-dismissed) .gev-voice-error-tray",
      [2, 3, 0],
    ],
    ['#gev-voice-control .gev-voice-help-tray::after', [1, 1, 1]],
  ];
  for (const [selector, expected] of cases) {
    assert.deepEqual(
      specificity(selector),
      expected,
      `specificity of "${selector}"`,
    );
  }
});

test('the model refuses every cascade construct it cannot resolve', () => {
  const complaints = [];
  for (const { rule, part } of ownBoxEntries()) {
    const guarded = rule.decls.filter((decl) => GUARDED_PROPS.has(decl.prop));
    if (!guarded.length) continue;
    // Expanded Context covers the right edge top to bottom; the credit row
    // stops short of it instead (the docked-Context test below).
    if (part === DOCKED_RAIL) continue;
    if (part.startsWith(OMNIBAR_SCOPE) || part.startsWith(OMNIBAR_DOCK_SCOPE)) {
      const allowed = OMNIBAR_RECOGNIZED.get(part);
      for (const decl of guarded) {
        if (!allowed?.has(decl.prop))
          complaints.push(
            `unrecognized Omnibar rule positions a modelled element: "${part}" (${decl.prop})`,
          );
        if (decl.important)
          complaints.push(`!important on ${decl.prop} of "${part}"`);
      }
      if (rule.media.length)
        complaints.push(
          `media query on Omnibar rule "${part}": ${rule.media.join(' && ')}`,
        );
      continue;
    }
    if (!RECOGNIZED.has(part)) {
      complaints.push(
        `unrecognized selector positions a modelled element: "${part}" (${guarded.map((d) => d.prop).join(', ')})`,
      );
      continue;
    }
    for (const condition of rule.media) {
      if (parseMediaCondition(condition) === null) {
        complaints.push(
          `unmodelled media condition "${condition}" on "${part}"`,
        );
      }
    }
    if (rule.media.length > 1) {
      complaints.push(
        `nested media queries on "${part}": ${rule.media.join(' && ')}`,
      );
    }
    for (const decl of guarded) {
      // Measurement is synchronous and restored before returning or painting.
      // Only these two exact declarations earn the exemption tested below.
      const railMeasurement =
        part === '#right-context-rail[data-rail-measuring]' &&
        ((decl.prop === 'height' && decl.value === 'auto') ||
          (decl.prop === 'max-height' && decl.value === 'none'));
      if (decl.important && !railMeasurement)
        complaints.push(`!important on ${decl.prop} of "${part}"`);
      if (
        decl.prop === 'inset' ||
        decl.prop === 'margin' ||
        decl.prop === 'all' ||
        decl.prop.startsWith('inset-') ||
        decl.prop.startsWith('margin-block')
      ) {
        complaints.push(
          `shorthand ${decl.prop} on "${part}" — the model reads longhands only`,
        );
      }
      if (decl.prop === 'height' || decl.prop === 'max-height') {
        // A capped height can override `bottom` and invalidate the measured
        // dock/credit constants. Exemptions are each earned by a test below:
        // the rail's own max-height (resolved to `none` across the whole
        // modelled band by the rail clearance test) and `.layout-focus`
        // (proven inapplicable at <=720px by the mobile-mode test), plus
        // synchronous measurement, which is removed before any paint.
        const railOwn =
          part === '#right-context-rail' && decl.prop === 'max-height';
        const railFocus = part === '#right-context-rail.layout-focus';
        if (!railOwn && !railFocus && !railMeasurement)
          complaints.push(`${decl.prop}: ${decl.value} on "${part}"`);
      }
      if (
        decl.prop === 'transform' &&
        /translateY|translate3d|matrix|scale\(/.test(decl.value)
      ) {
        const identity = decl.value === 'translateY(0) scale(1)';
        if (!identity)
          complaints.push(`vertical transform on "${part}": ${decl.value}`);
      }
      if (
        decl.prop === 'translate' ||
        decl.prop === 'scale' ||
        decl.prop === 'zoom'
      ) {
        complaints.push(
          `${decl.prop} on "${part}" moves the box outside the model`,
        );
      }
    }
  }
  assert.deepEqual(
    complaints,
    [],
    `the attribution model cannot resolve:\n  ${complaints.join('\n  ')}\n`,
  );
});

test('custom properties inside modelled offsets are provably non-negative', () => {
  // The model evaluates them at 0, which is only a conservative floor if they
  // can never go negative. CSS is their only writer.
  const declared = RULES.flatMap((rule) =>
    rule.decls.filter((decl) => VETTED_VARS.has(decl.prop)),
  );
  assert.ok(
    declared.length >= VETTED_VARS.size,
    'every vetted custom property needs a CSS default',
  );
  for (const decl of declared) {
    assert.doesNotMatch(
      decl.value,
      /-\s*\d/,
      `${decl.prop} has a negative CSS default: ${decl.value}`,
    );
    const shape = FIXED_LENGTH_VARS.has(decl.prop)
      ? /^(0|\d+px)$/
      : /^(0|0px)$/;
    assert.match(
      decl.value,
      shape,
      `${decl.prop} default is not a vetted shape: ${decl.value}`,
    );
  }
});

test('the inputs behind the measured constants are unchanged', () => {
  // 28px credit / 62px dock are measured, not derived. Guard the CSS that
  // determines them so a change forces a re-measure instead of a silent drift.
  const creditBase = RULES.find(
    (rule) => rule.parts.length === 1 && rule.parts[0] === '#cesium-credits',
  );
  assert.ok(creditBase, '#cesium-credits base rule is missing');
  const declOf = (rule, prop) =>
    rule.decls.find((decl) => decl.prop === prop)?.value;
  assert.equal(
    declOf(creditBase, 'font-size'),
    '10px',
    'credit font-size drives its measured 28px height',
  );
  assert.equal(
    declOf(creditBase, 'white-space'),
    'nowrap',
    'a wrapping credit is taller than the measured 28px',
  );
  for (const prop of [
    'height',
    'min-height',
    'max-height',
    'line-height',
    'padding',
  ]) {
    assert.equal(
      declOf(creditBase, prop),
      undefined,
      `#cesium-credits gained ${prop}; re-measure CREDIT_HEIGHT_PX`,
    );
  }
  // Only `min-height` may floor the dock — that direction only ADDS clearance.
  for (const { rule, part } of ownBoxEntries()) {
    if (part !== '#command-dock') continue;
    for (const decl of rule.decls) {
      assert.notEqual(
        decl.prop,
        'height',
        'a fixed dock height invalidates COMPACT_DOCK_HEIGHT_PX',
      );
      assert.notEqual(
        decl.prop,
        'max-height',
        'a capped dock height invalidates COMPACT_DOCK_HEIGHT_PX',
      );
    }
  }
});

test('the full-width rail cannot inherit a height that overrides its floor', () => {
  // `#right-context-rail.layout-focus { height: … }` is a base rule with more
  // specificity than the <=720px floor, and height + top + bottom is
  // over-constrained. It is safe only because the rail's layout pass switches
  // to a mobile mode at the SAME breakpoint and removes both the class and the
  // custom property. Pin that, or the exemption above is unearned.
  const rail = fs.readFileSync(
    path.join(ROOT, 'src', 'ui', 'rightPanelRail.js'),
    'utf8',
  );
  const gate = rail.indexOf("windowRef.matchMedia('(max-width: 720px)')");
  assert.ok(
    gate > 0,
    'the rail layout pass no longer keys off (max-width: 720px)',
  );
  const mobileBranch = rail.slice(
    gate,
    rail.indexOf("layoutMode = 'mobile'", gate) + 40,
  );
  assert.match(mobileBranch, /stack\.classList\.remove\('layout-focus'\)/);
  assert.match(
    mobileBranch,
    /stack\.style\.removeProperty\('--right-stack-max-height'\)/,
  );
});

test('right rail measurement cannot persist into a painted attribution layout', () => {
  const rail = fs.readFileSync(
    path.join(ROOT, 'src', 'ui', 'rightPanelRail.js'),
    'utf8',
  );
  const start = rail.indexOf("stack.setAttribute('data-rail-measuring', '')");
  const end = rail.indexOf(
    "stack.removeAttribute('data-rail-measuring')",
    start,
  );
  assert.ok(start > rail.indexOf("layoutMode = 'mobile'"));
  assert.ok(end > start);
  const measurement = rail.slice(start, end);
  assert.match(measurement, /try \{[\s\S]*\} finally \{/);
  assert.doesNotMatch(
    measurement,
    /\b(?:await|return|yield)\b|requestAnimationFrame|setTimeout/,
  );
});

// ── Clearance ───────────────────────────────────────────────────────────────

/** A custom property's value as the Omnibar scopes declare it. */
function omnibarVar(name) {
  const decls = RULES.filter(
    (rule) =>
      rule.parts.includes(OMNIBAR_SCOPE) ||
      rule.parts.includes(OMNIBAR_DOCK_SCOPE),
  )
    .flatMap((rule) => rule.decls)
    .filter((decl) => decl.prop === name);
  assert.equal(
    decls.length,
    1,
    `${name} is declared once in the Omnibar scope`,
  );
  return decls[0].value;
}

/** A length in the Omnibar layout, with its scope's own custom properties. */
function omnibarPx(value, viewportHeight, where) {
  // The scope's properties may name each other ("--omnibar-dock-bottom"
  // clears "--omnibar-credits-clear"): substitute until none is left.
  let substituted = value;
  for (let pass = 0; /var\(--omnibar-/.test(substituted); pass += 1) {
    assert.ok(
      pass < 8,
      `Omnibar properties name each other in a loop: ${value}`,
    );
    substituted = substituted.replace(/var\((--omnibar-[\w-]+)\)/g, (_, name) =>
      omnibarVar(name),
    );
  }
  return toPx(substituted, viewportHeight, where);
}

test('Omnibar reserves a non-overlapping desktop footer at native credit sizing', () => {
  // The Omnibar layout resolves through the same cascade as the legacy one:
  // every legacy rule that could still match competes with the scope's.
  // The dock rises over the World Timeline by world-timeline.css's lift, as
  // the plain dock does; the Omnibar scope leaves the lift alone.
  assert.doesNotMatch(
    fs.readFileSync(path.join(ROOT, 'src/ui/styles/omnibar-dock.css'), 'utf8'),
    /--world-timeline-lift\s*:/,
    'the Omnibar layout leaves the timeline lift to world-timeline.css',
  );
  for (const width of WIDTHS.filter((w) => w >= OMNIBAR_MIN_WIDTH)) {
    for (const height of HEIGHTS) {
      for (const minimal of [false, true]) {
        const dock = resolve(
          ['#command-dock', OMNIBAR.dock],
          'bottom',
          width,
          'Omnibar dock',
        );
        assert.equal(
          dock.part,
          OMNIBAR.dock,
          `the Omnibar owns the dock at ${width}px`,
        );
        // Its top and height too: a legacy top or height winning here would
        // move or stretch the dock the clearance below is measured from.
        for (const [prop, value] of [
          ['top', 'auto'],
          ['height', '56px'],
        ]) {
          const own = resolve(
            ['#command-dock', OMNIBAR.dock],
            prop,
            width,
            `Omnibar dock ${prop}`,
          );
          assert.equal(
            own.part,
            OMNIBAR.dock,
            `the Omnibar owns the dock ${prop} at ${width}px`,
          );
          assert.equal(
            own.decl.value,
            value,
            `Omnibar dock ${prop} at ${width}px`,
          );
        }
        const credit = resolve(
          [
            ...CREDIT_SELECTORS,
            OMNIBAR.credit,
            ...(minimal ? [MINIMAL_HUD_CREDIT, OMNIBAR.minimalCredit] : []),
          ],
          'bottom',
          width,
          'Omnibar credit',
        );
        assert.ok(
          credit.part.startsWith(OMNIBAR_SCOPE),
          `the Omnibar owns the credit row at ${width}px`,
        );
        // The dock rises over the World Timeline from the dock's floor, and
        // the bar takes that floor: the floor is what clears the credit.
        assert.equal(
          dock.decl.value,
          'var(--omnibar-dock-raised)',
          `Omnibar dock bottom at ${width}px`,
        );
        assert.equal(
          omnibarVar('--omnibar-dock-raised').replace(/\s+/g, ' '),
          'calc( var(--omnibar-dock-bottom) + var(--world-timeline-lift, 0px) )',
        );
        const dockBottom = omnibarPx(
          'var(--omnibar-dock-bottom)',
          height,
          'Omnibar dock floor',
        );
        const creditTop =
          omnibarPx(credit.decl.value, height, 'Omnibar credit bottom') +
          CREDIT_HEIGHT_PX;
        assert.ok(
          dockBottom - creditTop >= MIN_CLEARANCE_PX,
          `at ${width}x${height}${minimal ? ' (minimal HUD)' : ''} the Omnibar dock (${dockBottom}px) must clear the credit line (${creditTop}px)`,
        );
      }
    }
  }
  // The minimal-HUD rail cap only shortens the rail, which is anchored at
  // its top, so it can only add room above the credit.
  const rail = RULES.find((rule) => rule.parts.includes(OMNIBAR.minimalRail));
  const cap = rail.decls.find(
    (decl) => decl.prop === '--omnibar-minimal-rail-height',
  );
  assert.match(
    cap?.value || '',
    /^min\(\s*var\(--right-stack-max-height, 70vh\),/,
  );
  assert.equal(
    rail.decls.find((decl) => decl.prop === 'max-height')?.value,
    'var(--omnibar-minimal-rail-height)',
  );
  assert.doesNotMatch(
    omnibarCss,
    /\.cesium-widget-credits|\.cesium-credit-logoContainer|\.cesium-credit-textContainer/,
    'the footer uses the original credit text and logo sizing',
  );
});

test('the full-width context rail clears the required credit at every modelled viewport', () => {
  const anchors = [];
  for (const rule of RULES) {
    if (!rule.parts.includes('#right-context-rail')) continue;
    for (const decl of rule.decls) {
      if (decl.prop === 'bottom') anchors.push({ rule, decl });
    }
  }
  assert.equal(
    anchors.length,
    1,
    'the rail has exactly one bottom anchor to reason about',
  );
  assert.equal(
    parseMediaCondition(anchors[0].rule.media[0]),
    720,
    'the rail only goes full-width below 720px',
  );

  const failures = [];
  for (const width of WIDTHS.filter((w) => w <= 720)) {
    // `bottom` only governs the floor while the box is not height-capped:
    // top + bottom + a resolved height is over-constrained and drops `bottom`.
    assert.equal(
      resolve(['#right-context-rail'], 'max-height', width, 'context rail').decl
        .value,
      'none',
      `at ${width}px the rail is height-capped, so its bottom anchor no longer decides its floor`,
    );
    eachLift((lift) => {
      for (const height of HEIGHTS) {
        const rail = resolve(
          ['#right-context-rail'],
          'bottom',
          width,
          'context rail',
        );
        const clearance =
          toPx(rail.decl.value, height, 'rail bottom') -
          creditTopPx(width, height);
        if (clearance < MIN_CLEARANCE_PX)
          failures.push(
            `${width}x${height} lift ${lift}: ${clearance.toFixed(1)}px`,
          );
      }
    });
  }
  assert.deepEqual(
    failures,
    [],
    `context rail re-enters the credit band at ${failures.join(', ')}`,
  );
});

test('expanded Context and the credit row never overlap', () => {
  const docked = RULES.filter((rule) => rule.parts.includes(DOCKED_RAIL));
  assert.equal(
    docked.length,
    1,
    'expanded Context has exactly one rule for its column',
  );
  assert.deepEqual(
    docked[0].media,
    [],
    'the expanded column applies at every width',
  );
  const decl = (prop) => docked[0].decls.find((d) => d.prop === prop)?.value;
  assert.equal(decl('right'), '0');
  assert.equal(decl('width'), 'var(--context-dock-width)');
  // The credit row starts under 3rem from the left and may run to its
  // max-width: with 3rem and the column's width taken off, it ends short of
  // the column.
  for (const base of [CREDIT_SELECTORS[1], MINIMAL_HUD_CREDIT]) {
    const selector = base.replace('body:not(', 'body.context-docked:not(');
    assert.ok(compareSpecificity(specificity(selector), specificity(base)) > 0);
    for (const width of WIDTHS) {
      const left = resolve([base], 'left', width, 'credit').decl.value;
      const rem = /^(\d*\.?\d+)rem$/.exec(left);
      assert.ok(
        rem && Number(rem[1]) < 3,
        `at ${width}px the credit starts at ${left}`,
      );
      assert.equal(
        resolve([base, selector], 'max-width', width, 'docked credit').decl
          .value,
        'calc(100vw - 3rem - var(--context-dock-width))',
        `at ${width}px the credit row can run under expanded Context`,
      );
    }
  }
});

test('the dock anchor changes at 720px — the 2vh cancellation is band-limited', () => {
  const lift = 'var(--world-timeline-lift, 0px)';
  assert.equal(
    resolve(['#command-dock'], 'bottom', 800, 'dock').decl.value,
    `calc(2vh + ${lift})`,
  );
  assert.equal(
    resolve(['#command-dock'], 'bottom', 720, 'dock').decl.value,
    `calc(8px + ${lift})`,
  );
  assert.equal(
    resolve(CREDIT_SELECTORS, 'bottom', 720, 'credit').decl.value,
    `calc(2vh + 5rem + ${lift})`,
    'the credit keeps its 2vh base below 720px — that asymmetry is the whole hazard',
  );
});

test('the minimal-HUD credit variant tracks the ordinary one', () => {
  // It is MORE specific, so if the two ever diverge the model reads the wrong
  // anchor while the browser paints the other.
  assert.ok(
    compareSpecificity(
      specificity(MINIMAL_HUD_CREDIT),
      specificity(CREDIT_SELECTORS[1]),
    ) > 0,
  );
  for (const width of WIDTHS) {
    assert.equal(
      resolve([MINIMAL_HUD_CREDIT], 'bottom', width, 'minimal-HUD credit').decl
        .value,
      resolve(CREDIT_SELECTORS, 'bottom', width, 'credit').decl.value,
      `the minimal-HUD credit anchor diverges at ${width}px`,
    );
  }
});

test('the credit line is never suppressed to make room', () => {
  const creditBlocks = [
    ...css.matchAll(/#cesium-credits[^{]*\{([^}]*)\}/g),
  ].map((m) => m[1]);
  assert.ok(creditBlocks.length > 0);
  for (const block of creditBlocks) {
    assert.doesNotMatch(
      block,
      /display\s*:\s*none/,
      'the credit must never be display:none',
    );
    assert.doesNotMatch(
      block,
      /visibility\s*:\s*hidden/,
      'the credit must never be hidden',
    );
    assert.doesNotMatch(
      block,
      /opacity\s*:\s*0(\D|$)/,
      'the credit must never be faded out',
    );
  }
  assert.match(
    css,
    /body\.ui-clean-view #cesium-credits,\s*\n\s*body\.recording-mode #cesium-credits \{[^}]*bottom: 36px;/,
  );
});

test('OSM-derived layers never force the desktop credit row into a stack', () => {
  assert.doesNotMatch(css, /body:has\([^)]*alpr-cameras[^}]*#cesium-credits/);
  assert.doesNotMatch(
    css,
    /#cesium-credits\s+\.cesium-credit-expand-link\s*\{[^}]*display:\s*block/,
  );
});

test('expanded Context keeps the credits beside it right to left and with the minimal HUD', () => {
  const css = fs
    .readFileSync(
      path.join(ROOT, 'src', 'ui', 'styles', 'context-dock.css'),
      'utf8',
    )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
  const rule = (selectorPart, decl) =>
    new RegExp(
      `${selectorPart}[^{}]*:is\\(#cesium-credits, #gev-credits\\) \\{[^}]*${decl}`,
    ).test(css);
  // Right to left the column docks to the left edge, where the credits start.
  assert.ok(
    rule(
      "html\\[dir='rtl'\\] body\\.context-docked",
      'left: calc\\(36px \\+ var\\(--context-dock-width\\)\\)',
    ),
    'right to left, the credits start past the expanded column',
  );
  // The minimal HUD puts the credits bottom right, where the column docks.
  assert.ok(
    rule(
      "^.*body\\.context-docked:not\\(\\.ui-clean-view\\):not\\(\\.recording-mode\\):is\\( \\.hud-minimal-active \\*, #intel-hud\\[data-variant='minimal'\\]\\.active \\)",
      'right: calc\\(36px \\+ var\\(--context-dock-width\\)\\)',
    ),
    'with the minimal HUD, the credits end before the expanded column',
  );
});
