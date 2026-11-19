import { renderApplicationHtml } from './testSupport/applicationHtml.mjs';
import { readStylesheet } from './testSupport/readStylesheet.mjs';
import { _selectContextMode } from './ui/contextTransactions.js';
import { _initGlobalContextPanel } from './ui/contextBindings.js';
import { ContextControls } from './ui/contextControls.js';
import { clearSelectedLayers } from './ui/contextActions.js';
import { PANEL_RAIL_ITEMS } from './ui/panelRailCatalog.js';
import { readFileSync as readRadioSource } from 'node:fs';
const radioBindings = readRadioSource(
  new URL('./ui/radioBindings.js', import.meta.url),
  'utf8',
);
const contextView = readRadioSource(
  new URL('./ui/views/ContextView.vue', import.meta.url),
  'utf8',
);
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = await renderApplicationHtml(
  readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
);
const css = readStylesheet(new URL('../style.css', import.meta.url));

test('Contacts stays in the keyboard sequence and Space Missions owns its rail item', () => {
  const button = html.match(
    /<button id="global-context-flights-btn"[\s\S]*?<\/button>/,
  )?.[0];
  assert.ok(button, 'Contacts control is missing');
  assert.match(button, /role="tab"/);
  assert.match(button, /tabindex="0"/);
  const tag = contextView.match(/<button id="global-context-flights-btn"[^>]*>/)?.[0];
  assert.ok(tag, 'Contacts control is missing from the view');
  assert.doesNotMatch(tag, /:tabindex|:disabled|\sdisabled/);
  assert.doesNotMatch(html, /id="global-context-missions-btn"/);
  assert.match(html, /id="space-missions-panel"[^>]*data-panel-id="space-missions-panel"/);
  assert.equal(PANEL_RAIL_ITEMS['space-missions-panel'].icon, 'rocket_launch');
});

test('Context activation and Clear All never native-disable tabs and guard repeated clicks', () => {
  const select = _selectContextMode.toString();
  const clear = clearSelectedLayers.toString();
  assert.doesNotMatch(
    select,
    /_globalContext(?:Flights|Missions)Btn\.disabled\s*=\s*true/,
  );
  assert.doesNotMatch(
    clear,
    /_globalContext(?:Flights|Missions)Btn\.disabled\s*=\s*true/,
  );
});

test('a Contacts click while Context is busy is ignored', () => {
  const button = new EventTarget();
  const controls = new ContextControls({
    elements: { _globalContextFlightsBtn: button },
    installations: {},
    actions: { getCockpit: () => null, claimVisualAuthority() {} },
  });
  const runs = [];
  controls._runUserFacingContextAction = (operation) => {
    runs.push(operation);
    return Promise.resolve(false);
  };
  const click = () => button.dispatchEvent(new Event('click'));
  controls._contextModeChanging = true;
  click();
  controls._contextModeChanging = false;
  controls._clearSelectedLayersPromise = Promise.resolve();
  click();
  assert.equal(runs.length, 0, 'a transition or Clear All in flight drops it');
  controls._clearSelectedLayersPromise = null;
  click();
  assert.equal(runs.length, 1, 'an idle panel takes the click');
  controls.stop();
});

test('Context tabs draw a visible keyboard-focus outline including active tabs', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const focusRule = rules.find(
    ([, selector, body]) =>
      selector.trim().endsWith('.context-mode-button:focus-visible') &&
      /outline:\s*2px solid var\(--text-primary\)/.test(body),
  );
  assert.ok(
    focusRule,
    'Context focus-visible rule must draw a two-pixel outline',
  );
  assert.match(focusRule[2], /outline-offset:\s*-3px/);

  const activeRule = rules.find(([, selector]) =>
    selector.trim().endsWith('.context-mode-button.active'),
  );
  assert.ok(activeRule, 'Context active-state rule is missing');
  assert.doesNotMatch(activeRule[2], /outline:\s*none/);
});

