// src/ui/airportLinks.test.mjs — airports named in Context open their card:
// an aircraft's route ends and its origin → destination line, the airports an
// airport card's arrivals come from and its departures go to, and the near
// link on a place. A code the bundled pack does not know stays plain text.
// Back on the airport card returns to the card it was opened from. Over
// happy-dom, including selected-card weather and local clocks.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick, ref } from 'vue';
import ContextView from './views/ContextView.vue';
import AirportLink from './views/panels/AirportLink.vue';
import { useEntityCardStore } from './stores/entityCard.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { _setAirportsFetchForTest } from '../data/airports.js';
import { placeIdentity } from './placeCard.js';

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await turn();
    await nextTick();
  }
};

const SDF = [
  'KSDF',
  'SDF',
  'Louisville Muhammad Ali International Airport',
  38.1744,
  -85.736,
  'large',
  'Louisville',
  'US',
  501,
  3,
];
const MCI = [
  'KMCI',
  'MCI',
  'Kansas City International Airport',
  39.2976,
  -94.7139,
  'large',
  'Kansas City',
  'US',
  1026,
  3,
];
const AUS = [
  'KAUS',
  'AUS',
  'Austin–Bergstrom International Airport',
  30.1945,
  -97.6699,
  'large',
  'Austin',
  'US',
  542,
  2,
];

function useAirports(t, rows = [SDF, MCI, AUS]) {
  _setAirportsFetchForTest(
    async () =>
      new Response(JSON.stringify({ meta: {}, rows }), { status: 200 }),
  );
  t.after(() => _setAirportsFetchForTest(null));
}

/** Mount Context with a Live Flights layer holding `records`. */
function fixture(t, records) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(ContextView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const cards = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  const flights = {
    id: 'flights',
    name: 'Live Flights',
    enabled: true,
    stats: { count: records.length },
    module: { getAnalystRecords: () => records },
  };
  const dataManager = {
    layers: new Map([['flights', flights]]),
    isEnabled: (id) => id === 'flights',
    getAll: () => [flights],
    subscribe: () => () => {},
  };
  const flown = [];
  const flownWith = [];
  const credited = [];
  cards.connect({
    creditAirports: () => credited.push('ourairports'),
    dataManager: () => dataManager,
    inspectorRows: () => dataManager.getAll(),
    regionalBrief: async () => null,
    previews: () => null,
    canFollow: () => false,
    flyTo: (card, options) => {
      flown.push(card.key);
      flownWith.push({ key: card.key, explicit: options?.explicit === true });
    },
  });
  t.after(() => {
    cards.connect(null);
    chrome.detach(owner);
    app.unmount();
    globalThis.fetch = realFetch;
  });
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  return {
    $: (selector) => document.querySelector(selector),
    cards,
    flown,
    flownWith,
    credited,
  };
}

const UPS = {
  id: 'u1',
  callsign: 'UPS2914',
  lat: 38.7,
  lon: -90,
  altitudeM: 10_000,
  routeOrigin: 'SDF',
  routeDestination: 'MCI',
  routeFrom: { code: 'SDF', name: 'Louisville', lat: 38.1744, lon: -85.736 },
  routeTo: { code: 'MCI', name: 'Kansas City', lat: 39.2976, lon: -94.7139 },
};
const flight = (record) => ({
  layerId: 'flights',
  id: record.id,
  label: record.callsign,
  lat: record.lat,
  lon: record.lon,
});

test('an airport code is a button that names the airport; an unknown one is plain text', async (t) => {
  useAirports(t);
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp({
    render: () => [
      h(AirportLink, { code: 'SDF' }),
      h(AirportLink, { code: 'XQZ' }),
      h(AirportLink, { code: '—' }),
    ],
  }).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  await settle();
  const buttons = document.querySelectorAll('button.airport-link');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].type, 'button');
  assert.equal(buttons[0].textContent.trim(), 'SDF');
  assert.equal(
    buttons[0].getAttribute('aria-label'),
    'Open Louisville airport (SDF)',
  );
  const plain = [...document.querySelectorAll('span.airport-link--plain')];
  assert.deepEqual(
    plain.map((node) => node.textContent.trim()),
    ['XQZ', '—'],
  );
});

