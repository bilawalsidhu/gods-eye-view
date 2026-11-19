import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CYBER_SONAR_RENDER_INTERVAL_MS,
  applyCyberSonarSettings,
  createCyberSonarSampler,
  cyberSonarIntensityAtScreenPoint,
  cyberSonarSector,
  isCyberContactSonarActive,
  isCyberSonarActive,
} from './cyberSonar.js';
import { createCyberSonarScene } from './cyberSonarScene.js';
import { bindRenderer } from './render/rendererOf.js';

test('frame sampler matches reference without per-contact settings access', () => {
  let reads = 0;
  const values = {
    cyberSonarOpacity: '62',
    cyberSonarSector: '40',
    cyberSonarRange: '110',
  };
  const root = {
    dataset: new Proxy(values, {
      get(o, k) {
        reads++;
        return o[k];
      },
    }),
  };
  const frame = createCyberSonarSampler(1000, 800, 1234, root),
    once = reads;
  for (let x = 0; x < 1000; x += 33)
    for (let y = 0; y < 800; y += 31) frame.at(x, y);
  assert.equal(reads, once);
  for (let x = 0; x < 1000; x += 33)
    for (let y = 0; y < 800; y += 31)
      assert.ok(
        Math.abs(
          frame.at(x, y) -
            cyberSonarIntensityAtScreenPoint(x, y, 1000, 800, 1234, {
              dataset: values,
            }),
        ) < 1e-10,
      );
});

test('removed CSS mode cannot disable GPU contacts; unsupported renderers fail closed', () => {
  const root = { dataset: { cyberSonar: 'on' }, style: { setProperty() {} } };
  const options = {
    root,
    body: { classList: { contains: () => false } },
    hud: { classList: { contains: () => true } },
    reducedMotion: false,
  };
  root.dataset.cyberSonarMode = 'css';
  assert.equal(applyCyberSonarSettings({ mode: 'css' }, root).mode, undefined);
  assert.equal(root.dataset.cyberSonarMode, undefined);
  assert.equal(isCyberSonarActive(options), true);
  assert.equal(isCyberContactSonarActive(options), true);
  assert.equal(
    applyCyberSonarSettings({ mode: 'invalid' }, root).mode,
    undefined,
  );
  assert.equal(isCyberContactSonarActive(options), true);
  root.dataset.cyberSonarGpu = 'unsupported';
  assert.equal(isCyberContactSonarActive(options), false);
});

test('the sector is the sweep the HUD shows, in CSS pixels and radians', () => {
  const root = {
    dataset: {
      cyberSonarOpacity: '62',
      cyberSonarSector: '40',
      cyberSonarRange: '110',
    },
  };
  const s = cyberSonarSector(1000, 800, 1300, { root });
  assert.deepEqual(s.center, { x: 500, y: 400 });
  assert.ok(Math.abs(s.angle - Math.PI / 2) < 1e-9, 'a quarter period');
  assert.ok(Math.abs(s.width - (40 * Math.PI) / 180) < 1e-12);
  assert.ok(Math.abs(s.radius - 440) < 1e-9);
  assert.equal(s.floor, 0.62);
  assert.equal(s.strength, 0.72);
  assert.equal(s.color, '#ffd6d6');
  const rest = cyberSonarSector(1000, 800, 1300, { root, sweeping: false });
  assert.equal(rest.radius, 0);
  assert.ok(Math.abs(rest.floor - (0.62 + 0.38 * 0.46)) < 1e-12);
});

/**
 * A document with the Cyber HUD shown, and a renderer fake bound to a
 * viewer: its frame's preUpdate is ticked by hand and its effects record
 * each sector.
 */
