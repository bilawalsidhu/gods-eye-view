import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import ContextView from './views/ContextView.vue';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// The rail's measuring pass lifts these panel scrollers to their natural
// height, which clamps their scroll offset to zero. Only scrollers tagged
// `data-rail-scroller` get their offset restored afterwards, so every lifted
// scroller must carry the tag or a layout pass snaps it back to the top.
test('the mounted Context scroller lifted for measurement carries the restore marker', (t) => {
  const css = read('./styles/layers.css');
  const lifted = [
    ...css.matchAll(
      /#right-context-rail\[data-rail-measuring\]\s*>\s*\[data-panel-id\]:not\(\.collapsed\)\s*>\s*\.([a-z-]+)/g,
    ),
  ].map((match) => match[1]);
  assert.ok(lifted.length > 0, 'measuring CSS lists lifted scrollers');

  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(ContextView).use(createPinia());
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });
  for (const className of lifted) {
    const scroller = host.querySelector(
      `#right-context-rail > [data-panel-id] > .${className}`,
    );
    assert.ok(scroller, `mounted ${className} exists`);
    assert.ok(
      scroller.hasAttribute('data-rail-scroller'),
      `${className} restores its scroll`,
    );
  }
});