// A code given by its ICAO alias shows that alias; the button's name says the
// same code, so what is read matches what is seen.
test('an airport named by its ICAO alias says that code in its name', async (t) => {
  useAirports(t);
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp({
    render: () => [
      h(AirportLink, { code: 'KSDF' }),
      h(AirportLink, { code: 'SDF' }),
    ],
  }).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  await settle();
  const buttons = [...document.querySelectorAll('button.airport-link')];
  assert.deepEqual(
    buttons.map((button) => [
      button.textContent.trim(),
      button.getAttribute('aria-label'),
    ]),
    [
      ['KSDF', 'Open Louisville airport (KSDF)'],
      ['SDF', 'Open Louisville airport (SDF)'],
    ],
  );
});

// An airport card's data is OurAirports': its credit shows however the card
// opened, a route's airport link included, not only from search.
test('an airport opened from a route link credits OurAirports', async (t) => {
  useAirports(t);
  const { cards, credited } = fixture(t, [UPS]);
  cards.select(flight(UPS), { fly: true });
  await settle();
  assert.deepEqual(credited, []);
  document.querySelector('.route-profile__end').click();
  await settle();
  assert.equal(cards.card?.key, 'place:airport:KSDF');
  assert.deepEqual(credited, ['ourairports']);
});

test('an open airport card translates its credit when the page language changes', async (t) => {
  const { bindLocale, getLocale, setLocale } = await import('../i18n/index.js');
  const prior = getLocale();
  bindLocale(ref(prior));
  setLocale('en');
  t.after(() => setLocale(prior));
  const { $, cards } = fixture(t, []);
  cards.openAirport({
    ident: 'ZTST',
    name: 'Test Passenger Airport',
    lat: 12,
    lon: 34,
  });
  await nextTick();
  const source = $('.entity-card__source-line');
  assert.equal(source.textContent, 'OurAirports · bundled');
  const selected = cards.card;
  setLocale('de');
  await nextTick();
  assert.equal(cards.card, selected);
  assert.equal(source.textContent, 'OurAirports · mitgeliefert');
});

test('a new pick scrolls the panel back to the top', async (t) => {
  useAirports(t);
  const OTHER = { ...UPS, id: 'u2', callsign: 'UPS2915', lat: 38.9 };
  const { $, cards } = fixture(t, [UPS, OTHER]);
  cards.select(flight(UPS), { fly: true });
  await settle();
  const scroller = $('#entity-card').closest('.global-context-panel-inner');
  const scrolled = [];
  scroller.scrollTo = (options) => scrolled.push(options);
  cards.select(flight(OTHER), { fly: true });
  await settle();
  assert.deepEqual(scrolled, [{ top: 0, behavior: 'smooth' }]);
});

test('an aircraft card’s route ends open the airport’s card, and Back returns to the aircraft', async (t) => {
  useAirports(t);
  const { $, cards, flown } = fixture(t, [UPS]);
  cards.select(flight(UPS), { fly: true });
  await settle();
  assert.equal(cards.card?.key, 'flights:u1');
  const ends = [...document.querySelectorAll('.route-profile__end')];
  assert.equal(ends.length, 2);
  assert.ok(ends.every((end) => end.tagName === 'BUTTON'));
  assert.equal(
    ends[0].getAttribute('aria-label'),
    'Open Louisville airport (SDF)',
  );
  assert.equal(
    ends[1].getAttribute('aria-label'),
    'Open Kansas City airport (MCI)',
  );
  assert.equal($('.place-details__back'), null);

  ends[0].click();
  await settle();
  assert.equal(cards.card?.key, 'place:airport:KSDF');
  assert.equal(flown.at(-1), 'place:airport:KSDF', 'flies there');
  const back = $('.place-details__back');
  assert.ok(back, 'Back shows on the airport card');
  assert.equal(back.type, 'button');
  assert.match(back.textContent, /Back to UPS2914/);

  back.click();
  await settle();
  assert.equal(cards.card?.key, 'flights:u1');
  assert.equal(cards.backTo, null);
});

