import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOICE_OFF_LAYERS } from '../../voice/layerManifest.js';
import { ANALYST_LAYERS } from '../../data/analystEngine.js';

const read = (path) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const currentState = read('docs/CURRENT-STATE.md');
const start = currentState.indexOf(
  '## Turbulence — NOAA Aviation Weather Center',
);
const section = currentState.slice(
  start,
  currentState.indexOf('\n## ', start + 1) + 1,
);
const tokens = JSON.parse(read('src/data/layerStateTokenReservations.json'));

test('CURRENT-STATE has a Turbulence section naming the reserved share-link token', () => {
  assert.ok(start >= 0, 'section present');
  const token = JSON.stringify(tokens).match(
    /\["weather-turbulence","([^"]+)"\]/,
  )?.[1];
  assert.ok(token, 'weather-turbulence has a reserved token');
  assert.match(section, new RegExp(`share-link\\s+token \`${token}\``));
});

test('CURRENT-STATE matches the layer being outside voice and the analyst', () => {
  assert.ok(Object.hasOwn(VOICE_OFF_LAYERS, 'weather-turbulence'));
  assert.ok(!Object.hasOwn(ANALYST_LAYERS, 'weather-turbulence'));
  assert.match(section, /Voice is off for this layer for now/);
  const analyst = currentState.match(/Analyst records come on demand[^\n]*/)[0];
  assert.doesNotMatch(analyst, /turbulence/i);
});

test('CURRENT-STATE states what the layer does not cover', () => {
  assert.match(section, /contiguous United States only/);
  assert.match(section, /not the gridded WAFS/);
  assert.match(section, /not for flight planning/);
});

test('the live-layers table lists the route', () => {
  assert.match(
    currentState,
    /\| Turbulence ≋ \(`weather-turbulence`\)[^\n]*`\/api\/turbulence`/,
  );
});
