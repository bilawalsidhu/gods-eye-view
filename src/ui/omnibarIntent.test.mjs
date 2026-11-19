import assert from 'node:assert/strict';
import test from 'node:test';
import { isPanelText, magnitudeFloor, parseOmnibar } from './omnibarIntent.js';

const matchLayers = (term) =>
  ['flights', 'ships'].includes(term) ? [{ id: term, score: 2 }] : [];

test('place lookup retains comma qualifiers in standalone and combined requests', () => {
  assert.deepEqual(
    [...parseOmnibar('  Paris, Texas  ', matchLayers).steps],
    [{ kind: 'place', place: 'Paris, Texas' }],
  );
  const { steps } = parseOmnibar(
    'north up, flights near Paris, Texas, follow AAL123',
    matchLayers,
  );
  assert.deepEqual(
    steps.map(({ kind }) => kind),
    ['place', 'camera', 'layer', 'follow'],
  );
  assert.equal(steps[0].place, 'paris, texas');
});

test('named layer removals and orbit stop preserve the requested action', () => {
  const { steps } = parseOmnibar(
    'hide all flights and ships, stop orbit',
    matchLayers,
  );
  assert.deepEqual(
    [...steps],
    [
      { kind: 'layer', layer: { id: 'flights', score: 2 }, enabled: false },
      { kind: 'layer', layer: { id: 'ships', score: 2 }, enabled: false },
      { kind: 'camera', name: 'move_camera', args: { motion: 'stop' } },
    ],
  );
  assert.deepEqual(
    [...parseOmnibar('turn off all layers', matchLayers).steps],
    [{ kind: 'camera', act: 'clear' }],
  );
});

const layersOf = (steps) =>
  [...steps].map((step) =>
    step.kind === 'layer'
      ? { kind: 'layer', id: step.layer.id, enabled: step.enabled }
      : step,
  );

test('turning the radio off is a radio step, and its verb is never a place', () => {
  assert.deepEqual(
    layersOf(parseOmnibar('tokyo and turn off the radio', matchLayers).steps),
    [
      { kind: 'place', place: 'tokyo' },
      { kind: 'radio', action: 'disable' },
    ],
  );
  assert.deepEqual(
    layersOf(
      parseOmnibar('show flights and stop the radio', matchLayers).steps,
    ),
    [
      { kind: 'layer', id: 'flights', enabled: true },
      { kind: 'radio', action: 'disable' },
    ],
  );
  assert.deepEqual(
    layersOf(parseOmnibar('go to austin, mute radio', matchLayers).steps),
    [
      { kind: 'place', place: 'austin' },
      { kind: 'radio', action: 'disable' },
    ],
  );
  assert.deepEqual(
    layersOf(parseOmnibar('play radio in tokyo', matchLayers).steps),
    [
      { kind: 'place', place: 'tokyo' },
      { kind: 'radio', action: 'enable' },
    ],
  );
});

// Layers as the Omnibar matches them: whole names are `exact`, a name's
// start is not.
const LAYERS = {
  flights: ['flights'],
  earthquakes: ['earthquakes', 'quakes'],
  'local-firms': ['fires'],
  'rocket-launches': ['rockets', 'launches'],
  traffic: ['traffic'],
  radio: ['radio'],
};
const matchNamed = (term) => {
  const needle = term.trim().toLowerCase();
  if (!needle) return [];
  return Object.entries(LAYERS)
    .filter(([, words]) =>
      words.some((word) => needle.length >= 3 && word.startsWith(needle)),
    )
    .map(([id, words]) => ({
      id,
      score: 2,
      exact: words.includes(needle) || words.includes(`${needle}s`),
    }));
};

