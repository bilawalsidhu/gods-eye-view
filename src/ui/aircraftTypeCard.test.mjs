import '../testSupport/registerDom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { aircraftTypeCardModel } from '../layers/flights/typeCard.js';
import { applicationI18n } from './i18n.js';
import { createUiRuntime } from './vueRuntime.js';
import { createAircraftTypeCard } from './aircraftTypeCard.js';
import AircraftTypeCard from './views/panels/AircraftTypeCard.vue';

const TRACKED = {
  icao24: '4b1814',
  callsign: 'SWR100',
  registration: 'HB-JNA',
  typeCode: 'B789',
  military: false,
  altitudeM: 11277,
  velocityMps: 251.4,
  track: 281.6,
  latitude: 47.45,
  longitude: 8.55,
  origin: 'ZRH',
  destination: 'JFK',
};

function mount(initial, t) {
  document.body.replaceChildren();
  const ui = createUiRuntime();
  const state = { tracked: initial };
  const card = createAircraftTypeCard({
    getTracked: () => state.tracked,
    ui,
    resolveAsset: (url) => `/app${url}`,
  });
  t.after(() => {
    card.destroy();
    ui.destroy();
  });
  const emit = async (type, layerId = 'flights') => {
    window.dispatchEvent(new CustomEvent(type, { detail: { layerId } }));
    await nextTick();
  };
  const host = () => document.querySelector('[data-aircraft-type-card-host]');
  const view = () => host().querySelector('[data-aircraft-type-card]');
  return { state, card, emit, host, view };
}

const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();

function render(record, t) {
  const model = aircraftTypeCardModel(record, {
    isMilitary: record.military === true,
  });
  const root = document.body.appendChild(document.createElement('div'));
  const app = createApp(AircraftTypeCard, {
    model,
    resolveAsset: (url) => `/app${url}`,
  }).use(applicationI18n());
  app.mount(root);
  t.after(() => {
    app.unmount();
    root.remove();
  });
  return root;
}

test('the component renders the type name, photo and civil class line', (t) => {
  const root = render(TRACKED, t);
  assert.equal(root.querySelector('h2').textContent, 'Boeing 787-9');
  assert.equal(
    root.querySelector('img').getAttribute('src'),
    '/app/aircraft-types/B789.webp',
  );
  assert.equal(
    root.querySelector('.cls').textContent,
    'Civil · Widebody airliner',
  );
  assert.equal(text(root.querySelector('header')), 'Selected aircraft 4B1814');
  assert.equal(
    root
      .querySelector('[data-aircraft-type-card]')
      .classList.contains('is-military'),
    false,
  );
});

test('the photo credit links to its author and licence', (t) => {
  const root = render(TRACKED, t);
  const links = [...root.querySelectorAll('.credit a')];
  assert.ok(links.length >= 1);
  assert.ok(links.every((a) => a.getAttribute('href').startsWith('https://')));
  assert.ok(
    links.every((a) => a.getAttribute('rel') === 'noopener noreferrer'),
  );
  assert.match(text(root.querySelector('.credit')), /^Photo: .+ · .+/);
});

test('the specs and telemetry grids show the type and live values in aviation units', (t) => {
  const root = render(TRACKED, t);
  const cells = Object.fromEntries(
    [...root.querySelectorAll('dl > div')].map((cell) => [
      cell.querySelector('dt').textContent,
      cell.querySelector('dd').textContent,
    ]),
  );
  assert.equal(cells.Manufacturer, 'Boeing Commercial Airplanes');
  assert.match(cells.Length, /m$/);
  assert.equal(cells.Callsign, 'SWR100');
  assert.equal(cells['Type code'], 'B789');
  assert.equal(cells.Altitude, '36,998 ft');
  assert.equal(cells.Speed, '489 kt');
  assert.equal(cells.Heading, '282°');
  assert.equal(cells.Position, '47.450, 8.550');
  assert.equal(cells.Route, 'ZRH → JFK');
  assert.equal(
    root.querySelector('footer').textContent,
    'Photo shows the aircraft type, not the tracked airframe.',
  );
});