// An airport link, Back and a list row are a person's clicks: each flight
// retires older navigation, as Fly to does, so a place search still
// resolving cannot take the camera back afterwards.
test('airport links, Back and list rows fly as explicit navigation', async (t) => {
  useAirports(t);
  const { $, cards, flownWith } = fixture(t, [UPS]);
  cards.select(flight(UPS), { fly: true });
  await settle();
  assert.deepEqual(flownWith.at(-1), { key: 'flights:u1', explicit: false });

  document.querySelector('.route-profile__end').click();
  await settle();
  assert.deepEqual(flownWith.at(-1), {
    key: 'place:airport:KSDF',
    explicit: true,
  });

  $('.place-details__back').click();
  await settle();
  assert.deepEqual(flownWith.at(-1), { key: 'flights:u1', explicit: true });

  cards.open(flight(UPS));
  await settle();
  assert.deepEqual(flownWith.at(-1), { key: 'flights:u1', explicit: true });
});

// The link that switches cards goes with its card: keyboard focus moves to
// the airport card's Back, and Back returns it to the link it came from.
test('an airport link and Back keep keyboard focus on the card', async (t) => {
  useAirports(t);
  const { $, cards } = fixture(t, [UPS]);
  cards.select(flight(UPS), { fly: true });
  await settle();
  const end = document.querySelector('.route-profile__end');
  end.focus();
  end.click();
  await settle();
  assert.equal(cards.card?.key, 'place:airport:KSDF');
  assert.equal(document.activeElement, $('.place-details__back'));
  $('.place-details__back').click();
  await settle();
  assert.equal(cards.card?.key, 'flights:u1');
  assert.notEqual(document.activeElement, document.body);
  assert.equal(document.activeElement?.dataset?.airport, 'KSDF');
});