test('near-miss lines read as people mean them', () => {
  const read = (text) => layersOf(parseOmnibar(text, matchNamed).steps);
  const clear = [{ kind: 'camera', act: 'clear' }];
  assert.deepEqual(read('hide everything'), clear);
  assert.deepEqual(read('remove everything'), clear);
  assert.equal(isPanelText('hide everything'), false);
  assert.equal(isPanelText('close all panels'), true);
  assert.deepEqual(read('track flights near austin'), [
    { kind: 'place', place: 'austin' },
    { kind: 'layer', id: 'flights', enabled: true },
  ]);
  assert.deepEqual(read('follow AAL123'), [
    { kind: 'follow', query: 'aal123' },
  ]);
  assert.deepEqual(read('show earthquake data layer'), [
    { kind: 'layer', id: 'earthquakes', enabled: true },
  ]);
  assert.equal(isPanelText('show earthquake data layer'), false);
  assert.equal(read('open data layers')[0].item, 'data-panel');
  assert.equal(
    read('open space missions panel')[0].item,
    'space-missions-panel',
  );
  assert.equal(
    read('close the missions panel')[0].item,
    'space-missions-panel',
  );
  // Without "panel" it is the layer, not its panel.
  assert.equal(isPanelText('show space missions'), false);
  assert.deepEqual(read('go to trinidad and tobago and show flights'), [
    { kind: 'place', place: 'trinidad and tobago' },
    { kind: 'layer', id: 'flights', enabled: true },
  ]);
  // "fire" is a whole layer word, so "Fire Island" is ambiguous: the whole
  // line is offered as a place first (see the Omnibar test).
  assert.equal(parseOmnibar('Fire Island', matchNamed).ambiguous, true);
  assert.deepEqual(read('Show Low, AZ'), [
    { kind: 'place', place: 'Show Low, AZ' },
  ]);
  // Words that also start place names ask only in a longer line.
  for (const place of ['Can Tho', 'Tell City']) {
    const { steps, question } = parseOmnibar(place, matchNamed);
    assert.equal(question, false, place);
    assert.deepEqual([...steps], [{ kind: 'place', place }]);
  }
  assert.equal(parseOmnibar('can you show me', matchNamed).question, true);
  assert.equal(parseOmnibar('Can Tho?', matchNamed).question, true);
  assert.equal(parseOmnibar('what is here', matchNamed).question, true);
});

test('a magnitude floor is read for earthquakes only', () => {
  assert.deepEqual(magnitudeFloor('quakes above m5 in japan', matchNamed), {
    text: 'quakes in japan',
    minMagnitude: 5,
  });
  assert.deepEqual(magnitudeFloor('earthquakes m4.5+ near tokyo', matchNamed), {
    text: 'earthquakes near tokyo',
    minMagnitude: 4.5,
  });
  assert.deepEqual(magnitudeFloor('flights over m25', matchNamed), {
    text: 'flights over m25',
    minMagnitude: null,
  });
  assert.deepEqual(magnitudeFloor('flights near austin', matchNamed), {
    text: 'flights near austin',
    minMagnitude: null,
  });
});

test('place names holding a command word are places, or ambiguous at most', () => {
  const read = (text) => parseOmnibar(text, matchNamed);
  // The cockpit and the radio need a verb.
  for (const text of [
    'Cockpit Country, Jamaica',
    'cockpit',
    'cockpit view',
    'Rock and Roll Hall of Fame',
  ]) {
    const { steps } = read(text);
    assert.deepEqual([...steps], [{ kind: 'place', place: text }], text);
  }
  assert.deepEqual([...read('enter cockpit').steps], [{ kind: 'cockpit' }]);
  assert.equal(
    read('Radio City Music Hall').steps.some((step) => step.kind === 'radio'),
    false,
  );
  // One keyword without a verb beside the rest of a name: the whole line is
  // offered as a place ahead of the plan.
  for (const text of [
    'Radio City Music Hall',
    'Radio Free Europe',
    'Thermal, California',
    'Tilt Cove',
    'Hud Valley',
    'tokyo traffic',
  ])
    assert.equal(read(text).ambiguous, true, text);
  // A verb, a joining "and" or "near" makes it a plan.
  // Keywords nobody asked for, joined to the rest of a name, leave the
  // whole line a place first too ("Storm Lake and Spencer").
  assert.equal(read('noir and tokyo').ambiguous, true);
  for (const text of [
    'flights near austin',
    'show traffic in tokyo',
    'tilt and go to cove',
    'show noir and tokyo',
  ])
    assert.equal(read(text).ambiguous, false, text);
});

