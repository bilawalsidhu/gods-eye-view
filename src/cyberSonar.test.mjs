import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import {
  syncCyberSonarAnimation,
  applyCyberSonarThemePhase,
  createCyberSonarSampler,
  cyberSonarAngleDeg,
  cyberSonarAnimationDelay,
  cyberSonarFrameDelay,
  applyCyberSonarSettings,
  CYBER_SONAR_PERIOD_MS,
  isCyberSonarEnabled,
  isCyberSonarActive,
  setCyberSonarEnabled,
} from './cyberSonar.js';

test('production-transformed sonar defaults retain the document method receiver', async () => {
  const source = await readFile(
    new URL('./cyberSonar.js', import.meta.url),
    'utf8',
  );
  const { code } = await transformWithEsbuild(source, 'cyberSonar.js', {
    target: 'es2019',
    minify: true,
  });
  const compiled = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  );
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const hud = { classList: { contains: (name) => name === 'active' } };
  const document = {
    documentElement: { dataset: { cyberSonar: 'on' } },
    body: { classList: { contains: () => false } },
    getElementById(id) {
      assert.equal(this, document);
      assert.equal(id, 'intel-hud');
      return hud;
    },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document,
  });
  try {
    assert.equal(compiled.isCyberSonarActive(), true);
    assert.equal(compiled.isCyberMapThemeActive(), true);
    assert.ok(
      Number.isFinite(compiled.createCyberSonarSampler(800, 600).at(400, 300)),
    );
    document.documentElement.dataset.cyberSonar = 'off';
    assert.equal(compiled.isCyberSonarActive(), false);
    assert.equal(compiled.isCyberMapThemeActive(), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
});

test('the Cyber sonar clock advances clockwise and wraps cleanly', () => {
  assert.equal(cyberSonarAngleDeg(0), 0);
  assert.equal(cyberSonarAngleDeg(CYBER_SONAR_PERIOD_MS / 4), 90);
  assert.equal(cyberSonarAngleDeg(CYBER_SONAR_PERIOD_MS), 0);
  assert.equal(cyberSonarAnimationDelay(CYBER_SONAR_PERIOD_MS / 2), '-2600ms');
});

test('contact refresh cadence waits only until the next bounded sonar frame', () => {
  assert.equal(cyberSonarFrameDelay(1_000, 1_000), 80);
  assert.equal(cyberSonarFrameDelay(1_000, 1_035), 45);
  assert.equal(cyberSonarFrameDelay(1_000, 1_080), 0);
  assert.equal(cyberSonarFrameDelay(Number.NEGATIVE_INFINITY, 1_000), 0);
});

test('the sweep brightens contacts inside its sector and dims the remainder', () => {
  const width = 1_000;
  const height = 800;
  const centerX = width / 2;
  const centerY = height / 2;
  const at = (now) => createCyberSonarSampler(width, height, now, { dataset: {} }).at;

  assert.equal(at(0)(centerX, centerY - 200), 1);
  assert.equal(at(0)(centerX + 200, centerY), 0.84);
  assert.equal(at(CYBER_SONAR_PERIOD_MS / 4)(centerX + 200, centerY), 1);
  assert.equal(at(0)(centerX, centerY - 401), 0.84);
  assert.equal(at(0)(Number.NaN, 0), 1);
});

test('the sonar activates only while on, over a visible map HUD with motion enabled', () => {
  const root = { dataset: { cyberSonar: 'on' } };
  const classes = (...values) => ({
    contains: (value) => values.includes(value),
  });
  assert.equal(
    isCyberSonarActive({
      root,
      body: { classList: classes() },
      hud: { classList: classes('active') },
      reducedMotion: false,
    }),
    true,
  );
  assert.equal(
    isCyberSonarActive({
      root,
      body: { classList: classes('cockpit-mode') },
      hud: { classList: classes('active') },
      reducedMotion: false,
    }),
    false,
  );
  assert.equal(
    isCyberSonarActive({
      root,
      body: { classList: classes() },
      hud: { classList: classes('active') },
      reducedMotion: true,
    }),
    false,
  );
  root.dataset.cyberSonar = 'off';
  assert.equal(
    isCyberSonarActive({
      root,
      body: { classList: classes() },
      hud: { classList: classes('active') },
      reducedMotion: false,
    }),
    false,
  );
});

