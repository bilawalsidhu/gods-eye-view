import '../src/testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { CctvControls } from '../src/ui/cctvControls.js';
import { useCctvStore } from '../src/ui/stores/cctv.js';
import CctvPanel from '../src/ui/views/panels/CctvPanel.vue';

const source = readFileSync(
  new URL('./qa-camera-controls.mjs', import.meta.url),
  'utf8',
);

test('the delayed-frame scenario keeps camera B selectable after the flight to A', async (t) => {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CctvPanel).use(pinia);
  app.mount(host);
  const select = document.getElementById('cctv-camera-select');
  const controls = new CctvControls({
    elements: {
      _cctvPanel: document.getElementById('cctv-panel'),
      _cctvSelect: select,
    },
    cctv: {},
    actions: {
      isEnabled: () => true,
      setPanelCollapsed() {},
      syncViewport() {},
    },
    store: useCctvStore(pinia),
  });
  t.after(() => {
    controls.destroy();
    app.unmount();
  });
  const [a, b] = ['a', 'b'].map((id) => ({
    id: `qa-camera-${id}`,
    name: id,
    city: 'Austin',
  }));
  const render = async (activeCamera, cameraIndex) => {
    controls._renderCctvState({
      enabled: true,
      count: 2,
      activeCameraId: activeCamera.id,
      activeCamera,
      cameraIndex,
    });
    await nextTick();
  };
  await render(b, [a, b]);
  const prepare = source.slice(
    source.indexOf('  await page.setCacheEnabled(false);'),
    source.indexOf('  delayCameraA = true;'),
  );
  await new Function('page', `return (async () => { ${prepare} })();`)({
    setCacheEnabled: async () => {},
    focus: async (selector) => document.querySelector(selector).focus(),
  });
  await render(a, [a]);
  assert.ok([...select.options].some((option) => option.value === b.id));
  select.value = b.id;
  assert.equal(select.value, b.id);
  select.blur();
  await nextTick();
  assert.ok(
    ![...select.options].some((option) => option.value === b.id),
    'an unfocused picker drops B once the flight takes it out of view',
  );
});

test('camera B fixtures respond while camera A frames remain held', async () => {
  let route;
  const delayedFrames = new Set();
  const routing = source.slice(
    source.indexOf("  page.on('request',"),
    source.indexOf('  await page.goto('),
  );
  new Function('page', 'origin', 'delayCameraA', 'delayedFrames', routing)(
    { on: (event, handler) => (route = handler) },
    'http://localhost:4321',
    true,
    delayedFrames,
  );
  const replies = [];
  for (const id of ['a', 'b']) {
    route({
      url: () => `http://localhost:4321/api/cctv/frame/qa-camera-${id}?ts=1`,
      respond: async (response) => replies.push({ id, response }),
    });
  }
  assert.equal(delayedFrames.size, 1);
  assert.deepEqual(
    replies.map(({ id }) => id),
    ['b'],
  );
  assert.match(replies[0].response.body, /QA CAMERA B/);
  await Promise.all([...delayedFrames].map((respond) => respond()));
  assert.deepEqual(
    replies.map(({ id }) => id),
    ['b', 'a'],
  );
});
