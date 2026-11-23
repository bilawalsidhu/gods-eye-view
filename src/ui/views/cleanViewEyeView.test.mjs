// src/ui/views/cleanViewEyeView.test.mjs — the Display view renders the clean
// view eye beside EXIT CLEAN VIEW, and its click, like Clean UI and EXIT,
// answers through the display store.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useDisplayStore } from '../stores/display.js';
import DisplayControlsView from './DisplayControlsView.vue';

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useDisplayStore(pinia);
  const calls = [];
  store.connect({
    toggleCleanView: () => calls.push('toggleCleanView'),
    exitCleanView: () => calls.push('exitCleanView'),
  });
  const app = createApp(DisplayControlsView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return { calls, store };
}
const $ = (id) => document.getElementById(id);

test('the eye is a toggle button after EXIT CLEAN VIEW, and Clean UI carries aria-pressed', (t) => {
  mount(t);
  const eye = $('clean-view-eye');
  assert.ok(eye, 'eye button in the page');
  assert.equal(eye.getAttribute('type'), 'button');
  assert.equal(eye.getAttribute('aria-pressed'), 'false');
  assert.notEqual(eye.getAttribute('tabindex'), '-1');
  assert.equal($('clean-view-toggle').getAttribute('aria-pressed'), 'false');
  assert.ok(
    $('clean-view-exit').compareDocumentPosition(eye) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    'eye follows the EXIT button',
  );
});

test('the eye, Clean UI and EXIT answer through the display store', (t) => {
  const { calls } = mount(t);
  $('clean-view-eye').click();
  $('clean-view-toggle').click();
  $('clean-view-exit').click();
  assert.deepEqual(calls, [
    'toggleCleanView',
    'toggleCleanView',
    'exitCleanView',
  ]);
});

test('the eye and Clean UI render the published clean view state as kit toggles', async (t) => {
  const { store } = mount(t);
  const pressed = () => [
    $('clean-view-eye').getAttribute('aria-pressed'),
    $('clean-view-toggle').getAttribute('aria-pressed'),
  ];
  assert.deepEqual(pressed(), ['false', 'false']);
  // Classes other code adds (the shell's `active`) survive a press.
  $('clean-view-toggle').classList.add('active');
  store.publishCleanView(true);
  await nextTick();
  assert.deepEqual(pressed(), ['true', 'true']);
  assert.ok($('clean-view-toggle').classList.contains('active'));
  assert.ok($('clean-view-eye').classList.contains('ui-button--pressed'));
  // A label the eye's controller wrote survives the re-render.
  $('clean-view-eye').setAttribute('aria-label', 'controller label');
  store.publishCleanView(false);
  await nextTick();
  assert.deepEqual(pressed(), ['false', 'false']);
  assert.equal($('clean-view-eye').getAttribute('aria-label'), 'controller label');
});
