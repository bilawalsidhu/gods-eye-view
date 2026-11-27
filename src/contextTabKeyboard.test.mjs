import { renderApplicationHtml } from './testSupport/applicationHtml.mjs';
import { readStylesheet } from './testSupport/readStylesheet.mjs';
import { _selectContextMode } from './ui/contextTransactions.js';
import { clearSelectedLayers } from './ui/contextActions.js';
import { PANEL_RAIL_ITEMS } from './ui/panelRailCatalog.js';
import { readFileSync as readRadioSource } from 'node:fs';
const radioBindings = readRadioSource(
  new URL('./ui/radioBindings.js', import.meta.url),
  'utf8',
);
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';

const html = await renderApplicationHtml(
  readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
);
const css = readStylesheet(new URL('../style.css', import.meta.url));

test('Context has no Contacts control, and Space Missions no panel or rail item of its own', () => {
  assert.doesNotMatch(html, /id="global-context-flights-btn"/);
  assert.doesNotMatch(html, /id="installations-search-btn"/);
  assert.doesNotMatch(html, /id="global-context-missions-btn"/);
  // Its list is Context's Inspect view while the layer is on; Weather's,
  // News's and Recent Imagery's share the Lists tab.
  for (const id of ['space-missions-panel', 'weather-panel', 'news-panel', 'recent-imagery-panel']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
    assert.equal(PANEL_RAIL_ITEMS[id], undefined, `${id} has no rail item`);
  }
  assert.doesNotMatch(html, /id="context-missions"/);
  const template = new Window().document.createElement('template');
  template.innerHTML = html;
  const lists = template.content.querySelector('#context-lists');
  assert.ok(lists, 'Context has a shared Lists panel');
  assert.equal(lists.querySelector('#context-list-space-missions'), null);
  for (const body of ['weather-panel-body', 'news-panel-body', 'recent-imagery-panel-body'])
    assert.ok(lists.querySelector(`#${body}`), `${body} belongs in Lists`);
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

test('Context async action buttons remain focused while busy', () => {
  const radio = radioBindings.slice(
    radioBindings.indexOf('const toggleRadio = async (trigger) => {'),
    radioBindings.indexOf('this._storeToken = this.store?.connect?.('),
  );
  const clear = clearSelectedLayers.toString();

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
  assert.match(clear, /this\.setClearBusy\(true\)/);
  // The globe actions view marks the clear button busy, never disabled.
  const globeActions = readFileSync(
    new URL('./ui/views/panels/GlobeActions.vue', import.meta.url),
    'utf8',
  );
  const clearButton = globeActions.match(
    /<UiButton id="clear-selected-layers"[^>]*>/,
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
    // Folded (as it renders first), the name is a button that opens it.
    'button.panel-title context-title-open',
    'span.panel-divider',
    'button.context-dock-btn context-search-toggle',
    'span.material-symbols-outlined',
    'button.context-dock-btn',
    'span.material-symbols-outlined',
    'button.panel-edge-btn',
    'span.material-symbols-outlined',
    'button.panel-collapse-btn',
  ]);
});

test('Context keeps a legible title and no halo', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const clean = (selector) =>
    selector
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const rule = (selector) =>
    rules.find(([, s]) => clean(s) === selector)?.[2] || '';

  assert.match(rule('#global-context-panel .panel-glow'), /display:\s*none/);
  // The shared rail title colour (brighter than --text-secondary) keeps the
  // open Context title legible; no Context-only rule dims it again.
  assert.equal(
    rule(
      ":root #global-context-panel:not(.collapsed) .panel-title",
    ),
    '',
  );
});
