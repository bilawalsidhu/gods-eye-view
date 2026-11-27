// src/ui/omnibarRows.test.mjs — the Omnibar's one pipeline from typed text
// to rows, read without the DOM: what Enter runs for a line before any row is
// chosen, what may go to the place service, and the rows themselves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOmnibar, readLine } from './omnibarRows.js';
import { normalizeLine } from './omnibarIntent.js';

const LAYERS = [
  { id: 'flights', name: 'Live Flights', enabled: false },
  { id: 'military', name: 'Military Flights', enabled: false },
  { id: 'radio', name: 'Radio', enabled: false },
  { id: 'cctv', name: 'CCTV', enabled: false },
  { id: 'earthquakes', name: 'Earthquakes', enabled: false },
  { id: 'traffic', name: 'Traffic', enabled: false },
  { id: 'weather-radar', name: 'Weather radar', enabled: false },
];
const layers = (on = []) =>
  LAYERS.map((layer) => ({ ...layer, enabled: on.includes(layer.id) }));

/** One step of a plan, as the table writes it. */
function stepOutcome(step) {
  switch (step.kind) {
    case 'place':
      return `fly(${step.place})`;
    case 'layer':
      return `layer(${step.layer.id},${step.enabled ? 'on' : 'off'})`;
    case 'style':
      return `style(${step.style})`;
    case 'stack':
      return `map(${step.stack})`;
    case 'camera':
      return `camera(${step.act || step.args?.motion || step.args?.direction || step.name})`;
    case 'hud':
      return `hud(${step.visible})`;
    case 'panel':
      return `panel(${step.action} ${step.item || step.side})`;
    case 'radio':
      return `radio(${step.action || 'enable'})`;
    case 'follow':
      return `follow(${step.query})`;
    default:
      return step.kind;
  }
}

/** What Enter runs for a line before any row is chosen. */
function outcome(text, { on = [], places = [] } = {}) {
  const omnibar = createOmnibar({ layers: layers(on) });
  const { rows, defaultIndex } = omnibar.rows(text, { places });
  const row = rows[defaultIndex];
  if (!row) return 'nothing';
  switch (row.kind) {
    case 'place':
      return `search(${row.place})`;
    case 'layer':
      return `layer(${row.id},${row.enabled ? 'on' : 'off'})`;
    case 'ask':
      return `ask(${row.query})`;
    case 'plan':
      return row.steps.map(stepOutcome).join(' + ');
    default:
      return row.kind;
  }
}

