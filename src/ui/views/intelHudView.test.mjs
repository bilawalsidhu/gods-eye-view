// src/ui/views/intelHudView.test.mjs — the Intel HUD view renders what
// IntelHUD publishes: its readouts, visibility, layout variant and colors.
//
// hud.js imports `mgrs`, which Node's ESM loader cannot read named exports
// from, so a module hook swaps it for a stub before the import (the same
// setup as hudPageVisibility.test.mjs).
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { registerHooks } from 'node:module';
import { presentSelectedVessel } from '../../hudReadouts.js';
import { useHudStore } from '../stores/hud.js';
import IntelHudView from './IntelHudView.vue';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { toDegrees as deg } from '../../geo/index.js';
import { assertSameNode } from '../../testSupport/domAssert.mjs';

const MGRS_STUB_URL = 'gev-test-stub:mgrs';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs') return { url: MGRS_STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === MGRS_STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export function forward() { return "10SEG55776339"; }\nexport default { forward };\n',
      };
    }
    return next(url, context);
  },
});

const { IntelHUD } = await import('../../hud.js');

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useHudStore(pinia);
  const app = createApp(IntelHudView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const hud = new IntelHUD(
    {},
    {
      camera: fakeCameraPort({
        pose: { lat: deg(0.7), lon: deg(-1.2), height: 500 },
      }).port,
      // No AI summary: the readouts are what this test renders.
      summaryService: { configured: async () => false },
      publish: (view) => store.publish(view),
    },
  );
  t.after(() => {
    hud.destroy();
    presentSelectedVessel(null);
    app.unmount();
  });
  return { hud, store, root: document.getElementById('intel-hud') };
}

