import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import { BillboardCollection, Color, PointPrimitive } from 'cesium';
import {
  syncCyberSonarAnimation,
  applyCyberSonarPrimitive,
  cyberSonarBaseAlpha,
  applyCyberSonarThemePhase,
  cyberSonarAngleDeg,
  cyberSonarAnimationDelay,
  cyberSonarFrameDelay,
  cyberSonarIntensityAtScreenPoint,
  cyberSonarLabelIntensity,
  cyberSonarTintColor,
  applyCyberSonarSettings,
  CYBER_SONAR_DIM_FACTOR,
  CYBER_SONAR_LABEL_DIM_FACTOR,
  CYBER_SONAR_PERIOD_MS,
  CYBER_SONAR_RENDER_INTERVAL_MS,
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
    documentElement: { dataset: { uiTheme: 'cyber' } },
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
    document.documentElement.dataset.uiTheme = 'tactical';
    assert.equal(compiled.isCyberSonarActive(), false);
    assert.equal(compiled.isCyberMapThemeActive(), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
});

test('hue-only aircraft restyles retain owner alpha across sonar opacity changes', () => {
  const collection = new BillboardCollection();
  const visual = collection.add({ color: Color.WHITE.withAlpha(0.8) });
  try {
    for (const opacity of [0.84, 0.35, 0.81, 1, 0.84]) {
      for (let i = 0; i < 8; i++) {
        visual.color = Color.CYAN.withAlpha(cyberSonarBaseAlpha(visual));
        applyCyberSonarPrimitive(visual, opacity);
        assert.equal(visual.color.alpha, 0.8 * opacity);
      }
    }
    // A true owner freshness update must not be mistaken for our old alpha.
    visual.color = Color.YELLOW.withAlpha(0.4);
    assert.equal(cyberSonarBaseAlpha(visual), 0.4);
    applyCyberSonarPrimitive(visual, 0.35);
    visual.color = Color.CYAN.withAlpha(cyberSonarBaseAlpha(visual));
    applyCyberSonarPrimitive(visual, 0.84);
    applyCyberSonarPrimitive(visual, 1, false);
    assert.ok(Color.equals(visual.color, Color.CYAN.withAlpha(0.4)));
  } finally {
    collection.destroy();
  }
});

test('the Cyber sonar clock advances clockwise and wraps cleanly', () => {
  assert.equal(cyberSonarAngleDeg(0), 0);
  assert.equal(cyberSonarAngleDeg(CYBER_SONAR_PERIOD_MS / 4), 90);
  assert.equal(cyberSonarAngleDeg(CYBER_SONAR_PERIOD_MS), 0);
  assert.equal(cyberSonarAnimationDelay(CYBER_SONAR_PERIOD_MS / 2), '-2600ms');
});

test('contact refresh cadence waits only until the next bounded sonar frame', () => {
  assert.equal(CYBER_SONAR_RENDER_INTERVAL_MS, 80);
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

  assert.equal(
    cyberSonarIntensityAtScreenPoint(centerX, centerY - 200, width, height, 0),
    1,
  );
  assert.equal(
    cyberSonarIntensityAtScreenPoint(centerX + 200, centerY, width, height, 0),
    CYBER_SONAR_DIM_FACTOR,
  );
  assert.equal(
    cyberSonarIntensityAtScreenPoint(
      centerX + 200,
      centerY,
      width,
      height,
      CYBER_SONAR_PERIOD_MS / 4,
    ),
    1,
  );
  assert.equal(
    cyberSonarIntensityAtScreenPoint(centerX, centerY - 401, width, height, 0),
    CYBER_SONAR_DIM_FACTOR,
  );
  assert.equal(
    cyberSonarIntensityAtScreenPoint(Number.NaN, 0, width, height, 0),
    1,
  );
});