// A followed aircraft's airport links open the airport, not the craft nor
// one near the airport: the follow is let go before the camera flies, or it
// would pull the camera back on to the plane, or on to the one nearest
// where it lands.
test('an airport link on a followed aircraft lets go of the follow and opens the airport', async (t) => {
  useAirports(t);
  // One with airport positions (the route profile), one scheduled only (the
  // plain origin → destination line).
  const SCHEDULED = {
    id: 'u2',
    callsign: 'UPS77',
    lat: 38.7,
    lon: -90,
    routeOrigin: 'SDF',
    routeDestination: 'XQZ',
  };
  const records = [UPS, SCHEDULED];
  const { cards, flown } = fixture(t, records);
  const flights = {
    id: 'flights',
    name: 'Live Flights',
    enabled: true,
    stats: { count: 2 },
    module: { getAnalystRecords: () => records },
  };
  const followed = [];
  const letGo = [];
  const dataManager = {
    layers: new Map([['flights', flights]]),
    isEnabled: (id) => id === 'flights' && flights.enabled,
    getAll: () => [flights],
    subscribe: () => () => {},
  };
  cards.connect({
    dataManager: () => dataManager,
    regionalBrief: async () => null,
    previews: () => null,
    canFollow: (card) => card?.layerId === 'flights',
    follow: (card) => followed.push(card.key),
    letGo: (card) => letGo.push(card?.key),
    flyTo: (card) => flown.push(card.key),
  });
  for (const [record, selector] of [
    [UPS, '.route-profile__end'],
    [SCHEDULED, '.entity-card__route-end'],
  ]) {
    cards.select(flight(record));
    await settle();
    // The camera follows it, as the shell reports.
    cards.following = cards.card.key;
    const key = `flights:${record.id}`;
    assert.equal(cards.card?.key, key);
    const link = document.querySelector(`button${selector}`);
    assert.ok(link, `${selector} is a link`);
    letGo.length = 0;
    link.click();
    await settle();
    assert.equal(
      cards.card?.key,
      'place:airport:KSDF',
      `${selector} opens the airport`,
    );
    assert.deepEqual(letGo, [key], 'the follow is let go');
    assert.equal(cards.following, null);
    assert.equal(
      flown.at(-1),
      'place:airport:KSDF',
      'and the camera flies there',
    );
    // The airport card's own Fly to goes to the airport, not the aircraft.
    flown.length = 0;
    const flyTo = [...document.querySelectorAll('#entity-card button')].find(
      (button) => /Fly to/.test(button.textContent),
    );
    assert.ok(flyTo, 'the airport card has Fly to');
    flyTo.click();
    await settle();
    assert.deepEqual(
      flown,
      ['place:airport:KSDF'],
      'Fly to flies to the airport',
    );
    assert.equal(cards.following, null, 'nothing followed meanwhile');
    // Back shows the aircraft and flies to it, without following it: that
    // is the reader's Follow.
    followed.length = 0;
    flights.enabled = false;
    cards.back();
    cards.refresh();
    await settle();
    assert.equal(cards.card?.key, key, 'Back returns to the aircraft');
    assert.deepEqual(followed, [], 'Back does not follow it again');
    assert.equal(flown.at(-1), key, 'it flies to it instead');
    flights.enabled = true;
    cards.refresh();
    flights.enabled = false;
    cards.refresh();
    assert.equal(
      cards.card,
      null,
      'turning off a live layer still closes its card',
    );
    flights.enabled = true;
  }
});

test('the origin → destination line links the airports the pack knows only', async (t) => {
  useAirports(t);
  // A scheduled route: no airport positions, so the plain line shows.
  const record = {
    id: 'u2',
    callsign: 'UPS77',
    lat: 38.7,
    lon: -90,
    routeOrigin: 'SDF',
    routeDestination: 'XQZ',
  };
  const { $, cards } = fixture(t, [record]);
  cards.select(flight(record), { fly: true });
  await settle();
  assert.equal($('.route-profile'), null);
  const ends = [...document.querySelectorAll('.entity-card__route-end')];
  assert.deepEqual(
    ends.map((end) => [end.tagName, end.textContent.trim()]),
    [
      ['BUTTON', 'SDF'],
      ['SPAN', 'XQZ'],
    ],
  );
  ends[0].click();
  await settle();
  assert.equal(cards.card?.key, 'place:airport:KSDF');
  assert.match($('.place-details__back').textContent, /Back to UPS77/);
});