test('a military contact takes the amber faction', (t) => {
  const root = render({ ...TRACKED, military: true, typeCode: 'Q9' }, t);
  assert.equal(
    root
      .querySelector('[data-aircraft-type-card]')
      .classList.contains('is-military'),
    true,
  );
  assert.match(root.querySelector('.cls').textContent, /^Military/);
});

test('an unknown type shows the raw code, no photo and the library notice', (t) => {
  const root = render({ ...TRACKED, typeCode: 'ZZZZ' }, t);
  assert.equal(root.querySelector('h2').textContent, 'ZZZZ');
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('.credit'), null);
  assert.equal(root.querySelector('.cls').textContent, 'Civil');
  assert.equal(
    root.querySelector('footer').textContent,
    'This aircraft type is not in the type library yet.',
  );
});

test('missing telemetry shows a dash and no route row', (t) => {
  const root = render(
    {
      ...TRACKED,
      altitudeM: null,
      velocityMps: null,
      track: null,
      latitude: null,
      longitude: null,
      origin: null,
      destination: null,
    },
    t,
  );
  const grid = text(root.querySelector('dl'));
  assert.equal(grid.includes('Route'), false);
  assert.match(grid, /Altitude --Speed --Heading --Position --/);
});

test('selecting a civil aircraft shows the card in the cyan faction', async (t) => {
  const m = mount(TRACKED, t);
  assert.equal(m.host().hidden, true);
  await m.emit('gev:awareness-subject-selected');
  assert.equal(m.host().hidden, false);
  assert.equal(m.view().querySelector('h2').textContent, 'Boeing 787-9');
  assert.equal(m.view().classList.contains('is-military'), false);
});

test('a military selection takes the amber faction', async (t) => {
  const m = mount({ ...TRACKED, military: true }, t);
  await m.emit('gev:awareness-subject-selected', 'military');
  assert.equal(m.view().classList.contains('is-military'), true);
});

test('clearing the selection hides the card and removes its content', async (t) => {
  const m = mount(TRACKED, t);
  await m.emit('gev:awareness-subject-selected');
  m.state.tracked = null;
  await m.emit('gev:awareness-subject-cleared');
  assert.equal(m.host().hidden, true);
  assert.equal(m.host().querySelector('h2'), null);
});

test('selections from other layers leave the card alone', async (t) => {
  const m = mount(TRACKED, t);
  await m.emit('gev:awareness-subject-selected', 'satellites');
  assert.equal(m.host().hidden, true);
  assert.equal(m.host().querySelector('h2'), null);
});

test('the telemetry refresh updates the shown values in place', async (t) => {
  const m = mount(TRACKED, t);
  await m.emit('gev:awareness-subject-selected');
  const photo = m.view().querySelector('img');
  m.state.tracked = { ...TRACKED, altitudeM: 3048 };
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await nextTick();
  assert.match(m.view().textContent, /10,000 ft/);
  assert.equal(
    m.view().querySelector('img'),
    photo,
    'the photo node is reused',
  );
});

test('the card keeps clear of the right panel stack', async (t) => {
  const m = mount(TRACKED, t);
  const stack = document.body.appendChild(document.createElement('div'));
  stack.id = 'right-panel-stack';
  stack.getBoundingClientRect = () => ({ left: 700, width: 260, height: 400 });
  Object.defineProperty(window, 'innerWidth', {
    value: 1000,
    configurable: true,
  });
  await m.emit('gev:awareness-subject-selected');
  assert.equal(m.host().style.right, '312px');
});

test('destroy removes the card from the page', (t) => {
  const m = mount(TRACKED, t);
  m.card.destroy();
  assert.equal(m.host(), null);
});
