import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeVesselClass,
  describeActivity,
  readDraughtTrend,
  buildVesselNarrative,
  narrativeText,
} from './ais-narrative.js';
import { decodeDestination, destinationLabel } from './ais-locode.js';

const NOW = 1_700_000_000;

function bulker(overrides = {}) {
  return {
    name: 'CAPE BRITANNIA',
    mmsi: '431449000',
    type: '79',
    length: 292,
    flag: 'Japan',
    draught: 14.9,
    load_state: 'LADEN',
    destination: 'TWMLI',
    eta: '09-24 14:30',
    nav_status: 0,
    speed: 9.6,
    ...overrides,
  };
}

function voyage(draught, hoursAgo) {
  return { draught, observed: NOW - hoursAgo * 3600 };
}

test('LOCODEs, plain names and routes all decode', () => {
  assert.equal(destinationLabel(decodeDestination('NLRTM')), 'Rotterdam, Netherlands');
  assert.equal(destinationLabel(decodeDestination('AU NTL')), 'Newcastle, Australia');
  assert.equal(destinationLabel(decodeDestination('ANTWERPEN')), 'Antwerp, Belgium');
  assert.equal(destinationLabel(decodeDestination('ROTTERDAM>HAMBURG')), 'Hamburg, Germany');
});

test('an unlisted LOCODE still yields its country', () => {
  const decoded = decodeDestination('DERSK');
  assert.equal(decoded.confidence, 'COUNTRY');
  assert.equal(decoded.country, 'Germany');
  assert.equal(destinationLabel(decoded), 'Germany (DERSK)');
});

test('free text is never forced into a country', () => {
  const decoded = decodeDestination('SWEDISH SAR VESSEL');
  assert.equal(decoded.confidence, 'RAW');
  assert.equal(decoded.country, '', 'SW must not be read as a country code');
});

test('vessel class reads flag, length and type', () => {
  assert.equal(describeVesselClass(bulker()), 'Japan-flagged 292m very large cargo ship');
  assert.equal(describeVesselClass({ type: '52' }), 'tug');
  assert.equal(describeVesselClass({ type: '30', flag: 'Norway' }), 'Norway-flagged fishing vessel');
  assert.equal(describeVesselClass({}), 'vessel');
});

test('activity reflects navigational status over raw speed', () => {
  assert.equal(describeActivity({ nav_status: 5, speed: 0 }).alongside, true);
  assert.equal(describeActivity({ nav_status: 1, speed: 0 }).activity, 'waiting at anchor');
  assert.equal(describeActivity({ nav_status: 7, speed: 3 }).activity, 'fishing');
  assert.equal(describeActivity({ nav_status: 0, speed: 12 }).activity, 'under way');
  assert.equal(describeActivity({ nav_status: 0, speed: 0 }).activity, 'stopped');
});

test('a rising draught reads as loading, a falling one as discharging', () => {
  assert.equal(readDraughtTrend([voyage(14.9, 1), voyage(9.2, 14)]).trend, 'LOADING');
  assert.equal(readDraughtTrend([voyage(9.2, 1), voyage(14.9, 14)]).trend, 'DISCHARGING');
  assert.equal(readDraughtTrend([voyage(9.2, 1), voyage(9.3, 14)]).trend, 'STEADY');
});

test('a single observation cannot establish a trend', () => {
  assert.equal(readDraughtTrend([voyage(9.2, 1)]).trend, 'UNKNOWN');
  assert.equal(readDraughtTrend([]).trend, 'UNKNOWN');
  assert.equal(readDraughtTrend(null).trend, 'UNKNOWN');
});

test('the loading story is told from the draught record', () => {
  const n = buildVesselNarrative(bulker(), [voyage(14.9, 1), voyage(9.2, 14)]);
  assert.match(n.why, /5\.7m deeper/);
  assert.match(n.why, /loading/);
  assert.match(n.heading, /Mailiao, Taiwan/);
  assert.match(n.heading, /ETA 24 Sep 14:30/);
});

test('a berthed vessel with a rising draught is described as taking on cargo', () => {
  const n = buildVesselNarrative(
    bulker({ nav_status: 5, speed: 0, destination: 'AU NTL' }),
    [voyage(14.9, 1), voyage(9.2, 14)],
  );
  assert.match(n.doing, /taking on cargo/);
  assert.match(n.headline, /CAPE BRITANNIA/);
});

test('a ballast vessel under way is described as going to load', () => {
  const n = buildVesselNarrative(
    bulker({ load_state: 'BALLAST', draught: 9.2 }),
    [],
  );
  assert.match(n.why, /going to .* to load/);
});

test('without evidence the narrative declines to guess', () => {
  const n = buildVesselNarrative({ name: 'X', mmsi: '1', type: '70', speed: 8, nav_status: 0 }, []);
  assert.match(n.why, /no draught/i);
  assert.ok(n.caveats.includes('no draught broadcast'));
});

test('an unproven load state is stated as unknown, not asserted', () => {
  const n = buildVesselNarrative(bulker({ load_state: 'UNKNOWN' }), []);
  assert.match(n.why, /not yet been seen both loaded and empty/);
  assert.ok(n.caveats.some((c) => /more observations/.test(c)));
});

test('estimated positions and sanctions hits become caveats', () => {
  const n = buildVesselNarrative(
    bulker({ estimated: true, sanctioned: true, sanction_confidence: 'IMO', sanction_programs: 'IRAN' }),
    [],
  );
  assert.ok(n.caveats.some((c) => /dead-reckoned/.test(c)));
  assert.ok(n.caveats.some((c) => /IRAN/.test(c)));
});

test('narrativeText assembles one readable paragraph', () => {
  const text = narrativeText(buildVesselNarrative(bulker(), [voyage(14.9, 1), voyage(9.2, 14)]));
  assert.match(text, /^CAPE BRITANNIA — Japan-flagged 292m very large cargo ship, under way\./);
  assert.match(text, /Under way to Mailiao, Taiwan/);
});

test('AIS @ padding never leaks into a destination', () => {
  const decoded = decodeDestination('US SFO AN@@@@@@@@@');
  assert.equal(decoded.confidence, 'LOCODE');
  assert.equal(destinationLabel(decoded), 'San Francisco, United States');
});

test('a LOCODE with a trailing berth note still resolves', () => {
  assert.equal(destinationLabel(decodeDestination('NLRTM B3')), 'Rotterdam, Netherlands');
});

test('an unrecognised five-letter prefix is not invented into a port', () => {
  const decoded = decodeDestination('XXABC DEF');
  assert.equal(decoded.confidence, 'RAW');
  assert.equal(decoded.port, '');
});

test('overseas-territory MIDs do not hijack their sovereign ISO code', () => {
  // MID 303 is Alaska and sorts before the US entry; New York is not Alaskan.
  assert.equal(destinationLabel(decodeDestination('USNYC')), 'New York, United States');
  assert.equal(destinationLabel(decodeDestination('GBIMM')), 'Immingham, United Kingdom');
});

test('long official country names are shortened for prose', () => {
  assert.equal(
    describeVesselClass({ type: '52', flag: 'United States of America' }),
    'United States-flagged tug',
  );
});

test('a vague type carries no size adjective', () => {
  assert.equal(describeVesselClass({ type: '90', length: 40 }), '40m other vessel');
});
