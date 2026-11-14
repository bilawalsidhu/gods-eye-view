import test from 'node:test';
import assert from 'node:assert/strict';
import { aidToNavigationTypeName, isAidToNavigation } from './vesselTypes.js';

test('an aid-to-navigation type code names its kind of aid', () => {
  assert.equal(aidToNavigationTypeName(20), 'Cardinal Mark N');
  assert.equal(aidToNavigationTypeName('13'), 'Beacon, Port hand');
  assert.equal(aidToNavigationTypeName(2), 'RACON');
  assert.equal(aidToNavigationTypeName(29), 'Safe Water');
  assert.equal(aidToNavigationTypeName(31), 'Light Vessel / LANBY / Rigs');
  // Code 0, a code past 31 and no code name no kind.
  for (const code of [0, 32, -1, '', null, undefined, 'x'])
    assert.equal(aidToNavigationTypeName(code), 'Navigation aid', code);
});

test('aids to navigation are known by their type, else their MMSI', () => {
  for (const type of [
    'Beacon, Special Mark',
    'Cardinal Mark N',
    'Port Hand Mark',
    'Starboard Hand Mark',
    'Safe Water',
    'Isolated danger',
    'Preferred Channel Port hand',
    'RACON',
    'Light Vessel / LANBY / Rigs',
    'Reference point',
    'Navigation aid',
    'AtoN',
    'Lighthouse',
    'Buoy',
    // Every kind an aid report names is an aid, whatever its MMSI.
    'Light, with sectors',
    'Leading light rear',
    'Fixed structure off shore',
    'Emergency wreck marking buoy',
  ])
    assert.equal(isAidToNavigation({ type, mmsi: '' }), true, type);
  // A virtual aid is an aid whatever its type or MMSI.
  assert.equal(
    isAidToNavigation({ type: '', mmsi: '', virtual: true }),
    true,
  );
  // AIS aid-to-navigation stations are numbered 99MIDxxxx.
  assert.equal(isAidToNavigation({ type: '', mmsi: '993672001' }), true);
  assert.equal(isAidToNavigation({ type: '0', mmsi: ' 992351234 ' }), true);
  for (const vessel of [
    { type: 'Buoy Tender', mmsi: '366999001' },
    { type: 'Buoy-Laying Vessel', mmsi: '' },
    { type: 'Buoy Layer', mmsi: '' },
    { type: 'Lighter', mmsi: '' },
    { type: 'Flight deck', mmsi: '' },
    { type: 70, mmsi: 366999002 },
    { type: '70', mmsi: '366999002' },
    { type: '0', mmsi: '' },
    { type: 'Cargo', mmsi: '99' },
    { type: 'Passenger', mmsi: '9936720011' },
    {},
  ])
    assert.equal(isAidToNavigation(vessel), false, JSON.stringify(vessel));
});
