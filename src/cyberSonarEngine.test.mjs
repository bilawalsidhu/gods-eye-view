import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from './globe/testing/fakeEngine.js';
import { CYBER_SONAR_RENDER_INTERVAL_MS } from './cyberSonar.js';
import {
  createCyberSonarEngineScene,
  cyberSonarEngineState,
} from './cyberSonarEngine.js';

// The DOM the Cyber theme reads: the root's dataset, the body's cockpit
// class, the HUD's visibility and the reduced-motion preference.
function withCyberPage(run) {
  const names = ['document', 'matchMedia'];
  const saved = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  const root = {
    dataset: { uiTheme: 'cyber', cyberSonarOpacity: '40' },
    style: {
      setProperty() {},
      removeProperty() {},
      getPropertyValue: () => '',
    },
    querySelector: () => null,
  };
  const hud = { active: true };
  globalThis.document = {
    documentElement: root,
    body: { classList: { contains: () => false } },
    getElementById: (id) =>
      id === 'intel-hud'
        ? { classList: { contains: (name) => name === 'active' && hud.active } }
        : null,
  };
  globalThis.matchMedia = () => ({ matches: false });
  return Promise.resolve(run({ root, hud })).finally(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
}

test('without the contactSonar capability the engine scene does nothing', () =>
  withCyberPage(({ root }) => {
    const dispose = createCyberSonarEngineScene(createFakeEngine(), null, {
      root,
    });
    assert.equal(root.dataset.cyberSonarGpu, undefined);
    dispose();
  }));

test('each drawn frame hands the engine the theme, the settings and the sweep angle', () =>
  withCyberPage(async ({ root, hud }) => {
    const engine = createFakeEngine({ kind: 'navara', contactSonar: true });
    let now = 1300;
    const timers = new Map();
    let nextTimer = 1;
    const dispose = createCyberSonarEngineScene(engine, null, {
      root,
      now: () => now,
      setTimer: (callback, ms) => {
        timers.set(nextTimer, [callback, ms]);
        return nextTimer++;
      },
      clearTimer: (id) => timers.delete(id),
    });
    assert.equal(root.dataset.cyberSonarGpu, 'supported');
    engine.fake.frame();
    assert.deepEqual(engine.render.contactSonar(), {
      enabled: true,
      active: true,
      angleDeg: 90,
      range: 100,
      opacity: 40,
      sector: 24,
    });
    assert.deepEqual(
      engine.render.contactSonar(),
      cyberSonarEngineState(now, root),
    );
    // No contacts: no render demand of its own.
    assert.equal(timers.size, 0);
    const set = engine.movers.createSet({
      id: 'qa-contacts',
      kind: 'point',
      capacity: 2,
      point: { sizePx: 8 },
    });
    set.set(0, { position: { x: 6378137, y: 0, z: 0 } });
    set.setCount(1);
    set.commit();
    now = 2600;
    engine.fake.frame();
    assert.equal(engine.render.contactSonar().angleDeg, 180);
    assert.equal(timers.size, 1);
    const [[callback, ms]] = timers.values();
    assert.equal(ms, CYBER_SONAR_RENDER_INTERVAL_MS);
    const before = engine.fake.renderRequests;
    callback();
    assert.equal(engine.fake.renderRequests, before + 1);
    // The HUD hidden: the treatment ends on the next frame.
    hud.active = false;
    engine.fake.frame();
    assert.equal(engine.render.contactSonar().enabled, false);
    dispose();
    assert.equal(root.dataset.cyberSonarGpu, undefined);
    assert.equal(engine.render.contactSonar().active, false);
    const calls = engine.fake.calls.length;
    engine.fake.frame();
    assert.equal(
      engine.fake.calls
        .slice(calls)
        .filter(({ method }) => method === 'render.setContactSonar').length,
      0,
      'nothing after dispose',
    );
  }));
