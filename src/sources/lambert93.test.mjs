import test from 'node:test';
import assert from 'node:assert/strict';
import { lambert93ToLonLat, LAMBERT93_PARAMS } from './lambert93.js';

/**
 * Control points generated with proj4:
 *   +proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +k_0=0.99987742
 *   +x_0=700000 +y_0=6600000 +ellps=GRS80
 * An earlier implementation of this file used the wrong cone apex sign and
 * a single standard parallel; both put Paris ~6 degrees of latitude off.
 * These cases pin the correct behaviour.
 */
const CONTROL_POINTS = [
  ['Paris', 652474.8491, 6862003.1391, 48.8566, 2.3522],
  ['Bordeaux', 417276.1996, 6421835.1881, 44.8378, -0.5792],
  ['Lyon', 842649.1711, 6519934.1825, 45.764, 4.8357],
  ['Marseille', 892366.6384, 6247078.5232, 43.2965, 5.3698],
  ['Lille', 704060.6481, 7059080.3085, 50.6292, 3.0573],
  ['Strasbourg', 1050319.7479, 6840870.1177, 48.5734, 7.7521],
  ['Brest', 146700.8103, 6836233.3656, 48.3904, -4.4861],
  ['Nice', 1043368.0645, 6299436.8905, 43.7102, 7.262],
  ['Nantes', 355620.0209, 6689712.1046, 47.2184, -1.5536],
  ['Toulouse', 574373.2214, 6279682.2417, 43.6047, 1.4442],
];

test('lambert93ToLonLat reproduces proj4 control points', () => {
  for (const [name, x, y, lat, lon] of CONTROL_POINTS) {
    const result = lambert93ToLonLat(x, y);
    assert.ok(result, `${name} should convert`);
    assert.ok(
      Math.abs(result.lat - lat) < 1e-6,
      `${name} latitude ${result.lat} != ${lat}`,
    );
    assert.ok(
      Math.abs(result.lon - lon) < 1e-6,
      `${name} longitude ${result.lon} != ${lon}`,
    );
  }
});

test('northing grows northward', () => {
  const north = lambert93ToLonLat(700000, 7000000);
  const south = lambert93ToLonLat(700000, 6200000);
  assert.ok(north.lat > south.lat, 'north must be north of south');
  assert.ok(north.lat > 49.5 && north.lat < 50.5, 'north is north of 49.5N');
  assert.ok(south.lat > 42.5 && south.lat < 43.5, 'south is south of 43.5N');
  // The latitude of origin (46.5N) sits exactly at the false northing.
  const origin = lambert93ToLonLat(700000, 6600000);
  assert.ok(Math.abs(origin.lat - 46.5) < 1e-9);
  assert.ok(Math.abs(origin.lon - 3) < 1e-9);
});

test('longitude grows eastward', () => {
  const east = lambert93ToLonLat(1050319.7479, 6840870.1177);
  const west = lambert93ToLonLat(146700.8103, 6836233.3656);
  assert.ok(east.lon > west.lon, 'east must be east of west');
});

test('non-finite and degenerate input is rejected', () => {
  assert.equal(lambert93ToLonLat(Number.NaN, 0), null);
  assert.equal(lambert93ToLonLat(0, Number.POSITIVE_INFINITY), null);
  assert.equal(lambert93ToLonLat(undefined, undefined), null);
});

test('published parameters match EPSG:2154', () => {
  assert.equal(LAMBERT93_PARAMS.falseEasting, 700000);
  assert.equal(LAMBERT93_PARAMS.falseNorthing, 6600000);
  assert.ok(Math.abs(LAMBERT93_PARAMS.lat0 - 46.5) < 1e-9);
  assert.ok(Math.abs(LAMBERT93_PARAMS.lon0 - 3) < 1e-9);
  assert.ok(Math.abs(LAMBERT93_PARAMS.lat1 - 49) < 1e-9);
  assert.ok(Math.abs(LAMBERT93_PARAMS.lat2 - 44) < 1e-9);
});
