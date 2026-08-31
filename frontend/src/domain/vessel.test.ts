import { describe, expect, it } from 'vitest';

import { flagMid, isUnderWay, shipTypeLabel, vesselLabel } from './vessel';
import { makeVessel } from '../testing/vessel';

describe('shipTypeLabel', () => {
  it('names the specific craft the standard names', () => {
    expect(shipTypeLabel(30)).toBe('Fishing');
    expect(shipTypeLabel(35)).toBe('Military operations');
    expect(shipTypeLabel(37)).toBe('Pleasure craft');
    expect(shipTypeLabel(52)).toBe('Tug');
    expect(shipTypeLabel(59)).toBe('Noncombatant');
  });

  it('falls back to the category for codes whose units digit is a cargo hazard class', () => {
    expect(shipTypeLabel(70)).toBe('Cargo');
    // 71 to 74 are cargo carrying IMO hazard categories A to D. Still cargo.
    expect(shipTypeLabel(74)).toBe('Cargo');
    expect(shipTypeLabel(80)).toBe('Tanker');
    expect(shipTypeLabel(84)).toBe('Tanker');
    expect(shipTypeLabel(60)).toBe('Passenger');
    expect(shipTypeLabel(69)).toBe('Passenger');
    expect(shipTypeLabel(20)).toBe('Wing in ground');
    expect(shipTypeLabel(44)).toBe('High-speed craft');
    expect(shipTypeLabel(90)).toBe('Other type');
  });

  it('says nothing for a code the standard reserves', () => {
    // 1 to 19 are reserved, and so are 38, 39, 56 and 57. None of them is a type, so none
    // of them gets a substitute label.
    expect(shipTypeLabel(1)).toBeNull();
    expect(shipTypeLabel(19)).toBeNull();
    expect(shipTypeLabel(38)).toBeNull();
    expect(shipTypeLabel(39)).toBeNull();
    expect(shipTypeLabel(56)).toBeNull();
    expect(shipTypeLabel(57)).toBeNull();
  });

  it('says nothing when the feed reported no type at all', () => {
    // 0 on the wire means not available and the adapter already mapped it to null. 322 of
    // 950 live records carried no usable static data of one kind or another.
    expect(shipTypeLabel(null)).toBeNull();
    expect(shipTypeLabel(undefined)).toBeNull();
  });
});

describe('vesselLabel', () => {
  it('prefers the broadcast name', () => {
    expect(vesselLabel(makeVessel({ name: 'FINNMAID' }))).toBe('FINNMAID');
  });

  it('falls back to the call sign, then to the MMSI', () => {
    // 108 of 1,058 live positions had no static record and so no name, which is normal.
    expect(vesselLabel(makeVessel({ name: null, call_sign: 'OJPQ' }))).toBe('OJPQ');
    expect(vesselLabel(makeVessel({ mmsi: '230123450', name: null, call_sign: null }))).toBe(
      '230123450',
    );
  });
});

describe('flagMid', () => {
  it('takes the ITU MID off the front of the MMSI and nothing else', () => {
    // Three digits, and no country: one MID can cover several territories, so turning it
    // into a flag state needs the published ITU table in phase 5.
    expect(flagMid(makeVessel({ mmsi: '230123450' }))).toBe('230');
    expect(flagMid(makeVessel({ mmsi: '306999999' }))).toBe('306');
  });
});

describe('isUnderWay', () => {
  it('is true only when the feed gave both a course and a speed above zero', () => {
    expect(isUnderWay(makeVessel({ speed_over_ground_mps: 8, course_over_ground_deg: 90 }))).toBe(
      true,
    );
    expect(isUnderWay(makeVessel({ speed_over_ground_mps: 0 }))).toBe(false);
    expect(isUnderWay(makeVessel({ speed_over_ground_mps: null }))).toBe(false);
    expect(isUnderWay(makeVessel({ course_over_ground_deg: null }))).toBe(false);
  });

  it('reads a course due north as a real course, not as a missing one', () => {
    // 0.0 is due north and 360.0 on the wire means not available. The adapter maps the
    // sentinel to null before this ever sees it, so a zero here is a heading.
    expect(isUnderWay(makeVessel({ course_over_ground_deg: 0, speed_over_ground_mps: 8 }))).toBe(
      true,
    );
  });

  it('believes the speed over the status the master typed in', () => {
    // A ship set to "moored" and making way is a ship that is moving. The status is typed
    // by a person and the speed is a measurement.
    expect(
      isUnderWay(
        makeVessel({
          navigational_status: 'moored',
          speed_over_ground_mps: 6,
          course_over_ground_deg: 200,
        }),
      ),
    ).toBe(true);
  });
});
