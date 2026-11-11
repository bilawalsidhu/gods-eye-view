// A translated vessel type is never cut mid-word on the card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { buildVesselCard, buildSelectedVesselCard } from './aisLiveVessels.js';
import { displayVesselType } from './vesselLabels.js';
import { setLocale } from '../i18n/index.js';

const POS = new Cesium.Cartesian3(1, 2, 3);
const rec = (type) => ({
  name: 'X',
  mmsi: '1',
  type,
  destination: '',
  speed: 5,
  course: 10,
  heading: 10,
  lastPositionUtc: '',
  missedRefreshes: 0,
  position: POS,
  billboard: null,
});
// Every AIS ShipType code with its own display token.
const CODES = [
  '30',
  '31',
  '33',
  '34',
  '35',
  '36',
  '37',
  '50',
  '51',
  '52',
  '53',
  '54',
  '55',
  '58',
  '40',
  '60',
  '70',
  '80',
  '90',
];

// The card label is acceptable when it is the whole translation, or when it
// was shortened at a word boundary and marked with an ellipsis.
function assertNotCutMidWord(label, full, where) {
  if (label === full) return;
  const head = label.replace(/(…|\.\.\.)$/, '');
  assert.notEqual(
    head,
    label,
    `${where}: "${label}" cut from "${full}" without an ellipsis`,
  );
  assert.ok(
    full.startsWith(head),
    `${where}: "${label}" is not a prefix of "${full}"`,
  );
  assert.match(
    full.slice(head.length),
    /^[\s-]/,
    `${where}: "${label}" cuts "${full}" mid-word`,
  );
}

for (const locale of ['es', 'ru']) {
  test(`${locale}: vessel type on cards is never cut mid-word`, () => {
    setLocale(locale);
    try {
      for (const code of CODES) {
        const full = displayVesselType(code).toUpperCase();
        const ambient = buildVesselCard(rec(code)).details[0].split(' · ')[0];
        const selected = buildSelectedVesselCard(rec(code)).details[0].split(
          ' · ',
        )[0];
        assertNotCutMidWord(ambient, full, `${locale} ${code} ambient`);
        assertNotCutMidWord(selected, full, `${locale} ${code} selected`);
      }
    } finally {
      setLocale('en');
    }
  });
}

test('en: free feed text is still bounded to the card width', () => {
  setLocale('en');
  assert.equal(
    buildVesselCard(rec('Crude Oil Tanker')).details[0].split(' · ')[0],
    'CRUDE OIL TANK',
  );
  assert.equal(
    buildSelectedVesselCard(rec('54')).details[0].split(' · ')[0],
    'ANTI-POLLUTION',
  );
});
