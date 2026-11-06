import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOICE_OFF_LAYERS } from '../../voice/layerManifest.js';
import { ANALYST_LAYERS } from '../../data/analystEngine.js';

const read = (path) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const current = read('docs/CURRENT-STATE.md');
const start = current.indexOf('## Wildlife Sightings —');
const section = current
  .slice(start, current.indexOf('\n## ', start + 1))
  .replace(/\s+/g, ' ');

test('Wildlife docs name the permanent token, voice policy and coverage limits', () => {
  const token = JSON.parse(
    read('src/data/layerStateTokenReservations.json'),
  ).find(([id]) => id === 'wildlife-sightings')?.[1];
  assert.ok(token);
  assert.match(section, new RegExp(`share-link token \`${token}\``));
  assert.match(section, /Voice is off for this layer for now/);
  assert.ok(Object.hasOwn(VOICE_OFF_LAYERS, 'wildlife-sightings'));
  assert.ok(!Object.hasOwn(ANALYST_LAYERS, 'wildlife-sightings'));
  assert.match(section, /not a census/i);
  assert.match(section, /Salish Sea/);
  assert.match(section, /0\.01°/);
  assert.match(section, /private records are excluded/);
});

test('Wildlife documentation defines recency by observation time and compact ambient credit', () => {
  assert.match(section, /observation time/i);
  assert.match(section, /\bd1\b/);
  assert.match(section, /48 h/);
  assert.match(section, /96 px/);
  assert.match(section, /creator name/i);
  assert.match(section, /110\/125 km/);
  assert.match(section, /120 km/);
  assert.match(section, /random sample/);
  assert.match(section, /bounded frame cache/);
  assert.match(read('DATA_SOURCES.md'), /observation time/i);
});

test('Wildlife docs describe direct photo selection and text-only privacy rows', () => {
  assert.match(section, /compact anchored\s+photo card/);
  assert.match(section, /object-fit: contain/);
  assert.match(section, /preserving zoom/);
  assert.match(section, /compact observed\s+age/);
  assert.match(section, /Obscured sightings also stay\s+text-only/);
  assert.match(section, /Acartia stays text-only/);
  assert.match(section, /closes the card and clears selection/);
  assert.match(
    section,
    /shell teardown also removes its host and subscription/,
  );
  assert.doesNotMatch(
    section,
    /opens\s+the \*\*Sighting\*\* panel|Clicking the panel photo/,
  );
});

test('Wildlife docs record queue failure isolation and the complete badge mapping', () => {
  assert.match(section, /recovered queue tail/);
  assert.match(section, /ordinary grid failures/);
  assert.match(section, /DEGRADED/);
  assert.match(section, /1.5 px dark outline/);
  for (const glyph of [
    'raven',
    'pets',
    'egg_alt',
    'water_drop',
    'set_meal',
    'bug_report',
    'pest_control',
    'eco',
    'umbrella',
    'category',
    'question_mark',
  ])
    assert.ok(section.includes('`' + glyph + '`'), glyph);
});

test('Wildlife docs separate density from real observation icons and define persistent selection', () => {
  assert.match(section, /dedicated, nonpickable billboard/);
  assert.match(section, /view-relative density ramp/);
  assert.match(section, /four logical cell widths/);
  assert.match(
    section,
    /Only real sampled observation rows produce taxon badges/,
  );
  assert.match(
    section,
    /Grid tiles publish even while the independent observation/,
  );
  assert.match(section, /until explicit\s+deselection or layer disable/);
  assert.match(
    section,
    /releases\s+the glow collection, texture atlas, timers, queues and style listeners/,
  );
  assert.doesNotMatch(section, /grid badge|Clicking a grid cell/);
});

test('Wildlife docs describe one source link, name declutter and globe glow limits', () => {
  assert.match(section, /selected chrome and paint lane/);
  assert.match(section, /single source link/);
  assert.match(section, /80 screen pixels/);
  assert.match(section, /word boundary/);
  assert.match(section, /3,000 km/);
  assert.match(section, /8,000 km/);
  assert.match(section, /5% radius margin/);
  assert.match(section, /add no per-frame work/);
});

test('Wildlife docs cite the documented UTFGrid endpoint and the Acartia key request', () => {
  for (const path of [
    'docs/KNOWN-ISSUES.md',
    'DATA_SOURCES.md',
    'docs/CURRENT-STATE.md',
  ]) {
    const text = read(path);
    assert.doesNotMatch(text, /undocumented (iNaturalist|UTFGrid) endpoint/i);
    assert.doesNotMatch(text, /grid \(undocumented/i);
  }
  for (const path of ['docs/KNOWN-ISSUES.md', 'DATA_SOURCES.md'])
    assert.match(read(path), /Grid Tiles UTFGrid/);
  assert.match(
    read('DATA_SOURCES.md'),
    /create an account and generate an API key/,
  );
});