// Every line is read with no row chosen. `search(q)` is the place search,
// `nothing` means Enter runs nothing.
const OUTCOMES = [
  // A switch after what it switches is a switch, never a place.
  ['noir off', 'style(normal)'],
  ['Noir off', 'style(normal)'],
  ['noir on', 'style(noir)'],
  ['turn off noir', 'style(normal)'],
  ['thermal off', 'style(normal)'],
  ['night vision off', 'style(normal)'],
  ['orbit off', 'camera(stop)'],
  ['osm off', 'nothing'],
  ['hud off', 'hud(off)'],
  ['radio off', 'radio(disable)'],
  ['cctv off', 'layer(cctv,off)'],
  ['Bath on', 'search(Bath on)'],
  // A verb ends at a space: hyphenated names are names.
  ['Hide-A-Way Lake noir', 'search(Hide-A-Way Lake noir)'],
  ['Hide-A-Way Lake', 'search(Hide-A-Way Lake)'],
  ['Show-Me Lake radio', 'search(Show-Me Lake radio)'],
  // A closing full stop, curly apostrophes and "please".
  ['Show flights.', 'layer(flights,on)'],
  ['show flights!', 'layer(flights,on)'],
  ['please show flights', 'layer(flights,on)'],
  ['Please, show flights', 'layer(flights,on)'],
  ['show flights please', 'layer(flights,on)'],
  ['North up.', 'camera(northUp)'],
  ['please north up', 'camera(northUp)'],
  ['Clear all layers!', 'camera(clear)'],
  ['what’s here', 'ask(what’s here)'],
  ['what’s here?', 'ask(what’s here?)'],
  ['Paris, Texas.', 'search(Paris, Texas.)'],
  ['Washington D.C.', 'search(Washington D.C.)'],
  ['please', 'search(please)'],
  // Ask GEV (a billed call) needs a question, not a name.
  ['Do it Best Hardware', 'search(Do it Best Hardware)'],
  ['Can You Imagine', 'search(Can You Imagine)'],
  ['Is This It', 'search(Is This It)'],
  ['Where Is My Mind', 'search(Where Is My Mind)'],
  ['can you show me', 'nothing'],
  ['is it raining in tokyo', 'nothing'],
  ['is it raining in tokyo?', 'ask(is it raining in tokyo?)'],
  ['where is my mind', 'ask(where is my mind)'],
  ['how far is paris', 'ask(how far is paris)'],
  ['Can Tho City', 'search(Can Tho City)'],
  ['Is there', 'search(Is there)'],
  // Pasted sentences are no place, and words about a layer are no place.
  ['Show radio stations', 'layer(radio,on)'],
  ['show radio station', 'layer(radio,on)'],
  ['show flights here', 'layer(flights,on)'],
  ['flights here', 'search(flights here)'],
  ['I went to the store yesterday and it was really great', 'nothing'],
  ['the quick brown fox jumps over the lazy dog', 'nothing'],
  ['we saw so many flights over the city and it was loud', 'nothing'],
  ['go to Austin and show flights', 'fly(austin) + layer(flights,on)'],
  // keywords without a verb ask for nothing,
  // however many clauses they fill, and names keep their words.
  ['Fire and Rain', 'search(Fire and Rain)'],
  ['Rain, Thermal', 'search(Rain, Thermal)'],
  ['Weather and Traffic', 'search(Weather and Traffic)'],
  // Each word alone is a command that runs ("orbit", "tilt").
  ['Orbit and Tilt', 'camera(orbit) + camera(tilt)'],
  ['Noir and Thermal', 'search(Noir and Thermal)'],
  ['Trains and Boats and Planes', 'search(Trains and Boats and Planes)'],
  ['Storm Lake and Spencer', 'search(Storm Lake and Spencer)'],
  ['Fire Island and Ocean Beach', 'search(Fire Island and Ocean Beach)'],
  ['Thermal and Indio', 'search(Thermal and Indio)'],
  ['Please Touch Museum', 'search(Please Touch Museum)'],
  ['Kindly Lane', 'search(Kindly Lane)'],
  ['Pretty Please', 'search(Pretty Please)'],
  ['Yahoo!', 'search(Yahoo!)'],
  ['Draw Bridge', 'search(Draw Bridge)'],
  ['draw well', 'search(draw well)'],
  ['draw a line', 'open-draw'],
  ['How To Train Your Dragon', 'nothing'],
  ['how to see satelites', 'ask(how to see satelites)'],
  ['Train Station', 'search(Train Station)'],
  ['Traffic Status', 'search(Traffic Status)'],
  ['Remove Island', 'search(Remove Island)'],
  ['Toggle Inn', 'search(Toggle Inn)'],
  ['Disable Canyon', 'search(Disable Canyon)'],
  ['remove island', 'nothing'],
  ['show noir and show cctv', 'style(noir) + layer(cctv,on)'],
  // a name with "?" is offered to GEV,
  // never sent; a question's form is.
  ['New York?', 'nothing'],
  ['Truth or Consequences?', 'nothing'],
  ['Ho Chi Minh City?', 'nothing'],
  ['Santa Cruz de la Sierra?', 'nothing'],
  ['東京都？', 'nothing'],
  ['東京はどこ？', 'ask(東京はどこ？)'],
  ['is it far?', 'ask(is it far?)'],
  ['how about the weather in paris today?', 'nothing'],
  ['123–45–6789', 'nothing'],
  ['what is 4111–1111–1111–1111?', 'nothing'],
  // a switch with its place after "in" asks;
  // a vague "how do I" runs no walk; names with "senha" or "xox" in them
  // and addresses with numbers are places.
  ['turn on radio in tokyo', 'fly(tokyo) + radio(enable)'],
  ['enable radio in tokyo', 'fly(tokyo) + radio(enable)'],
  ['turn on noir in tokyo', 'fly(tokyo) + style(noir)'],
  ['how do I share', 'guide'],
  ['how do I sha', 'nothing'],
  ['Sachsenhausen', 'search(Sachsenhausen)'],
  ['Xoxocotla', 'search(Xoxocotla)'],
  ['Meguro Honmachi 2-chome', 'search(Meguro Honmachi 2-chome)'],
  [
    '1600 Pennsylvania Ave NW Washington DC 20500',
    'search(1600 Pennsylvania Ave NW Washington DC 20500)',
  ],
  // A long comma address beside a layer word is a sentence; a verb that
  // starts a name asks for nothing; small talk asks no question.
  ['San Jose, Santa Clara County, California, USA flights', 'nothing'],
  ['Start Point noir', 'search(Start Point noir)'],
  ['Track Hill noir', 'search(Track Hill noir)'],
  ['Open Bay north up', 'search(Open Bay north up)'],
  ['show noir', 'style(noir)'],
  ['play radio tokyo', 'fly(tokyo) + radio(enable)'],
  ["what's up", "search(what's up)"],
  ["how's it going", "search(how's it going)"],
  ["what's the weather in paris", "ask(what's the weather in paris)"],
  ['Hauptstrasse 12 10115 Berlin', 'search(Hauptstrasse 12 10115 Berlin)'],
  // "of" and "at" may join the words of a name; CJK addresses and
  // postcodes are places.
  ['Planes of Fame Air Museum', 'search(Planes of Fame Air Museum)'],
  ['Boats at Sea', 'search(Boats at Sea)'],
  ['flights over texas', 'fly(texas) + layer(flights,on)'],
  ['北京市朝阳区建国路88号', 'search(北京市朝阳区建国路88号)'],
  ['東京都港区六本木6丁目', 'search(東京都港区六本木6丁目)'],
  ['Washington DC 20500-0003', 'search(Washington DC 20500-0003)'],
  ['Calle 100 # 19-61 Bogota', 'search(Calle 100 # 19-61 Bogota)'],
  // Addresses that look like numbers to keep, and long names, are offered
  // to search on purpose; Enter runs nothing. "Track 7" and "Nearest Plane
  // Crash Site" are names.
  ['Tverskaya 13 125009 Moscow', 'search(Tverskaya 13 125009 Moscow)'],
  ['Москва, ул. Тверская, д. 13, 125009', 'nothing'],
  ['San Miguel de las Piedras Primera Sección', 'nothing'],
  ['Goto', 'search(Goto)'],
  ['goto tokyo', 'search(tokyo)'],
  ['Track 7', 'search(Track 7)'],
  ['Track 29', 'search(Track 29)'],
  ['Nearest Plane Crash Site', 'search(Nearest Plane Crash Site)'],
  ['nearest plane', 'nearest'],
  // Lines the mounted Enter table pins too, read through the module.
  ['tokyo traffic', 'search(tokyo traffic)'],
  ['flights near tokyo', 'fly(tokyo) + layer(flights,on)'],
  ['radio near Clear Lake', 'search(clear lake)'],
  ['Thermal', 'search(Thermal)'],
  ['Thermal, California', 'search(Thermal, California)'],
  ['radio', 'search(radio)'],
  ['share', 'nothing'],
  ['hide', 'nothing'],
  ['Turn on the radio', 'layer(radio,on)'],
];

