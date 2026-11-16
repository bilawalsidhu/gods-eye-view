import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAirAccident } from './cards.js';
import { ASN_RECORD_URL } from './records.js';
import { accidentMarkerImage, markerPixelSize } from './index.js';

test('markers grow with the death toll, within bounds', () => {
  assert.equal(markerPixelSize(null), 16);
  assert.equal(markerPixelSize(0), 16);
  assert.ok(markerPixelSize(10) > markerPixelSize(1));
  assert.equal(markerPixelSize(5000), 36);
});

test('the marker is a coloured disc with a white rim and an aircraft', () => {
  const url = accidentMarkerImage('#ff4d4d');
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'));
  const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1));
  assert.match(svg, /<circle [^>]*fill="#ff4d4d" stroke="#ffffff"/);
  assert.ok(svg.includes('<path d="M18 6.5'));
});

test('the card leads with the toll, then date, place, flight and aircraft', () => {
  const { title, details, link } = describeAirAccident({
    id: 'wikidata:Q163107',
    date: '2002-07-01',
    place: 'Überlingen',
    country: 'Germany',
    fatalities: 71,
    survivors: 0,
    aircraft: 'Boeing 757 / Tupolev Tu-154M',
    registration: 'RA-85816',
    flight: 'BTC 2937',
    origin: 'Moscow Domodedovo Airport',
    destination: 'Barcelona Airport',
    operator: 'Bashkirian Airlines',
    approximate: false,
    name: 'Überlingen mid-air collision',
    url: `${ASN_RECORD_URL}20020701-0`,
  });
  assert.equal(title, 'Überlingen mid-air collision');
  assert.equal(details[0], 'Fatalities: 71');
  const text = details.join('\n');
  assert.match(text, /Überlingen · Germany/);
  assert.match(
    text,
    /Flight BTC 2937 · Route: Moscow Domodedovo Airport → Barcelona Airport/,
  );
  // One registration for two aircraft names neither.
  assert.match(text, /Aircraft: Boeing 757 \/ Tupolev Tu-154M/);
  assert.doesNotMatch(text, /RA-85816/);
  assert.match(text, /Operator: Bashkirian Airlines/);
  assert.doesNotMatch(text, /Approximate/);
  assert.match(text, /Source: Wikidata/);
  assert.match(text, /Aviation Safety Network record/);
  assert.equal(link, `${ASN_RECORD_URL}20020701-0`);
});

test('an unnamed, placed accident says where it was placed', () => {
  const { title, details, link } = describeAirAccident({
    id: 'wikidata:Q5',
    place: 'Taiwan',
    country: 'Taiwan',
    fatalities: null,
    aircraft: 'Boeing 737 MAX 8',
    registration: 'PK-LQP',
    origin: 'Soekarno–Hatta International Airport',
    approximate: true,
    name: null,
    url: 'https://www.wikidata.org/wiki/Q5',
  });
  assert.equal(title, 'Air accident · Boeing 737 MAX 8');
  const text = details.join('\n');
  assert.doesNotMatch(text, /Fatalities/);
  // The country is not repeated when it is the place.
  assert.doesNotMatch(text, /Taiwan · Taiwan/);
  assert.match(text, /Aircraft: PK-LQP · Boeing 737 MAX 8/);
  assert.match(text, /Route: departed from Soekarno–Hatta/);
  assert.match(text, /Approximate position: placed at Taiwan/);
  assert.match(text, /Wikidata item/);
  assert.equal(link, 'https://www.wikidata.org/wiki/Q5');
});
