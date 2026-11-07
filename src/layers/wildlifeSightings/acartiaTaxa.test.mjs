import test from 'node:test';
import assert from 'node:assert/strict';
import { ACARTIA_CETACEAN_NAMES, acartiaSpeciesGroup } from './acartiaTaxa.js';

test('frozen cetacean names accept only normalized exact species or aliases', () => {
  assert.equal(Object.isFrozen(ACARTIA_CETACEAN_NAMES), true);
  assert.throws(() => ACARTIA_CETACEAN_NAMES.push('Whale shark'), TypeError);
  for (const name of ACARTIA_CETACEAN_NAMES) {
    assert.equal(acartiaSpeciesGroup(name), 'cetacean');
    assert.equal(acartiaSpeciesGroup(`  ${name.toUpperCase()}  `), 'cetacean');
    assert.equal(acartiaSpeciesGroup(`${name} or another animal`), null);
  }
  assert.equal(acartiaSpeciesGroup('Dall’s porpoise'), 'cetacean');
  assert.equal(acartiaSpeciesGroup('Pacific white–sided dolphin'), 'cetacean');
  assert.equal(acartiaSpeciesGroup('  HARBOR  PORPOISE '), 'cetacean');
});

test('clearly marine mammal names remain distinct from validated cetacean species', () => {
  for (const name of [
    'Harbor seal',
    'Phoca vitulina',
    'Sea otter',
    'Unidentified whale',
  ]) {
    assert.equal(acartiaSpeciesGroup(name), 'marine-mammal');
  }
  for (const name of [
    'Unknown',
    'Whale shark',
    'Elephant',
    '',
    null,
    { species: 'Orca' },
  ]) {
    assert.equal(acartiaSpeciesGroup(name), null);
  }
});
