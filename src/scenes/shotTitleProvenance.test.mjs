import test from 'node:test';
import assert from 'node:assert/strict';
import { displayShotTitle } from './recipes.js';
import { setLocale } from '../i18n/index.js';

test('a typed shot title in a user scene with an applied pack stays as typed', () => {
  setLocale('ru');
  const title = 'Global Incident Context';
  // The user's own shot (not from the pack: no sourcePackId) in a user scene
  // that later received the Nepal evidence pack.
  const ownShot = { id: 'user-shot-7', title };
  const scene = {
    id: 'scene-user-123',
    appliedShotPacks: [{ id: 'bhote-koshi-nepal-evidence-pack', version: 12 }],
  };
  assert.equal(displayShotTitle(title, ownShot, scene), title);
});