for (const [text, expected] of OUTCOMES)
  test(`Enter on ${JSON.stringify(text)} runs ${expected}`, () => {
    assert.equal(outcome(text), expected);
  });

test('"show flights" with Live Flights on offers Live Flights, not Military Flights', () => {
  assert.equal(
    outcome('show flights', { on: ['flights'] }),
    'layer(flights,on)',
  );
  assert.equal(
    outcome('turn on flights', { on: ['flights'] }),
    'layer(flights,on)',
  );
  const { rows, defaultIndex } = createOmnibar({
    layers: layers(['flights']),
  }).rows('show flights');
  // Nothing to switch on the default row; Military Flights is offered after.
  assert.equal(rows[defaultIndex].hint, 'Layer');
  assert.ok(rows.some((row) => row.id === 'military'));
  assert.equal(outcome('hide flights', { on: [] }), 'layer(flights,off)');
  // "military" names Military Flights, never Live Flights.
  assert.equal(outcome('show military'), 'layer(military,on)');
});

test('a layer near a place cannot admit an unrelated bare style step', () => {
  assert.doesNotMatch(outcome('flights near Austin and noir'), /style\(noir\)/);
  assert.equal(
    outcome('flights near Austin'),
    'fly(austin) + layer(flights,on)',
  );
});

test('private text never reaches the place service, the search or GEV', () => {
  const omnibar = createOmnibar({ layers: layers() });
  for (const text of [
    '123 45 6789',
    '123456789',
    '123-45-6789',
    '4111 1111',
    '١٢٣٤, ٥٦٧٨',
    'what is my pass\u200bword: violet?',
    '4111-1111-1111-1111',
    '+1 415 555',
    '415 555 0',
    '415.555.0100',
    'hunter22',
    'letmein1',
    'Tr0ub4dor&3',
    'pa$$w0rd',
    'token: abc',
    'api key=xyz',
    'password hunter2',
    'me@example.com',
    '４１１１ １１１１ １１１１ １１１１',
    'john＠example.com',
    'ｓｋ_live_abc',
    '٤١١١ ١١١١ ١١١١ ١١١١',
    '४१११ ११११ ११११ ११११',
    '4111.1111.1111.1111',
    'what is 4111.1111.1111.1111',
    'where is ｊｏｈｎ＠ｅｘａｍｐｌｅ.ｃｏｍ',
    'card ٤١١١١١١١١١١١١١١١ valid?',
    '123–45–6789',
    '415‐555‐0100',
    '415−555−0100',
    '4111:1111:1111:1111',
    '4111|1111|1111|1111',
    '4111\u200b1111\u200b1111\u200b1111',
    'contraseña: hunter',
    'Passwort: geheim',
    'mot de passe: chat',
    'пароль qwerty',
    'api key abcdefgh',
  ]) {
    assert.equal(omnibar.placeQuery(text), null, text);
    assert.equal(omnibar.countRequest(text), null, text);
    const { rows, defaultIndex } = omnibar.rows(text);
    // Only a row to search it as a place on purpose, never by Enter.
    assert.ok(
      rows.every((row) => row.kind === 'place' && row.explicit),
      text,
    );
    assert.equal(defaultIndex, -1, text);
  }
  // Callsigns, postcodes, coordinates and street numbers are not secrets.
  assert.equal(omnibar.placeQuery('SW1A 1AA'), 'SW1A 1AA');
  assert.equal(omnibar.placeQuery('10 Downing Street'), '10 Downing Street');
  assert.equal(omnibar.placeQuery('Route 66'), 'Route 66');
  for (const callsign of ['UAL2110', 'BAW15K', 'N123AB'])
    assert.equal(omnibar.placeQuery(callsign), null, callsign);
  for (const text of ['30.2672, -97.7431', '14R PU 2090 4906']) {
    const { rows, defaultIndex } = omnibar.rows(text);
    assert.equal(rows[defaultIndex].kind, 'place', text);
    assert.ok(rows[defaultIndex].coords, text);
  }
});

test('private text still finds things already on the map, locally', () => {
  const omnibar = createOmnibar({ layers: layers() });
  const found = [];
  const { rows } = omnibar.rows('366123456', {
    entities: (text) => {
      found.push(text);
      return [
        {
          key: 'v1',
          icon: 'directions_boat',
          identity: 'v1',
          title: '366123456',
          layerName: 'Vessels',
        },
      ];
    },
  });
  assert.deepEqual(found, ['366123456']);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['entity'],
  );
});

test('typed photo results use the same translated title as the entity strip', () => {
  const translateTitle = (item) =>
    item.titleWords?.text === 'Street-level photo'
      ? 'Photo au niveau de la rue'
      : item.title;
  const omnibar = createOmnibar({
    layers: layers(),
    entityTitle: translateTitle,
  });
  const identity = { layerId: 'street-level', id: 'panoramax:1' };
  const { rows } = omnibar.rows('panoramax:1', {
    entities: () => [
      {
        key: 'street-level:panoramax:1',
        title: 'Street-level photo',
        titleWords: { text: 'Street-level photo' },
        layerName: 'Street Level',
        identity,
      },
    ],
  });
  const photo = rows.find((row) => row.kind === 'entity');
  assert.equal(photo.label, 'Photo au niveau de la rue');
  assert.equal(photo.identity, identity);
});

