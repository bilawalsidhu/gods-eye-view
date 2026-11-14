// src/cockpitRadar.test.mjs — the bridge radar's range steps, rings and
// heading-up contact projection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RADAR_RANGE_NM,
  METRES_PER_NM,
  RADAR_MAX_CONTACTS,
  RADAR_RANGES_NM,
  nextRadarRange,
  projectRadarContacts,
  radarPicture,
  radarRangeM,
  radarRingsNm,
} from './cockpitRadar.js';

const OWN = Object.freeze({ latitude: 54.5, longitude: 10.2, headingDeg: 0 });
/** One nautical mile of latitude, in degrees. */
const NM_LAT = 1 / 60;
/** One nautical mile of longitude at 54.5°N, in degrees. */
const NM_LON = 1 / (60 * Math.cos((54.5 * Math.PI) / 180));

function contact(id, northNm, eastNm, extra = {}) {
  return {
    id,
    name: id,
    latitude: OWN.latitude + northNm * NM_LAT,
    longitude: OWN.longitude + eastNm * NM_LON,
    course: null,
    color: '#fff',
    stale: false,
    ...extra,
  };
}

test('the range steps 3, 6, 12, 24 NM, opens on 3 and wraps', () => {
  assert.deepEqual(RADAR_RANGES_NM, [3, 6, 12, 24]);
  assert.equal(DEFAULT_RADAR_RANGE_NM, 3);
  assert.equal(nextRadarRange(3), 6);
  assert.equal(nextRadarRange(6), 12);
  assert.equal(nextRadarRange(12), 24);
  assert.equal(nextRadarRange(24), 3);
  assert.equal(nextRadarRange(7), 6, 'an unknown range steps from the default');
  assert.equal(radarRangeM(6), 6 * METRES_PER_NM);
});

test('range rings sit at each quarter of the range', () => {
  assert.deepEqual(radarRingsNm(6), [1.5, 3, 4.5, 6]);
  assert.deepEqual(radarRingsNm(24), [6, 12, 18, 24]);
});

test('a contact dead ahead is straight up the scope', () => {
  const [ahead] = projectRadarContacts(OWN, [contact('A', 3, 0)], {
    rangeNm: 6,
  });
  assert.ok(Math.abs(ahead.x) < 0.01, `x ${ahead.x}`);
  assert.ok(Math.abs(ahead.y - 0.5) < 0.01, `y ${ahead.y}`);
  assert.ok(Math.abs(ahead.distanceNm - 3) < 0.02);
  assert.ok(Math.abs(ahead.relativeBearingDeg) < 0.5);
});

test('heading-up turns the picture with the bow', () => {
  // Heading east: a contact to the north is on the port beam, one to the
  // south on the starboard beam, one to the east dead ahead.
  const own = { ...OWN, headingDeg: 90 };
  const byId = Object.fromEntries(
    projectRadarContacts(own, [
      contact('N', 2, 0),
      contact('S', -2, 0),
      contact('E', 0, 2),
    ]).map((entry) => [entry.id, entry]),
  );
  assert.ok(byId.N.x < -0.3 && Math.abs(byId.N.y) < 0.02, 'north is to port');
  assert.ok(
    byId.S.x > 0.3 && Math.abs(byId.S.y) < 0.02,
    'south is to starboard',
  );
  assert.ok(Math.abs(byId.E.x) < 0.02 && byId.E.y > 0.3, 'east is ahead');
  assert.ok(Math.abs(byId.S.relativeBearingDeg - 90) < 1);
  assert.ok(Math.abs(byId.N.relativeBearingDeg + 90) < 1);
});

test('a contact to starboard is right of the centre', () => {
  const [starboard] = projectRadarContacts(OWN, [contact('B', 0, 1.5)]);
  assert.ok(starboard.x > 0.2, `x ${starboard.x}`);
  assert.ok(Math.abs(starboard.y) < 0.01);
});

test('course is drawn relative to the bow and stays null when unknown', () => {
  const own = { ...OWN, headingDeg: 90 };
  const [crossing, drifting] = projectRadarContacts(own, [
    contact('A', 1, 0, { course: 180 }),
    contact('B', 2, 0, { course: null }),
  ]);
  assert.equal(crossing.relativeCourseDeg, 90);
  assert.equal(drifting.relativeCourseDeg, null);
});

test('contacts beyond the range are left out', () => {
  const contacts = projectRadarContacts(
    OWN,
    [contact('in', 5.9, 0), contact('out', 6.2, 0), contact('far', 0, 30)],
    { rangeNm: 6 },
  );
  assert.deepEqual(
    contacts.map((entry) => entry.id),
    ['in'],
  );
  assert.ok(contacts.every((entry) => Math.hypot(entry.x, entry.y) <= 1));
});

test('contacts come nearest first, capped', () => {
  const many = Array.from({ length: RADAR_MAX_CONTACTS + 15 }, (_, index) =>
    contact(`V${index}`, 0, 5.5 - index * 0.07),
  );
  const contacts = projectRadarContacts(OWN, many, { rangeNm: 6 });
  assert.equal(contacts.length, RADAR_MAX_CONTACTS);
  for (let index = 1; index < contacts.length; index += 1)
    assert.ok(contacts[index - 1].distanceNm <= contacts[index].distanceNm);
  assert.equal(
    projectRadarContacts(OWN, many, { rangeNm: 6, maxCount: 3 }).length,
    3,
    'a smaller cap is honoured',
  );
});

test('a picture carries the range, rings, heading and own course over ground', () => {
  const picture = radarPicture(
    { ...OWN, headingDeg: 350, courseDeg: 10 },
    [contact('A', 1, 0)],
    12,
  );
  assert.equal(picture.rangeNm, 12);
  assert.deepEqual(picture.ringsNm, [3, 6, 9, 12]);
  assert.equal(picture.headingDeg, 350);
  assert.equal(picture.ownRelativeCourseDeg, 20);
  assert.equal(picture.contacts.length, 1);
  assert.ok(picture.contacts[0].x > 0, 'north is to starboard of 350°');
  assert.equal(radarPicture(OWN, [], 6).ownRelativeCourseDeg, null);
});
