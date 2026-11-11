import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_RECIPES, displayShotTitle } from './recipes.js';
import { setLocale } from '../i18n/index.js';

test('an operator-typed title in the built-in Nepal scene stays as typed', () => {
  const scene = SCENE_RECIPES.find((r) => r.id === 'bhote-koshi-nepal-scene');
  assert.ok(scene, 'built-in bootstrap scene exists');
  for (const locale of ['ru', 'es', 'it', 'zh-CN', 'zh-Hant']) {
    setLocale(locale);
    const title = 'Global Incident Context';
    // A shot captured by the operator: no sourcePackId, renamed to this title.
    const shown = displayShotTitle(
      title,
      { id: 'shot-user', title },
      { id: scene.id },
    );
    assert.equal(shown, title, `${locale}: got ${shown}`);
  }
});
