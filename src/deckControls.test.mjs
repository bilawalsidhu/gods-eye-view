import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECK_CONTROLS_STORAGE_KEY,
  DECK_LOOK_FULL_ALTITUDE_M,
  DECK_LOOK_MIN_ALTITUDE_M,
  DECK_LOOK_MIN_SCALE,
  deckLookSensitivityScale,
  readDeckControlsEnabled,
  writeDeckControlsEnabled,
} from './deckControls.js';

test('deck look sensitivity is lowest near the ground and full at regional altitude', () => {
  assert.equal(deckLookSensitivityScale(DECK_LOOK_MIN_ALTITUDE_M), DECK_LOOK_MIN_SCALE);
  assert.equal(deckLookSensitivityScale(DECK_LOOK_FULL_ALTITUDE_M), 1);
  assert.ok(deckLookSensitivityScale(2_000) < deckLookSensitivityScale(40_000));
  assert.ok(deckLookSensitivityScale(40_000) < deckLookSensitivityScale(DECK_LOOK_FULL_ALTITUDE_M));
});

test('deck look sensitivity clamps below min and above full altitude', () => {
  assert.equal(deckLookSensitivityScale(0), DECK_LOOK_MIN_SCALE);
  assert.equal(deckLookSensitivityScale(-100), DECK_LOOK_MIN_SCALE);
  assert.equal(deckLookSensitivityScale(DECK_LOOK_FULL_ALTITUDE_M + 50_000), 1);
});

test('deck controls slider preference prefers stored value over env default', () => {
  const storage = new Map();
  const fake = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
  };
  assert.equal(readDeckControlsEnabled(fake, '0'), false);
  assert.equal(readDeckControlsEnabled(fake, '1'), true);
  fake.setItem(DECK_CONTROLS_STORAGE_KEY, '1');
  assert.equal(readDeckControlsEnabled(fake, '0'), true);
  fake.setItem(DECK_CONTROLS_STORAGE_KEY, '0');
  assert.equal(readDeckControlsEnabled(fake, '1'), false);
});

test('writeDeckControlsEnabled persists 1/0 and survives read-back', () => {
  const storage = new Map();
  const fake = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
  };
  writeDeckControlsEnabled(true, fake);
  assert.equal(fake.getItem(DECK_CONTROLS_STORAGE_KEY), '1');
  assert.equal(readDeckControlsEnabled(fake, '0'), true);
  writeDeckControlsEnabled(false, fake);
  assert.equal(fake.getItem(DECK_CONTROLS_STORAGE_KEY), '0');
  assert.equal(readDeckControlsEnabled(fake, '1'), false);
});
