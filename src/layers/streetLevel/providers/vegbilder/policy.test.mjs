import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COVERAGE_YEARS,
  coverageLayers,
  driveFilter,
  layerName,
  layerOfId,
  linesFromImages,
  normalizeImage,
  passOf,
  passesVegbilderFilter,
  roadName,
  searchLayers,
  vegbilderPhotoUrl,
  yearsFor,
} from './policy.js';
import {
  driveFeatures,
  vegbilderFeature,
} from '../../../../testSupport/vegbilderFakes.mjs';

const NOW = Date.UTC(2026, 9, 14);
test('feature types are one per year and kind; a photo id names its own', () => {
  assert.equal(layerName(2025, false), 'vegbilder_1_0:Vegbilder_2025');
  assert.equal(layerName(2024, true), 'vegbilder_1_0:Vegbilder_360_2024');
  assert.equal(
    layerOfId(
      'Vegbilder_360_2025.2025-07-20T03.31.02_EV00018_S55D40_m00151_360_1',
    ),
    'vegbilder_1_0:Vegbilder_360_2025',
  );
  assert.equal(layerOfId('Other_2025.x'), null);
  assert.equal(layerOfId('Vegbilder_2025./../x'), null, 'no path in an id');
  assert.equal(layerOfId(undefined), null);
});

test('years: flat from 2014 without 2015, 360° from 2021, newest first, none past this year', () => {
  const flat = yearsFor(false, NOW);
  assert.equal(flat[0], 2026);
  assert.equal(flat.at(-1), 2014);
  assert.ok(!flat.includes(2015));
  assert.deepEqual(yearsFor(true, NOW), [2026, 2025, 2024, 2023, 2022, 2021]);
});

test('coverage comes from the latest years of the kinds the filter lets through, none before SINCE', () => {
  const all = coverageLayers({ pano: 'all', sinceMs: null }, NOW);
  assert.equal(all.length, COVERAGE_YEARS * 2);
  assert.ok(all.includes('vegbilder_1_0:Vegbilder_2024'));
  assert.ok(all.includes('vegbilder_1_0:Vegbilder_360_2026'));
  assert.ok(!all.includes('vegbilder_1_0:Vegbilder_2023'));
  assert.deepEqual(
    coverageLayers({ pano: 'pano', sinceMs: Date.UTC(2025, 5, 1) }, NOW),
    ['vegbilder_1_0:Vegbilder_360_2026', 'vegbilder_1_0:Vegbilder_360_2025'],
  );
  assert.deepEqual(
    coverageLayers({ pano: 'flat', sinceMs: Date.UTC(2026, 0, 2) }, NOW),
    ['vegbilder_1_0:Vegbilder_2026'],
  );
});

test('the nearest search walks newest first, flat before 360° in a year, back to SINCE', () => {
  const layers = searchLayers({ pano: 'all', sinceMs: null }, NOW);
  assert.deepEqual(layers.slice(0, 3), [
    'vegbilder_1_0:Vegbilder_2026',
    'vegbilder_1_0:Vegbilder_360_2026',
    'vegbilder_1_0:Vegbilder_2025',
  ]);
  assert.equal(layers.at(-1), 'vegbilder_1_0:Vegbilder_2014');
  assert.ok(!layers.includes('vegbilder_1_0:Vegbilder_360_2020'));
  assert.deepEqual(
    searchLayers({ pano: 'pano', sinceMs: Date.UTC(2025, 0, 1) }, NOW),
    ['vegbilder_1_0:Vegbilder_360_2026', 'vegbilder_1_0:Vegbilder_360_2025'],
  );
});

test('a feature normalizes to a photo with its road, drive and signed addresses on Vegvesen’s host only', () => {
  const image = normalizeImage(vegbilderFeature({ pano: true }));
  assert.equal(image.layer, 'vegbilder_1_0:Vegbilder_360_2025');
  assert.equal(image.isPano, true);
  assert.equal(image.heading, 198.26);
  assert.equal(image.meter, 568);
  assert.equal(image.road.lane, '1');
  assert.equal(
    image.driveId,
    'Vegbilder_360_2025|RV162|S1D50|AKSA|F1|2025-06-19',
  );
  assert.match(
    image.urls.full,
    /^https:\/\/s3vegbilder\.atlas\.vegvesen\.no\//,
  );
  assert.match(image.urls.preview, /_preview\.jpg/);
  assert.equal(vegbilderPhotoUrl(image), image.urls.full);

  const store = vegbilderFeature();
  store.properties.URL =
    'https://s3-oslo.osys.vegvesen.no/sagadpl-prod-objektlager-vegbilder-gul/360/abc.jpg?X-Amz-Signature=1';
  assert.match(
    normalizeImage(store).urls.full,
    /^https:\/\/s3-oslo\.osys\.vegvesen\.no\//,
  );

  const foreign = vegbilderFeature();
  foreign.properties.URL = 'https://evil.example/x.jpg';
  assert.equal(normalizeImage(foreign).urls.full, null);
  assert.equal(
    vegbilderPhotoUrl(normalizeImage(foreign)),
    'https://vegbilder.atlas.vegvesen.no',
  );

  const nowhere = vegbilderFeature();
  nowhere.geometry.coordinates = [NaN, 59];
  assert.equal(normalizeImage(nowhere), null);
  assert.equal(
    normalizeImage({ id: 'x', geometry: { coordinates: [10, 59] } }),
    null,
  );
});