test('Context async action buttons remain focused while busy', () => {
  const radio = radioBindings.slice(
    radioBindings.indexOf('const toggleRadio = async (trigger) => {'),
    radioBindings.indexOf('this._storeToken = this.store?.connect?.('),
  );
  const radioPanel = readFileSync(
    new URL('./ui/views/panels/RadioPanel.vue', import.meta.url),
    'utf8',
  );
  const clear = clearSelectedLayers.toString();

  const init = _initGlobalContextPanel.toString();
  assert.match(init, /if \(this\._installationsSearchBusy\) return;/);
  assert.doesNotMatch(init, /\.disabled\s*=\s*true/);
  const search = contextView.match(
    /<button id="installations-search-btn"[^>]*>/,
  )?.[0];
  assert.ok(search, 'nearby sites search is missing');
  assert.doesNotMatch(search, /:disabled|\sdisabled/);
  assert.match(search, /:aria-busy=/);
  assert.match(radio, /trigger\.getAttribute\('aria-busy'\) === 'true'/);
  assert.doesNotMatch(radio, /trigger\.disabled\s*=\s*true/);
  const cockpitRadio = readFileSync(
    new URL('./ui/views/panels/CockpitUtilityControls.vue', import.meta.url),
    'utf8',
  );
  const cockpitEnable = cockpitRadio.match(
    /<UiButton id="cockpit-radio-enable-btn"[^>]*>/,
  )?.[0];
  assert.ok(cockpitEnable, 'Cockpit Radio Enable button is missing');
  assert.doesNotMatch(cockpitEnable, /disabled(?!=")|:disabled/);
  assert.match(cockpitEnable, /:aria-busy=/);
  // The Radio view never disables its Enable button; it marks it busy.
  const enable = radioPanel.match(/<UiButton id="radio-enable-btn"[^>]*>/)?.[0];
  assert.ok(enable, 'Radio Enable button is missing');
  assert.doesNotMatch(enable, /disabled(?!=")|:disabled/);
  assert.match(enable, /:aria-busy=/);
  assert.match(clear, /this\.setClearBusy\(true\)/);
  // The globe actions view marks the clear button busy, never disabled.
  const globeActions = readFileSync(
    new URL('./ui/views/panels/GlobeActions.vue', import.meta.url),
    'utf8',
  );
  const clearButton = globeActions.match(
    /<button id="clear-selected-layers"[^>]*>/,
  )?.[0];
  assert.ok(clearButton, 'Clear selected layers button is missing');
  assert.doesNotMatch(clearButton, /disabled(?!=")|:disabled=/);
  assert.match(clearButton, /:aria-busy=/);
});

test('Context header holds its title, search, expand, edge switch and collapse control', () => {
  const panel = html.match(
    /<div id="global-context-panel"[\s\S]*?<div class="cyber-panel-body[ "]/,
  );
  assert.ok(panel, 'Global Context panel is missing');
  const header = panel[0].match(
    /<div class="ui-panel__head panel-header">([\s\S]*?)<\/div>\s*<div class="cyber-panel-body[ "]/,
  );
  assert.ok(header, 'Global Context header is missing');
  // The kit's own ui-* classes carry no Core styles.
  const tags = [
    ...header[1].matchAll(/<(\w+)\s+(?:type="button"\s+)?class="([^"]+)"/g),
  ].map(
    ([, tag, cls]) =>
      `${tag}.${cls
        .split(' ')
        .filter((name) => !/^ui-/.test(name))
        .join(' ')}`,
  );
  assert.deepEqual(tags, [
    'span.panel-title',
    'span.panel-divider',
    'button.context-dock-btn',
    'span.material-symbols-outlined',
    'button.context-dock-btn',
    'span.material-symbols-outlined',
    'button.panel-edge-btn',
    'span.material-symbols-outlined',
    'button.panel-collapse-btn',
  ]);
});

test('Context reads as one segmented control with legible type and no halo', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const clean = (selector) =>
    selector
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const rule = (selector) =>
    rules.find(([, s]) => clean(s) === selector)?.[2] || '';
  const px = (body, prop) =>
    Number(
      body.match(new RegExp(`${prop}:[^;]*?(\\d+(?:\\.\\d+)?)px`))?.[1] || 0,
    );

  assert.match(rule('#global-context-panel .panel-glow'), /display:\s*none/);
  const modes = rule('.global-context-modes');
  assert.match(modes, /border:\s*1px solid/);
  assert.match(modes, /padding:\s*2px/);
  assert.ok(
    px(rule('.context-mode-button'), 'font') >= 10,
    'mode labels must stay at least 10px',
  );
  assert.doesNotMatch(rule('.context-mode-button.active'), /box-shadow/);
  const standby = rule('.context-mode-standby');
  assert.ok(
    px(standby, 'font') >= 10,
    'standby guidance must stay at least 10px',
  );
  assert.doesNotMatch(standby, /dashed/);
  assert.ok(
    px(rule('.global-context-actions .panel-layer-toggle'), 'font-size') >= 10,
  );
  // The shared rail title colour (brighter than --text-secondary) keeps the
  // open Context title legible; no Context-only rule dims it again.
  assert.equal(
    rule(
      ":root #global-context-panel:not(.collapsed) .panel-title",
    ),
    '',
  );
});
