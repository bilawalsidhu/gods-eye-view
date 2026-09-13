import { readFileSync as readRadioSource } from 'node:fs';
const radioBindings = readRadioSource(new URL('./ui/radioBindings.js', import.meta.url), 'utf8');
const radioPresentation = readRadioSource(new URL('./ui/radioPresentation.js', import.meta.url), 'utf8');
const radioControlsSource = readRadioSource(new URL('./ui/radioControls.js', import.meta.url), 'utf8');
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

test('Contacts and Space Missions both participate in the ordinary Tab sequence', () => {
  for (const id of ['global-context-flights-btn', 'global-context-missions-btn']) {
    const button = html.match(new RegExp(`<button id="${id}"[\\s\\S]*?</button>`));
    assert.ok(button, `${id} is missing`);
    assert.match(button[0], /role="tab"/);
    assert.match(button[0], /tabindex="0"/);
  }

  const sync = ui.match(/_syncContextModeButtons\(\) \{([\s\S]*?)\n  \}\n\n  \/\*\* Wire/);
  assert.ok(sync, 'Context mode sync is missing');
  assert.match(sync[1], /\[this\._globalContextFlightsBtn, this\._globalContextMissionsBtn\]/);
  assert.match(sync[1], /button\.tabIndex = 0/);
  assert.doesNotMatch(sync[1], /tabIndex\s*=\s*[^;]*\?\s*-1/);
});

test('Context transition state preserves focus and Tab availability until settle', () => {
  const sync = ui.match(/_syncContextModeButtons\(\) \{([\s\S]*?)\n  \}\n\n  \/\*\* Wire/);
  assert.ok(sync, 'Context mode sync is missing');

  const attributes = () => new Map();
  const makeButton = () => {
    const attrs = attributes();
    let disabled = false;
    const button = {
      attrs,
      tabIndex: -1,
      classList: { toggle() {} },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      get disabled() { return disabled; },
      set disabled(value) {
        disabled = Boolean(value);
        // Model the browser behavior that exposed this regression: native
        // disabled drops focus immediately.
        if (disabled && globalThis.document?.activeElement === button) {
          globalThis.document.activeElement = null;
        }
      },
    };
    return button;
  };
  const contacts = makeButton();
  const missions = makeButton();
  const panel = { classList: { toggle() {} }, setAttribute() {} };
  const priorDocument = globalThis.document;
  globalThis.document = { activeElement: missions, getElementById: () => panel };
  const owner = {
    _contextMode: null,
    _contextModeChanging: true,
    _globalContextFlightsBtn: contacts,
    _globalContextMissionsBtn: missions,
    _contextModeStandby: {},
    _contextFlightsView: {},
    _contextMissionsView: {},
    cockpitView: { syncEntry() {} },
    _syncContactsDetection() {},
    _scheduleRightPanelLayout() {},
  };
  try {
    Function(sync[1]).call(owner);
    assert.equal(globalThis.document.activeElement, missions, 'busy sync retains focused Space Missions');
    for (const button of [contacts, missions]) {
      assert.equal(button.disabled, false);
      assert.equal(button.tabIndex, 0);
      assert.equal(button.attrs.get('aria-disabled'), 'true');
      assert.equal(button.attrs.get('aria-busy'), 'true');
    }

    owner._contextModeChanging = false;
    owner._contextMode = 'space-missions';
    Function(sync[1]).call(owner);
    assert.equal(globalThis.document.activeElement, missions, 'settled sync retains focused Space Missions');
    for (const button of [contacts, missions]) {
      assert.equal(button.disabled, false);
      assert.equal(button.tabIndex, 0);
      assert.equal(button.attrs.get('aria-disabled'), 'false');
      assert.equal(button.attrs.get('aria-busy'), 'false');
    }
  } finally {
    globalThis.document = priorDocument;
  }
});

