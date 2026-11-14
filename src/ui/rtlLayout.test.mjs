// Right-to-left layout pins: chrome that mirrors in Arabic must mirror on
// both sides of a pair, or one half lands on the other or off the screen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sheet = (name) =>
  readFileSync(new URL(`./styles/${name}`, import.meta.url), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(
    css,
  );
  assert.ok(match, `no rule for ${selector}`);
  return match[1];
}

test('the dock trays open from their own wing in right-to-left', () => {
  const rtl = sheet('rtl.css');
  const location = ruleBody(
    rtl,
    "html[dir='rtl'] #command-dock #location-bar .dock-popover-content",
  );
  assert.match(
    location,
    /right: calc\(\(var\(--dock-unified-width\) - var\(--dock-location-open\)\) \/ 2\);/,
  );
  assert.match(location, /left: auto;/);
  assert.match(location, /transform-origin: bottom right;/);
  const presets = ruleBody(
    rtl,
    "html[dir='rtl'] #command-dock #control-panel .dock-popover-content",
  );
  assert.match(
    presets,
    /left: calc\(\(var\(--dock-unified-width\) - var\(--dock-presets-open\)\) \/ 2\);/,
  );
  assert.match(presets, /right: auto;/);
  assert.match(presets, /transform-origin: bottom left;/);
  // The narrow band re-centres both trays on the mobile tray width.
  const narrow = /@media \(max-width: 900px\) \{([\s\S]*?)\n\}/.exec(rtl);
  assert.ok(narrow, 'no max-width:900px block in rtl.css');
  assert.match(
    narrow[1],
    /#location-bar \.dock-popover-content \{\s*right: calc\(\s*\(var\(--dock-unified-width\) - var\(--dock-popover-mobile-width\)\) \/ 2\s*\);/,
  );
  assert.match(
    narrow[1],
    /#control-panel \.dock-popover-content \{\s*left: calc\(\s*\(var\(--dock-unified-width\) - var\(--dock-popover-mobile-width\)\) \/ 2\s*\);/,
  );
});

test('the Cyber cockpit keeps Data Layers on the left edge in every language', () => {
  const body = ruleBody(
    sheet('cyber.css'),
    ":root[data-ui-theme='cyber'] body.cockpit-mode #left-panel-stack",
  );
  // inset-inline-start would become right: 30px in Arabic and beat
  // rtl.css's reset, landing the stack on the utility controls.
  assert.doesNotMatch(body, /inset-inline-start/);
  assert.match(body, /left: 30px;/);
  assert.match(body, /right: auto;/);
});

test('the panel rails stay on the outer side of their stacks in right-to-left', () => {
  const layers = sheet('layers.css');
  // Each rail is placed by its screen-side edge; a physical side would put
  // it over the panels once the stacks swap sides.
  const left = ruleBody(layers, '.gev-panel-rail--left');
  assert.match(
    left,
    /inset-inline-start: calc\(-1 \* var\(--panel-rail-clearance\)\);/,
  );
  assert.doesNotMatch(left, /(?:^|\s)(?:left|right):/);
  const right = ruleBody(layers, '.gev-panel-rail--right');
  assert.match(
    right,
    /inset-inline-end: calc\(-1 \* var\(--panel-rail-clearance\)\);/,
  );
  assert.doesNotMatch(right, /(?:^|\s)(?:left|right):/);
  // Their tips open toward the middle of the screen.
  const kit = sheet('kit.css');
  assert.match(
    ruleBody(kit, '.ui-tooltip__tip--right'),
    /inset-inline-start: calc\(100% \+ 10px\);/,
  );
  assert.match(
    ruleBody(kit, '.ui-tooltip__tip--left'),
    /inset-inline-end: calc\(100% \+ 10px\);/,
  );
  // Cyber's right stack keeps its rail clearance on the left edge.
  assert.match(
    sheet('rtl.css'),
    /html\[dir='rtl'\]\[data-ui-theme='cyber'\] #right-context-rail \{\s*right: auto;\s*left: calc\(51px \+ var\(--panel-rail-clearance\)\);/,
  );
});

test('phone top-bar actions mirror with the logo', () => {
  const mobile = sheet('mobile-shell.css');
  const actions = ruleBody(mobile, 'body.mobile-shell #top-center-actions');
  assert.match(actions, /inset-inline-start: auto;/);
  assert.match(actions, /inset-inline-end: 12px;/);
  assert.doesNotMatch(actions, /(?:^|\s)right:/);
  const corner = ruleBody(mobile, 'body.mobile-shell #corner-actions');
  assert.match(corner, /inset-inline-end: 12px;/);
  assert.doesNotMatch(corner, /(?:^|\s)right:/);
});

test('the Space Missions counter reads as a number pair in right-to-left', () => {
  const counters =
    /html\[dir='rtl'\]\s*:is\(([^)]*\[data-role='beat-index'\][^)]*)\)\s*\{([^}]*)\}/.exec(
      sheet('rtl.css'),
    );
  assert.ok(counters, 'no left-to-right counter rule in rtl.css');
  assert.match(counters[1], /\[data-mission-index\]/);
  assert.match(counters[2], /direction: ltr;/);
});

test('select chevrons and legend ranges follow the field and the ramp in right-to-left', () => {
  const field = sheet('form-field.css');
  assert.match(
    ruleBody(field, 'select.gev-field'),
    /padding-inline-end: 22px;/,
  );
  assert.match(
    ruleBody(field, 'select.gev-field--compact'),
    /padding-inline-end: 18px;/,
  );
  // Selects that set their own padding keep the chevron's room at the end.
  for (const [name, selector, inline] of [
    ['radio.css', '#radio-filter', '8px 24px'],
    ['radio.css', '.sdr-gain-row select', '7px 22px'],
    ['voice-card.css', '#gev-voice-timeout-select', '0.45rem 22px'],
  ]) {
    const body = ruleBody(sheet(name), selector);
    assert.match(body, new RegExp(`padding-inline: ${inline};`));
    assert.doesNotMatch(body, /(?:^|\s)padding(?:-right)?:/);
  }
  const rtl = sheet('rtl.css');
  assert.match(
    ruleBody(rtl, "html[dir='rtl'] select.gev-field"),
    /background-position: left 8px center;/,
  );
  assert.match(
    ruleBody(rtl, "html[dir='rtl'] select.gev-field--compact"),
    /background-position: left 6px center;/,
  );
  assert.match(
    ruleBody(rtl, "html[dir='rtl'] .rail-card-scale"),
    /direction: ltr;/,
  );
});
