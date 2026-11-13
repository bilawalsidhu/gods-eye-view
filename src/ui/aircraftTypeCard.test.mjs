import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createAircraftTypeCard } from './aircraftTypeCard.js';

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

function mount(initial) {
  const window = new Window({ url: 'http://localhost:4173/' });
  const state = { tracked: initial };
  const card = createAircraftTypeCard({
    getTracked: () => state.tracked,
    resolveAsset: (url) => `/app${url}`,
    documentRef: window.document,
    windowRef: window,
  });
  const emit = (type, layerId = 'flights') =>
    window.dispatchEvent(new window.CustomEvent(type, { detail: { layerId } }));
  const host = () => window.document.querySelector('[data-aircraft-type-card]');
  return { window, state, card, emit, host };
}

test('selecting a civil aircraft shows its type name, photo and cyan faction', () => {
  const m = mount(TRACKED);
  m.emit('gev:awareness-subject-selected');
  assert.equal(m.host().hidden, false);
  assert.equal(m.host().querySelector('h2').textContent, 'Boeing 787-9');
  assert.equal(
    m.host().querySelector('img').getAttribute('src'),
    '/app/aircraft-types/B789.webp',
  );
  assert.equal(m.host().classList.contains('is-military'), false);
  m.card.destroy();
});

test('the photo credit links to its source and licence', () => {
  const m = mount(TRACKED);
  m.emit('gev:awareness-subject-selected');
  const links = [...m.host().querySelectorAll('.credit a')];
  assert.ok(links.length >= 1);
  assert.ok(links.every((a) => a.getAttribute('href').startsWith('https://')));
  m.card.destroy();
});

test('a military contact takes the amber faction', () => {
  const m = mount({ ...TRACKED, military: true, typeCode: 'B789' });
  m.emit('gev:awareness-subject-selected', 'military');
  assert.equal(m.host().classList.contains('is-military'), true);
  m.card.destroy();
});

test('clearing the selection hides the card', () => {
  const m = mount(TRACKED);
  m.emit('gev:awareness-subject-selected');
  m.state.tracked = null;
  m.emit('gev:awareness-subject-cleared');
  assert.equal(m.host().hidden, true);
  assert.equal(m.host().querySelector('h2'), null);
  m.card.destroy();
});

test('selections from other layers leave the card alone', () => {
  const m = mount(TRACKED);
  m.emit('gev:awareness-subject-selected', 'satellites');
  assert.equal(m.host().hidden, true);
  m.card.destroy();
});

test('an unknown type shows the raw code with no photo', () => {
  const m = mount({ ...TRACKED, typeCode: 'ZZZZ' });
  m.emit('gev:awareness-subject-selected');
  assert.equal(m.host().querySelector('h2').textContent, 'ZZZZ');
  assert.equal(m.host().querySelector('img'), null);
  assert.equal(m.host().hidden, false);
  m.card.destroy();
});

test('live telemetry is shown in aviation units', () => {
  const m = mount(TRACKED);
  m.emit('gev:awareness-subject-selected');
  const text = m.host().textContent;
  assert.match(text, /36,998 ft/);
  assert.match(text, /489 kt/);
  assert.match(text, /282°/);
  assert.match(text, /ZRH → JFK/);
  m.card.destroy();
});

test('destroy removes the card from the page', () => {
  const m = mount(TRACKED);
  m.card.destroy();
  assert.equal(m.host(), null);
});