function fixture({ modulation = true, lists = true } = {}) {
  const previous = {
    document: globalThis.document,
    matchMedia: globalThis.matchMedia,
  };
  const root = { dataset: { cyberSonar: 'on' } };
  const status = { textContent: '' };
  const state = { cockpit: false, reducedMotion: false };
  globalThis.document = {
    documentElement: root,
    body: { classList: { contains: () => state.cockpit } },
    getElementById: (id) =>
      id === 'cyber-sonar-status'
        ? status
        : { classList: { contains: () => true } },
  };
  globalThis.matchMedia = () => ({ matches: state.reducedMotion });
  const ticks = new Set();
  const changes = new Set();
  const sets = [];
  const requests = [];
  let drawing = null;
  const effects = {
    diagnostics: () => ({
      style: null,
      passes: drawing && lists ? ['screenModulation'] : [],
    }),
    on(event, cb) {
      changes.add(cb);
      return () => changes.delete(cb);
    },
  };
  if (modulation)
    effects.screenModulation = (sector) => {
      const was = effects.diagnostics().passes.length;
      drawing = sector;
      sets.push(sector);
      if (effects.diagnostics().passes.length !== was)
        for (const cb of [...changes]) cb(effects.diagnostics());
    };
  const canvas = { clientWidth: 1000, clientHeight: 800 };
  const viewer = {};
  const unbind = bindRenderer(viewer, {
    canvas,
    effects,
    frame: {
      on(phase, cb) {
        assert.equal(phase, 'preUpdate');
        ticks.add(cb);
        return () => ticks.delete(cb);
      },
      requestRender: (reason) => requests.push(reason),
    },
  });
  return {
    root,
    status,
    state,
    sets,
    requests,
    canvas,
    viewer,
    ticks,
    changes,
    effects,
    tick(rendering = false) {
      for (const cb of [...ticks]) cb({ rendering });
    },
    restore() {
      unbind();
      globalThis.document = previous.document;
      globalThis.matchMedia = previous.matchMedia;
    },
  };
}

test('a renderer without the capability leaves markers alone and says so', () => {
  const f = fixture({ modulation: false });
  try {
    const dispose = createCyberSonarScene(f.viewer);
    assert.equal(f.root.dataset.cyberSonarGpu, 'unsupported');
    assert.match(f.status.textContent, /Native contacts remain visible/);
    f.tick(true);
    assert.equal(f.changes.size, 0);
    dispose();
    assert.equal(f.ticks.size, 0);
    assert.equal(f.root.dataset.cyberSonarGpu, undefined);
  } finally {
    f.restore();
  }
});

test('the HUD sweep keeps its clock while markers cannot be shaded', () => {
  const f = fixture({ modulation: false });
  const animation = {
    animationName: 'cyber-sonar-sweep',
    playState: 'running',
    startTime: 500,
    effect: { updateTiming() {} },
  };
  f.root.querySelector = (selector) =>
    selector === '.hud-sonar'
      ? { isConnected: true, getAnimations: () => [animation] }
      : null;
  try {
    const dispose = createCyberSonarScene(f.viewer);
    f.tick(false);
    assert.equal(animation.startTime, 0);
    assert.equal(f.root.dataset.cyberSonarGpu, 'unsupported');
    dispose();
  } finally {
    f.restore();
  }
});

