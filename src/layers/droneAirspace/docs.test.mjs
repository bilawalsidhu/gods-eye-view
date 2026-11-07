import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOICE_OFF_LAYERS } from '../../voice/layerManifest.js';
import { ANALYST_LAYERS } from '../../data/analystEngine.js';

const read = (path) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const currentState = read('docs/CURRENT-STATE.md');
const section = currentState.slice(
  currentState.indexOf('## Prohibited & Restricted Airspace'),
  currentState.indexOf('\n## ', currentState.indexOf('## Prohibited')) + 1,
);
const tokens = JSON.parse(read('src/data/layerStateTokenReservations.json'));

test('CURRENT-STATE names the reserved share-link token', () => {
  const token = JSON.stringify(tokens).match(
    /\["drone-airspace","([^"]+)"\]/,
  )?.[1];
  assert.ok(token, 'drone-airspace has a reserved token');
  assert.match(section, new RegExp(`share-link token \`${token}\``));
});

test('CURRENT-STATE matches the layer being outside voice and the analyst', () => {
  assert.ok(Object.hasOwn(VOICE_OFF_LAYERS, 'drone-airspace'));
  assert.ok(!Object.hasOwn(ANALYST_LAYERS, 'drone-airspace'));
  assert.doesNotMatch(section, /Voice can toggle/);
  assert.match(section, /Voice is off for this layer for now/);
  const analyst = currentState.match(/Analyst records come on demand[^\n]*/)[0];
  assert.doesNotMatch(analyst, /drone/i);
});

test('CURRENT-STATE states what the layer does not cover', () => {
  assert.match(section, /UAS Facility Map/);
  assert.match(section, /LAANC/);
  assert.match(section, /TFRs/);
});