test('a map item named like a place follows the place; a callsign leads', () => {
  const omnibar = createOmnibar({ layers: layers() });
  const entities = (text) =>
    [
      {
        key: 's1',
        icon: 'directions_boat',
        identity: 's1',
        title: 'HAMBURG',
        layerName: 'Vessels',
      },
      {
        key: 'f1',
        icon: 'flight',
        identity: 'f1',
        title: 'UAL123',
        layerName: 'Flights',
      },
    ].filter((item) => item.title.toLowerCase().startsWith(text.toLowerCase()));
  const hamburg = omnibar.rows('Hamburg', { entities });
  assert.equal(hamburg.rows[hamburg.defaultIndex].kind, 'place');
  assert.equal(hamburg.rows[1].kind, 'entity');
  const callsign = omnibar.rows('UAL123', { entities });
  assert.equal(callsign.rows[callsign.defaultIndex].kind, 'entity');
});

test('a long name or an address that looks private can be searched on purpose', () => {
  const omnibar = createOmnibar({ layers: layers() });
  for (const text of [
    'Москва, ул. Тверская, д. 13, 125009',
    'San Miguel de las Piedras Primera Sección',
  ]) {
    const { rows, defaultIndex } = omnibar.rows(text);
    assert.equal(defaultIndex, -1, text);
    const row = rows.find((each) => each.explicit);
    assert.equal(row?.place, text, text);
    assert.equal(omnibar.placeQuery(text), null, text);
  }
  // A bare number names no place.
  assert.deepEqual(omnibar.rows('4111 1111 1111 1111').rows, []);
});

test('a pasted sentence is never sent to the place service', () => {
  const omnibar = createOmnibar({ layers: layers() });
  for (const text of [
    'I went to the store yesterday and it was really great',
    'we saw so many flights over the city and it was loud',
    'Show radio stations',
    'noir off',
    'can you show me',
  ])
    assert.equal(omnibar.placeQuery(text), null, text);
  assert.equal(omnibar.placeQuery('Tokyo traffic'), 'Tokyo traffic');
  assert.equal(omnibar.placeQuery('flights near Tokyo.'), 'tokyo');
  assert.equal(omnibar.placeQuery('Paris, Texas.'), 'Paris, Texas.');
  assert.equal(omnibar.placeQuery('go to Paris, noir'), 'paris');
  assert.equal(omnibar.placeQuery('turn on radio in tokyo'), 'tokyo');
  assert.equal(omnibar.placeQuery('Sachsenhausen'), 'Sachsenhausen');
});

// The wording people use reaches each feature's own walk, and Enter starts
// it.
const GUIDE_PHRASES = [
  ['how do i change the map style', 'styles'],
  ['how to change the visual style', 'styles'],
  ['show me how to use night vision', 'styles'],
  ['how do i turn on the hud', 'hud'],
  ['how do i hide the hud', 'hud'],
  ['how do i tilt', 'tilt'],
  ['how do i tilt the map', 'tilt'],
  ['how to tilt the camera', 'tilt'],
  ['how to share this view', 'share'],
  ['how do i share a link', 'share'],
  ['how do i reset', 'globe'],
  ['how do i get back to the globe', 'globe'],
  ['how do i see the whole globe', 'globe'],
  ['how do i point north', 'north'],
  ['how do i use the compass', 'north'],
  ['how do i clear all layers', 'clear'],
  ['how to turn off all layers', 'clear'],
  ['how do i change the map', 'map-source'],
  ['how do i switch to openstreetmap', 'map-source'],
  ['how to measure distance', 'draw'],
  ['how do i draw', 'draw'],
  ['how do i draw a line', 'draw'],
  ['how do i measure an area', 'draw'],
  ['how do i search layers', 'find-layer'],
  ['how do i change language', 'preferences'],
];
for (const [text, feature] of GUIDE_PHRASES)
  test(`${JSON.stringify(text)} starts the ${feature} walk`, () => {
    const { rows, defaultIndex } = createOmnibar({ layers: layers() }).rows(
      text,
    );
    assert.equal(rows[defaultIndex]?.kind, 'guide', text);
    assert.equal(rows[defaultIndex].guide.feature, feature, text);
  });

test('a layer named in full leads a feature topic its words also hold', () => {
  const all = createOmnibar({
    layers: [
      ...layers(),
      { id: 'recent-imagery', name: 'Recent Imagery', enabled: false },
      { id: 'weather-lightning', name: 'Lightning density', enabled: false },
    ],
  });
  for (const [text, id] of [
    ['how do I see recent imagery', 'recent-imagery'],
    ['how do I see lightning density', 'weather-lightning'],
  ]) {
    const { rows, defaultIndex } = all.rows(text);
    assert.equal(rows[defaultIndex].guide.layer?.id, id, text);
  }
  // The Context panel's walk stays first beside a layer named Global
  // Context.
  const context = createOmnibar({
    layers: [
      { id: 'military-awareness', name: 'Global Context', enabled: false },
    ],
  }).rows('how do I open global context');
  assert.equal(context.rows[context.defaultIndex].guide.feature, 'context');
});

