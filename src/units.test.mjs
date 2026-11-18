import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_UNIT_SYSTEM,
  UNIT_SYSTEM_STORAGE_KEY,
  bindUnitSystem,
  celsiusToFahrenheit,
  getUnitSystem,
  normalizeUnitSystem,
  onUnitSystemChange,
  readStoredUnitSystem,
  setUnitSystem,
  usesImperial,
  writeStoredUnitSystem,
} from './units.js';

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
};

test('the page reads metric until a person chooses imperial', () => {
  assert.equal(DEFAULT_UNIT_SYSTEM, 'metric');
  assert.equal(getUnitSystem(), 'metric');
  assert.equal(usesImperial(), false);
});

test('only metric and imperial are systems', () => {
  assert.equal(normalizeUnitSystem('imperial'), 'imperial');
  assert.equal(normalizeUnitSystem('metric'), 'metric');
  assert.equal(normalizeUnitSystem('Imperial'), null);
  assert.equal(normalizeUnitSystem('us'), null);
  assert.equal(normalizeUnitSystem(undefined), null);
});

test('a choice is kept for the next visit, and a blocked store keeps nothing', () => {
  const storage = memoryStorage();
  assert.equal(readStoredUnitSystem(storage), null);
  assert.equal(writeStoredUnitSystem('imperial', storage), true);
  assert.equal(storage.getItem(UNIT_SYSTEM_STORAGE_KEY), 'imperial');
  assert.equal(readStoredUnitSystem(storage), 'imperial');
  assert.equal(writeStoredUnitSystem('furlongs', storage), false);
  const blocked = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal(readStoredUnitSystem(blocked), null);
  assert.equal(writeStoredUnitSystem('metric', blocked), false);
  assert.equal(readStoredUnitSystem({ getItem: () => 'kelvin' }), null);
});

test('a switch reaches listeners once, and a bound ref holds the choice', () => {
  const heard = [];
  const stop = onUnitSystemChange((system) => heard.push(system));
  try {
    assert.equal(setUnitSystem('metric'), 'metric', 'no change, no news');
    assert.equal(setUnitSystem('imperial'), 'imperial');
    assert.equal(usesImperial(), true);
    assert.equal(setUnitSystem('nonsense'), 'metric', 'unknown falls back');
    assert.deepEqual(heard, ['imperial', 'metric']);

    const ref = { value: 'whatever' };
    bindUnitSystem(ref);
    assert.equal(ref.value, 'metric', 'the ref starts at the current choice');
    ref.value = 'imperial';
    assert.equal(getUnitSystem(), 'imperial', 'the ref is the source of truth');
  } finally {
    stop();
    setUnitSystem('metric');
  }
  setUnitSystem('imperial');
  assert.deepEqual(heard, ['imperial', 'metric'], 'a stopped listener hears nothing');
  setUnitSystem('metric');
});

test('Fahrenheit from Celsius', () => {
  assert.equal(celsiusToFahrenheit(0), 32);
  assert.equal(celsiusToFahrenheit(100), 212);
  assert.equal(celsiusToFahrenheit(-40), -40);
  assert.equal(celsiusToFahrenheit(21.5), 70.7);
});
