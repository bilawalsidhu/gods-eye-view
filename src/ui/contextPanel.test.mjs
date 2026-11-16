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
      _globalContextMissionsBtn: $('global-context-missions-btn'),
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
  for (const id of [
    'global-context-flights-btn',
    'global-context-missions-btn',
  ]) {
    const tab = $(id);
    assert.equal(tab.className, 'context-mode-button');
    assert.equal(tab.getAttribute('aria-selected'), 'false');
    assert.equal(tab.getAttribute('tabindex'), '0');
    assert.equal(tab.hasAttribute('aria-busy'), false);
  }
  assert.equal($('context-mode-standby').hidden, false);
  assert.equal($('context-flights-view').hidden, true);
  assert.equal($('context-missions-view').hidden, true);
  assert.equal($('installations-search-btn').hasAttribute('aria-busy'), false);
});

test('a transition keeps focus and Tab on both tabs until it settles', async (t) => {
  const { $, controls, sync } = fixture(t);
  const contacts = $('global-context-flights-btn');
  const missions = $('global-context-missions-btn');
  missions.focus();
  controls._contextModeChanging = true;
  await sync();
  assert.equal(
    document.activeElement === missions,
    true,
    'busy render keeps focus',
  );
  for (const tab of [contacts, missions]) {
    assert.equal(tab.disabled, false);
    assert.equal(tab.getAttribute('tabindex'), '0');
    assert.equal(tab.getAttribute('aria-disabled'), 'true');
    assert.equal(tab.getAttribute('aria-busy'), 'true');
  }

  controls._contextModeChanging = false;
  controls._contextMode = 'space-missions';
  await sync();
  assert.equal(
    document.activeElement === missions,
    true,
    'settled render keeps focus',
  );
  for (const tab of [contacts, missions]) {
    assert.equal(tab.disabled, false);
    assert.equal(tab.getAttribute('aria-disabled'), 'false');
    assert.equal(tab.getAttribute('aria-busy'), 'false');
  }
  assert.equal(missions.classList.contains('active'), true);
  assert.equal(missions.getAttribute('aria-selected'), 'true');
  assert.equal(contacts.classList.contains('active'), false);
  assert.equal(contacts.getAttribute('aria-selected'), 'false');
  assert.equal($('context-mode-standby').hidden, true);
  assert.equal($('context-flights-view').hidden, true);
  assert.equal($('context-missions-view').hidden, false);
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