test('road names read as Norwegians write them', () => {
  assert.equal(roadName({ category: 'E', number: 18 }), 'E18');
  assert.equal(roadName({ category: 'R', number: 162 }), 'Rv. 162');
  assert.equal(roadName({ category: 'F', number: 61 }), 'Fv. 61');
  assert.equal(roadName({ category: null, number: 1 }), null);
});

test('lines: one per pass of a drive, broken at gaps in space or time; lone photos draw nothing', () => {
  const run = driveFeatures(5).map(normalizeImage);
  const gap = driveFeatures(3, { start: 200 }).map(normalizeImage);
  const later = driveFeatures(3, { start: 40 }).map((feature) => feature);
  const laterImages = later.map((feature, i) => {
    feature.properties.TIDSPUNKT = new Date(
      Date.parse(feature.properties.TIDSPUNKT) + 3_600_000 + i,
    ).toISOString();
    return normalizeImage(feature);
  });
  const lone = normalizeImage(vegbilderFeature({ lane: '2', meter: 10 }));
  const { sequences, overview } = linesFromImages([
    ...gap,
    ...run,
    ...laterImages,
    lone,
  ]);
  assert.deepEqual(overview, []);
  assert.equal(
    sequences.length,
    3,
    'the gap and the hour-later pass make their own lines',
  );
  assert.ok(sequences.every((line) => line.parts[0].length >= 2));
  assert.equal(sequences[0].parts[0].length, 5);
  assert.equal(sequences[0].isPano, false);
  assert.equal(new Set(sequences.map((line) => line.id)).size, 3);
  assert.ok(
    sequences.every((line) => !line.id.includes('~')),
    'part suffixes stay free',
  );
});

test('a lane driven against the metering runs in the order it was taken', () => {
  const features = driveFeatures(4, { lane: '2' });
  const times = features
    .map((feature) => feature.properties.TIDSPUNKT)
    .reverse();
  const against = features.map((feature, i) => {
    feature.properties.TIDSPUNKT = times[i];
    return normalizeImage(feature);
  });
  const pass = passOf(against[2], against);
  assert.deepEqual(
    pass.map((image) => image.meter),
    [30, 20, 10, 0],
  );
});

test('the drive filter pins road, lane and day, with a metre window', () => {
  const image = normalizeImage(vegbilderFeature({ meter: 100 }));
  const cql = driveFilter(image, 300);
  assert.match(cql, /VEGKATEGORI = 'R'/);
  assert.match(cql, /VEGNUMMER = 162/);
  assert.match(cql, /KRYSSDEL IS NULL/);
  assert.match(cql, /FELTKODE = '1'/);
  assert.match(
    cql,
    /TIDSPUNKT DURING 2025-06-19T00:00:00Z\/2025-06-20T00:00:00Z/,
  );
  assert.match(cql, /METER BETWEEN 0 AND 400/);
  const quoted = normalizeImage(vegbilderFeature());
  quoted.road.category = "E' OR 1=1";
  assert.match(
    driveFilter(quoted),
    /VEGKATEGORI = 'E'' OR 1=1'/,
    'quotes are escaped',
  );
});

test('the filter keeps photos by kind and capture time', () => {
  const flat = normalizeImage(vegbilderFeature());
  const pano = normalizeImage(vegbilderFeature({ pano: true }));
  assert.equal(
    passesVegbilderFilter(flat, { pano: 'pano', sinceMs: null }),
    false,
  );
  assert.equal(
    passesVegbilderFilter(pano, { pano: 'flat', sinceMs: null }),
    false,
  );
  assert.equal(
    passesVegbilderFilter(flat, { pano: 'all', sinceMs: Date.UTC(2025, 6, 1) }),
    false,
  );
  assert.equal(
    passesVegbilderFilter(flat, { pano: 'all', sinceMs: Date.UTC(2025, 5, 1) }),
    true,
  );
  assert.equal(passesVegbilderFilter(flat, null), true);
});