test('nearest to, several places, and what can be followed', () => {
  const read = (text) => layersOf(parseOmnibar(text, matchNamed).steps);
  assert.deepEqual(read('nearest plane to Heathrow'), [
    { kind: 'place', place: 'heathrow' },
    { kind: 'nearest' },
  ]);
  const both = parseOmnibar('flights near New York and Paris', matchNamed);
  assert.equal(both.steps[0].place, 'new york');
  assert.deepEqual(both.extraPlaces, ['paris']);
  assert.deepEqual(read('Follow Me Bar'), [
    { kind: 'place', place: 'Follow Me Bar' },
  ]);
  // A name without a digit is followed only when it is loaded on the map.
  assert.deepEqual(
    layersOf(
      parseOmnibar('follow the iss', matchNamed, {
        isEntity: (name) => name === 'iss',
      }).steps,
    ),
    [{ kind: 'follow', query: 'iss' }],
  );
  assert.deepEqual(read('Track Hill'), [
    { kind: 'place', place: 'Track Hill' },
  ]);
  assert.deepEqual(read('follow UAL 123'), [
    { kind: 'follow', query: 'ual 123' },
  ]);
});

test('a magnitude floor is no part of the place', () => {
  const { text, minMagnitude } = magnitudeFloor(
    'show me earthquakes above m5 in japan',
    matchNamed,
  );
  assert.equal(minMagnitude, 5);
  assert.deepEqual(layersOf(parseOmnibar(text, matchNamed).steps), [
    { kind: 'place', place: 'japan' },
    { kind: 'layer', id: 'earthquakes', enabled: true },
  ]);
});