test('an airport card’s arrivals and departures name the other airport, which opens its card', async (t) => {
  useAirports(t);
  const records = [
    {
      id: 'a1',
      callsign: 'SWA1123',
      lat: 30.3,
      lon: -97.7,
      routeOrigin: 'SDF',
      routeDestination: 'AUS',
    },
    {
      id: 'a2',
      callsign: 'XYZ9',
      lat: 30.31,
      lon: -97.71,
      routeOrigin: 'XQZ',
      routeDestination: 'AUS',
    },
    {
      id: 'd1',
      callsign: 'UAL649',
      lat: 30.25,
      lon: -97.6,
      routeOrigin: 'KAUS',
      routeDestination: 'MCI',
    },
  ];
  records.push({ ...records[2], id: 'd2', callsign: 'SECOND', lat: 30.26 });
  const { $, cards } = fixture(t, records);
  assert.equal(cards.openAirport(null), false);
  assert.equal(cards.card, null, 'no airport, no card');
  const aus = {
    ident: 'KAUS',
    iata: 'AUS',
    name: AUS[2],
    lat: AUS[3],
    lon: AUS[4],
    size: 'large',
    city: 'Austin',
    country: 'US',
    elevationFt: 542,
    runways: 2,
  };
  cards.openAirport(aus);
  await settle();
  assert.equal(cards.card?.key, 'place:airport:KAUS');
  assert.equal($('.place-details__back'), null, 'opened from nothing');

  const rowOf = (callsign) =>
    [...document.querySelectorAll('.place-details .nearby-lists li')].find(
      (row) => row.textContent.includes(callsign),
    );
  const arriving = rowOf('SWA1123');
  assert.match(
    arriving.querySelector('.nearby-lists__via').textContent,
    /from SDF/,
  );
  const link = arriving.querySelector('button.airport-link');
  assert.equal(
    link.getAttribute('aria-label'),
    'Open Louisville airport (SDF)',
  );
  assert.ok(
    !arriving.querySelector('button button'),
    'never a button inside a button',
  );
  const unknown = rowOf('XYZ9');
  assert.equal(unknown.querySelector('button.airport-link'), null);
  assert.match(
    unknown.querySelector('.airport-link--plain').textContent,
    /XQZ/,
  );
  const departing = rowOf('UAL649');
  assert.match(
    departing.querySelector('.nearby-lists__via').textContent,
    /to MCI/,
  );

  rowOf('SECOND').querySelector('button.airport-link').click();
  await settle();
  assert.equal(cards.card?.key, 'place:airport:KMCI');
  const back = $('.place-details__back');
  assert.match(
    back.textContent,
    /Back to Austin–Bergstrom International Airport/,
  );
  back.click();
  await settle();
  assert.equal(cards.card?.key, 'place:airport:KAUS');
  assert.equal(
    document.activeElement,
    rowOf('SECOND').querySelector('button.airport-link'),
  );
});

test('Back belongs to the airport card it was made for', async (t) => {
  useAirports(t);
  const { $, cards } = fixture(t, [UPS]);
  cards.select(flight(UPS), { fly: true });
  await settle();
  document.querySelector('.route-profile__end').click();
  await settle();
  assert.ok($('.place-details__back'));
  // Another pick drops it; the same airport again later has none.
  cards.select(flight(UPS), { fly: true });
  await settle();
  assert.equal(cards.backTo, null);
  cards.clear();
  cards.select(
    placeIdentity({
      airport: {
        ident: 'KSDF',
        iata: 'SDF',
        name: SDF[2],
        lat: SDF[3],
        lon: SDF[4],
        city: 'Louisville',
      },
    }),
    { fly: true },
  );
  await settle();
  assert.equal(cards.card?.key, 'place:airport:KSDF');
  assert.equal($('.place-details__back'), null);
});

test('a place’s near link opens the airport’s card with Back to the place', async (t) => {
  useAirports(t);
  const { $, cards } = fixture(t, []);
  cards.select(
    placeIdentity({
      name: 'Terminal Rd',
      lat: 30.2,
      lon: -97.67,
      from: 'spot',
    }),
    { fly: true },
  );
  await settle();
  const near = $('.place-line__near');
  assert.ok(near, 'near AUS');
  near.focus();
  near.click();
  await settle();
  assert.equal(cards.card?.key, 'place:airport:KAUS');
  const back = $('.place-details__back');
  assert.match(back.textContent, /Back to Terminal Rd/);
  assert.equal(
    document.activeElement,
    back,
    'focus moves to the airport card’s Back, not the page',
  );
  back.click();
  await settle();
  assert.equal(cards.card?.title, 'Terminal Rd');
  assert.equal(document.activeElement, $('.place-line__near'));
  assert.equal($('.place-details__back'), null);
});

