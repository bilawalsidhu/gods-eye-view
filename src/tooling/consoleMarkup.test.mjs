import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPLICATION_TEMPLATES,
  expandApplicationHtml,
} from '../../build/application-html.js';
import { CONSOLE_MODULES } from '../console/commands.js';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (name) => readFileSync(path.join(ROOT, name), 'utf8');
const DOCUMENT = expandApplicationHtml(read('index.html'));
const CSS = readStylesheet(new URL('../../style.css', import.meta.url));
// Comments carry selector-like prose; strip them before reading structure.
const CONSOLE_CSS = read('src/ui/styles/console.css').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** `{ selector, body }` for every rule in the console stylesheet. */
function consoleRules() {
  const rules = [];
  for (const block of CONSOLE_CSS.split('}')) {
    const brace = block.indexOf('{');
    if (brace === -1) continue;
    const selector = block.slice(0, brace).trim();
    if (!selector || selector.startsWith('@')) continue;
    rules.push({ selector, body: block.slice(brace + 1) });
  }
  return rules;
}

/** Element ids the console source looks up by literal name. */
function referencedIds() {
  const ids = new Set();
  for (const name of [
    'src/console/index.js',
    'src/console/palette.js',
    'src/console/analyst.js',
  ]) {
    const source = read(name);
    for (const [, id] of source.matchAll(
      /(?:getElementById|\belement)\(\s*'([a-z0-9-]+)'\s*\)/g,
    )) {
      ids.add(id);
    }
  }
  return ids;
}

test('the console is a registered component template, expanded once', () => {
  assert.ok(APPLICATION_TEMPLATES.includes('console'));
  assert.equal(
    [...read('index.html').matchAll(/gev:template console/g)].length,
    1,
  );
  assert.match(DOCUMENT, /id="gev-console"/);
  assert.match(DOCUMENT, /id="gev-console-palette"/);
});

test('every id the console code reaches for exists in the document', () => {
  // Panels the application builds at runtime are reached through the rail's
  // data attribute, not by literal id, so this set is the static contract.
  const missing = [...referencedIds()].filter(
    (id) => !DOCUMENT.includes(`id="${id}"`),
  );
  assert.deepEqual(missing, [], `console ids absent from the document: ${missing}`);
});

test('the rail drives panels the command registry also knows about', () => {
  const railPanels = [
    ...DOCUMENT.matchAll(/data-console-panel="([a-z0-9-]+)"/g),
  ].map(([, id]) => id);
  assert.ok(railPanels.length, 'the rail carries module buttons');
  assert.deepEqual(
    railPanels,
    CONSOLE_MODULES.map((module) => module.panelId),
    'the rail and the palette offer the same modules, in the same order',
  );
  // A module is only reachable if something in the document owns its
  // disclosure — either a dock tray toggle or a stacked panel collapse button.
  // Radio builds its panel at runtime, so it is excluded by construction.
  const runtimeBuilt = new Set(['radio-panel']);
  for (const panelId of railPanels) {
    if (runtimeBuilt.has(panelId)) continue;
    assert.ok(
      DOCUMENT.includes(`data-collapse-target="${panelId}"`) ||
        DOCUMENT.includes(`data-dock-toggle-target="${panelId}"`),
      `${panelId} has no disclosure control for the rail to click`,
    );
  }
});

test('the console stylesheet is loaded, and last', () => {
  const entry = read('style.css');
  assert.match(entry, /@import '\.\/src\/ui\/styles\/console\.css';/);
  assert.equal(
    entry.trim().split('\n').at(-1).trim(),
    "@import './src/ui/styles/console.css';",
    'console overrides must resolve after the styles they adjust',
  );
  assert.ok(CSS.includes('.gc-topbar {'), 'the resolved stylesheet carries it');
});

test('no console surface is anchored into the attribution band', () => {
  // #cesium-credits sits at bottom:36px and measures ~28px tall, and the
  // Google/Cesium terms require it to stay visible. Console chrome therefore
  // owns the top band; a viewport-anchored surface that does hang from the
  // bottom has to clear the credit outright. src/creditAttribution.test.mjs
  // models the application's own chrome — this keeps the console out of it.
  const CREDIT_BAND_PX = 96;
  const offenders = [];
  for (const { selector, body } of consoleRules()) {
    // Only viewport-anchored boxes are measured against the credit; a
    // decorative inset inside a console panel is positioned by its own box.
    if (!/position:\s*fixed/.test(body)) continue;
    const [, value] = /(?:^|[;{])\s*bottom:\s*([^;}]+)/.exec(body) || [];
    if (value === undefined) continue;
    const pixels = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
    if (!pixels) {
      offenders.push(`${selector}: unmodelled bottom anchor "${value.trim()}"`);
    } else if (Number(pixels[1]) < CREDIT_BAND_PX) {
      offenders.push(`${selector}: bottom ${value.trim()} re-enters the credit band`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the console never repositions the elements the credit model reasons about', () => {
  // Moving these would invalidate the clearance proof in
  // src/creditAttribution.test.mjs, which reads geometry declarations only.
  const modelled = ['#cesium-credits', '#command-dock', '#right-context-rail'];
  const guarded =
    /\b(?:top|bottom|height|min-height|max-height|position|transform|inset)\s*:/;
  for (const { selector, body } of consoleRules()) {
    if (!modelled.some((name) => selector.includes(name))) continue;
    assert.doesNotMatch(
      body,
      guarded,
      `the console moves a modelled element: ${selector}`,
    );
  }
});

test('standing the console down leaves the application interface alone', () => {
  // Every host-application override hangs off a body class, so removing it is
  // a complete restoration rather than a partial one.
  const keyframeStop = /^(?:from|to|\d+(?:\.\d+)?%)$/;
  for (const { selector } of consoleRules()) {
    for (const part of selector.split(',')) {
      const rule = part.trim();
      if (!rule || keyframeStop.test(rule)) continue;
      // The token block and the console's own surfaces are its to style.
      if (/^:root\b/.test(rule)) continue;
      if (/\.gc-|\.gev-console|#gev-console/.test(rule)) continue;
      assert.match(
        rule,
        /^body\.(?:gev-console|ui-clean-view|cockpit-mode)\b/,
        `an unscoped rule changes the application outside console mode: ${rule}`,
      );
    }
  }
});

test('the console asks for no icon-font glyph', () => {
  // The rail and the buttons draw inline SVG. A Material Symbols ligature
  // that the subset in index.html is missing renders as its own name, and the
  // console is on screen from the first frame.
  const [, consoleMarkup] = /(<div id="gev-console"[\s\S]+?)<!-- Re-entry/.exec(
    expandApplicationHtml('<!-- gev:template console -->\n'),
  ) || [];
  assert.ok(consoleMarkup, 'the console template expands on its own');
  assert.doesNotMatch(consoleMarkup, /material-symbols-outlined/);
});