test('the opacity setting controls every contact floor and preserves brighter labels', () => {
  const values = new Map();
  const root = {
    dataset: {},
    style: { setProperty: (name, value) => values.set(name, value) },
  };
  const settings = applyCyberSonarSettings({ opacity: 62 }, root);
  assert.equal(settings.opacity, 62);
  assert.equal(root.dataset.cyberSonarOpacity, '62');
  const s = createCyberSonarSampler(1_000, 800, 0, root);
  assert.equal(s.at(900, 400), 0.62);
  assert.equal(s.label(0.62), 0.81);
});

test('the sonar control defaults off and records explicit operator state', () => {
  const root = { dataset: {} };
  assert.equal(isCyberSonarEnabled(root), false);
  // The removed Cyber theme no longer turns it on.
  root.dataset.uiTheme = 'cyber';
  assert.equal(isCyberSonarEnabled(root), false);
  assert.equal(setCyberSonarEnabled(true, root), true);
  assert.equal(root.dataset.cyberSonar, 'on');
  assert.equal(isCyberSonarEnabled(root), true);
  assert.equal(setCyberSonarEnabled(false, root), false);
  assert.equal(root.dataset.cyberSonar, 'off');
  assert.equal(isCyberSonarEnabled(root), false);
});

test('the sweep corrects delayed starts and reacquires restarted animations without per-frame writes', () => {
  let queries = 0,
    writes = 0;
  const makeAnimation = () => ({
    animationName: 'cyber-sonar-sweep',
    playState: 'running',
    startTime: 1800,
    effect: {
      updateTiming(value) {
        assert.deepEqual(value, { delay: 0 });
        writes++;
      },
    },
  });
  let animation = makeAnimation();
  let element = {
    isConnected: true,
    getAnimations() {
      queries++;
      return [animation];
    },
  };
  const root = { querySelector: () => element };
  syncCyberSonarAnimation(root);
  assert.equal(animation.startTime, 0);
  for (let i = 0; i < 100; i++) syncCyberSonarAnimation(root);
  assert.equal(queries, 1);
  assert.equal(writes, 1);
  animation.playState = 'idle';
  animation = makeAnimation();
  syncCyberSonarAnimation(root);
  assert.equal(animation.startTime, 0);
  assert.equal(writes, 2);
  element.isConnected = false;
  animation = makeAnimation();
  element = { isConnected: true, getAnimations: () => [animation] };
  syncCyberSonarAnimation(root);
  assert.equal(animation.startTime, 0);
  assert.equal(writes, 3);
  assert.doesNotThrow(() => syncCyberSonarAnimation({}));
});

test('turning Sonar on seeds and releases the compositor sweep phase', () => {
  const values = new Map();
  const root = {
    dataset: { cyberSonar: 'on' },
    style: {
      setProperty: (name, value) => values.set(name, value),
      removeProperty: (name) => values.delete(name),
      getPropertyValue: (name) => values.get(name) || '',
    },
  };
  applyCyberSonarThemePhase(root, true, CYBER_SONAR_PERIOD_MS / 4);
  assert.equal(values.has('--cyber-sonar-angle'), false);
  assert.equal(values.get('--cyber-sonar-phase-delay'), '-1300ms');
  applyCyberSonarThemePhase(root, true, CYBER_SONAR_PERIOD_MS / 2);
  assert.equal(values.get('--cyber-sonar-phase-delay'), '-1300ms');
  applyCyberSonarThemePhase(root, false, 0);
  assert.equal(values.has('--cyber-sonar-angle'), false);
  assert.equal(values.has('--cyber-sonar-phase-delay'), false);
});
