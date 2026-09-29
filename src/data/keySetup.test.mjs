// keySetup: the one registry that names a key-gated layer's missing key.
// Ported from upstream 6fa25c3 (fix(ui): name the missing provider key on a
// key-gated layer row) — a row reading KEY REQUIRED without saying WHICH key
// leaves a dead control and no next step.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KEY_SETUP_REQUIREMENTS,
  keySetupRequirement,
  layerKeyRequirementTooltip,
} from './keySetup.js';
import { readSource } from '../testSupport/readSource.js';

test('keySetupRequirement: the firms entry names the exact variable and where to get it', () => {
  const text = keySetupRequirement('firms');
  assert.match(text, /FIRMS_MAP_KEY/, 'the exact env var an operator sets');
  assert.match(text, /\.env/, 'and where it goes');
  // .env.example must keep documenting the same variable — the registry and
  // the example file are two tellings of one truth.
  const env = readSource('../../.env.example', import.meta.url);
  assert.match(env, /^# FIRMS_MAP_KEY=/m, '.env.example documents FIRMS_MAP_KEY');
});

test('keySetupRequirement: unknown, blank, and non-string ids return empty — never a guess', () => {
  assert.equal(keySetupRequirement('tomtom'), '');
  assert.equal(keySetupRequirement('FIRMS'), '', 'ids are case-sensitive registry keys');
  assert.equal(keySetupRequirement('  firms  '), keySetupRequirement('firms'),
    'whitespace-padded ids resolve (the tooltip path trims its input, the gate matches)');
  assert.equal(keySetupRequirement(''), '');
  assert.equal(keySetupRequirement(null), '');
  assert.equal(keySetupRequirement(undefined), '');
});

test('layerKeyRequirementTooltip: guidance only while the key is actually missing AND named', () => {
  const gated = { name: 'FIRMS heat field', requiresKeyId: 'firms', stats: { keyRequired: true } };
  assert.match(layerKeyRequirementTooltip(gated), /FIRMS_MAP_KEY/);

  // Key present: the row is a normal control, not a setup step.
  assert.equal(layerKeyRequirementTooltip({ ...gated, stats: { keyRequired: false } }), '');
  assert.equal(layerKeyRequirementTooltip({ ...gated, stats: {} }), '');
  assert.equal(layerKeyRequirementTooltip({ ...gated, stats: { keyRequired: 'KEY REQUIRED' } }), '',
    'a truthy-but-not-true flag is not the contract');

  // Declares nothing, or declares an id the registry doesn't know: '' —
  // guidance naming the wrong variable sends the operator to the wrong provider.
  assert.equal(layerKeyRequirementTooltip({ stats: { keyRequired: true } }), '');
  assert.equal(layerKeyRequirementTooltip({ requiresKeyId: 'nope', stats: { keyRequired: true } }), '');
  assert.equal(layerKeyRequirementTooltip(null), '');
  assert.equal(layerKeyRequirementTooltip(), '');
});

test('the manager projects requiresKeyId and names the key on the toggle control', () => {
  // Parity anchors: the projection mirrors showInTogglePanel, and the toggle
  // button carries the guidance on both title and aria-label (a screen reader
  // announces the next step, not just the fault).
  const manager = readSource('./manager.js', import.meta.url);
  assert.match(manager, /requiresKeyId: entry\.module\.requiresKeyId \|\| null/);
  assert.match(manager, /layerKeyRequirementTooltip\(layer\)/);
  assert.match(manager, /aria-label',\s*\n\s*keyGuidance/);
  assert.match(manager, /button\.title = keyGuidance;/, "'' must clear a stale tooltip once the key lands");

  // The one layer gated on a key declares its registry id.
  const firms = readSource('./firmsHeatmap.js', import.meta.url);
  assert.match(firms, /requiresKeyId: 'firms'/);
  assert.match(firms, /keyRequired: _keyRequired/, 'stats must carry the machine-readable half');
});

test('the registry stays frozen — UI copy is not runtime-mutable', () => {
  assert.equal(Object.isFrozen(KEY_SETUP_REQUIREMENTS), true);
  assert.equal(Object.isFrozen(KEY_SETUP_REQUIREMENTS.firms), true);
});