test('the sonar activates only for a visible Cyber map HUD with motion enabled', () => {
  const root = { dataset: { uiTheme: 'cyber' } };
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

test('labels keep a more readable baseline while tracking the same sweep', () => {
  assert.equal(CYBER_SONAR_DIM_FACTOR, 0.84);
  assert.equal(CYBER_SONAR_LABEL_DIM_FACTOR, 0.92);
  assert.equal(
    cyberSonarLabelIntensity(CYBER_SONAR_DIM_FACTOR),
    CYBER_SONAR_LABEL_DIM_FACTOR,
  );
  assert.equal(cyberSonarLabelIntensity(1), 1);
  assert.ok(
    cyberSonarLabelIntensity(CYBER_SONAR_DIM_FACTOR) > CYBER_SONAR_DIM_FACTOR,
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
  assert.equal(
    cyberSonarIntensityAtScreenPoint(900, 400, 1_000, 800, 0, root),
    0.62,
  );
  assert.equal(cyberSonarLabelIntensity(0.62, root), 0.81);
  assert.equal(cyberSonarLabelIntensity(1, root), 1);

  applyCyberSonarSettings({ opacity: 100 }, root);
  assert.equal(cyberSonarLabelIntensity(1, root), 1);
  assert.deepEqual(
    cyberSonarTintColor({ red: 1, green: 1, blue: 1, alpha: 1 }, 1, root),
    { red: 1, green: 0.8848, blue: 0.8848, alpha: 1 },
  );
});

test('the sonar control defaults on and records explicit operator state', () => {
  const root = { dataset: {} };
  assert.equal(isCyberSonarEnabled(root), true);
  assert.equal(setCyberSonarEnabled(false, root), false);
  assert.equal(root.dataset.cyberSonar, 'off');
  assert.equal(isCyberSonarEnabled(root), false);
  assert.equal(setCyberSonarEnabled(true, root), true);
  assert.equal(root.dataset.cyberSonar, 'on');
});

test('real Cesium points and billboards recover after repeated low/high opacity cycles', () => {
  const collection = new BillboardCollection();
  const base = new Color(0.7, 0.5, 0.25, 0.8);
  const visuals = [
    new PointPrimitive({ color: base }),
    collection.add({ color: base }),
  ];
  try {
    for (const visual of visuals) {
      for (const factor of [0.35, 1, 0.5, 1, 0.35]) {
        for (let frame = 0; frame < 60; frame++) {
          applyCyberSonarPrimitive(visual, factor);
        }
        assert.equal(visual.color.alpha, base.alpha * factor);
      }
      // Owner setters mutate the same Cesium Color object, even when the new
      // alpha equals the last sonar output. Its new RGB must become the base.
      const refreshed = new Color(0.2, 0.8, 0.4, visual.color.alpha);
      visual.color = refreshed;
      applyCyberSonarPrimitive(visual, 0.5);
      assert.equal(visual.color.alpha, refreshed.alpha * 0.5);
      applyCyberSonarPrimitive(visual, 1, false);
      assert.ok(Color.equals(visual.color, refreshed));
    }
  } finally {
    collection.destroy();
  }
});

test('generic Cesium primitives dim, accept owner style refreshes, and restore', () => {
  const makeColor = (alpha, red = 1) => ({
    red,
    green: 0.5,
    blue: 0.25,
    alpha,
    clone() {
      return makeColor(this.alpha, this.red);
    },
  });
  const visual = { color: makeColor(0.8) };
  applyCyberSonarPrimitive(visual, 0.25, true);
  assert.equal(visual.color.alpha, 0.2);
  const paintedColor = visual.color;
  applyCyberSonarPrimitive(visual, 0.25, true);
  assert.equal(visual.color, paintedColor);
  visual.color = makeColor(0.6, 0.7);
  applyCyberSonarPrimitive(visual, 0.5, true);
  assert.equal(visual.color.alpha, 0.3);
  assert.notEqual(visual.color.red, 0.7);
  applyCyberSonarPrimitive(visual, 1, false);
  assert.equal(visual.color.alpha, 0.6);
  assert.equal(visual.color.red, 0.7);
});

test('Cyber contact tint moves from cool-muted to warm-bright with the sector', () => {
  const root = { dataset: { cyberSonarIntensity: '70' } };
  const base = { red: 0.2, green: 0.8, blue: 1, alpha: 0.75 };
  const dim = cyberSonarTintColor(base, CYBER_SONAR_DIM_FACTOR, root);
  const bright = cyberSonarTintColor(base, 1, root);
  assert.ok(bright.red > dim.red);
  assert.ok(bright.green > dim.green);
  assert.equal(bright.alpha, 0.75);
});

test('unswept white map symbols retain a bright readable Cyber tint', () => {
  const root = { dataset: { cyberSonarIntensity: '70' } };
  const dim = cyberSonarTintColor(
    { red: 1, green: 1, blue: 1, alpha: 1 },
    CYBER_SONAR_DIM_FACTOR,
    root,
  );
  assert.ok(dim.red >= 0.72);
  assert.ok(dim.green >= 0.76);
  assert.ok(dim.blue >= 0.79);
  assert.equal(dim.alpha, 1);
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

test('the selected Cyber theme seeds and releases the compositor sweep phase', () => {
  const values = new Map();
  const root = {
    dataset: {},
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