test('the sweep sets its sector on drawing ticks and at the cadence, and changes at once', () => {
  const f = fixture();
  const now = performance.now;
  let clock = 1000;
  performance.now = () => clock;
  try {
    const dispose = createCyberSonarScene(f.viewer);
    assert.equal(f.root.dataset.cyberSonarGpu, 'supported');
    assert.equal(f.status.textContent, '');
    f.tick();
    assert.equal(f.sets.length, 1, 'the theme sets a sector');
    assert.deepEqual(f.sets[0], cyberSonarSector(1000, 800, 1000));
    clock += 10;
    f.tick(false);
    assert.equal(f.sets.length, 1, 'an idle tick before the cadence sets none');
    f.tick(true);
    assert.equal(f.sets.length, 2, 'a tick that draws moves the angle');
    assert.deepEqual(f.sets[1], cyberSonarSector(1000, 800, 1010));
    clock += CYBER_SONAR_RENDER_INTERVAL_MS;
    f.tick(false);
    assert.equal(f.sets.length, 3, 'the cadence moves it on an idle tick');
    f.canvas.clientWidth = 600;
    f.tick(false);
    assert.equal(f.sets.length, 4, 'a resize sets it at once');
    assert.deepEqual(f.sets[3].center, { x: 300, y: 400 });
    f.root.dataset.cyberSonarOpacity = '50';
    f.tick(false);
    assert.equal(f.sets.length, 5, 'a setting change sets it at once');
    assert.equal(
      f.sets[4].floor,
      0.5,
      'while sweeping the floor is the opacity',
    );
    f.state.reducedMotion = true;
    f.tick(false);
    assert.equal(f.sets[5].radius, 0, 'reduced motion rests the sweep');
    assert.equal(f.sets[5].floor, 0.5 + 0.5 * 0.46, 'at rest it lifts');
    clock += 1000;
    f.tick(true);
    f.tick(false);
    assert.equal(f.sets.length, 6, 'at rest only changes set it');
    f.state.reducedMotion = false;
    f.state.cockpit = true;
    f.tick(false);
    assert.equal(f.sets[6], null, 'out of the map it clears');
    f.tick(true);
    assert.equal(f.sets.length, 7, 'cleared once');
    f.state.cockpit = false;
    f.root.dataset.cyberSonar = 'off';
    f.tick(false);
    assert.equal(f.sets.length, 7, 'Sonar OFF leaves contacts untreated');
    f.root.dataset.cyberSonar = 'on';
    f.tick(false);
    assert.ok(f.sets[7]?.radius > 0, 'Sonar ON sweeps at once');
    f.root.dataset.cyberSonar = 'off';
    f.tick(false);
    assert.equal(f.sets[8], null, 'Sonar OFF clears it');
    f.tick(true);
    assert.equal(f.sets.length, 9);
    // The removed Cyber theme attribute alone does nothing.
    f.root.dataset.uiTheme = 'cyber';
    f.tick(false);
    assert.equal(f.sets.length, 9);
    f.root.dataset.cyberSonar = 'on';
    f.tick(false);
    assert.ok(f.sets[9]?.radius > 0, 'back on, it sweeps at once');
    assert.deepEqual(f.requests, [], 'the scene itself never asks for frames');
    dispose();
    assert.equal(f.sets[10], null, 'disposal clears it');
    assert.equal(f.ticks.size, 0);
    assert.equal(f.changes.size, 0);
    assert.equal(f.root.dataset.cyberSonarGpu, undefined);
    dispose();
    assert.equal(f.sets.length, 11);
  } finally {
    performance.now = now;
    f.restore();
  }
});

test('a sector the renderer does not list is unsupported: cleared, and the sweep stops', () => {
  const f = fixture({ lists: false });
  try {
    const dispose = createCyberSonarScene(f.viewer);
    f.tick(true);
    assert.equal(f.sets.length, 2);
    assert.equal(f.sets[1], null, 'cleared again');
    assert.equal(f.root.dataset.cyberSonarGpu, 'unsupported');
    assert.match(f.status.textContent, /Native contacts remain visible/);
    f.tick(true);
    assert.equal(f.sets.length, 2, 'never set again');
    dispose();
    assert.equal(f.sets.length, 2);
  } finally {
    f.restore();
  }
});

test('a pass the renderer stops drawing on its own stops the sweep', () => {
  const f = fixture();
  try {
    const dispose = createCyberSonarScene(f.viewer);
    f.tick(true);
    assert.equal(f.sets.length, 1);
    for (const cb of [...f.changes]) cb({ style: null, passes: [] });
    assert.equal(f.root.dataset.cyberSonarGpu, 'unsupported');
    assert.equal(f.sets.at(-1), null);
    const count = f.sets.length;
    f.tick(true);
    assert.equal(f.sets.length, count);
    dispose();
  } finally {
    f.restore();
  }
});

test('layer visibility changes ask for a frame', () => {
  const f = fixture();
  let listener = null;
  const manager = {
    subscribe(cb) {
      listener = cb;
      return () => (listener = null);
    },
  };
  try {
    const dispose = createCyberSonarScene(f.viewer, manager);
    listener({ type: 'visibility' });
    listener({ type: 'data' });
    assert.deepEqual(f.requests, ['cyber-sonar']);
    dispose();
    assert.equal(listener, null);
  } finally {
    f.restore();
  }
});