test('only an address that looks like a number may be searched anyway', () => {
  const omnibar = createOmnibar({ layers: layers() });
  for (const text of [
    'password hunter2',
    'john.doe@example.com',
    'hunter22',
    'sk-abc123def',
    'DE89 3704 0044 0532 0130 00',
    'pin 1234567',
    'door code 4421',
    // A number beside a word that says what it is, or one too long for an
    // address.
    'code 12345678 Berlin',
    'token 12345678 Berlin',
    'user john pass 12345678',
    'card 4111 1111 1111 1111 please',
    'my card is 4111111111111111',
    'routing 021000021 New York',
    'phone +1 415 555 0100 office',
    'BSN 123456782 Utrecht',
    'medicare 1234567890 Sydney',
    // Digits and words read as they fold: superscript, circled, full-width
    // or split by a zero-width space; card and phone words in other
    // languages.
    'Berlin ⁴¹¹¹¹¹¹¹¹¹¹¹¹¹¹¹',
    'Berlin ①②③④⑤⑥⑦⑧⑨⑩',
    'Main St 12 ¹²³⁴⁵⁶⁷⁸⁹¹²³⁴⁵⁶ Berlin',
    'ｃａｒｄ 4111 1111 Berlin',
    'ca\u200brd 4111 1111 Berlin',
    'Visa 4111 1111 Berlin',
    'Kreditkarte 4111 1111 Berlin',
    'Telefon 912 34 567',
  ])
    assert.deepEqual(omnibar.rows(text).rows, [], text);
  for (const text of [
    'Москва, ул. Тверская, д. 13, 125009',
    'Jl. Jend. Sudirman No. 52-53, 12190 Jakarta',
  ])
    assert.ok(
      omnibar.rows(text).rows.some((row) => row.explicit),
      text,
    );
});

test("a line naming a layer still starts that layer's walk", () => {
  const { rows, defaultIndex } = createOmnibar({ layers: layers() }).rows(
    'how to turn on flights',
  );
  assert.equal(rows[defaultIndex].guide.layer.id, 'flights');
});

test('every feature the words name has a walk', async () => {
  const { FEATURE_GUIDES } = await import('./omnibarGuide.js');
  const omnibar = createOmnibar({ layers: layers() });
  for (const [text] of GUIDE_PHRASES) {
    const { rows, defaultIndex } = omnibar.rows(text);
    const feature = rows[defaultIndex].guide.feature;
    assert.equal(typeof FEATURE_GUIDES[feature], 'function', feature);
  }
});

test('the line is normalised once, in one place', () => {
  assert.equal(normalizeLine('  Show   flights.  '), 'Show flights');
  // "please" goes only around a request; in a name it stays.
  assert.equal(readLine('please, north up!'), 'north up');
  assert.equal(readLine('please show flights'), 'show flights');
  assert.equal(readLine('Please Touch Museum'), 'Please Touch Museum');
  assert.equal(readLine('Kindly Lane'), 'Kindly Lane');
  assert.equal(readLine('Pretty Please'), 'Pretty Please');
  assert.equal(normalizeLine('please, north up!'), 'please, north up');
  assert.equal(normalizeLine('what’s here'), "what's here");
  assert.equal(normalizeLine('東京？'), '東京?');
  assert.equal(normalizeLine('Ｔｏｋｙｏ'), 'Tokyo');
  assert.equal(normalizeLine('Washington D.C.'), 'Washington D.C.');
  assert.equal(normalizeLine('St. Louis.'), 'St. Louis');
  assert.equal(normalizeLine('please'), 'please');
});

test('the rows the parser and the Enter rule agree on come from one place', () => {
  // A command named exactly is the default; one merely begun only follows.
  const omnibar = createOmnibar({ layers: layers() });
  assert.equal(outcome('North up'), 'camera(northUp)');
  assert.equal(outcome('> North up'), 'camera(northUp)');
  const begun = omnibar.rows('> nort');
  assert.equal(begun.defaultIndex, -1);
  assert.equal(begun.rows[0].command, 'north');
  // A Photon place counts for the credit.
  const { rows } = omnibar.rows('Shibuya', {
    places: [
      {
        name: 'Shibuya',
        detail: 'Tokyo, Japan',
        latitude: 35.66,
        longitude: 139.7,
      },
    ],
  });
  assert.equal(rows[0].source, 'photon');
});

test('coordinates named as the place are flown to, never refused or looked up', () => {
  const omnibar = createOmnibar({ layers: layers() });
  for (const text of [
    'go to 30.27, -97.74',
    'go to 48.85 2.35',
    'go to 14R PU 2090 4906',
  ]) {
    const { rows, defaultIndex } = omnibar.rows(text);
    assert.equal(rows[defaultIndex]?.kind, 'place', text);
    assert.match(rows[defaultIndex].label, /°[NS] .*°[EW]/, text);
    assert.equal(omnibar.placeQuery(text), null, text);
  }
  const { rows, defaultIndex } = omnibar.rows(
    'show flights near 30.27, -97.74',
  );
  assert.equal(rows[defaultIndex].kind, 'plan');
  assert.equal(omnibar.placeQuery('show flights near 30.27, -97.74'), null);
  // A card number is still no spot.
  assert.equal(omnibar.rows('go to 4111 1111 1111 1111').defaultIndex, -1);
  assert.equal(omnibar.placeQuery('go to ,'), null);
});

