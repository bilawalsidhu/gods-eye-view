// src/ui/contextPanel.test.mjs — the Context mode switch renders what
// ContextControls presents (`_presentContext()`), over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { useContextStore } from './stores/context.js';
import ContextView from './views/ContextView.vue';
import { ContextControls } from './contextControls.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(ContextView).use(pinia);
  app.mount(host);
  const $ = (id) => document.getElementById(id);
  const store = useContextStore(pinia);
  const controls = new ContextControls({
    elements: {
      _globalContextFlightsBtn: $('global-context-flights-btn'),
      _installationsSearchBtn: $('installations-search-btn'),
    },
    installations: {},
    actions: {
      getCockpit: () => null,
      claimVisualAuthority() {},
      showToast() {},
      setClearBusy() {},
      syncDetection() {},
      scheduleLayout() {},
      refreshRadio() {},
      setPanelCollapsed() {},
    },
    publish: (view) => store.publish(view),
  });
  t.after(() => {
    controls.stop();
    controls.disconnect();
    app.unmount();
  });
  const sync = async () => {
    controls._syncContextModeButtons();
    await nextTick();
  };
  return { $, controls, sync };
}

test('before ContextControls renders, the switch shows its initial markup', (t) => {
  const { $ } = fixture(t);
  const panel = $('global-context-panel');
  assert.equal(
    panel.className,
    'ui-panel panel-collapsible collapsed ui-panel--collapsed',
  );
  assert.equal(panel.hasAttribute('data-context-mode'), false);
  const tab = $('global-context-flights-btn');
  assert.equal(
    tab.className,
    'ui-button ui-focus ui-button--ghost ui-button--accent context-mode-button',
  );
  assert.equal(tab.getAttribute('aria-selected'), 'false');
  assert.equal(tab.getAttribute('tabindex'), '0');
  assert.equal(tab.hasAttribute('aria-busy'), false);
  assert.equal($('context-mode-standby').hidden, false);
  assert.equal($('context-flights-view').hidden, true);
  assert.equal($('global-context-missions-btn'), null);
  assert.equal($('context-missions-view'), null);
  assert.equal($('installations-search-btn').hasAttribute('aria-busy'), false);
});

test('a Contacts transition keeps the tab focusable until it settles', async (t) => {
  const { $, controls, sync } = fixture(t);
  const contacts = $('global-context-flights-btn');
  contacts.focus();
  controls._contextModeChanging = true;
  await sync();
  assert.equal(document.activeElement, contacts);
  assert.equal(contacts.disabled, false);
  assert.equal(contacts.getAttribute('tabindex'), '0');
  assert.equal(contacts.getAttribute('aria-disabled'), 'true');
  assert.equal(contacts.getAttribute('aria-busy'), 'true');

  controls._contextModeChanging = false;
  controls._contextMode = 'flights';
  await sync();
  assert.equal(document.activeElement, contacts);
  assert.equal(contacts.disabled, false);
  assert.equal(contacts.getAttribute('aria-disabled'), 'false');
  assert.equal(contacts.getAttribute('aria-busy'), 'false');
  assert.equal(contacts.classList.contains('active'), true);
  assert.equal(contacts.getAttribute('aria-selected'), 'true');
  assert.equal($('context-mode-standby').hidden, true);
  assert.equal($('context-flights-view').hidden, false);
});

test('the panel carries the mode beside the classes its chrome writes', async (t) => {
  const { $, controls, sync } = fixture(t);
  const panel = $('global-context-panel');
  panel.classList.remove('collapsed');
  controls._contextMode = 'flights';
  await sync();
  // Without an owner the button, and the kit class, keep the start state.
  assert.equal(
    panel.className,
    'ui-panel panel-collapsible ui-panel--collapsed context-enabled',
  );
  assert.equal(panel.getAttribute('data-context-mode'), 'flights');
  assert.equal($('context-flights-view').hidden, false);

  panel.classList.add('collapsed');
  controls._contextMode = null;
  await sync();
  assert.equal(
    panel.className,
    'ui-panel panel-collapsible ui-panel--collapsed collapsed',
  );
  assert.equal(panel.getAttribute('data-context-mode'), 'none');
  assert.equal($('context-mode-standby').hidden, false);
  assert.equal($('context-flights-view').hidden, true);
});

test('the nearby sites search is busy, without native disable, until it settles', async (t) => {
  const { $, controls } = fixture(t);
  const button = $('installations-search-btn');
  let release;
  let enables = 0;
  controls._dataManager = {
    layers: new Map([['military-installations', {}]]),
    setEnabled: () => {
      enables += 1;
      return new Promise((resolve) => (release = resolve));
    },
    isEnabled: () => true,
  };
  controls.installations.searchNearby = async () => true;
  button.focus();
  button.click();
  await nextTick();
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.disabled, false);
  assert.equal(document.activeElement === button, true);
  button.click();
  assert.equal(enables, 1, 'a busy search ignores a second click');

  release(true);
  await turn();
  await nextTick();
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.getAttribute('aria-disabled'), 'false');
});

test('with Context closed, the collapsible sections are already in the page for PanelChrome', (t) => {
  // PanelChrome finds collapsible panels once, at startup, by their collapse
  // buttons; Context starts closed, so a section that mounts only while it
  // is open would never be registered and its +/- would do nothing.
  fixture(t);
  assert.equal(
    document
      .getElementById('global-context-panel')
      .classList.contains('collapsed'),
    true,
  );
  const targets = [
    ...document.querySelectorAll('.panel-collapse-btn[data-collapse-target]'),
  ].map((button) => button.dataset.collapseTarget);
  for (const id of ['station-panel', 'live-panel', 'radio-panel'])
    assert.ok(targets.includes(id), `${id} is there to be registered`);
});
