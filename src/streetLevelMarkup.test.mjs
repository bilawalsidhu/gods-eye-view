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
    '#right-context-rail > #street-level-panel:not(.panel-floating)',
    '#right-context-rail #street-level-panel.collapsed:not(.panel-floating)',
  ])
    assert.ok(css.includes(rule), `layers.css names ${rule}`);
  // Rail placement never applies to the panel once it floats as a window.
  assert.match(
    css,
    /#right-context-rail\.layout-focus\s*>\s*#street-level-panel:not\(\.collapsed\):not\(\.panel-floating\)/,
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
  // Floating and expanded viewers must not inherit the phone height.
  for (const selector of [
    ".panel-floating\\[style\\*='height'\\] \\.sl-viewer",
    '\\.sl-viewer-wrap-expanded \\.sl-viewer',
  ])
    assert.match(panelCss, new RegExp(`${selector} \\{[^}]*height: auto`));
});

test('the viewer comes first and the panel is a portable, resizable window', () => {
  const controlsBlock = html.slice(html.indexOf('<fieldset id="sl-controls"'));
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
  const position = read('src/ui/panelPositionControls.js');
  assert.match(
    position,
    /id: 'street-level-panel',[\s\S]*?portable: true,[\s\S]*?min: \{ width: 320, height: 280 \}/,
  );
  assert.match(
    panelCss,
    /\.panel-floating\[style\*='height'\] \.sl-settings \{[^}]*overflow-y: auto/,
  );
  // Shrinking docks it back at its default size rather than leaving a
  // window over the globe: collapsing a floating panel, or SHRINK / Esc on
  // the expanded viewer.
  assert.match(
    position,
    /id: 'street-level-panel',[\s\S]*?dockOnCollapse: true/,
  );
  assert.match(
    read('src/ui/panelChrome.js'),
    /classList\.toggle\('collapsed', nextCollapsed\);[\s\S]{0,200}?if \(explicit && !restore\)\s*this\._panelPosition\?\.onPanelCollapsed\?\.\(panelId, nextCollapsed\)/,
  );
  assert.match(
    controls,
    /setViewerExpanded\(!this\.isViewerExpanded\(\), \{ dock: true \}\)/,
  );
  assert.match(controls, /this\.setViewerExpanded\(false, \{ dock: true \}\)/);
  assert.match(controls, /if \(!on && dock\) this\.actions\.dockPanel\?\.\(\)/);
  assert.match(
    read('src/ui/applicationShell.js'),
    /panelId === 'street-level-panel'\)\s*this\._streetLevelControls\?\.onPanelResized\(\)/,
  );
});