test('only a layer in or near a place is counted, never a name', () => {
  const omnibar = createOmnibar({
    layers: [...layers(), { id: 'ships', name: 'Ships', enabled: false }],
  });
  assert.ok(omnibar.countRequest('flights over Texas'));
  assert.ok(omnibar.countRequest('quakes above M5 in Japan'));
  for (const text of [
    'Ship Bottom',
    'Radio City Music Hall',
    'radio settings',
    'show me how to turn off flights',
  ])
    assert.equal(omnibar.countRequest(text), null, text);
});

test('a place named Left or Right is no panel to close', () => {
  const omnibar = createOmnibar({ layers: layers(['flights']) });
  const { rows, defaultIndex } = omnibar.rows(
    'hide flights near Left Bank, Paris',
  );
  assert.equal(rows[defaultIndex].kind, 'plan');
  assert.ok(rows[defaultIndex].steps.every((step) => step.kind !== 'panel'));
  for (const text of ['hide the left panel', 'close right side']) {
    const read = omnibar.rows(text);
    assert.ok(
      read.rows[read.defaultIndex].steps.some((step) => step.kind === 'panel'),
      text,
    );
  }
});

test('the place service gets the whole place, however it is asked', () => {
  const omnibar = createOmnibar({ layers: layers() });
  assert.equal(
    omnibar.placeQuery('flights near Trinidad and Tobago'),
    'trinidad and tobago',
  );
  assert.equal(
    omnibar.placeQuery('take me to New York City NY'),
    'New York City NY',
  );
  // A signed longitude or a semicolon stays inside the coordinates.
  for (const text of [
    'show flights near 30.27, +97.74',
    'go to 30.27; -97.74',
  ]) {
    const { rows, defaultIndex } = omnibar.rows(text);
    assert.ok(defaultIndex >= 0, text);
    assert.equal(omnibar.placeQuery(text), null, text);
    assert.notEqual(rows[defaultIndex].kind, 'none', text);
  }
});

test('several switches in one line are one plan', () => {
  const omnibar = createOmnibar({ layers: layers(['flights']) });
  for (const text of ['hide flights, show radio', 'hide flights; show radio']) {
    const { rows, defaultIndex } = omnibar.rows(text);
    assert.equal(rows[defaultIndex].kind, 'plan', text);
  }
});

const SFO = {
  ident: 'KSFO',
  iata: 'SFO',
  name: 'San Francisco International Airport',
  lat: 37.6198,
  lon: -122.3748,
  size: 'large',
  city: 'San Francisco',
  country: 'US',
};
const AUS = {
  ident: 'KAUS',
  iata: 'AUS',
  name: 'Austin Bergstrom International Airport',
  lat: 30.1975,
  lon: -97.662,
  size: 'large',
  city: 'Austin',
  country: 'US',
};
const ELY = {
  ident: 'KELY',
  iata: 'ELY',
  name: 'Ely Airport Yelland Field',
  lat: 39.2997,
  lon: -114.842,
  size: 'medium',
  city: 'Ely',
  country: 'US',
};

test('a large airport’s code in capitals leads with the airport; the place service follows with its own places', () => {
  const omnibar = createOmnibar({ layers: layers() });
  const sfo = omnibar.rows('SFO', {
    airport: SFO,
    places: [
      {
        name: 'SFO',
        detail: 'Tølløse, Region Zealand, Denmark',
        latitude: 55.61,
        longitude: 11.77,
      },
    ],
  });
  const [airport, found] = sfo.rows;
  assert.equal(sfo.defaultIndex, 0, 'Enter opens the airport');
  assert.equal(airport.kind, 'place');
  assert.equal(airport.icon, 'local_airport');
  assert.equal(airport.airport, 'SFO');
  assert.equal(
    airport.label,
    'San Francisco International Airport (SFO) · San Francisco, United States',
  );
  assert.deepEqual(airport.coords, {
    latitude: 37.6198,
    longitude: -122.3748,
  });
  // The place service's hit is where it says, and names no airport.
  assert.equal(found.label, 'Go to SFO');
  assert.equal(found.hint, 'Tølløse, Region Zealand, Denmark');
  assert.deepEqual(found.coords, { latitude: 55.61, longitude: 11.77 });
  assert.equal(found.airport, undefined);

  // Typed in lower case the place service leads; the airport follows it.
  const lower = omnibar.rows('sfo', { airport: SFO, places: [] });
  assert.notEqual(lower.rows[lower.defaultIndex]?.airport, 'SFO');
  assert.ok(lower.rows.some((row) => row.airport === 'SFO'));

  // A country's code names the country first, even for a large airport.
  const aus = omnibar.rows('AUS', {
    airport: AUS,
    places: [
      {
        name: 'Australia',
        detail: 'Oceania',
        latitude: -25.27,
        longitude: 133.77,
      },
    ],
  });
  assert.equal(aus.rows[aus.defaultIndex].label, 'Go to Australia');
  assert.equal(aus.rows[aus.defaultIndex + 1].airport, 'AUS');

  const typed = omnibar.rows('AUS', { airport: AUS });
  assert.equal(typed.rows[typed.defaultIndex].label, 'Go to AUS');
  assert.equal(typed.rows[typed.defaultIndex + 1].airport, 'AUS');
});

