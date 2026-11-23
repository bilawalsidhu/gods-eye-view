import { createApp, h, nextTick } from 'vue';
import { createPinia, storeToRefs } from 'pinia';
import { useVoiceStore } from '../ui/stores/voice.js';
import VoiceControl from '../ui/views/panels/VoiceControl.vue';

/**
 * Render whichever voice control the store presents, as the command dock
 * does, into the current document. Import registerDom.mjs first.
 * @param {import('node:test').TestContext} t
 * @returns {{pinia: import('pinia').Pinia, settle: () => Promise<void>}}
 */
export function mountVoiceView(t) {
  const doc = globalThis.document;
  // happy-dom lacks the browser's `[hidden]` rule, which visibility checks
  // and focus moves rely on.
  if (!doc.getElementById('test-ua-hidden')) {
    const style = doc.head.appendChild(doc.createElement('style'));
    style.id = 'test-ua-hidden';
    style.textContent = '[hidden] { display: none; }';
  }
  doc.body.replaceChildren();
  const host = doc.body.appendChild(doc.createElement('div'));
  const pinia = createPinia();
  const { view } = storeToRefs(useVoiceStore(pinia));
  const app = createApp({
    render: () =>
      view.value
        ? h(VoiceControl, { key: view.value.id, view: view.value })
        : null,
  }).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  // Renders, then any focus the owners asked for after it.
  const settle = async () => {
    await nextTick();
    await nextTick();
  };
  return { pinia, settle };
}
