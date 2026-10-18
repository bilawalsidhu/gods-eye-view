import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCyberSonarControlState,
  setCyberSonarControls,
} from './cyberSonarControls.js';
import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { StyleManager } from './applicationShell.js';
import { VisualSettings } from './visualSettings.js';
import { readFileSync } from 'node:fs';

function fixture(theme = 'cyber') {
  const root = {
    dataset: { uiTheme: theme, cyberSonarGpu: 'supported' },
    style: { setProperty() {} },
  };
  const flags = new Set();
  const hudFlags = new Set(['active']);
  const doc = {
    documentElement: root,
    body: { classList: { contains: (name) => flags.has(name) } },
    getElementById: () => ({
      classList: { contains: (name) => hudFlags.has(name) },
    }),
  };
  const calls = [];
  const owner = {
    hud: { getVariant: () => theme },
    _setCyberSonarSetting(name, value) {
      calls.push([name, value]);
      const suffix = name[0].toUpperCase() + name.slice(1);
      root.dataset['cyberSonar' + suffix] = String(value);
    },
    _setCyberSonarEnabled(value) {
      calls.push(['enabled', value]);
      root.dataset.cyberSonar = value ? 'on' : 'off';
    },
  };
  return { doc, owner, calls, flags, hudFlags, root };
}

test('real runner and facade use visual settings, preserve visibility and return actual values', async () => {
  const f = fixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.doc;
  const renders = [];
  const visual = Object.create(VisualSettings.prototype);
  visual.services = { governorRequestRender: (reason) => renders.push(reason) };
  const owner = Object.create(StyleManager.prototype);
  owner._visualSettings = visual;
  Object.defineProperty(owner, 'hud', { value: f.owner.hud });
  const viewer = {
    camera: { moveEnd: { addEventListener() {} } },
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: new EventTarget() },
  };
  try {
    const runner = createGevActionRunner({ styleManager: owner, viewer, dataManager: {} });
    const result = await runner('set_cyber_sonar', { enabled: false, intensityPct: 73, sectorDeg: 9 });
    assert.equal(result.ok, true);
    assert.equal(result.sonar.intensityPct, 73);
    assert.equal(result.sonar.sectorDeg, 9);
    assert.equal(result.sonar.enabled, false);
    assert.equal(f.root.dataset.uiTheme, 'cyber');
    assert.equal(f.hudFlags.has('active'), true);
    assert.equal(renders.length, 3);
    const before = getCyberSonarControlState();
    const invalid = await runner('set_cyber_sonar', { rings: 6, opacityPct: 0 });
    assert.equal(invalid.ok, false);
    assert.deepEqual(getCyberSonarControlState(), before);
    assert.equal(renders.length, 3);
    const zero = await runner('set_cyber_sonar', { intensityPct: 0 });
    assert.equal(zero.sonar.intensityPct, 0);
    assert.equal(zero.sonar.enabled, false);
    const unavailable = createGevActionRunner({ styleManager: {}, viewer, dataManager: {} });
    assert.equal((await unavailable('set_cyber_sonar', { enabled: true })).ok, false);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('native sonar sliders represent every accepted integer without browser snapping', () => {
  const html = readFileSync(new URL('./templates/display-controls.html', import.meta.url), 'utf8');
  for (const name of ['rings', 'range', 'intensity', 'opacity', 'sector']) {
    assert.match(html, new RegExp(`id="cyber-sonar-${name}"[^>]*step="1"`));
  }
});

test('sonar action is available to both shared and server voice schemas', () => {
  for (const tools of [GEV_ACTION_SCHEMAS, GEV_REALTIME_TOOLS]) {
    const action = tools.find((tool) => tool.name === 'set_cyber_sonar');
    assert.ok(action);
    assert.equal(action.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(action.parameters.properties), [
      'enabled', 'rings', 'rangePct', 'intensityPct', 'opacityPct', 'sectorDeg',
    ]);
    assert.equal(action.parameters.properties.intensityPct.minimum, 0);
    assert.equal(action.parameters.properties.opacityPct.minimum, 35);
  }
});

test('maps all settings to the slider owner and reads actual state, including zero', () => {
  const f = fixture();
  const result = setCyberSonarControls(f.owner, {
    enabled: false, rings: 6, rangePct: 80,
    intensityPct: 0, opacityPct: 90, sectorDeg: 30,
  }, f.doc);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, [
    ['rings', 6], ['range', 80], ['intensity', 0],
    ['opacity', 90], ['sector', 30], ['enabled', false],
  ]);
  assert.equal(result.sonar.enabled, false);
  assert.equal(result.sonar.intensityPct, 0);
  assert.equal(result.sonar.contactSweepActive, false);
  assert.deepEqual(result.sonar, getCyberSonarControlState(f.doc));
});

test('rejects the whole invalid request before any mutation', () => {
  for (const request of [
    {}, null, [], { enabled: 'false' }, { rings: 2 }, { rangePct: 121 },
    { opacityPct: NaN }, { intensityPct: Infinity }, { sectorDeg: 8.5 },
    { intensityPct: '50' }, { enabled: false, unknown: 1 },
    { rings: 6, sectorDeg: 61 },
  ]) {
    const f = fixture();
    assert.equal(setCyberSonarControls(f.owner, request, f.doc).ok, false);
    assert.deepEqual(f.calls, []);
  }
});

test('requires Cyber and preserves off state and every omitted setting', () => {
  for (const theme of ['tactical', 'operator', 'minimal']) {
    const f = fixture(theme);
    assert.equal(setCyberSonarControls(f.owner, { enabled: true }, f.doc).ok, false);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.root.dataset.cyberSonar = 'off';
  const before = getCyberSonarControlState(f.doc);
  const result = setCyberSonarControls(f.owner, { rings: 12 }, f.doc);
  assert.deepEqual(result.sonar, { ...before, rings: 12 });
  assert.deepEqual(f.calls, [['rings', 12]]);
});

test('reports inactive map effects in Cockpit, hidden HUD, unsupported and uninitialized GPU', () => {
  const f = fixture();
  f.flags.add('cockpit-mode');
  assert.equal(getCyberSonarControlState(f.doc).mapSweepActive, false);
  f.flags.clear();
  f.hudFlags.clear();
  assert.equal(getCyberSonarControlState(f.doc).contactSweepActive, false);
  f.hudFlags.add('active');
  for (const value of ['unsupported', undefined]) {
    if (value === undefined) delete f.root.dataset.cyberSonarGpu;
    else f.root.dataset.cyberSonarGpu = value;
    assert.equal(getCyberSonarControlState(f.doc).contactSweepActive, false);
  }
});
