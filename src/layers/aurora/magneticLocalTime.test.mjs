import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEOMAGNETIC_POLE,
  decimalYear,
  dipoleAxis,
  geomagneticPole,
  mltRotationRadians,
  rotateAbout,
  subsolarPoint,
  unitVector,
} from './magneticLocalTime.js';

const DEG = Math.PI / 180;

test('the subsolar point tracks the Sun through the year', () => {
  // Solstices and equinoxes, against published solar declination. The
  // low-precision formula is good to about an arcminute, so a tenth of a
  // degree is a loose check that still catches a wrong obliquity or a sign
  // flip in the ecliptic longitude.
  const cases = [
    ['2026-03-20T12:00:00Z', 0, 0.4],
    ['2026-06-21T12:00:00Z', 23.44, 0.1],
    ['2026-09-23T12:00:00Z', 0, 0.4],
    ['2026-12-21T12:00:00Z', -23.44, 0.1],
  ];
  for (const [iso, expected, tolerance] of cases) {
    const { latitudeDeg } = subsolarPoint(new Date(iso));
    assert.ok(
      Math.abs(latitudeDeg - expected) < tolerance,
      `${iso}: declination ${latitudeDeg.toFixed(3)}, expected near ${expected}`,
    );
  }
});

test('the subsolar longitude follows UTC at fifteen degrees an hour', () => {
  // Noon UTC puts the Sun near the prime meridian, offset only by the equation
  // of time, which peaks around 16 minutes - four degrees.
  const noon = subsolarPoint(new Date('2026-10-02T12:00:00Z'));
  assert.ok(
    Math.abs(noon.longitudeDeg) < 5,
    `noon UTC subsolar longitude ${noon.longitudeDeg.toFixed(2)}`,
  );
  // Six hours later it must have moved a quarter turn west.
  const later = subsolarPoint(new Date('2026-10-02T18:00:00Z'));
  let moved = noon.longitudeDeg - later.longitudeDeg;
  moved = ((((moved + 180) % 360) + 360) % 360) - 180;
  assert.ok(
    Math.abs(moved - 90) < 0.5,
    `six hours moved the Sun ${moved.toFixed(2)} degrees, expected 90`,
  );
});

test('the vendored pole matches the IGRF-14 table it was derived from', () => {
  // These are the values the magnetosphere layer computes from the full
  // coefficient table. If that table is ever vendored here, this test is the
  // thing that should start failing.
  const at2025 = geomagneticPole(new Date('2025-01-01T00:00:00Z'));
  assert.ok(Math.abs(at2025.latitudeDeg - 80.7894) < 1e-3);
  assert.ok(Math.abs(at2025.longitudeDeg - -72.7628) < 1e-3);
  const at2027 = geomagneticPole(new Date('2027-01-01T00:00:00Z'));
  assert.ok(
    Math.abs(at2027.latitudeDeg - 80.8711) < 2e-3,
    `2027 latitude ${at2027.latitudeDeg}`,
  );
  assert.ok(
    Math.abs(at2027.longitudeDeg - -72.8401) < 2e-3,
    `2027 longitude ${at2027.longitudeDeg}`,
  );
  // The pole is near but not at the spin axis; roughly nine degrees of tilt is
  // what makes the exact rotation below differ from a flat 15 degrees an hour.
  assert.ok(90 - at2025.latitudeDeg > 8 && 90 - at2025.latitudeDeg < 11);
});

test('decimal year spans the year it is in', () => {
  assert.equal(decimalYear(new Date('2026-01-01T00:00:00Z')), 2026);
  const mid = decimalYear(new Date('2026-07-02T12:00:00Z'));
  assert.ok(Math.abs(mid - 2026.5) < 0.01, `mid-year gave ${mid}`);
});

