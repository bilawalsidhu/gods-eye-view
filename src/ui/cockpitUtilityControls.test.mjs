// src/ui/cockpitUtilityControls.test.mjs — the Cockpit's Display and Radio
// launchers and the compact Radio controls render what RadioControls
// presents, over happy-dom with the real controls bound to them.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import { onKeyDown as cockpitKeyDown } from './cockpitInput.js';
import { RadioControls } from './radioControls.js';
import { renderRadioState } from './radioPresentation.js';
import { syncSignalLayout } from './cockpitLayout.js';
import { useCockpitStore } from './stores/cockpit.js';
import { useRadioStore } from './stores/radio.js';
import CockpitUtilityControls from './views/panels/CockpitUtilityControls.vue';

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const outside = document.body.appendChild(document.createElement('button'));
  const pinia = createPinia();
  const app = createApp(CockpitUtilityControls).use(pinia);
  app.mount(host);
  const $ = (id) => document.getElementById(id);
  const calls = [];
  let enabled = false;
  let toggles = 0;
  let finishToggle = null;
  const ui = { presentationActive: true, filter: 'all' };
  const actions = {
    isRegistered: () => true,
    isEnabled: () => enabled,
    runUserAction: (operation) => operation(),
    setEnabled: (next) => {
      toggles += 1;
      return new Promise((resolve) => {
        finishToggle = () => {
          enabled = next;
          resolve(true);
        };
      });
    },
    setParams: (params) => {
      calls.push(['params', params]);
      return params.filter !== 'refused';
    },
    setPanelCollapsed() {},
    setSignalCollapsed: (collapsed) => calls.push(['signal', collapsed]),
    revealStyleParameters: () => calls.push(['reveal']),
    layoutCockpit() {},
    isCockpitActive: () => true,
    signalUserCollapsed: () => false,
    scheduleLayout() {},
    getLifecycle: () => null,
    preservePanelStateDuringClear: () => true,
  };
  const controls = new RadioControls({
    elements: {
      _radioPanel: document.createElement('section'),
      // A bare tuner slider: the panel's tuner has its own tests.
      _radioTunerSlider: Object.assign(document.createElement('input'), {
        type: 'range',
      }),
      _cockpitUtilityControls: $('cockpit-utility-controls'),
      _cockpitDisplayToggleBtn: $('cockpit-display-toggle-btn'),
      _cockpitRadioToggleBtn: $('cockpit-radio-toggle-btn'),
      _cockpitRadioEnableBtn: $('cockpit-radio-enable-btn'),
    },
    radio: {
      subscribe: () => () => {},
      endTuning() {},
      getTunerStations: () => [],
      getUIState: () => ui,
      cycleStation: (direction, { rotate }) =>
        calls.push(['cycle', direction, rotate]),
      togglePlayback: () => calls.push(['playback']),
    },
    actions,
    canvas: document.createElement('canvas'),
    store: useRadioStore(pinia),
  });
  t.after(() => {
    controls.destroy();
    app.unmount();
  });
  const render = async (state) => {
    renderRadioState.call(controls, {
      enabled: true,
      categories: [{ id: 'all', label: 'All', count: 3, color: '' }],
      filter: 'all',
      filteredCount: 3,
      stationCount: 3,
      volume: 0.8,
      audioState: 'stopped',
      ...state,
    });
    await nextTick();
  };
  return {
    $,
    controls,
    calls,
    ui,
    render,
    outside,
    finishToggle: () => finishToggle(),
    toggles: () => toggles,
  };
}

const control = (button) => button.closest('.cockpit-utility-control');

