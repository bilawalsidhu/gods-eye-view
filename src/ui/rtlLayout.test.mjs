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

test('position counters read as a number pair in right-to-left', () => {
  const counters =
    /html\[dir='rtl'\]\s*:is\(([^)]*\[data-role='beat-index'\][^)]*)\)\s*\{([^}]*)\}/.exec(
      sheet('rtl.css'),
    );
  assert.ok(counters, 'no left-to-right counter rule in rtl.css');
  assert.match(counters[1], /#cockpit-brief-position/);
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

test('Radio and camera controls in Context keep their sense in right-to-left', () => {
  const rtl = sheet('rtl.css');
  // The local receiver's seek pair keeps down on the left, as the SDR card's.
  assert.match(
    rtl,
    /html\[dir='rtl'\] :is\(\.sdr-seek-row, \.radio-stations__seek, \.radio-tuner\) \{\s*direction: ltr;/,
  );
  const player = readFileSync(
    new URL('./views/panels/LocalReceiverPlayer.vue', import.meta.url),
    'utf8',
  );
  assert.match(
    player,
    /<span class="radio-stations__seek"[^>]*>\s*<UiButton[^>]*seekSdr', -1\)[\s\S]*?seekSdr', 1\)/,
  );
  // A row's Previous and Next chevrons point the other way.
  assert.match(
    rtl,
    /\.data-toggle-chip:is\(\s*\[data-chip-icon='chevron_left'\],\s*\[data-chip-icon='chevron_right'\]\s*\)\s*\.ui-icon \{\s*transform: scaleX\(-1\);/,
  );
  const chips = readFileSync(
    new URL('./rail/RailChips.vue', import.meta.url),
    'utf8',
  );
  assert.match(chips, /:data-chip-icon="chip\.icon \|\| undefined"/);
  // So do the radio player's Previous and Next skip glyphs.
  assert.match(
    rtl,
    /\.radio-mini__controls\s*:is\(\[data-chip-icon='skip_previous'\], \[data-chip-icon='skip_next'\]\)\s*\.ui-icon \{\s*transform: scaleX\(-1\);/,
  );
  const mini = readFileSync(
    new URL('./views/panels/RadioMiniPlayer.vue', import.meta.url),
    'utf8',
  );
  assert.match(mini, /data-chip-icon="skip_previous"[^>]*@click="step\(-1\)"/);
  assert.match(mini, /data-chip-icon="skip_next"[^>]*@click="step\(1\)"/);
  // A camera card's expand button sits at the end, clear of the paused chip
  // at the start.
  const card = sheet('entity-card.css');
  const expand = ruleBody(card, '.cctv-preview__expand');
  assert.match(expand, /inset-inline-end: 6px;/);
  assert.doesNotMatch(expand, /(^|\s)(left|right):/);
  assert.match(ruleBody(card, '.paused-chip'), /inset-inline-start:/);
});
