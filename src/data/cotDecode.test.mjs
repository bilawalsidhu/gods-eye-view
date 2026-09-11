import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCotEvent, extractCotEvents } from './cotDecode.js';

const FRIENDLY_UNIT_XML = '<event version="2.0" uid="ANDROID-359999089000000" type="a-f-G-U-C" '
  + 'time="2026-08-24T12:00:00.000Z" start="2026-08-24T12:00:00.000Z" stale="2026-08-24T12:05:00.000Z" how="m-g">'
  + '<point lat="35.123456" lon="-97.123456" hae="250.0" ce="9999999.0" le="9999999.0"/>'
  + '<detail>'
  + '<contact callsign="ALPHA1"/>'
  + '<__group name="Blue" role="Team Member"/>'
  + '<takv device="SM-G960U" platform="ATAK-CIV" os="29" version="4.8.0"/>'
  + '<track course="45.0" speed="1.5"/>'
  + '<status battery="85"/>'
  + '</detail>'
  + '</event>';

// A stale/cancel message — no detail, self-closing.
const SELF_CLOSING_XML = '<event version="2.0" uid="ANDROID-1" type="a-f-G-U-C" '
  + 'time="2026-08-24T12:00:00.000Z" start="2026-08-24T12:00:00.000Z" stale="2026-08-24T12:00:01.000Z" how="m-g"/>';

test('decodeCotEvent: decodes a real friendly-unit event with full detail', () => {
  const record = decodeCotEvent(FRIENDLY_UNIT_XML);
  assert.deepEqual(record, {
    uid: 'ANDROID-359999089000000',
    type: 'a-f-G-U-C',
    affiliation: 'FRIENDLY',
    how: 'm-g',
    time: '2026-08-24T12:00:00.000Z',
    start: '2026-08-24T12:00:00.000Z',
    stale: '2026-08-24T12:05:00.000Z',
    latitude: 35.123456,
    longitude: -97.123456,
    hae: 250,
    ce: 9999999,
    le: 9999999,
    callsign: 'ALPHA1',
    groupName: 'Blue',
    groupRole: 'Team Member',
    device: 'SM-G960U',
    platform: 'ATAK-CIV',
    version: '4.8.0',
    course: 45,
    speed: 1.5,
    battery: '85',
    detail: {
      contact: { '@_callsign': 'ALPHA1' },
      __group: { '@_name': 'Blue', '@_role': 'Team Member' },
      takv: { '@_device': 'SM-G960U', '@_platform': 'ATAK-CIV', '@_os': '29', '@_version': '4.8.0' },
      track: { '@_course': '45.0', '@_speed': '1.5' },
      status: { '@_battery': '85' },
    },
  });
});

test('decodeCotEvent: a fully self-closing event (a bare cancel/delete, no point) is out of scope', () => {
  // A real top-level self-closing <event/> can never carry a <point> child —
  // Phase 1 only renders point-representable objects, so this correctly
  // decodes to null rather than a phantom marker at no location.
  assert.equal(decodeCotEvent(SELF_CLOSING_XML), null);
});

test('decodeCotEvent: an event with a point but no detail decodes cleanly', () => {
  const xml = '<event uid="ANDROID-1" type="a-f-G-U-C" stale="s"><point lat="10" lon="20"/></event>';
  const record = decodeCotEvent(xml);
  assert.equal(record.uid, 'ANDROID-1');
  assert.equal(record.latitude, 10);
  assert.equal(record.callsign, null);
  assert.deepEqual(record.detail, {});
});

test('decodeCotEvent: rejects events with no usable point (null island / missing)', () => {
  const noPoint = '<event uid="x" type="a-f-G"><detail/></event>';
  const nullIsland = '<event uid="x" type="a-f-G"><point lat="0" lon="0"/></event>';
  assert.equal(decodeCotEvent(noPoint), null);
  assert.equal(decodeCotEvent(nullIsland), null);
});

test('decodeCotEvent: rejects an event missing uid or type', () => {
  assert.equal(decodeCotEvent('<event type="a-f-G"><point lat="1" lon="1"/></event>'), null);
  assert.equal(decodeCotEvent('<event uid="x"><point lat="1" lon="1"/></event>'), null);
});

test('decodeCotEvent: a present-but-blank numeric attribute reads as missing, not zero', () => {
  const xml = '<event uid="x" type="a-f-G"><point lat="10" lon="20" hae=""/>'
    + '<detail><track course="" speed="1.5"/></detail></event>';
  const record = decodeCotEvent(xml);
  assert.equal(record.hae, null);
  assert.equal(record.course, null);
  assert.equal(record.speed, 1.5);
});

test('extractCotEvents: splits multiple events in one chunk', () => {
  const { events, remainder } = extractCotEvents(FRIENDLY_UNIT_XML + SELF_CLOSING_XML);
  assert.equal(events.length, 2);
  assert.equal(events[0], FRIENDLY_UNIT_XML);
  assert.equal(events[1], SELF_CLOSING_XML);
  assert.equal(remainder, '');
});

test('extractCotEvents: an event split across two TCP chunks reassembles', () => {
  const splitAt = 60;
  const first = extractCotEvents(FRIENDLY_UNIT_XML.slice(0, splitAt));
  assert.equal(first.events.length, 0);
  assert.equal(first.remainder, FRIENDLY_UNIT_XML.slice(0, splitAt));

  const second = extractCotEvents(first.remainder + FRIENDLY_UNIT_XML.slice(splitAt));
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0], FRIENDLY_UNIT_XML);
  assert.equal(second.remainder, '');
});

test('extractCotEvents: drops bytes before the first <event (prologue/whitespace)', () => {
  const { events, remainder } = extractCotEvents(`<?xml version="1.0"?>\n  ${SELF_CLOSING_XML}`);
  assert.equal(events.length, 1);
  assert.equal(events[0], SELF_CLOSING_XML);
  assert.equal(remainder, '');
});

test('extractCotEvents: empty/no-event buffer yields nothing and empty remainder', () => {
  assert.deepEqual(extractCotEvents(''), { events: [], remainder: '' });
  assert.deepEqual(extractCotEvents('   \n  '), { events: [], remainder: '' });
});