test('before RadioControls presents, both popovers are closed and the controls start idle', (t) => {
  const { $ } = fixture(t);
  for (const kind of ['display', 'radio']) {
    const toggle = $(`cockpit-${kind}-toggle-btn`);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.textContent, '◀');
    assert.equal($(`cockpit-${kind}-panel`).hidden, true);
    assert.equal(control(toggle).classList.contains('is-expanded'), false);
  }
  assert.equal(
    $('cockpit-display-toggle-btn').getAttribute('aria-label'),
    'Expand Cockpit display options',
  );
  assert.equal(
    $('cockpit-radio-toggle-btn').title,
    'Expand Cockpit Radio controls',
  );
  assert.equal($('cockpit-radio-station').textContent, 'READY');
  const enable = $('cockpit-radio-enable-btn');
  assert.equal(enable.textContent, 'ENABLE');
  assert.equal(enable.getAttribute('aria-pressed'), 'false');
  assert.equal(enable.hasAttribute('aria-busy'), false);
  assert.equal($('cockpit-radio-play-btn').disabled, true);
  assert.equal($('cockpit-radio-play-btn').textContent, '▶');
  assert.equal($('cockpit-radio-volume').value, '80');
  assert.equal($('cockpit-radio-volume').disabled, true);
  assert.equal($('cockpit-radio-volume-value').textContent, '80%');
  assert.equal(
    document.querySelectorAll('[data-cockpit-display-slot]').length,
    4,
  );
});

test('a launcher opens its popover, closes the other, and Escape returns focus', async (t) => {
  const { $, controls, calls } = fixture(t);
  // The application shell takes the Display launcher's clicks.
  controls._setCockpitDisclosure('display', true);
  await nextTick();
  assert.equal(controls._cockpitDisclosureOpen('display'), true);
  assert.equal($('cockpit-display-panel').hidden, false);
  assert.equal($('cockpit-display-toggle-btn').textContent, '▶');
  assert.equal(
    $('cockpit-display-toggle-btn').getAttribute('aria-label'),
    'Collapse Cockpit display options',
  );
  assert.equal(
    control($('cockpit-display-toggle-btn')).classList.contains('is-expanded'),
    true,
  );
  assert.deepEqual(calls.slice(0, 2), [['signal', true], ['reveal']]);
  $('cockpit-radio-toggle-btn').click();
  await nextTick();
  assert.equal($('cockpit-display-panel').hidden, true);
  assert.equal($('cockpit-radio-panel').hidden, false);
  assert.equal(
    $('cockpit-radio-toggle-btn').getAttribute('aria-expanded'),
    'true',
  );
  $('cockpit-radio-play-btn').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await nextTick();
  assert.equal($('cockpit-radio-panel').hidden, true);
  assert.equal(document.activeElement === $('cockpit-radio-toggle-btn'), true);
  assert.deepEqual(calls.at(-1), ['signal', false]);
});

test('a press outside the Cockpit controls closes the open popover', async (t) => {
  const { $, controls, outside } = fixture(t);
  controls._setCockpitDisclosure('radio', true);
  await nextTick();
  $('cockpit-radio-volume').dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true }),
  );
  await nextTick();
  assert.equal($('cockpit-radio-panel').hidden, false);
  outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await nextTick();
  assert.equal($('cockpit-radio-panel').hidden, true);
  assert.equal(controls._cockpitDisclosureOpen('radio'), false);
});

test('the compact controls render the presented Radio state', async (t) => {
  const { $, render } = fixture(t);
  await render({
    selected: { id: 's1', name: 'KUTX' },
    audioState: 'playing',
    volume: 0.35,
  });
  assert.equal($('cockpit-radio-station').textContent, 'KUTX');
  const enable = $('cockpit-radio-enable-btn');
  assert.equal(enable.textContent, 'DISABLE');
  assert.equal(enable.classList.contains('active'), true);
  assert.equal(enable.classList.contains('panel-layer-toggle'), true);
  assert.equal(enable.getAttribute('aria-pressed'), 'true');
  assert.equal(enable.getAttribute('aria-label'), 'Disable Radio');
  assert.equal(enable.getAttribute('aria-busy'), 'false');
  assert.equal(enable.disabled, false);
  const play = $('cockpit-radio-play-btn');
  assert.equal(play.disabled, false);
  assert.equal(play.textContent, 'Ⅱ');
  assert.equal(play.classList.contains('active'), true);
  assert.equal(play.getAttribute('aria-label'), 'Pause selected radio station');
  assert.equal(play.title, 'Pause');
  assert.equal($('cockpit-radio-prev-btn').disabled, false);
  assert.equal($('cockpit-radio-volume').value, '35');
  assert.equal($('cockpit-radio-volume').disabled, false);
  assert.equal($('cockpit-radio-volume-value').textContent, '35%');
  await render({ enabled: false, selected: null, loading: true });
  assert.equal($('cockpit-radio-station').textContent, 'SYNCING');
  assert.equal(enable.textContent, 'ENABLE');
  assert.equal(enable.classList.contains('active'), false);
  assert.equal(play.disabled, true);
  assert.equal(play.textContent, '▶');
  assert.equal($('cockpit-radio-volume').disabled, true);
});

