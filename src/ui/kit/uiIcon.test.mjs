import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'vue';
import UiIcon from './UiIcon.vue';

test('timeline play and pause render their own line icons', () => {
  const host = document.body.appendChild(document.createElement('div'));
  try {
    for (const [name, icon] of [['play_arrow', 'lucide-play'], ['pause', 'lucide-pause']]) {
      render(h(UiIcon, { name }), host);
      assert.ok(host.querySelector(`svg.${icon}`));
      assert.equal(host.querySelector('svg.lucide-layers'), null);
    }
  } finally { render(null, host); host.remove(); }
});