test('Context activation and Clear All never native-disable tabs and guard repeated clicks', () => {
  const init = ui.slice(
    ui.indexOf('_initGlobalContextPanel() {'),
    ui.indexOf('async _runUserFacingContextAction(', ui.indexOf('_initGlobalContextPanel() {')),
  );
  const select = ui.slice(
    ui.indexOf('async _selectContextMode('),
    ui.indexOf('async _deactivateContextForLayerChange(', ui.indexOf('async _selectContextMode(')),
  );
  const clear = ui.slice(
    ui.indexOf('clearSelectedLayers() {'),
    ui.indexOf('resetToGlobeView() {', ui.indexOf('clearSelectedLayers() {')),
  );
  assert.equal((init.match(/if \(this\._contextModeChanging \|\| this\._clearSelectedLayersPromise\) return;/g) || []).length, 2);
  assert.doesNotMatch(select, /_globalContext(?:Flights|Missions)Btn\.disabled\s*=\s*true/);
  assert.doesNotMatch(clear, /_globalContext(?:Flights|Missions)Btn\.disabled\s*=\s*true/);
});

test('Context tablist retains Left, Right, Home, and End keyboard navigation', () => {
  const init = ui.match(/_initGlobalContextPanel\(\) \{([\s\S]*?)\n    this\._globalContextFlightsBtn\?\.addEventListener/);
  assert.ok(init, 'Context panel initialization is missing');
  assert.match(init[1], /event\.key === 'ArrowRight'/);
  assert.match(init[1], /event\.key === 'ArrowLeft'/);
  assert.match(init[1], /event\.key === 'Home'/);
  assert.match(init[1], /event\.key === 'End'/);
  assert.match(init[1], /contextTabs\[nextIndex\]\.focus\(\{ preventScroll: true \}\)/);
  assert.match(init[1], /contextTabs\[nextIndex\]\.click\(\)/);
});

test('Context tabs draw a visible keyboard-focus outline including active tabs', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const focusRule = rules.find(([, selector, body]) => (
    selector.trim().endsWith('.context-mode-button:focus-visible')
      && /outline:\s*2px solid var\(--text-primary\)/.test(body)
  ));
  assert.ok(focusRule, 'Context focus-visible rule must draw a two-pixel outline');
  assert.match(focusRule[2], /outline-offset:\s*-3px/);

  const activeRule = rules.find(([, selector]) => selector.trim().endsWith('.context-mode-button.active'));
  assert.ok(activeRule, 'Context active-state rule is missing');
  assert.doesNotMatch(activeRule[2], /outline:\s*none/);
});

test('Context async action buttons remain focused while busy', () => {
  const init = ui.slice(
    ui.indexOf('_initGlobalContextPanel() {'),
    ui.indexOf('async _runUserFacingContextAction(', ui.indexOf('_initGlobalContextPanel() {')),
  );
  const radio = radioBindings.slice(radioBindings.indexOf('const toggleRadio = async (trigger) => {'), radioBindings.indexOf('this.listen(this._contextRadioToggleBtn,'));
  const radioSync = radioPresentation.slice(0, radioPresentation.indexOf('if (this._radioFilter)'));
  const clear = ui.slice(
    ui.indexOf('clearSelectedLayers() {'),
    ui.indexOf('resetToGlobeView() {', ui.indexOf('clearSelectedLayers() {')),
  );

  assert.match(init, /button\.getAttribute\('aria-busy'\) === 'true'/);
  assert.doesNotMatch(init, /button\.disabled\s*=\s*true/);
  assert.match(radio, /trigger\.getAttribute\('aria-busy'\) === 'true'/);
  assert.doesNotMatch(radio, /trigger\.disabled\s*=\s*true/);
  for (const name of ['_radioEnableBtn', '_contextRadioMiniEnableBtn', '_cockpitRadioEnableBtn']) {
    assert.match(radioSync, new RegExp(`${name}\\.disabled = false`));
  }
  assert.doesNotMatch(clear, /_clearSelectedLayersBtn\.disabled\s*=\s*true/);
  assert.match(clear, /_clearLayersControl\?\.setBusy\(true\)/);
  const control = readFileSync(new URL('./ui/clearLayersControl.js', import.meta.url), 'utf8');
  assert.match(control, /button\.setAttribute\('aria-busy', String\(busy\)\)/);
  assert.doesNotMatch(control, /button\.disabled\s*=/);
});
