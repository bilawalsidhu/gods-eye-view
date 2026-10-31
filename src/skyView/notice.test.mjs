import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { DATA_CREDITS } from '../data/dataCredits.js';

const here = (name) => new URL(name, import.meta.url);
const text = (name) => readFileSync(here(name), 'utf8');

test('GEV credits carry the CC BY-SA attribution for both Sky view catalogues', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'sky-catalogues');
  assert.ok(
    credit,
    'the sky-catalogues credit line is missing from DATA_CREDITS',
  );
  assert.match(credit.html, /HYG database v4\.4/);
  assert.match(credit.html, /David Nash/);
  assert.match(credit.html, /CC BY-SA 4\.0/);
  assert.match(credit.html, /href="https:\/\/codeberg\.org\/astronexus\/hyg"/);
  assert.match(credit.html, /Stellarium/);
  assert.match(
    credit.html,
    /href="https:\/\/github\.com\/Stellarium\/stellarium-skycultures"/,
  );
});

test('DATA_SOURCES.md and LICENSE list the Sky view data', () => {
  const sources = readFileSync(here('../../DATA_SOURCES.md'), 'utf8');
  assert.match(sources, /Sky view stars and constellations/);
  assert.match(sources, /src\/skyView\/data\//);
  const licence = readFileSync(here('../../LICENSE'), 'utf8');
  assert.match(licence, /src\/skyView\/data\/\): HYG v4\.4/);
});

test('NOTICE.md and both upstream licence texts sit next to the data', () => {
  const notice = text('./NOTICE.md');
  for (const pattern of [
    /HYG database v4\.4, David Nash/,
    /CC BY-SA 4\.0/,
    /Stellarium sky cultures/,
    /Text and data: CC BY-SA/,
    /astronomy-engine 2\.1\.19/,
  ])
    assert.match(notice, pattern);
  assert.match(
    text('./data/LICENSE-HYG.md'),
    /Creative Commons Attribution-ShareAlike 4\.0/,
  );
  assert.match(
    text('./data/LICENSE-Stellarium-western.md'),
    /Text and data: CC BY-SA/,
  );
  assert.match(
    text('./data/CC-BY-SA-4.0.txt'),
    /Attribution-ShareAlike 4\.0 International/,
  );
  for (const name of ['stars.json', 'constellations.json', 'manifest.json'])
    assert.ok(existsSync(here(`./data/${name}`)), name);
});

test('the data files declare their own licence', () => {
  const stars = JSON.parse(text('./data/stars.json'));
  const lines = JSON.parse(text('./data/constellations.json'));
  assert.equal(stars.licence, 'CC BY-SA 4.0');
  assert.match(stars.source, /HYG v4\.4/);
  assert.match(lines.licence, /CC BY-SA/);
  assert.match(lines.source, /Stellarium/);
});

test('astronomy-engine is pinned to an exact version', () => {
  const pkg = JSON.parse(readFileSync(here('../../package.json'), 'utf8'));
  assert.match(pkg.dependencies['astronomy-engine'], /^\d+\.\d+\.\d+$/);
});