test('dragging the volume shows the value at once and a render leaves the held slider alone', async (t) => {
  const { $, calls, render } = fixture(t);
  await render({ volume: 0.8 });
  const volume = $('cockpit-radio-volume');
  volume.focus();
  volume.value = '42';
  volume.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  assert.equal($('cockpit-radio-volume-value').textContent, '42%');
  assert.deepEqual(calls.at(-1), ['params', { volume: 0.42 }]);
  // A render reporting an older volume while the slider is held.
  await render({ volume: 0.8 });
  assert.equal(volume.value, '42');
});

test('the compact transport steps stations without rotating the camera', (t) => {
  const { $, calls } = fixture(t);
  for (const id of [
    'cockpit-radio-prev-btn',
    'cockpit-radio-play-btn',
    'cockpit-radio-next-btn',
  ]) {
    $(id).disabled = false;
    $(id).click();
  }
  assert.deepEqual(calls, [
    ['cycle', -1, false],
    ['playback'],
    ['cycle', 1, false],
  ]);
});

test('the station filter answers with the tag the directory keeps', (t) => {
  const { controls, calls, ui } = fixture(t);
  assert.equal(controls.store.act('setRadioFilter', 'jazz'), 'jazz');
  assert.equal(controls.store.act('setRadioFilter', 'refused'), 'all');
  ui.presentationActive = false;
  assert.equal(controls.store.act('setRadioFilter', 'rock'), 'all');
  assert.deepEqual(calls, [
    ['params', { filter: 'jazz' }],
    ['params', { filter: 'refused' }],
  ]);
});

test('a destroyed RadioControls answers no controls', (t) => {
  const { controls, calls } = fixture(t);
  controls.destroy();
  assert.equal(controls.store.act('setRadioFilter', 'jazz'), undefined);
  controls.store.act('cycleRadio', 1);
  assert.deepEqual(calls, []);
});

test('the Cockpit Enable button is marked busy while its own toggle runs', async (t) => {
  const { $, render, finishToggle, toggles } = fixture(t);
  await render({ enabled: false });
  const enable = $('cockpit-radio-enable-btn');
  // A double press lands before the busy state renders; only one toggle runs.
  enable.click();
  enable.click();
  assert.equal(toggles(), 1);
  await nextTick();
  assert.equal(enable.getAttribute('aria-busy'), 'true');
  assert.equal(enable.getAttribute('aria-disabled'), 'true');
  assert.equal(enable.disabled, false);
  // A second press while busy starts nothing.
  enable.click();
  assert.equal(toggles(), 1);
  finishToggle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.equal(enable.getAttribute('aria-busy'), 'false');
});

test('the launchers read in the UI language', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('ru');
  const { $, controls } = fixture(t);
  const before = $('cockpit-radio-toggle-btn').getAttribute('aria-label');
  controls._setCockpitDisclosure('radio', true);
  await nextTick();
  const after = $('cockpit-radio-toggle-btn').getAttribute('aria-label');
  assert.notEqual(before, 'Expand Cockpit Radio controls');
  assert.notEqual(after, before);
  assert.notEqual(after, 'Collapse Cockpit Radio controls');
});

