import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderApplicationHtml } from './testSupport/applicationHtml.mjs';
import { readStylesheet } from './testSupport/readStylesheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = await renderApplicationHtml(read('index.html'));
const css = readStylesheet(path.join(ROOT, 'style.css'));
const panelCss = read('src/ui/styles/street-level.css');
const panelChrome = read('src/ui/panelChrome.js');
const layoutController = read('src/ui/panelLayoutController.js');

test('Street Level has no panel: its photo waits in Context, its filters are its layer row', () => {
  assert.doesNotMatch(html, /id="street-level-panel"/);
  assert.doesNotMatch(html, /data-collapse-target="street-level-panel"/);
  // The viewer is always in the page (a provider mounts into it), hidden in
  // Context (out of view) until a photo's card takes it.
  const home = html.indexOf('class="sl-viewer-home"');
  assert.ok(home > 0, 'its hidden home');
  assert.match(html.slice(home, home + 120), /aria-hidden="true"/);
  assert.match(html.slice(home, home + 120), /\binert\b/);
  // Out of view but sized, so a viewer built there has a size.
  assert.match(
    panelCss,
    /\.sl-viewer-home \{[^}]*left: -10000px;[^}]*width: 400px;/,
  );
  assert.ok(html.indexOf('id="sl-viewer-root"') > home);
  assert.ok(html.indexOf('id="sl-viewer-wrap"') > home);
});

test('no panel chrome, cockpit entry, rail icon or rail layout names the retired panel', () => {
  assert.doesNotMatch(panelChrome, /street-level-panel/);
  assert.doesNotMatch(read('src/ui/panelRailCatalog.js'), /street-level-panel/);
  assert.doesNotMatch(layoutController, /_streetLevelPanel|street-level-panel/);
  assert.ok(!css.includes('#street-level-panel'));
  assert.ok(!css.includes('.street-level-panel-inner'));
});

test('the photo carries its source colours wherever it moves', () => {
  assert.match(
    panelCss,
    /\.sl-viewer-root,\s*\.sl-viewer-wrap \{[^}]*--sl-green:/,
  );
});

test("the row's provider chips keep their source colours", () => {
  assert.match(
    panelCss,
    /\[data-layer-id='street-level'\] \.data-toggle-chip\[data-chip-color\]\.active \{[^}]*var\(--chip-color/,
  );
  // KartaView's purple is too dark as text on its own tint.
  assert.match(
    panelCss,
    /\[data-chip-id='sl-provider-kartaview'\] \{\s*color: #8f8aff;/,
  );
});

test('FIT / FILL is one tab stop, on its checked button', () => {
  const radios = [
    ...html.matchAll(/<button [^>]*data-sl-render="([a-z]+)"[^>]*>/g),
  ];
  assert.equal(radios.length, 2);
  for (const [tag, value] of radios)
    assert.equal(
      /tabindex="-1"/.test(tag),
      value !== 'letterbox',
      `data-sl-render="${value}" roving tab stop`,
    );
});

test('embed mode shows an open photo over the globe, filling the overlay', () => {
  const overlay = css.match(
    /body\.ui-embed \.sl-viewer-wrap-embed \{([^}]*)\}/,
  );
  assert.ok(overlay, 'embed styles the viewer it moves over the globe');
  for (const rule of ['position: fixed', 'inset: 12px', 'z-index: 1000'])
    assert.ok(overlay[1].includes(rule), rule);
  // Cockpit, recording and scene playback own the screen: the photo hides.
  for (const mode of ['cockpit-mode', 'recording-mode', 'scene-playback-mode'])
    assert.match(
      css,
      new RegExp(
        `body\\.ui-embed\\.${mode} \\.sl-viewer-wrap-embed[^{]*\\{[^}]*display: none`,
      ),
      mode,
    );
  // The photo takes the overlay's height, as it does full screen.
  assert.match(
    css,
    /body\.ui-embed \.sl-viewer-wrap-embed \.sl-viewer \{[^}]*flex: 1 1 auto/,
  );
});
