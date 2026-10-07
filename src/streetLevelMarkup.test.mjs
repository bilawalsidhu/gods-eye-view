import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandApplicationHtml } from '../build/application-html.js';
import { readStylesheet } from './testSupport/readStylesheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = expandApplicationHtml(read('index.html'));
const css = readStylesheet(path.join(ROOT, 'style.css'));
const panelChrome = read('src/ui/panelChrome.js');
const layoutController = read('src/ui/panelLayoutController.js');
const panelCss = read('src/ui/styles/street-level.css');
const controls = read('src/ui/streetLevelControls.js');

test('Street Level is an ordinary collapsible GEV panel that starts collapsed', () => {
  assert.match(
    html,
    /<div id="street-level-panel" class="panel-collapsible collapsed" data-panel-id="street-level-panel">/,
  );
  assert.match(
    html,
    /<button class="panel-collapse-btn" data-collapse-target="street-level-panel"/,
  );
  assert.match(html, /<span class="panel-title">STREET LEVEL<\/span>/);
  // Provider-neutral header: no vendor mark; the inner restores its scroll.
  assert.doesNotMatch(html, /sl-mark|mly-mark/);
  assert.match(
    html,
    /<div class="street-level-panel-inner" data-rail-scroller>/,
  );
  assert.doesNotMatch(
    html,
    /mapillary-dock|sl-minimized|sl-3d-btn|sl-photoreal-btn/,
  );
});

