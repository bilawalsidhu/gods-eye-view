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

const listeners = () => ({ addEventListener() {}, removeEventListener() {} });

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useHudStore(pinia);
  const app = createApp(IntelHudView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const hud = new IntelHUD(
    {
      camera: {
        pitch: -Math.PI / 2,
        positionCartographic: { latitude: 0.7, longitude: -1.2, height: 500 },
        computeViewRectangle: () => undefined,
        moveStart: listeners(),
        moveEnd: listeners(),
      },
    },
    {
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
  return { hud, root: document.getElementById('intel-hud') };
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