// The airport card's flight lists refresh with the flights layer. A focused
// row or the airport named beside it that drops out hands the focus on: to
// the row now in its place, and once the lists are gone, to the card's title.
const AUS_AIRPORT = {
  ident: 'KAUS',
  iata: 'AUS',
  name: AUS[2],
  lat: AUS[3],
  lon: AUS[4],
  size: 'large',
  city: 'Austin',
  country: 'US',
  elevationFt: 542,
  runways: 2,
};
const arrival = (id, callsign, routeOrigin, lat) => ({
  id,
  callsign,
  lat,
  lon: -97.7,
  routeOrigin,
  routeDestination: 'AUS',
});

async function airportCardWith(t, records) {
  const fixed = fixture(t, records);
  fixed.cards.openAirport(AUS_AIRPORT);
  await settle();
  assert.equal(fixed.cards.card?.key, 'place:airport:KAUS');
  return fixed;
}
const arrivalRow = (key) =>
  document.querySelector(
    `.place-details .nearby-lists [data-row-key="flights:${key}"]`,
  );
// What has the focus, in words: a failed check names it rather than
// printing the whole document.
const focusName = () => {
  const node = document.activeElement;
  if (!node || node === document.body) return 'the page';
  if (node.dataset?.rowKey) return `row ${node.dataset.rowKey}`;
  if (node.dataset?.viaKey) return `airport beside ${node.dataset.viaKey}`;
  return String(node.className || node.tagName);
};
const arrivalVia = (key) =>
  arrivalRow(key)?.closest('li')?.querySelector('button.airport-link');

test(
  'a focused arrival that drops out hands the focus to the row now in its place',
  { timeout: 10_000 },
  async (t) => {
    useAirports(t);
    const records = [
      arrival('a1', 'SWA1123', 'SDF', 30.2),
      arrival('a2', 'DAL220', 'MCI', 30.3),
    ];
    const { cards } = await airportCardWith(t, records);
    const row = arrivalRow('a1');
    assert.ok(row, 'SWA1123 is listed');
    row.focus();
    assert.equal(focusName(), 'row flights:a1');
    records.splice(0, 1);
    cards.refresh();
    await settle();
    assert.equal(arrivalRow('a1'), null, 'SWA1123 is gone');
    assert.equal(focusName(), 'row flights:a2');
  },
);

test(
  'a focused airport beside an arrival that drops out hands the focus to the row now in its place',
  { timeout: 10_000 },
  async (t) => {
    useAirports(t);
    const records = [
      arrival('a1', 'SWA1123', 'SDF', 30.2),
      arrival('a2', 'DAL220', 'MCI', 30.3),
    ];
    const { cards } = await airportCardWith(t, records);
    const via = arrivalVia('a1');
    assert.ok(via, 'SDF is a button beside SWA1123');
    via.focus();
    assert.equal(document.activeElement === via, true, 'SDF has the focus');
    records.splice(0, 1);
    cards.refresh();
    await settle();
    assert.equal(arrivalRow('a1'), null, 'SWA1123 is gone');
    assert.equal(focusName(), 'row flights:a2');
  },
);

test(
  'when the last flight at an airport goes while focused, the card’s title takes the focus',
  { timeout: 10_000 },
  async (t) => {
    useAirports(t);
    const records = [arrival('a1', 'SWA1123', 'SDF', 30.2)];
    const { $, cards } = await airportCardWith(t, records);
    const via = arrivalVia('a1');
    via.focus();
    assert.equal(document.activeElement === via, true, 'SDF has the focus');
    records.length = 0;
    cards.refresh();
    await settle();
    assert.equal($('.place-details .nearby-lists'), null, 'the lists are gone');
    assert.equal(
      document.activeElement === $('#entity-card .entity-card__title'),
      true,
      `the card’s title has the focus, not ${focusName()}`,
    );
  },
);