test('the panel is registered with panel chrome, cockpit entry and the right rail', () => {
  assert.match(panelChrome, /\{ id: 'street-level-panel' \}/);
  assert.match(
    panelChrome,
    /COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object\.freeze\(\[[\s\S]*'street-level-panel'/,
  );
  assert.match(
    panelChrome,
    /const isRightRail = \[[\s\S]*'street-level-panel'/,
  );
  // The layout controller moves every rail panel in one loop; ours is listed.
  assert.match(
    layoutController,
    /for \(const panel of \[[\s\S]*?this\._streetLevelPanel,[\s\S]*?\]\) \{[\s\S]*?stack\.insertBefore\(panel, globalContextPanel\)/,
  );
  for (const rule of [
    '#right-context-rail > #street-level-panel',
    '#right-context-rail #street-level-panel.collapsed',
  ])
    assert.ok(css.includes(rule), `layers.css names ${rule}`);
  assert.match(
    css,
    /#right-context-rail\.layout-focus\s*>\s*#street-level-panel:not\(\.collapsed\)/,
  );
});

test('panel styles stay inside GEV conventions: no !important, no fixed panel', () => {
  assert.equal((panelCss.match(/!important/g) || []).length, 0);
  const fixed = panelCss
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .filter((block) => /position:\s*fixed/.test(block))
    .map((block) => block.slice(0, block.indexOf('{')).trim());
  assert.deepEqual(fixed, ['.sl-viewer-wrap-expanded']);
});

test('the keyless state gates the controls rather than leaving dead buttons', () => {
  // The key requirement is documented (README, .env.example), not repeated in the panel.
  assert.doesNotMatch(
    html,
    /sl-keyless|sl-query|sl-results|data-sl-suggestion/,
  );
  assert.match(html, /<fieldset id="sl-controls"/);
  assert.match(html, /<div id="sl-provider-chips" class="sl-chips"><\/div>/);
  // The gate holds the filters only, so the chips' key tooltip stays reachable.
  const gate = html.slice(
    html.indexOf('<fieldset id="sl-controls"'),
    html.indexOf('</fieldset>', html.indexOf('<fieldset id="sl-controls"')),
  );
  assert.doesNotMatch(gate, /sl-provider-chips/);
  assert.match(gate, /data-sl-pano="all"/);
  assert.match(gate, /id="sl-since"/);
  assert.match(
    html,
    /<input id="sl-since" class="sl-range" type="range" min="0" max="8" step="1"/,
  );
  assert.match(html, /<output id="sl-since-label"/);
  assert.doesNotMatch(html, /<select id="sl-since"|value="year:/);
  assert.match(html, /<ul id="sl-legend"/);
  assert.match(html, /id="sl-error"[^>]*role="alert"/);
  // The header pill is the layer's on/off switch, not just a readout.
  assert.match(
    html,
    /<button id="sl-status" class="sl-status" type="button" aria-pressed="false"/,
  );
  assert.match(
    controls,
    /this\.listen\(el\.status, 'click', \(\) => this\._toggleEnabled\(\)\)/,
  );
});

test('the expanded viewer is a modal dialog that restores focus', () => {
  assert.match(controls, /setAttribute\('role', 'dialog'\)/);
  assert.match(controls, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(controls, /_expandReturnFocus/);
  // A real modal: the rest of the application is inert while it is shown.
  assert.match(controls, /node\.inert = true/);
  assert.match(controls, /node\.inert = false/);
});

test('labels say what the buttons do', () => {
  for (const label of [
    'aria-label="Camera follows view"',
    'PROVIDERS',
    'SINCE',
  ])
    assert.ok(html.includes(label), label);
  // The provider chips are the on/off switch; no separate buttons.
  assert.doesNotMatch(
    html,
    /OPEN NEAREST PHOTO|STREET LEVEL OFF|sl-enable-btn|sl-look-btn|LOOK HERE|STREET COCKPIT|>FRAME<|ZOOM TO RESULTS|ASK IN PLAIN ENGLISH/,
  );
});

test('on phones the viewer is sized from the rail band, not its aspect ratio', () => {
  assert.match(
    panelCss,
    /@media \(max-width: 720px\) \{\s*\.sl-viewer \{[^}]*height: clamp\(/,
  );
  // The expanded viewer must not inherit the phone height.
  assert.match(
    panelCss,
    /\.sl-viewer-wrap-expanded \.sl-viewer \{[^}]*height: auto/,
  );
});

test('the viewer comes first, with follow in its toolbar', () => {
  const controlsBlock = html.slice(html.indexOf('<div class="sl-main">'));
  assert.ok(
    controlsBlock.indexOf('id="sl-viewer-wrap"') <
      controlsBlock.indexOf('class="sl-settings"'),
    'imagery sits above the settings, visible without scrolling',
  );
  assert.match(
    controlsBlock.slice(0, controlsBlock.indexOf('id="sl-viewer"')),
    /id="sl-follow-btn"/,
    'follow lives in the viewer toolbar',
  );
});

test('Clean View, recording and the cockpit hide the expanded viewer on <body> (P2-5)', () => {
  // EXPAND moves the viewer out of every panel, past the panel-hiding rules.
  assert.match(
    read('src/ui/styles/controls.css'),
    /body\.ui-clean-view \.sl-viewer-wrap-expanded \{\s*opacity: 0 !important;\s*visibility: hidden !important;/,
  );
  assert.match(
    read('src/ui/styles/recording.css'),
    /body\.recording-mode \.sl-viewer-wrap-expanded \{\s*opacity: 0 !important;\s*visibility: hidden !important;/,
  );
  assert.match(
    read('src/ui/styles/cockpit.css'),
    /body\.cockpit-mode\s*:is\([^)]*\.sl-viewer-wrap-expanded\s*\)\s*\{\s*display: none !important;/,
  );
  // Hidden, it must not keep holding Esc and Tab.
  assert.match(controls, /_isDialogShown\(\)/);
});

test('the expanded viewer keeps the panel tokens (P3)', () => {
  assert.match(
    panelCss,
    /#street-level-panel,\s*\.sl-viewer-wrap \{\s*--sl-green:[^}]*--sl-text:[^}]*--sl-text-small:/,
  );
});

test('radiogroups are one tab stop and their focus ring is not clipped (P3)', () => {
  const seg = /\.sl-seg \{([^}]*)\}/.exec(panelCss)[1];
  assert.doesNotMatch(seg, /overflow/);
  assert.match(
    panelCss,
    /\.sl-seg-btn:focus-visible \{[^}]*outline: 1px solid/,
  );
  for (const [group, checked] of [
    ['data-sl-render', 'letterbox'],
    ['data-sl-pano', 'all'],
  ]) {
    const radios = [
      ...html.matchAll(
        new RegExp(`<button [^>]*${group}="([a-z]+)"[^>]*>`, 'g'),
      ),
    ];
    assert.ok(radios.length >= 2, group);
    for (const [tag, value] of radios)
      assert.equal(
        /tabindex="-1"/.test(tag),
        value !== checked,
        `${group}="${value}" roving tab stop`,
      );
  }
});

test('the Cyber theme frames the Street Level panel like its rail peers (P3)', () => {
  const cyber = read('src/ui/styles/cyber.css');
  const inner = (cyber.match(/\.recent-imagery-panel-inner,/g) || []).length;
  const panel = (cyber.match(/#recent-imagery-panel,/g) || []).length;
  assert.ok(inner > 0 && panel > 0);
  assert.equal(
    (cyber.match(/\.street-level-panel-inner,/g) || []).length,
    inner,
  );
  assert.equal((cyber.match(/#street-level-panel,/g) || []).length, panel);
  // A theme header rule must be able to outrank the panel's own.
  assert.doesNotMatch(panelCss, /#street-level-panel \.panel-header/);
});
