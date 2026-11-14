import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDisplayAccentTheme,
  readDisplayAccentPreferences,
} from './displayAccentSettings.js';

test('Tactical and Minimal retain automatic colors; Cyber defaults to purple', () => {
  const settings = readDisplayAccentPreferences(null);
  assert.equal(settings.tactical.id, 'auto');
  assert.equal(settings.minimal.id, 'auto');
  assert.equal(settings.cyber.color, '#7d4fae');
});

test('legacy Cyber preferences migrate without recoloring the other templates', () => {
  const legacy = JSON.stringify({ id: 'custom', customColor: '#123456' });
  const migrated = readDisplayAccentPreferences(null, legacy);
  assert.equal(migrated.cyber.color, '#123456');
  assert.equal(migrated.tactical.color, null);
  assert.equal(migrated.minimal.color, null);
  const stored = JSON.stringify({
    tactical: { id: 'green' },
    minimal: { id: 'custom', customColor: '#abcdef' },
    cyber: { id: 'red' },
  });
  const preferences = readDisplayAccentPreferences(stored, legacy);
  assert.equal(preferences.tactical.color, '#4ec98a');
  assert.equal(preferences.minimal.color, '#abcdef');
  assert.equal(preferences.cyber.color, '#c45454');
});

test('invalid settings fall back independently and do not throw', () => {
  assert.equal(readDisplayAccentPreferences('{bad').cyber.id, 'purple');
  const settings = readDisplayAccentPreferences(
    JSON.stringify({
      tactical: 'invalid',
      minimal: { id: 'custom', customColor: 'red' },
      cyber: [],
    }),
  );
  assert.equal(settings.tactical.id, 'auto');
  assert.equal(settings.minimal.color, '#7d4fae');
  assert.equal(settings.cyber.id, 'purple');
});

test('Default releases CSS overrides and preserves unrelated root state', () => {
  const properties = new Map();
  const root = {
    dataset: { unrelated: 'retained' },
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
  };
  applyDisplayAccentTheme(root, { id: 'green' });
  assert.equal(root.dataset.displayAccent, 'green');
  assert.equal(properties.get('--display-accent'), '#4ec98a');
  applyDisplayAccentTheme(root, readDisplayAccentPreferences(null).minimal);
  assert.equal(root.dataset.displayAccent, undefined);
  assert.equal(root.dataset.unrelated, 'retained');
  assert.equal(properties.size, 0);
});