test('the corners are in the document from mount, before IntelHUD presents them', (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(IntelHudView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  // The panel layout controllers query these synchronously at registration.
  const root = document.getElementById('intel-hud');
  assert.equal(root.querySelectorAll('.hud-corner').length, 4);
  assert.equal(root.querySelectorAll('.hud-edge').length, 2);
  assert.equal(root.className, '');
  assert.equal(root.hasAttribute('data-variant'), false);
  assert.equal(root.getAttribute('style'), null);
  assert.equal(document.getElementById('hud-summary').textContent, '');
  assert.equal(root.querySelector('.hud-rec').textContent, '●');
});

test('the first view renders the corners, edges and bottom bar', async (t) => {
  const { root } = mount(t);
  await nextTick();
  assert.equal(root.className, '');
  assert.equal(root.dataset.variant, 'tactical');
  assert.deepEqual(
    [...root.children].map((child) => child.className),
    [
      'hud-sonar',
      'hud-corner hud-top-left',
      'hud-corner hud-top-right',
      'hud-corner hud-bottom-left',
      'hud-corner hud-bottom-right',
      'hud-edge hud-left-edge',
      'hud-edge hud-right-edge',
      'hud-bottom-bar',
    ],
  );
  const text = (id) => document.getElementById(id).textContent;
  assert.equal(text('hud-mode'), 'NORMAL');
  assert.equal(text('hud-summary'), 'Awaiting telemetry...');
  assert.equal(text('hud-mgrs'), 'MGRS: ---');
  assert.equal(text('hud-ais-vessel'), 'AIS: --');
  assert.equal(
    root.querySelector('.hud-rec').textContent,
    '● REC  2026-01-01 00:00:00Z',
  );
  assert.equal(
    document.getElementById('hud-rec-dot').getAttribute('style'),
    null,
  );
  assert.match(
    root.querySelector('.hud-system').textContent,
    /^KH11-\d+ {2}OPS-\d+$/,
  );
  assert.deepEqual(
    [...root.querySelectorAll('.hud-right-edge .hud-readout')].map(
      (line) => line.textContent,
    ),
    ['BAND: PAN', 'BITS: 11', 'LVL: 1A'],
  );
});

test('visibility, variant, style colors and readouts follow IntelHUD', async (t) => {
  const { hud, root } = mount(t);
  hud.onStyleChange('surveillance');
  hud.setVariant('minimal');
  hud.setMode('on');
  await nextTick();
  assert.equal(root.classList.contains('active'), true);
  assert.equal(root.dataset.variant, 'minimal');
  assert.notEqual(root.style.getPropertyValue('--hud-color'), '');
  assert.equal(document.getElementById('hud-mode').textContent, hud._view.mode);
  assert.match(document.getElementById('hud-alt').textContent, /^ALT: \d+m/);
  hud._present({ recShown: false });
  await nextTick();
  assert.equal(
    document.getElementById('hud-rec-dot').style.visibility,
    'hidden',
  );
  hud.setMode('off');
  await nextTick();
  assert.equal(root.classList.contains('active'), false);
});

test('the selected vessel readout shows while a vessel is selected', async (t) => {
  mount(t);
  presentSelectedVessel({ text: 'AIS: TEST\nCARGO' });
  await nextTick();
  const vessel = document.getElementById('hud-ais-vessel');
  assert.equal(vessel.className, 'hud-ais-vessel active');
  assert.equal(vessel.textContent, 'AIS: TEST\nCARGO');
  presentSelectedVessel(null);
  await nextTick();
  assert.equal(vessel.className, 'hud-ais-vessel');
  assert.equal(vessel.textContent, 'AIS: --');
});

/**
 * IntelHUD over a fake camera, with every publish counted. Mock timers are
 * on, so the cadences run when the test ticks them.
 */
function countedHud(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const camera = fakeCameraPort({
    pose: { lat: deg(0.7), lon: deg(-1.2), height: 500 },
  });
  const published = [];
  const hud = new IntelHUD(
    {},
    {
      camera: camera.port,
      summaryService: { configured: async () => false },
      publish: (view) => published.push(view),
    },
  );
  t.after(() => hud.destroy());
  return { hud, camera, published };
}

test('a HUD that is not displayed works out and publishes no readouts', (t) => {
  const { hud, camera, published } = countedHud(t);
  hud.setMode('on');
  hud.setDisplayed(false);
  const pose = hud._camera.pose;
  let poses = 0;
  hud._camera.pose = () => {
    poses += 1;
    return pose();
  };
  const before = published.length;
  // Every cadence: the clock, the REC blink, telemetry and the summary.
  t.mock.timers.tick(60_000);
  camera.setPose({ height: 900 });
  camera.emit('moveStart');
  camera.emit('moveEnd');
  t.mock.timers.tick(60_000);
  assert.equal(published.length, before, 'nothing is published');
  assert.equal(poses, 0, 'the camera is not read');
});

test('a HUD displayed again shows current readouts at once', (t) => {
  const { hud, camera, published } = countedHud(t);
  hud.setMode('on');
  hud.setDisplayed(false);
  t.mock.timers.tick(5_000);
  camera.setPose({ height: 900 });
  camera.emit('moveStart');
  camera.emit('moveEnd');
  hud.setDisplayed(true);
  const view = published.at(-1);
  assert.match(view.alt, /^ALT: 900m/, 'the altitude the camera has now');
  assert.equal(view.timestamp, hud._formatUTC(), 'the clock reads now');
  // And the cadences run again.
  const count = published.length;
  t.mock.timers.tick(1_000);
  assert.ok(published.length > count);
});

test('a HUD shown while not displayed refreshes when it is displayed', (t) => {
  const { hud, camera, published } = countedHud(t);
  hud.setDisplayed(false);
  camera.setPose({ height: 700 });
  hud.setMode('on');
  assert.equal(published.at(-1).active, true, 'visibility is still published');
  assert.equal(published.at(-1).alt, 'ALT: --m   SUN: --° EL');
  hud.setDisplayed(true);
  assert.match(published.at(-1).alt, /^ALT: 700m/);
});

test('the view reports whether #intel-hud is displayed, and IntelHUD follows', async (t) => {
  // happy-dom lays nothing out: a stand-in observer reports the box, and
  // getClientRects() answers as the stylesheet would.
  const observers = [];
  const previous = globalThis.window.ResizeObserver;
  globalThis.window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.targets = [];
    }
  };
  t.after(() => {
    globalThis.window.ResizeObserver = previous;
  });
  const { hud, store, root } = mount(t);
  let boxes = 1;
  root.getClientRects = () => Array.from({ length: boxes });
  const report = () => observers.at(-1).callback([]);
  assert.deepEqual(observers.at(-1).targets, [root]);
  const calls = [];
  const setDisplayed = hud.setDisplayed.bind(hud);
  hud.setDisplayed = (displayed) => {
    calls.push(displayed);
    setDisplayed(displayed);
  };
  store.connect(hud);
  assert.deepEqual(calls, [true], 'connecting tells IntelHUD the view state');
  boxes = 0;
  report();
  report();
  assert.equal(store.displayed, false);
  assert.equal(hud._displayed, false);
  boxes = 1;
  report();
  assert.equal(hud._displayed, true);
  assert.deepEqual(calls, [true, false, true]);
});

test('a readout keeps its text node and changes its text', async (t) => {
  const { hud } = mount(t);
  hud._present({ alt: 'ALT: 1m', timestamp: '2026-01-01 00:00:01Z' });
  await nextTick();
  const alt = document.getElementById('hud-alt');
  const stamp = document.getElementById('hud-timestamp');
  const [altText, stampText] = [alt.firstChild, stamp.firstChild];
  hud._present({ alt: 'ALT: 2m', timestamp: '2026-01-01 00:00:02Z' });
  await nextTick();
  assert.equal(alt.textContent, 'ALT: 2m');
  assert.equal(stamp.textContent, '2026-01-01 00:00:02Z');
  assertSameNode(alt.firstChild, altText, 'the same text node');
  assertSameNode(stamp.firstChild, stampText, 'the same text node');
  assert.equal(alt.childNodes.length, 1);
  // An empty readout has no text node, as before.
  hud._present({ summary: '' });
  await nextTick();
  assert.equal(document.getElementById('hud-summary').childNodes.length, 0);
});