test('a smaller airport’s code that is also a place name: the place, then the airport', () => {
  const omnibar = createOmnibar({ layers: layers() });
  const ely = {
    name: 'Ely',
    detail: 'Cambridgeshire, England, United Kingdom',
    latitude: 52.4,
    longitude: 0.26,
  };
  const { rows, defaultIndex } = omnibar.rows('ELY', {
    airport: ELY,
    places: [ely],
  });
  assert.equal(rows[defaultIndex].label, 'Go to Ely');
  const airport = rows.find((row) => row.airport === 'ELY');
  assert.equal(
    airport?.label,
    'Ely Airport Yelland Field (ELY) · Ely, United States',
  );
  assert.ok(rows.indexOf(airport) > defaultIndex, 'listed after the place');
  // An airport for some other line is never offered.
  const other = omnibar.rows('Elyria', { airport: ELY, places: [] });
  assert.ok(other.rows.every((row) => !row.airport));
  // Without an airport the line is the place service's alone.
  const plain = omnibar.rows('ely', { places: [ely] });
  assert.equal(plain.rows[0].label, 'Go to Ely');
});

test('a place named with "and" stays whole, and a place keeps how it was typed', () => {
  const omnibar = createOmnibar({
    layers: [{ id: 'flights', name: 'Live Flights', enabled: false }],
  });
  const first = (text) => omnibar.rows(text, { places: [] }).rows[0];
  const plan = first('flights near Trinidad and Tobago');
  assert.equal(plan.kind, 'plan');
  assert.equal(plan.steps[0].place, 'trinidad and tobago');
  assert.equal(
    first('flights near Bosnia & Herzegovina').steps[0].place,
    'bosnia and herzegovina',
  );
  assert.equal(
    first('flights near Saint Vincent and the Grenadines').steps[0].place,
    'saint vincent and the grenadines',
  );
  // Two places joined by "and" are still two.
  assert.equal(
    first('flights near Austin and Dallas').steps[0].place,
    'austin',
  );
  // "İstanbul" is searched without a stray combining dot, and labelled as typed.
  const istanbul = first('show flights in İstanbul');
  assert.equal(istanbul.steps[0].place, 'istanbul');
  assert.match(istanbul.label, /^İstanbul /);
  assert.equal(first('iPhone store').label, 'Go to iPhone store');
});

test('"everything except" keeps the layers named and switches off the rest', () => {
  const omnibar = createOmnibar({
    layers: layers(['flights', 'radio', 'cctv']),
  });
  const first = (text) => omnibar.rows(text, { places: [] }).rows[0];
  for (const text of [
    'hide everything except flights',
    'turn off all but live flights',
    'clear everything other than flights',
  ]) {
    const plan = first(text);
    assert.equal(plan.kind, 'plan', text);
    assert.deepEqual(
      plan.steps.map(stepOutcome),
      ['layer(radio,off)', 'layer(cctv,off)'],
      text,
    );
  }
  assert.deepEqual(
    first('hide everything except flights and the cctv').steps.map(stepOutcome),
    ['layer(radio,off)'],
  );
  // Enter runs it: the line asked for it in so many words.
  assert.equal(
    outcome('hide everything except flights', { on: ['flights', 'radio'] }),
    'layer(radio,off)',
  );
  // A layer to keep that is not read switches nothing off.
  const unread = omnibar.rows('hide everything except flights and the fog', {
    places: [],
  });
  assert.deepEqual(
    unread.rows.map((row) => row.kind),
    ['ask'],
  );
  assert.equal(unread.defaultIndex, -1);
  const alone = createOmnibar({ layers: layers(['flights']) });
  assert.equal(
    alone.rows('hide everything except flights').rows[0].kind,
    'none',
  );
  // Naming no layer to keep is not this reading.
  assert.notEqual(first('hide everything except the coast').kind, 'plan');
});

test('"from the map" and a doubled verb do not change the request', () => {
  assert.equal(
    outcome('remove flights from the map', { on: ['flights'] }),
    'layer(flights,off)',
  );
  assert.equal(
    outcome('hide flights off the globe', { on: ['flights'] }),
    'layer(flights,off)',
  );
  assert.equal(normalizeLine('show show flights'), 'show flights');
  assert.equal(normalizeLine('turn off turn off flights'), 'turn off flights');
});

test('a grid reference after "near" is the place', () => {
  const omnibar = createOmnibar({ layers: layers() });
  const plan = omnibar.rows('flights near 14R PU 2090 4906', { places: [] })
    .rows[0];
  assert.equal(plan.kind, 'plan');
  assert.equal(plan.steps[0].kind, 'place');
  assert.match(plan.steps[0].place, /^14R PU 2090 4906$/i);
});

test('a keyword that begins a name offers no plan to the rest of it', () => {
  const omnibar = createOmnibar({ layers: layers() });
  for (const text of ['Radio City', 'Traffic Island', 'radio island']) {
    const { rows } = omnibar.rows(text, { places: [] });
    assert.equal(rows[0].kind, 'place', text);
    assert.ok(!rows.some((row) => row.kind === 'plan'), text);
    assert.ok(
      rows.some((row) => row.kind === 'layer'),
      text,
    );
  }
  // A keyword after the place, or before a place that is no name's
  // fragment, still offers its plan.
  for (const text of [
    'tokyo traffic',
    'earthquakes japan',
    'radio London',
    'traffic city hall',
    'traffic county cork',
    'earthquakes valley forge',
    'traffic road to hana',
  ]) {
    const { rows } = omnibar.rows(text, { places: [] });
    assert.ok(
      rows.some((row) => row.kind === 'plan'),
      text,
    );
  }
});

