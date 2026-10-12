import { readShellSource } from './testSupport/readShellSource.mjs';
import { readStylesheet } from './testSupport/readStylesheet.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readStylesheet(path.join(ROOT, 'style.css'));
const ui = readShellSource();

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
// Mobile flex attribution and touch dock, measured in the deployed Edge sweep.
const MOBILE_CREDIT_HEIGHT_PX = 34;
const MOBILE_DOCK_HEIGHT_PX = 70;

// Clear air the notice must keep above it. The stylesheet aims for 12px.
const MIN_CLEARANCE_PX = 8;

test('mobile media and length parsing validates new syntax and still rejects unknown constructs', () => {
  const media =
    '(max-width: 720px), (pointer: coarse) and (max-width: 900px), (pointer: coarse) and (max-height: 600px)';
  assert.equal(
    appliesAt({ media: [media] }, 932, 'touch landscape', {
      height: 430,
      coarse: true,
    }),
    true,
  );
  assert.equal(
    appliesAt({ media: [media] }, 932, 'desktop', {
      height: 430,
      coarse: false,
    }),
    false,
  );
  assert.equal(parseMediaCondition('(hover: hover)'), null);
  assert.equal(
    toPx(
      'calc(max(84px, calc(4.4rem + 14px)) + env(safe-area-inset-bottom))',
      915,
      'credit',
    ),
    84.4,
  );
  assert.equal(toPx('48dvh', 600, 'rail'), 288);
  assert.throws(() => toPx('env(unknown-inset)', 600, 'fixture'));
  assert.throws(() => toPx('clamp(1px, 2px, 3px)', 600, 'fixture'));
});

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