test('ar and he mark every Omnibar string alike with a right-to-left mark', async () => {
  const { readFile } = await import('node:fs/promises');
  // Every message the Omnibar's code passes to t(), msg() or tn(): after a
  // colon or comma, before a placeholder or Latin text, both catalogs put
  // U+200F, so the punctuation stays with the right-to-left text before it.
  const sources = await Promise.all(
    [
      './views/panels/Omnibar.vue',
      './views/panels/VoiceVisualizer.vue',
      './omnibarIntent.js',
      './omnibarRows.js',
      './omnibarGuide.js',
      './leftPanelRail.js',
    ].map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  );
  const code = sources.join('\n');
  // Single- or double-quoted, as t('…') / msg("…") / tn(n, '…', "…").
  const STRING = String.raw`'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"`;
  const literal = (match, from) => match[from] ?? match[from + 1];
  const keys = new Set([
    ...[
      ...code.matchAll(
        new RegExp(String.raw`\b(?:t|msg)\(\s*(?:${STRING})`, 'g'),
      ),
    ].map((match) => literal(match, 1)),
    ...[
      ...code.matchAll(
        new RegExp(
          String.raw`\btn\([^,]+,\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"),\s*(?:${STRING})`,
          'g',
        ),
      ),
    ].map((match) => literal(match, 1)),
  ]);
  assert.ok(keys.size > 100, `${keys.size} Omnibar messages`);
  const unmarked = /[:\u060c,] (?!\u200f)(?=[{A-Za-z\u00ab\u05f4"])/;
  for (const locale of ['ar', 'he']) {
    const catalog = JSON.parse(
      await readFile(
        new URL(`../i18n/locales/${locale}.json`, import.meta.url),
        'utf8',
      ),
    );
    for (const key of keys) {
      const entry = catalog[key];
      assert.ok(entry, `${locale} has ${key}`);
      for (const text of typeof entry === 'string'
        ? [entry]
        : Object.values(entry))
        assert.doesNotMatch(text, unmarked, `${locale}: ${key}`);
    }
  }
});

test('a "go to" clause is all place, and radio verbs apply to the radio', () => {
  const read = (text) => layersOf(parseOmnibar(text, matchNamed).steps);
  for (const [text, place] of [
    ['go to cockpit country', 'cockpit country'],
    ['go to Thermal, California', 'Thermal, California'],
    ['fly to Tilt Cove', 'Tilt Cove'],
    ['go to Night Vision Way', 'Night Vision Way'],
    ['go to Whole Earth Provision', 'Whole Earth Provision'],
  ])
    assert.deepEqual(read(text), [{ kind: 'place', place }], text);
  assert.deepEqual(read('go to austin, clear everything'), [
    { kind: 'place', place: 'austin' },
    { kind: 'camera', act: 'clear' },
  ]);
  assert.deepEqual(read('go to'), []);
  assert.deepEqual(read('play radio in Kill Devil Hills'), [
    { kind: 'place', place: 'kill devil hills' },
    { kind: 'radio', action: 'enable' },
  ]);
  assert.deepEqual(read('enter the cockpit view'), [{ kind: 'cockpit' }]);
  // Only a real question asks GEV by default; small talk goes there too.
  assert.equal(parseOmnibar('hi', matchNamed).asks, false);
  // Small talk is no question: it may be a place, with Ask GEV after it.
  assert.equal(parseOmnibar('hi', matchNamed).question, false);
  assert.equal(parseOmnibar('what is here', matchNamed).asks, true);
  // A long line is not split word by word into a layer and a place.
  let asked = 0;
  parseOmnibar('a b c d e f g h i j k l m n o p', (term) => {
    asked++;
    return matchNamed(term);
  });
  assert.ok(asked <= 2, `${asked} layer lookups`);
});

test('a request ending a "go to" clause is peeled off, and the line is ambiguous', () => {
  const read = (text) => parseOmnibar(text, matchNamed);
  for (const [text, place, step] of [
    ['go to tokyo in noir', 'tokyo', { kind: 'style', style: 'noir' }],
    ['go to tokyo, noir', 'tokyo', { kind: 'style', style: 'noir' }],
    ['go to Tokyo, north up', 'tokyo', { kind: 'camera', act: 'northUp' }],
    [
      'take me to Austin in thermal',
      'austin',
      { kind: 'style', style: 'thermal' },
    ],
    [
      'go to London with flights',
      'london',
      { kind: 'layer', id: 'flights', enabled: true },
    ],
    [
      'go to tokyo show flights',
      'tokyo',
      { kind: 'layer', id: 'flights', enabled: true },
    ],
  ]) {
    const parsed = read(text);
    assert.equal(parsed.ambiguous, true, text);
    assert.equal(parsed.peeled, true, text);
    assert.deepEqual(
      layersOf(parsed.steps),
      [{ kind: 'place', place }, step],
      text,
    );
  }
  for (const text of [
    'go to Thermal, California',
    'fly to Tilt Cove',
    'go to Night Vision Way',
    'go to cockpit country',
  ])
    assert.equal(read(text).steps.length, 1, text);
  // A joining word left alone names no place.
  assert.deepEqual(
    layersOf(read('go to Austin and show flights in noir').steps),
    [
      { kind: 'place', place: 'austin' },
      { kind: 'style', style: 'noir' },
      { kind: 'layer', id: 'flights', enabled: true },
    ],
  );
  // A named layer without a verb may be a name: "Hurricane, Utah".
  assert.equal(read('fires, utah').ambiguous, true);
  assert.equal(read('flights near austin').placeFrom, 'near');
  // A comma line without "?" is never a question.
  for (const text of ['Why, Arizona', 'What Cheer, Iowa', 'Can Tho, Vietnam'])
    assert.equal(read(text).question, false, text);
  assert.equal(read('why, arizona?').question, true);
});

test('the one verb test reads any letter case', async () => {
  const { hasActionVerb } = await import('./omnibarIntent.js');
  for (const text of [
    'Turn on the radio',
    'Turn On Radio',
    'Draw',
    'CLEAR THE MAP',
  ])
    assert.equal(hasActionVerb(text), true, text);
  for (const text of [
    'Kill Devil Hills',
    'Show',
    'See',
    'Clear Lake',
    'Tilt Cove',
  ])
    assert.equal(hasActionVerb(text), text === 'Show', text);
});

test('every place word is still a bundled place name', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { PLACE_WORDS } = await import('./omnibarEnter.js');
  const names = new Set();
  const cities = JSON.parse(
    await readFile(
      new URL(
        '../data/local_data/wikidata_cities/cities.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const row of cities.rows) names.add(row[0].toLowerCase());
  const dir = new URL('../data/local_data/wikidata_places/', import.meta.url);
  for (const file of await readdir(dir))
    if (/^-?\d+_-?\d+\.json$/.test(file))
      for (const row of JSON.parse(await readFile(new URL(file, dir), 'utf8'))
        .rows)
        names.add(row[0].toLowerCase());
  for (const word of PLACE_WORDS) assert.ok(names.has(word), word);
});