test('"except" keeps a layer and the one it shows through together', () => {
  const omnibar = createOmnibar({
    layers: [
      { id: 'flights', name: 'Live Flights', enabled: true },
      { id: 'satellites', name: 'Satellites', enabled: true },
      { id: 'rocket-launches', name: 'Space Missions', enabled: true },
    ],
  });
  for (const text of [
    'hide everything except space missions',
    'hide everything except satellites',
  ])
    assert.deepEqual(
      omnibar.rows(text, { places: [] }).rows[0].steps.map(stepOutcome),
      ['layer(flights,off)'],
      text,
    );
});

test('"except" leaves Satellites to switch off with Space Missions off', () => {
  const omnibar = createOmnibar({
    layers: [
      { id: 'flights', name: 'Live Flights', enabled: true },
      { id: 'satellites', name: 'Satellites', enabled: true },
      { id: 'rocket-launches', name: 'Space Missions', enabled: false },
    ],
  });
  assert.deepEqual(
    omnibar
      .rows('hide everything except space missions', { places: [] })
      .rows[0].steps.map(stepOutcome),
    ['layer(flights,off)', 'layer(satellites,off)'],
  );
  for (const text of [
    'hide everything except flights from the map',
    'clear everything except flights from the map',
    'please clear everything except flights from the map',
    'hide everything except flights from the map, please',
  ])
    assert.deepEqual(
      omnibar.rows(text, { places: [] }).rows[0].steps.map(stepOutcome),
      ['layer(satellites,off)'],
      text,
    );
  // "clear" takes the ending off only for the whole map: "clear flights
  // from the map" never offers to turn Flights on.
  for (const text of [
    'clear flights from the map',
    'clear all flights from the map',
    'clear all flights except ships from the map',
  ])
    assert.ok(
      !omnibar
        .rows(text, { places: [] })
        .rows.some((row) =>
          (row.steps || []).some(
            (step) => step.kind === 'layer' && step.enabled,
          ),
        ),
    );
  // After "show" the ending is part of what is asked.
  assert.equal(
    omnibar.rows('show me the view from the map', { places: [] }).defaultIndex,
    -1,
  );
  // The whole map cleared "from the map" is the same plan, not a place.
  for (const text of [
    'hide everything from the map',
    'remove all layers from the map',
    'clear the layers from the map',
  ]) {
    const { rows } = omnibar.rows(text, { places: [] });
    assert.equal(rows[0].kind, 'plan', text);
    assert.ok(!rows.some((row) => row.kind === 'place'), text);
  }
});

test('"turn off the screen" is no layer switch and no place', () => {
  for (const text of ['turn off the screen', 'switch off the map'])
    assert.equal(outcome(text, { on: ['flights'] }), 'nothing', text);
});

test('a place after a compound country is another place', () => {
  const omnibar = createOmnibar({ layers: layers() });
  const places = (text) =>
    omnibar
      .rows(text, { places: [] })
      .rows.filter((row) => row.kind === 'place')
      .map((row) => row.place.toLowerCase());
  assert.deepEqual(places('flights near trinidad and tobago and barbados'), [
    'trinidad and tobago',
    'barbados',
  ]);
  assert.deepEqual(places('flights near Paris and Trinidad and Tobago'), [
    'paris',
    'trinidad and tobago',
  ]);
});

test('a kind of place written before its name keeps the plan', () => {
  const omnibar = createOmnibar({ layers: layers() });
  for (const text of [
    'earthquakes lake tahoe',
    'earthquakes mount fuji',
    'traffic tower bridge',
  ]) {
    const { rows } = omnibar.rows(text, { places: [] });
    assert.ok(
      rows.some((row) => row.kind === 'plan'),
      text,
    );
  }
});

// Which typed codes an airport's row takes Enter for, with the bundled pack:
// a large airport's code in capitals, never a country's code or a smaller
// airport's, and never a word typed in lower case.
test('an airport row leads only for a large airport typed as its code', async () => {
  const { readFile } = await import('node:fs/promises');
  const { airportByCodeIn, indexAirports } =
    await import('../data/airports.js');
  const pack = JSON.parse(
    await readFile(
      new URL('../data/local_data/ourairports/airports.json', import.meta.url),
      'utf8',
    ),
  );
  const index = indexAirports(pack.rows);
  const omnibar = createOmnibar({ layers: layers() });
  const westernSydney = airportByCodeIn(index, 'YSWS');
  const byIcao = omnibar.rows('YSWS', { airport: westernSydney, places: [] });
  const explicit = byIcao.rows.find((row) => row.key === 'airport:AU-0539');
  assert.equal(explicit?.airport, 'WSI');
  assert.deepEqual(explicit.coords, {
    latitude: westernSydney.lat,
    longitude: westernSydney.lon,
  });
  assert.equal(byIcao.rows[byIcao.defaultIndex], explicit);
  const lower = omnibar.rows('ysws', {
    airport: airportByCodeIn(index, 'ysws'),
    places: [],
  });
  assert.equal(lower.rows[lower.defaultIndex].airport, undefined);
  assert.ok(lower.rows.some((row) => row.key === explicit.key));

  const lead = (line) => {
    const airport = airportByCodeIn(index, line);
    const { rows, defaultIndex } = omnibar.rows(line, { airport, places: [] });
    return Boolean(rows[defaultIndex]?.airport);
  };
  for (const [line, leads] of [
    ['SFO', true],
    ['JFK', true],
    ['LHR', true],
    ['SEA', true],
    ['USA', false],
    ['RUS', false],
    ['SYR', false],
    ['GPS', false],
    ['ITA', false],
    ['GER', false],
    ['sea', false],
    ['man', false],
    ['del', false],
  ])
    assert.equal(lead(line), leads, line);
});