/** Flatten style.css into rules carrying their raw media stack. */
function flattenRules(source) {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const mediaStack = [];
  let index = 0;
  let prelude = '';
  while (index < src.length) {
    const char = src[index];
    if (char === '{') {
      const head = prelude.replace(/\s+/g, ' ').trim();
      prelude = '';
      if (head.startsWith('@media')) {
        mediaStack.push(head.slice('@media'.length).trim());
        index += 1;
        continue;
      }
      if (head.startsWith('@')) {
        let level = 1;
        index += 1;
        while (index < src.length && level > 0) {
          if (src[index] === '{') level += 1;
          else if (src[index] === '}') level -= 1;
          index += 1;
        }
        continue;
      }
      const close = src.indexOf('}', index);
      assert.ok(close > index, `unterminated rule block for "${head}"`);
      const decls = [];
      for (const raw of src.slice(index + 1, close).split(';')) {
        const text = raw.trim();
        if (!text) continue;
        const colon = text.indexOf(':');
        if (colon < 0) continue;
        const value = text
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, ' ');
        decls.push({
          prop: text.slice(0, colon).trim().toLowerCase(),
          value: value.replace(/\s*!important$/i, '').trim(),
          important: /!important\s*$/i.test(value),
        });
      }
      rules.push({
        order: rules.length,
        media: [...mediaStack],
        parts: splitTopLevel(head, ',')
          .map((part) =>
            part.trim().replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'),
          )
          .filter(Boolean),
        decls,
      });
      index = close + 1;
      continue;
    }
    if (char === '}') {
      mediaStack.pop();
      prelude = '';
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  return rules;
}

const RULES = flattenRules(css);

// The touch drawer uses native modal flow rather than the legacy dock model.
// Pin its exact guarded geometry; fresh browser QA also measures/hit-tests the
// rendered credit children in closed-map, modal, and camera states. New values,
// selectors, properties or media conditions still fail closed here.
const MOBILE_CREDIT =
  'body.mobile-map-first:not(.ui-clean-view):not(.recording-mode) #cesium-credits';
const MOBILE_MINIMAL_CREDIT =
  "body.mobile-map-first:not(.ui-clean-view):not(.recording-mode):has(#intel-hud[data-variant='minimal'].active) #cesium-credits";
const MOBILE_RAIL =
  'body.mobile-map-first.mobile-camera-open:not(.mobile-menu-open) #right-context-rail';
const MOBILE_FLOW =
  'body.mobile-map-first #mobile-map-menu :is(.dock-popover-content, #top-center-actions, #scene-panel, #pp-toggles, #gev-voice-control, [data-panel-id])';
const MOBILE_OWN_GEOMETRY = new Map([
  // The desktop camera portal also places attribution in a normal-flow footer.
  // Pin the exact reset; the browser QA verifies its actual viewport clearance.
  [
    '.desktop-camera-expanded #cesium-credits|',
    [
      ['position', 'static', true],
      ['inset', 'auto', true],
      ['margin', '0', true],
      ['min-height', '24px', false],
    ],
  ],
  [
    'body.mobile-map-first .mobile-camera-expanded-credits #cesium-credits|',
    [
      ['position', 'static', true],
      ['inset', 'auto', true],
      ['margin', '0', true],
    ],
  ],
  [
    MOBILE_CREDIT + '|',
    [['bottom', 'max(12px, env(safe-area-inset-bottom))', false]],
  ],
  [
    MOBILE_MINIMAL_CREDIT + '|',
    [['bottom', 'max(12px, env(safe-area-inset-bottom))', false]],
  ],
  [
    MOBILE_RAIL + '|',
    [
      ['position', 'fixed', false],
      ['top', 'auto', false],
      ['bottom', 'calc(60px + env(safe-area-inset-bottom))', false],
      ['height', 'auto', false],
      ['max-height', 'min(40dvh, 300px)', false],
    ],
  ],
  [
    MOBILE_RAIL + '|(orientation: landscape)',
    [['max-height', 'calc(100dvh - 128px)', true]],
  ],
  [
    MOBILE_FLOW + '|',
    [
      ['position', 'static', true],
      ['inset', 'auto', true],
      ['transform', 'none', true],
      ['height', 'auto', true],
      ['max-height', 'none', true],
      ['margin', '0', true],
    ],
  ],
  [
    'body.mobile-map-first.mobile-menu-open #mobile-map-menu #cesium-credits|',
    [
      ['position', 'static', true],
      ['margin', '0', true],
    ],
  ],
]);

// ── What the model understands ──────────────────────────────────────────────

// Selectors that position a modelled element's OWN box. Anything else that
// positions one of these elements is an unmodelled construct and fails.
const RECOGNIZED = new Set([
  // credit
  '#cesium-credits',
  'body:not(.ui-clean-view):not(.recording-mode) #cesium-credits',
  "body:not(.ui-clean-view):not(.recording-mode):has(#intel-hud[data-variant='minimal'].active) #cesium-credits",
  'body.ui-clean-view #cesium-credits',
  'body.recording-mode #cesium-credits',
  // dock
  '#command-dock',
  '#command-dock:has(#location-bar:not(.collapsed))',
  '#command-dock:has(#control-panel:not(.collapsed))',
  // rail
  '#right-context-rail',
  '#right-context-rail.layout-focus',
  '#right-context-rail[data-rail-measuring]',
  // tray
  '#command-dock .dock-popover-content',
  '#command-dock #location-bar .dock-popover-content',
  '#command-dock #control-panel .dock-popover-content',
  '#command-dock #location-bar:not(.collapsed) .dock-popover-content',
  '#command-dock #control-panel:not(.collapsed) .dock-popover-content',
  '#command-dock.dock-has-pinned-tray #location-bar:not(.collapsed):not(.dock-pinned) .dock-popover-content',
  '#command-dock.dock-has-pinned-tray #control-panel:not(.collapsed):not(.dock-pinned) .dock-popover-content',
  '#command-dock.dock-has-two-pinned-trays .dock-pinned-top.dock-pinned:not(.collapsed) .dock-popover-content',
  '#command-dock.dock-has-two-pinned-trays #location-bar.dock-pinned-top.dock-pinned:not(.collapsed) .dock-popover-content',
  '#command-dock.dock-has-two-pinned-trays #control-panel.dock-pinned-top.dock-pinned:not(.collapsed) .dock-popover-content',
]);

const ELEMENT_KEYS = [
  '#cesium-credits',
  '#command-dock',
  '#right-context-rail',
  '.dock-popover-content',
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

// Custom properties allowed inside a modelled offset. Each is a pinned-tray
// stack height, proven non-negative below, so evaluating them at 0 is a
// conservative floor rather than a guess.
const VETTED_VARS = new Set([
  '--dock-pinned-stack-height',
  '--dock-lower-pinned-height',
  '--dock-location-pinned-height',
  '--dock-presets-pinned-height',
]);

/** Rules whose final compound targets a modelled element (pseudo-elements aside). */
function ownBoxEntries() {
  const entries = [];
  for (const rule of RULES) {
    for (const part of rule.parts) {
      const compound = lastCompound(part);
      if (!ELEMENT_KEYS.some((key) => compound.includes(key))) continue;
      if (compound.includes('::')) continue; // a pseudo-element is its own box
      entries.push({ rule, part });
    }
  }
  return entries;
}

/** A media condition the model can resolve, or null. */
function parseMediaCondition(condition) {
  const match = /^\(max-width:\s*(\d+)px\)$/.exec(condition.trim());
  if (match) return Number(match[1]);
  const branches = splitTopLevel(condition, ',').map((branch) =>
    branch.trim().split(/\s+and\s+/),
  );
  const supported =
    /^\((?:(?:max-width|max-height):\s*\d+px|pointer:\s*coarse|orientation:\s*landscape)\)$/;
  return branches.every((branch) =>
    branch.every((term) => supported.test(term)),
  )
    ? branches
    : null;
}

/**
 * Whether a rule applies at `width`. Only ever asked of rules that already
 * match a modelled selector, so an unresolvable condition there is a genuine
 * hole in the model and fails rather than being skipped.
 */
function appliesAt(rule, width, label, { height = 900, coarse = false } = {}) {
  return rule.media.every((condition) => {
    const parsed = parseMediaCondition(condition);
    assert.ok(
      parsed !== null,
      `unmodelled media condition "${condition}" gates ${label}`,
    );
    if (typeof parsed === 'number') return width <= parsed;
    return parsed.some((branch) =>
      branch.every((term) => {
        const size = /^\((max-width|max-height):\s*(\d+)px\)$/.exec(term);
        if (size)
          return (size[1] === 'max-width' ? width : height) <= Number(size[2]);
        if (/pointer:/.test(term)) return coarse;
        return width > height;
      }),
    );
  });
}

/** Resolve `prop` by real cascade order: importance, then specificity, then source. */
function resolve(candidates, prop, width, label, options = {}) {
  let winner = null;
  for (const rule of RULES) {
    if (!rule.parts.some((part) => candidates.includes(part))) continue;
    if (!appliesAt(rule, width, label, options)) continue;
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
  const sum = splitTopLevel(trimmed, '+');
  if (sum.length > 1)
    return sum.reduce(
      (total, term) => total + toPx(term, viewportHeight, where),
      0,
    );
  const functionMatch = /^(calc|min|max)\(([\s\S]*)\)$/.exec(trimmed);
  if (functionMatch) {
    if (functionMatch[1] === 'calc')
      return toPx(functionMatch[2], viewportHeight, where);
    const numbers = splitTopLevel(functionMatch[2], ',').map((term) =>
      toPx(term, viewportHeight, where),
    );
    return Math[functionMatch[1]](...numbers);
  }
  // Safe-area bottom is common to the notice, rail and dock anchors, so zero
  // is the same clearance as a nonzero inset. Unknown environment values fail.
  if (trimmed === 'env(safe-area-inset-bottom)') return 0;
  assert.doesNotMatch(
    trimmed,
    /^env\(/,
    `unmodelled environment value in ${where}: "${value}"`,
  );
  const inner = trimmed;
  assert.doesNotMatch(
    inner,
    /\b(clamp|attr|round|mod)\(/,
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
    if (term === '100%') continue; // the tray's own panel height, added separately
    if (term.startsWith('var(')) {
      const name = term.slice(4, term.lastIndexOf(')')).split(',')[0].trim();
      assert.ok(
        VETTED_VARS.has(name),
        `unvetted custom property ${name} in ${where}: "${value}"`,
      );
      continue; // proven non-negative; 0 is the conservative floor
    }
    assert.match(
      term,
      /^-?[\d.]+(px|rem|d?vh)$/,
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
  "body:not(.ui-clean-view):not(.recording-mode):has(#intel-hud[data-variant='minimal'].active) #cesium-credits";
const TRAY_ORDINARY = [
  '#command-dock .dock-popover-content',
  '#command-dock #location-bar .dock-popover-content',
];
const TRAY_SCENARIOS = [
  { name: 'ordinary tray', offset: TRAY_ORDINARY },
  {
    name: 'one pinned tray',
    offset: [
      ...TRAY_ORDINARY,
      '#command-dock.dock-has-pinned-tray #location-bar:not(.collapsed):not(.dock-pinned) .dock-popover-content',
    ],
    stackVar: '--dock-pinned-stack-height',
  },
  {
    name: 'two pinned trays (upper)',
    offset: [
      ...TRAY_ORDINARY,
      // The stock form still governs above 900px; the ID form is what keeps it
      // ahead of the ordinary narrow rule below it.
      '#command-dock.dock-has-two-pinned-trays .dock-pinned-top.dock-pinned:not(.collapsed) .dock-popover-content',
      '#command-dock.dock-has-two-pinned-trays #location-bar.dock-pinned-top.dock-pinned:not(.collapsed) .dock-popover-content',
    ],
    stackVar: '--dock-lower-pinned-height',
  },
];

function creditTopPx(width, height) {
  const bottom = resolve(CREDIT_SELECTORS, 'bottom', width, 'credit');
  return (
    toPx(bottom.decl.value, height, 'credit bottom') +
    (width <= 720 ? MOBILE_CREDIT_HEIGHT_PX : CREDIT_HEIGHT_PX)
  );
}

function trayBottomPx(scenario, width, height) {
  const dock = resolve(['#command-dock'], 'bottom', width, 'command dock');
  const offset = resolve(scenario.offset, 'bottom', width, scenario.name);
  const margin = resolve(
    ['#command-dock #location-bar:not(.collapsed) .dock-popover-content'],
    'margin-bottom',
    width,
    'open tray margin',
  );
  return (
    toPx(dock.decl.value, height, 'dock bottom') +
    (width <= 720 ? MOBILE_DOCK_HEIGHT_PX : COMPACT_DOCK_HEIGHT_PX) +
    toPx(offset.decl.value, height, `${scenario.name} offset`) +
    toPx(margin.decl.value, height, 'tray margin')
  );
}

// ── Fail-closed guards ──────────────────────────────────────────────────────

test('the specificity calculator itself is pinned', () => {
  const cases = [
    ['#cesium-credits', [1, 0, 0]],
    [
      'body:not(.ui-clean-view):not(.recording-mode) #cesium-credits',
      [1, 2, 1],
    ],
    ['#command-dock #location-bar .dock-popover-content', [2, 1, 0]],
    [
      '#command-dock.dock-has-pinned-tray #location-bar:not(.collapsed):not(.dock-pinned) .dock-popover-content',
      [2, 4, 0],
    ],
    [
      '#command-dock.dock-has-two-pinned-trays #location-bar.dock-pinned-top.dock-pinned:not(.collapsed) .dock-popover-content',
      [2, 5, 0],
    ],
    [
      '#command-dock.dock-has-two-pinned-trays .dock-pinned-top.dock-pinned:not(.collapsed) .dock-popover-content',
      [1, 5, 0],
    ],
    ['#command-dock .dock-popover-content::after', [1, 1, 1]],
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
    const mobileGeometry = MOBILE_OWN_GEOMETRY.get(
      part + '|' + rule.media.join(' && '),
    );
    if (mobileGeometry) {
      const actual = guarded.map(({ prop, value, important }) => [
        prop,
        value,
        important,
      ]);
      if (JSON.stringify(actual) !== JSON.stringify(mobileGeometry))
        complaints.push(`unvetted map-first geometry on "${part}"`);
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
        const mobileRule = rule.media.some(
          (condition) => typeof parseMediaCondition(condition) !== 'number',
        );
        const mobileAuto =
          mobileRule &&
          part === '#right-context-rail' &&
          decl.prop === 'height' &&
          decl.value === 'auto';
        const mobileTray =
          mobileRule &&
          decl.prop === 'max-height' &&
          ((part === '#command-dock .dock-popover-content' &&
            decl.value === '50dvh') ||
            (part.includes('.dock-popover-content') &&
              /^min\(50dvh, max\(64px, calc\(100dvh - max\(132px, calc\(4\.4rem \+ 62px\)\) - var\(--dock-(?:pinned-stack|lower-pinned)-height\) - 12px\)\)\)$/.test(
                decl.value.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'),
              )));
        const railOwn =
          part === '#right-context-rail' && decl.prop === 'max-height';
        const railFocus = part === '#right-context-rail.layout-focus';
        if (
          !railOwn &&
          !railFocus &&
          !railMeasurement &&
          !mobileAuto &&
          !mobileTray
        )
          complaints.push(`${decl.prop}: ${decl.value} on "${part}"`);
      }
      if (
        decl.prop === 'transform' &&
        /translateY|translate3d|matrix|scale\(/.test(decl.value)
      ) {
        const identity = decl.value === 'translateY(0) scale(1)';
        const closedTray =
          part === '#command-dock .dock-popover-content' &&
          decl.value === 'translateY(0.55rem) scale(0.985)';
        if (!identity && !closedTray)
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

test('map-first camera floor clears ordinary and minimal attribution on touch viewports', () => {
  for (const [width, height] of [
    [360, 600],
    [412, 915],
    [844, 320],
    [932, 430],
  ]) {
    const options = { coarse: true, height };
    const rail = resolve(
      [MOBILE_RAIL],
      'bottom',
      width,
      'map-first camera',
      options,
    );
    for (const creditSelector of [MOBILE_CREDIT, MOBILE_MINIMAL_CREDIT]) {
      const credit = resolve(
        [creditSelector],
        'bottom',
        width,
        'map-first credit',
        options,
      );
      const clearance =
        toPx(rail.decl.value, height, 'camera floor') -
        toPx(credit.decl.value, height, 'credit floor') -
        MOBILE_CREDIT_HEIGHT_PX;
      assert.ok(
        clearance >= MIN_CLEARANCE_PX,
        `map-first credit gap ${clearance}px at ${width}x${height}`,
      );
    }
  }
});

test('custom properties inside modelled offsets are provably non-negative', () => {
  // The model evaluates them at 0, which is only a conservative floor if they
  // can never go negative. Both writers are checked: CSS and the JS.
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
    assert.match(
      decl.value,
      /^(0|0px)$/,
      `${decl.prop} default is not a vetted shape: ${decl.value}`,
    );
  }
  const layout = fs.readFileSync(
    new URL('./ui/panelLayoutController.js', import.meta.url),
    'utf8',
  );
  const start = layout.indexOf('_updateCommandDockTrayStack() {');
  assert.ok(start > 0, '_updateCommandDockTrayStack is missing');
  const writer = layout.slice(
    start,
    layout.indexOf('  _scheduleAdaptivePanelLayout(', start),
  );
  // Every value traces back to a rect height, floored at 0 and rounded up.
  assert.match(
    writer,
    /const locationHeight =\s*[\s\S]{0,180}?getBoundingClientRect\(\)\.height\s*\|\| 0;/,
  );
  assert.match(
    writer,
    /const presetsHeight =\s*[\s\S]{0,180}?getBoundingClientRect\(\)\.height\s*\|\| 0;/,
  );
  assert.match(
    writer,
    /const lowerPinnedHeight =\s*[\s\S]{0,220}?getBoundingClientRect\(\)\.height\s*\|\| 0;/,
  );
  assert.match(
    writer,
    /const locationHeightPx = Math\.ceil\(locationHeight\);/,
  );
  assert.match(writer, /const presetsHeightPx = Math\.ceil\(presetsHeight\);/);
  assert.match(
    writer,
    /'--dock-location-pinned-height',\s*`\$\{locationHeightPx\}px`/,
  );
  assert.match(
    writer,
    /'--dock-presets-pinned-height',\s*`\$\{presetsHeightPx\}px`/,
  );
  assert.match(
    writer,
    /'--dock-lower-pinned-height',\s*`\$\{Math\.ceil\(lowerPinnedHeight\)\}px`/,
  );
  assert.match(writer, /'--dock-pinned-stack-height', stackHeight/);
  assert.match(
    writer,
    /const stackHeight =\s*pinnedCount > 1[\s\S]{0,160}?`calc\(\$\{locationHeightPx\}px \+ \$\{presetsHeightPx\}px \+ 1\.2rem\)`/,
  );
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
  const gate = rail.indexOf('windowRef.matchMedia(');
  assert.ok(gate > 0);
  assert.match(
    rail.slice(gate, gate + 220),
    /\(max-width: 720px\), \(pointer: coarse\) and \(max-width: 900px\), \(pointer: coarse\) and \(max-height: 600px\)/,
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

test('every open dock tray clears the required credit at every modelled viewport', () => {
  // Below 900px the tray widens to nearly the viewport and lands on the
  // bottom-left corner where the credit lives. The clearance is NOT one fixed
  // number: the dock is anchored at 2vh down to 721px and re-anchors to a flat
  // 8px at 720px, while the credit keeps its 2vh base throughout.
  const failures = [];
  for (const scenario of TRAY_SCENARIOS) {
    for (const width of WIDTHS.filter((w) => w <= 900)) {
      for (const height of HEIGHTS) {
        const clearance =
          trayBottomPx(scenario, width, height) - creditTopPx(width, height);
        if (clearance < MIN_CLEARANCE_PX) {
          failures.push(
            `${scenario.name} @ ${width}x${height}: ${clearance.toFixed(1)}px`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `a dock tray re-enters the credit band:\n  ${failures.join('\n  ')}\n`,
  );
});

test('a pinned tray still stacks above its sibling at narrow widths', () => {
  // The stock two-pinned selector carries one ID against five classes, so the
  // ordinary narrow rule (two IDs) outranks it and the upper tray silently
  // drops var(--dock-lower-pinned-height), landing on top of the lower one.
  for (const width of [1440, 900, 800, 720, 700, 600]) {
    for (const scenario of TRAY_SCENARIOS) {
      if (!scenario.stackVar) continue;
      const resolved = resolve(scenario.offset, 'bottom', width, scenario.name);
      assert.ok(
        resolved.decl.value.includes(`var(${scenario.stackVar})`),
        `at ${width}px the ${scenario.name} resolves to "${resolved.decl.value}" via "${resolved.part}" and loses its stack offset`,
      );
    }
  }
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
    3,
    'desktop, phone portrait and touch landscape each have an explicit bottom anchor',
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
      resolve(['#right-context-rail'], 'height', width, 'context rail').decl
        .value,
      'auto',
    );
    assert.equal(
      resolve(['#right-context-rail'], 'top', width, 'context rail').decl.value,
      'auto',
    );
    assert.equal(
      resolve(['#right-context-rail'], 'max-height', width, 'context rail').decl
        .value,
      '48dvh',
    );
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
        failures.push(`${width}x${height}: ${clearance.toFixed(1)}px`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `context rail re-enters the credit band at ${failures.join(', ')}`,
  );
});

test('the dock anchor changes at 720px — the 2vh cancellation is band-limited', () => {
  assert.equal(
    resolve(['#command-dock'], 'bottom', 800, 'dock').decl.value,
    '2vh',
  );
  assert.equal(
    toPx(
      resolve(['#command-dock'], 'bottom', 720, 'dock').decl.value,
      900,
      'dock',
    ),
    8,
  );
  assert.equal(
    resolve(CREDIT_SELECTORS, 'bottom', 720, 'credit').decl.value,
    'calc(max(84px, calc(4.4rem + 14px)) + env(safe-area-inset-bottom))',
    'the mobile credit reserves dock clearance while growing with root text size',
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

test('the tray only spans the credit corner at the widths the model covers', () => {
  const widened = RULES.filter(
    (rule) =>
      rule.parts.includes('#command-dock .dock-popover-content') &&
      rule.decls.some(
        (decl) =>
          decl.prop === 'width' &&
          decl.value.includes('--dock-popover-mobile-width'),
      ),
  );
  assert.equal(widened.length, 1);
  assert.equal(parseMediaCondition(widened[0].media[0]), 900);
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
