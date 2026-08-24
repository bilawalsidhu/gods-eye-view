import { describe, expect, it } from 'vitest';

import {
  LOCATION_PRIVACY_NOTICE,
  accuracyText,
  fixFromPosition,
  locationCapability,
  locationNotices,
  refusalFromCode,
} from './location';
import type { LocationFix, LocationState } from './location';

/**
 * A `GeolocationPosition` without a browser.
 *
 * Built by hand rather than mocked, because every field this module reads is one the
 * specification allows to be absent, wrong or non-finite, and a mock built from a happy path
 * would test none of that.
 */
function position(coords: Partial<GeolocationCoordinates>, timestamp = 1_700_000_000_000) {
  return {
    coords: {
      longitude: -0.12,
      latitude: 51.5,
      accuracy: 25,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      ...coords,
    },
    timestamp,
  } as GeolocationPosition;
}

describe('refusalFromCode', () => {
  it('names the two codes it can act on', () => {
    expect(refusalFromCode(1)).toBe('denied');
    expect(refusalFromCode(3)).toBe('timeout');
  });

  it('treats an unknown code the same as position-unavailable', () => {
    // Both mean the browser did not fix a position and did not usefully say why, so they read
    // the same to anyone looking at the rail. A future fourth code must not crash the layer.
    expect(refusalFromCode(2)).toBe('unavailable');
    expect(refusalFromCode(99)).toBe('unavailable');
    expect(refusalFromCode(NaN)).toBe('unavailable');
  });
});

describe('fixFromPosition', () => {
  it('takes a usable fix', () => {
    const fix = fixFromPosition(position({}));

    expect(fix).not.toBeNull();
    expect(fix?.lon).toBe(-0.12);
    expect(fix?.lat).toBe(51.5);
    expect(fix?.accuracyM).toBe(25);
    expect(fix?.altitudeM).toBeNull();
  });

  it('refuses a zero accuracy, which is a claim of perfect knowledge', () => {
    // The specification permits a non-negative radius, so zero is legal and it is the one
    // number on this layer that would certainly be false. Dropped rather than drawn.
    expect(fixFromPosition(position({ accuracy: 0 }))).toBeNull();
    expect(fixFromPosition(position({ accuracy: -1 }))).toBeNull();
  });

  it('refuses coordinates outside the world', () => {
    expect(fixFromPosition(position({ longitude: 181 }))).toBeNull();
    expect(fixFromPosition(position({ latitude: -91 }))).toBeNull();
    expect(fixFromPosition(position({ longitude: NaN }))).toBeNull();
    expect(fixFromPosition(position({ accuracy: Infinity }))).toBeNull();
  });

  it('keeps a finite altitude and drops a non-finite one', () => {
    expect(fixFromPosition(position({ altitude: 42 }))?.altitudeM).toBe(42);
    expect(fixFromPosition(position({ altitude: NaN }))?.altitudeM).toBeNull();
  });

  it('falls back to now when the browser timestamps a fix with nonsense', () => {
    const fix = fixFromPosition(position({}, NaN));

    expect(fix).not.toBeNull();
    expect(Number.isFinite(fix?.atMs ?? NaN)).toBe(true);
  });
});

describe('accuracyText', () => {
  it('reads in metres below a kilometre and kilometres above it', () => {
    expect(accuracyText(25)).toBe('25 m');
    expect(accuracyText(999)).toBe('999 m');
    expect(accuracyText(1000)).toBe('1.0 km');
    expect(accuracyText(2500)).toBe('2.5 km');
  });
});

describe('locationNotices', () => {
  const fix: LocationFix = { lon: 0, lat: 0, accuracyM: 10, altitudeM: null, atMs: 0 };

  it('carries the privacy promise in every state that has a position', () => {
    // The promise is the one thing a viewer cannot check for themselves, so it is on the row
    // rather than only in a comment. A state that shows a position and not this would be the
    // failure the notice exists to prevent.
    expect(locationNotices({ kind: 'fixed', fix })).toContain(LOCATION_PRIVACY_NOTICE);
  });

  it('says something in every state rather than going silent', () => {
    const states: LocationState[] = [
      { kind: 'unsupported' },
      { kind: 'off' },
      { kind: 'asking' },
      { kind: 'fixed', fix },
      { kind: 'refused', reason: 'denied' },
      { kind: 'refused', reason: 'unavailable' },
      { kind: 'refused', reason: 'timeout' },
    ];

    for (const state of states) {
      expect(locationNotices(state).length).toBeGreaterThan(0);
    }
  });
});

describe('locationCapability', () => {
  it('reports itself unavailable with a reason when there is no position', () => {
    // Same contract as every gated provider row: a layer that cannot draw says why, rather
    // than rendering nothing and letting a viewer assume the feature is broken.
    const refused = locationCapability({ kind: 'refused', reason: 'denied' });

    expect(refused.available).toBe(false);
    expect(refused.reason).toBeTruthy();
  });

  it('is available once a position is held', () => {
    const fixed = locationCapability({
      kind: 'fixed',
      fix: { lon: 0, lat: 0, accuracyM: 10, altitudeM: null, atMs: 0 },
    });

    expect(fixed.available).toBe(true);
  });
});