test('Cockpit Escape defers to a popover the moment its disclosure opens', async (t) => {
  const { controls } = fixture(t);
  let exits = 0;
  const cockpit = {
    active: true,
    isUtilityDisclosureOpen: () =>
      controls._cockpitDisclosureOpen('display') ||
      controls._cockpitDisclosureOpen('radio'),
    exit: () => (exits += 1),
  };
  const escape = () =>
    cockpitKeyDown.call(
      cockpit,
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  // Dispatched in the same task, before Vue renders the open popover.
  controls._setCockpitDisclosure('radio', true);
  escape();
  assert.equal(exits, 0);
  controls._setCockpitDisclosure('radio', false);
  escape();
  assert.equal(exits, 1);
  await nextTick();
});

test('the layout pass’s measured fit hides the collapsed control and marks the strip', async () => {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CockpitUtilityControls).use(pinia);
  app.mount(host);
  const radio = useRadioStore(pinia);
  const cockpit = useCockpitStore(pinia);
  const strip = document.getElementById('cockpit-utility-controls');
  const [display, radioControl] = strip.querySelectorAll(
    '.cockpit-utility-control',
  );
  const layout = (fit) => ({
    top: '96.0px',
    maxHeight: '300.00px',
    expandedMaxHeight: '300.00px',
    primaryOnly: false,
    hideCollapsed: false,
    ...fit,
  });
  // Until the layout pass runs, neither control carries aria-hidden.
  assert.equal(display.hasAttribute('aria-hidden'), false);
  radio.publishUtility({ display: false, radio: true });
  cockpit.publishUtilityLayout(
    layout({ primaryOnly: true, hideCollapsed: true }),
  );
  await nextTick();
  assert.equal(strip.classList.contains('layout-primary-only'), true);
  assert.equal(display.getAttribute('aria-hidden'), 'true');
  assert.equal(radioControl.getAttribute('aria-hidden'), 'false');
  // With nothing expanded there is no collapsed sibling to hide.
  radio.publishUtility({ display: false, radio: false });
  await nextTick();
  assert.equal(display.getAttribute('aria-hidden'), 'false');
  cockpit.publishUtilityLayout(layout());
  await nextTick();
  assert.equal(strip.classList.contains('layout-primary-only'), false);
  app.unmount();
});

test('the real layout pass drives the mounted controls: compact hides the collapsed sibling, Cyber shows both', async (t) => {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CockpitUtilityControls).use(pinia);
  app.mount(host);
  const radio = useRadioStore(pinia);
  const cockpit = useCockpitStore(pinia);
  const signalStream = document.body.appendChild(
    document.createElement('aside'),
  );
  const owner = {
    signalStream,
    signalCollapsed: false,
    contextCollapsed: false,
    context: null,
    publishUtilityLayout: (layout) => cockpit.publishUtilityLayout(layout),
    syncContextLayout() {},
  };
  const originalMatchMedia = window.matchMedia;
  let compact = true;
  window.matchMedia = (query) => ({ matches: compact, media: query });
  t.after(() => {
    window.matchMedia = originalMatchMedia;
    delete document.documentElement.dataset.uiTheme;
    document.body.style.removeProperty('opacity');
    document.documentElement.style.removeProperty('opacity');
    app.unmount();
  });
  const strip = document.getElementById('cockpit-utility-controls');
  const [display, radioControl] = strip.querySelectorAll(
    '.cockpit-utility-control',
  );
  radio.publishUtility({ display: false, radio: true });
  await nextTick();
  syncSignalLayout.call(owner);
  await nextTick();
  assert.equal(display.getAttribute('aria-hidden'), 'true');
  assert.equal(radioControl.getAttribute('aria-hidden'), 'false');
  assert.equal(cockpit.utilityLayout.top, null);
  // Compact hides the sibling without marking the strip primary-only.
  assert.equal(strip.classList.contains('layout-primary-only'), false);
  // Cyber aligns the strip with the Data panel and keeps both controls.
  compact = false;
  document.documentElement.dataset.uiTheme = 'cyber';
  const stack = document.body.appendChild(document.createElement('div'));
  stack.id = 'left-panel-stack';
  const dataPanel = stack.appendChild(document.createElement('section'));
  dataPanel.id = 'data-panel';
  for (const node of [
    dataPanel,
    stack,
    document.body,
    document.documentElement,
  ])
    node.style.opacity = '1';
  dataPanel.getBoundingClientRect = () => ({
    top: 120,
    bottom: 400,
    left: 0,
    right: 200,
    width: 200,
    height: 280,
  });
  syncSignalLayout.call(owner);
  await nextTick();
  assert.equal(display.getAttribute('aria-hidden'), 'false');
  assert.equal(radioControl.getAttribute('aria-hidden'), 'false');
  assert.equal(cockpit.utilityLayout.top, '120.00px');
  assert.equal(strip.classList.contains('layout-primary-only'), false);
});