test(
  'a focused airport beside an arrival keeps the focus when the arrivals change places',
  { timeout: 10_000 },
  async (t) => {
    useAirports(t);
    const records = [
      arrival('a1', 'SWA1123', 'SDF', 30.2),
      arrival('a2', 'DAL220', 'MCI', 30.3),
      arrival('a3', 'AAL12', 'SDF', 30.4),
    ];
    const { cards } = await airportCardWith(t, records);
    const via = arrivalVia('a3');
    via.focus();
    assert.equal(document.activeElement === via, true, 'SDF has the focus');
    // AAL12 comes in nearest; it moves to the top of the list.
    records[2].lat = 30.19;
    cards.refresh();
    await settle();
    const order = [
      ...document.querySelectorAll(
        '.place-details .nearby-lists [data-layer="arriving"] [data-row-key]',
      ),
    ].map((row) => row.dataset.rowKey);
    assert.deepEqual(order, ['flights:a3', 'flights:a1', 'flights:a2']);
    assert.equal(
      document.activeElement === arrivalVia('a3'),
      true,
      `SDF beside AAL12 keeps the focus, not ${focusName()}`,
    );
  },
);

test('a selected place reads weather only while its Context sheet and browser tab are visible', async (t) => {
  let visible = false;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  t.after(() => delete document.visibilityState);
  useAirports(t);
  const { cards } = fixture(t, []);
  const { useDisplayStore } = await import('./stores/display.js');
  const display = useDisplayStore();
  const requests = [];
  t.mock.method(cards, 'readWeather', (lat, lon, { signal }) => {
    requests.push({ lat, lon, signal });
    return requests.length === 1
      ? new Promise(() => {})
      : Promise.resolve({ weather: { temperatureC: 18 } });
  });
  const setVisible = async (value) => {
    visible = value;
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
  };
  cards.select(placeIdentity({ name: 'Test place', lat: 1, lon: 2 }), {
    fly: false,
  });
  cards.refresh();
  await settle();
  assert.equal(
    requests.length,
    0,
    'a hidden tab never starts the initial read',
  );
  await setVisible(true);
  assert.equal(requests.length, 1);
  assert.deepEqual([requests[0].lat, requests[0].lon], [1, 2]);
  await setVisible(false);
  assert.equal(
    requests[0].signal.aborted,
    true,
    'hiding cancels the in-flight read',
  );
  cards.refresh();
  await settle();
  assert.equal(requests.length, 1);
  display.publishPhoneShell({ enabled: true, sheet: 'layers' });
  await setVisible(true);
  cards.refresh();
  await settle();
  assert.equal(requests.length, 1, 'another sheet still covers Context');
  display.publishPhoneShell({ enabled: true, sheet: 'context' });
  await settle();
  assert.equal(requests.length, 2);
  await setVisible(false);
  await setVisible(true);
  assert.equal(requests.length, 2, 'the completed reading is still fresh');
});

test('airport search preserves a slowing arrival only for the selected airport', async (t) => {
  const { contextSearchOpen, contextSearchText } =
    await import('./contextSearch.js');
  const record = {
    id: 'civil1',
    callsign: 'TRAIN1',
    lat: AUS_AIRPORT.lat,
    lon: AUS_AIRPORT.lon,
    onGround: true,
    speedMps: 20,
  };
  const { cards, $ } = await airportCardWith(t, [record]);
  const arriving = () =>
    $('.place-details [data-field="arriving"] strong')?.textContent;
  record.speedMps = 12;
  cards.tick++;
  await nextTick();
  assert.match(arriving(), /1/);
  contextSearchOpen.value = true;
  contextSearchText.value = 'port';
  await nextTick();
  assert.equal(arriving(), undefined);
  contextSearchText.value = '';
  await nextTick();
  assert.match(arriving(), /1/);
  cards.openAirport({
    ...AUS_AIRPORT,
    ident: 'TEST',
    iata: '',
    name: 'Training field',
  });
  await settle();
  assert.match(arriving(), /0/);
  contextSearchOpen.value = false;
});
