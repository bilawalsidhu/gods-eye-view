import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavaraCredits } from './credits.js';

function fakeAttribution() {
  const shown = [];
  return {
    shown,
    add(items) {
      for (const item of items)
        if (!shown.some((entry) => entry.attributionHtml === item.attributionHtml))
          shown.push(item);
    },
    remove(items) {
      for (const item of items) {
        const index = shown.findIndex(
          (entry) => entry.attributionHtml === item.attributionHtml,
        );
        if (index >= 0) shown.splice(index, 1);
      }
    },
  };
}

test('addStatic shows HTML in the attribution and the remover is idempotent', () => {
  const attribution = fakeAttribution();
  const { credits } = createNavaraCredits({ attribution });
  const remove = credits.addStatic('<a href="x">X</a>', { onScreen: true });
  assert.deepEqual(attribution.shown, [{ attributionHtml: '<a href="x">X</a>' }]);
  remove();
  remove();
  assert.deepEqual(attribution.shown, []);
});

test('the same HTML added twice stays until both holders remove it', () => {
  const attribution = fakeAttribution();
  const { credits } = createNavaraCredits({ attribution });
  const first = credits.addStatic('Same');
  const second = credits.addStatic('Same');
  first();
  first();
  assert.equal(attribution.shown.length, 1);
  second();
  assert.equal(attribution.shown.length, 0);
});

test('destroy removes every credit; a view without attribution UI is a no-op', () => {
  const attribution = fakeAttribution();
  const { credits, destroy } = createNavaraCredits({ attribution });
  credits.addStatic('A');
  credits.addStatic('B');
  destroy();
  assert.deepEqual(attribution.shown, []);
  const bare = createNavaraCredits({ attribution: undefined });
  const remove = bare.credits.addStatic('A');
  remove();
});
