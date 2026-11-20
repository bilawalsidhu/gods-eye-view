import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../i18n/index.js';
import {
  LOCAL_AIS_BEACON_COLOR,
  LOCAL_AIS_COLOR,
  localAisCardModel,
} from './card.js';

const record = {
  mmsi: '200000001',
  name: 'TEST VESSEL',
  destination: 'NOWHERE',
  speed: 9.4,
  course: 77,
  approx: false,
  validated: true,
};

test('en: the card lists what the receiver gave, in English', () => {
  setLocale('en');
  const card = localAisCardModel(record);
  assert.equal(card.title, 'TEST VESSEL');
  assert.deepEqual(card.details, [
    'MMSI: 200000001',
    'Destination: NOWHERE',
    'Speed: 9.4 kn',
    'Course: 77°',
    'Heard by your receiver',
  ]);
});

test('unknown values are omitted, never shown as zero, and flags are explicit', () => {
  setLocale('en');
  const card = localAisCardModel({
    ...record,
    name: '',
    destination: '',
    speed: null,
    course: null,
    approx: true,
    validated: false,
  });
  assert.equal(card.title, 'MMSI: 200000001');
  assert.deepEqual(card.details, [
    'MMSI: 200000001',
    'Position approximate (AIS type 27)',
    'Position not yet validated by the receiver',
    'Heard by your receiver',
  ]);
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: the card follows the UI language`, () => {
    setLocale(locale);
    try {
      const text = localAisCardModel({
        ...record,
        approx: true,
        validated: false,
      }).details.join(' | ');
      for (const english of [
        'Destination',
        'Course',
        'Heard by',
        'not yet validated',
        'approximate',
      ])
        assert.doesNotMatch(text, new RegExp(english), text);
    } finally {
      setLocale('en');
    }
  });
}

const beacon = {
  mmsi: '970000001',
  name: '',
  destination: '',
  speed: null,
  course: null,
  approx: false,
  validated: true,
  beaconType: 'sart',
};

test('a beacon card is a distinct card: heard, unverified, status unknown', () => {
  setLocale('en');
  const card = localAisCardModel(beacon);
  assert.equal(card.title, 'AIS-SART beacon');
  assert.equal(card.accent, LOCAL_AIS_BEACON_COLOR);
  assert.notEqual(card.accent, LOCAL_AIS_COLOR);
  assert.deepEqual(card.details, [
    'MMSI: 970000001',
    'Distress or test beacon heard by your receiver',
    'Test transmissions are common. This is not a verified emergency.',
    'Active or test status: unknown',
  ]);
  // It never reads as a vessel, and never claims an emergency is real.
  const text = card.details.join(' ');
  assert.ok(!card.details.includes('Heard by your receiver'));
  assert.doesNotMatch(text, /Destination|Speed|Course/);
  assert.doesNotMatch(text, /confirmed/i);
});

test('each beacon kind is named, and an unknown kind is still a beacon', () => {
  setLocale('en');
  const title = (beaconType) =>
    localAisCardModel({ ...beacon, beaconType }).title;
  assert.equal(title('sart'), 'AIS-SART beacon');
  assert.equal(title('mob'), 'Man-overboard (MOB) beacon');
  assert.equal(title('epirb'), 'EPIRB beacon');
  assert.equal(title('other'), 'AIS distress beacon');
  // The receiver's own name for it wins.
  assert.equal(
    localAisCardModel({ ...beacon, name: 'TEST SART 1' }).title,
    'TEST SART 1',
  );
});

test('a beacon card keeps the position flags, and shows speed or course never', () => {
  setLocale('en');
  const card = localAisCardModel({
    ...beacon,
    speed: 3,
    course: 10,
    approx: true,
    validated: false,
  });
  assert.ok(card.details.includes('Position approximate (AIS type 27)'));
  assert.ok(
    card.details.includes('Position not yet validated by the receiver'),
  );
  assert.ok(!card.details.some((line) => /Speed|Course/.test(line)));
});

for (const locale of ['de', 'ja', 'ar']) {
  test(`${locale}: the beacon card follows the UI language`, () => {
    setLocale(locale);
    try {
      const card = localAisCardModel(beacon);
      const text = [card.title, ...card.details].join(' | ');
      for (const english of [
        'beacon',
        'Distress',
        'Test transmissions',
        'Active or',
        'verified',
      ])
        assert.doesNotMatch(text, new RegExp(english, 'i'), text);
    } finally {
      setLocale('en');
    }
  });
}