test('the oval turns about fifteen degrees an hour, but not exactly', () => {
  // A full day must come back to where it started, and an hour must be close
  // to a twenty-fourth of that. It is deliberately NOT exactly 15: the dipole
  // is tilted about nine degrees off the spin axis, so the Sun's azimuth about
  // the magnetic axis runs fast and slow across the day. A test asserting a
  // flat 15 would be asserting the approximation this module exists to avoid.
  const hour = mltRotationRadians(
    new Date('2026-10-02T00:00:00Z'),
    new Date('2026-10-02T01:00:00Z'),
  );
  const degrees = Math.abs(hour) / DEG;
  assert.ok(degrees > 13 && degrees < 17, `one hour turned ${degrees}`);
  assert.ok(
    Math.abs(degrees - 15) > 0.001,
    'an exactly uniform rate would mean the dipole tilt was ignored',
  );

  // Twenty-four hours is a full turn, give or take the Sun's own motion along
  // the ecliptic over a day.
  let total = 0;
  for (let h = 0; h < 24; h += 1) {
    total += mltRotationRadians(
      new Date(Date.UTC(2026, 9, 2, h)),
      new Date(Date.UTC(2026, 9, 2, h + 1)),
    );
  }
  assert.ok(
    Math.abs(Math.abs(total) / DEG - 360) < 1.5,
    `a day summed to ${(Math.abs(total) / DEG).toFixed(3)} degrees`,
  );
});

test('the rotation runs westward, the way the sky does', () => {
  // In the Earth-fixed frame the Sun moves west as the Earth turns east, so a
  // later instant is a negative rotation about the northward dipole axis. Get
  // this backwards and the oval slides the wrong way during every transition.
  const forward = mltRotationRadians(
    new Date('2026-10-02T03:18:00Z'),
    new Date('2026-10-02T03:23:00Z'),
  );
  assert.ok(forward < 0, `five minutes gave ${forward}`);
  const back = mltRotationRadians(
    new Date('2026-10-02T03:23:00Z'),
    new Date('2026-10-02T03:18:00Z'),
  );
  assert.ok(Math.abs(forward + back) < 1e-9, 'reversing must negate');
});

test('a five-minute step is the fraction of a degree the blend has to cover', () => {
  const step =
    Math.abs(
      mltRotationRadians(
        new Date('2026-10-02T03:18:00Z'),
        new Date('2026-10-02T03:23:00Z'),
      ),
    ) / DEG;
  // About 1.25 degrees. This is why the raster samples bilinearly: on a one
  // degree grid, nearest-neighbour would hold still and then jump a whole cell.
  assert.ok(step > 1 && step < 1.5, `five minutes turned ${step} degrees`);
});

test('rotating about an axis preserves length and leaves the axis alone', () => {
  const axis = dipoleAxis(new Date('2026-10-02T00:00:00Z'));
  const v = unitVector(65, 20);
  const turned = rotateAbout(v, axis, 0.3);
  assert.ok(
    Math.abs(Math.hypot(turned.x, turned.y, turned.z) - 1) < 1e-12,
    'rotation must not stretch',
  );
  const onAxis = rotateAbout(axis, axis, 1.1);
  for (const key of ['x', 'y', 'z'])
    assert.ok(Math.abs(onAxis[key] - axis[key]) < 1e-12, `axis moved in ${key}`);
  // A full turn is the identity.
  const full = rotateAbout(v, axis, 2 * Math.PI);
  for (const key of ['x', 'y', 'z'])
    assert.ok(Math.abs(full[key] - v[key]) < 1e-12, `full turn moved ${key}`);
});

test('the pole constant is frozen and complete', () => {
  assert.ok(Object.isFrozen(GEOMAGNETIC_POLE));
  for (const key of [
    'epochYear',
    'latitudeDeg',
    'longitudeDeg',
    'latitudeDriftPerYear',
    'longitudeDriftPerYear',
  ])
    assert.ok(Number.isFinite(GEOMAGNETIC_POLE[key]), `missing ${key}`);
});
