import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTour,
  budgetShots,
  densestCell,
  describePlace,
  pickHighlights,
  resolveTheme,
  shotCountFor,
  TOUR_SCENE_ID,
} from './tourBuilder.js';
import {
  parseSceneDocument,
  SCENE_DOCUMENT_VERSION,
  stringifySceneDocument,
} from '../director/document.js';

const CAMERA = { lat: 30.27, lon: -97.74, alt: 12_000, heading: 20, pitch: -40, roll: 0 };

/** Wrap a scene the way the Director stores it and run the document validator. */
function validate(scene) {
  const stamp = '2026-09-16T00:00:00.000Z';
  return parseSceneDocument(
    stringifySceneDocument({
      version: SCENE_DOCUMENT_VERSION,
      createdAt: stamp,
      updatedAt: stamp,
      installedBuiltInSceneIds: [],
      scenes: [scene],
    }),
  );
}

function flights({ dfw = 12, atl = 4 } = {}) {
  const rows = [];
  for (let i = 0; i < dfw; i++)
    rows.push({
      id: `DFW${i}`,
      icao24: `a${i}`,
      callsign: `AAL${100 + i}`,
      operator: i % 3 ? 'American Airlines' : 'Southwest',
      lat: 32.85 + i * 0.01,
      lon: -97.3 + i * 0.01,
      altitudeM: 3000 + i * 500,
      speedMps: 150 + i,
      heading: 90,
      onGround: false,
      military: false,
      routeOrigin: 'DFW',
      routeDestination: 'LAX',
    });
  for (let i = 0; i < atl; i++)
    rows.push({
      id: `ATL${i}`,
      icao24: `b${i}`,
      callsign: `DAL${i}`,
      operator: 'Delta',
      lat: 33.6 + i * 0.02,
      lon: -84.4,
      altitudeM: 9000,
      speedMps: 200,
      heading: 0,
      onGround: false,
    });
  rows.push({ id: 'GROUND', icao24: 'g1', callsign: 'AAL1', lat: 32.9, lon: -97.05, altitudeM: 0, onGround: true });
  rows.push({ id: 'UAL1234', icao24: 'u1', callsign: 'UAL1234', operator: 'United', lat: 32.95, lon: -97.02, altitudeM: 11_600, speedMps: 240, heading: 270, onGround: false });
  return rows;
}

test('resolveTheme maps spoken phrases to theme keys', () => {
  assert.equal(resolveTheme('busiest airspace right now'), 'airspace');
  assert.equal(resolveTheme('the harbor'), 'ships');
  assert.equal(resolveTheme('wildfires in California'), 'fires');
  assert.equal(resolveTheme('earthquakes'), 'quakes');
  assert.equal(resolveTheme('military jets'), 'military');
  assert.equal(resolveTheme('around here'), 'view');
  assert.equal(resolveTheme(''), 'airspace');
  assert.equal(resolveTheme('quakes'), 'quakes');
});

test('densestCell picks the 1° cell with the most airborne records', () => {
  const cell = densestCell(flights());
  assert.equal(cell.cellCount, 13);
  assert.equal(cell.count, 13);
  assert.ok(Math.abs(cell.lat - 32.9) < 0.2 && Math.abs(cell.lon + 97.2) < 0.2);
  assert.equal(densestCell([]), null);
  assert.equal(densestCell([{ id: 'x', lat: 1, lon: 1, onGround: true }]), null);
});

test('describePlace names the nearest hub, then the caller, then coordinates', () => {
  assert.equal(describePlace(32.9, -97.05), 'Dallas–Fort Worth');
  assert.equal(describePlace(-45, 10, () => 'Somewhere'), 'Somewhere');
  assert.equal(describePlace(-45.04, 10.06), '45.0°S 10.1°E');
});

test('pickHighlights leads with the highest aircraft and then varies operators', () => {
  const picks = pickHighlights('airspace', flights(), 3);
  assert.equal(picks[0].callsign, 'UAL1234');
  assert.equal(new Set(picks.map((r) => r.icao24)).size, 3);
  const operators = new Set(picks.map((r) => r.operator));
  assert.ok(operators.size >= 2);
  const ships = pickHighlights('ships', [
    { id: 'a', mmsi: '1', name: 'SLOW', lat: 1, lon: 1, speedKts: 3, shipType: 'Tanker' },
    { id: 'b', mmsi: '2', name: 'FAST', lat: 1, lon: 1, speedKts: 20, shipType: 'Cargo' },
    { id: 'c', mmsi: '3', name: 'MID', lat: 1, lon: 1, speedKts: 10, shipType: 'Cargo' },
  ], 2);
  assert.deepEqual(ships.map((r) => r.name), ['FAST', 'SLOW']);
});

test('budgetShots spends exactly the requested seconds across 4-8 shots', () => {
  assert.equal(shotCountFor(10), 4);
  assert.equal(shotCountFor(60), 6);
  assert.equal(shotCountFor(300), 8);
  for (const seconds of [10, 45, 60, 100]) {
    const kinds = Array.from({ length: shotCountFor(seconds) }, (_, i) =>
      i === 0 ? 'establishing' : i === 1 ? 'sweep' : 'highlight',
    );
    const timing = budgetShots(kinds, seconds);
    const total = timing.reduce((s, t) => s + t.durationSec + t.holdSec, 0);
    assert.ok(Math.abs(total - seconds) < 0.05, `${seconds}s -> ${total}`);
    for (const t of timing) {
      assert.ok(t.durationSec >= 0.2);
      assert.ok(t.holdSec >= 0.3);
    }
  }
});

test('airspace tour frames the densest cell, narrates the highest aircraft and validates', () => {
  const tour = buildTour({
    theme: 'busiest airspace',
    seconds: 60,
    records: { flights: flights() },
    camera: CAMERA,
    visual: { style: 'normal' },
  });
  assert.equal(tour.ok, true);
  assert.equal(tour.theme, 'airspace');
  assert.equal(tour.layer, 'flights');
  assert.equal(tour.place, 'Dallas–Fort Worth');
  assert.equal(tour.fallback, null);
  assert.equal(tour.scene.id, TOUR_SCENE_ID);
  assert.equal(tour.scene.shots.length, 6);
  assert.equal(tour.durationSec, 60);
  assert.match(
    tour.narration[0].line,
    /^Now over Dallas–Fort Worth: 13 aircraft within 60 km; the highest is United UAL1234 at 11600 m\.$/,
  );
  assert.match(tour.narration[1].line, /^Sweeping Dallas–Fort Worth/);
  assert.match(tour.narration[2].line, /United UAL1234: 11600 m, 864 km\/h, heading west/);
  assert.match(tour.narration.at(-1).line, /13 aircraft in one frame/);
  const sweep = tour.scene.shots[1];
  assert.equal(sweep.move.easing, 'cubic-in-out');
  assert.equal(sweep.camera.altitudeReference, 'ellipsoid');
  assert.equal(sweep.move.from.altitudeReference, 'ellipsoid');
  for (const shot of tour.scene.shots) {
    assert.deepEqual(shot.layers, { flights: { enabled: true } });
    assert.deepEqual(shot.visual, { style: 'normal' });
    assert.ok(shot.camera.alt > 50);
  }
  const wide = tour.scene.shots[0].camera;
  assert.ok(wide.alt > 100_000 && wide.pitch < -50);
  const highlight = tour.scene.shots[2].camera;
  assert.ok(highlight.alt > 11_600 && highlight.alt < 16_000);
  assert.equal(tour.highlights[0].id, 'u1');
  assert.doesNotThrow(() => validate(tour.scene));
});

test('ships, fires and quakes themes pick their layers and validate', () => {
  const ships = buildTour({
    theme: 'harbor',
    seconds: 40,
    records: {
      'ais-live-vessels': Array.from({ length: 9 }, (_, i) => ({
        id: `V${i}`,
        mmsi: `${1000 + i}`,
        name: i ? `SHIP ${i}` : 'EVER FAST',
        lat: 51.9 + i * 0.01,
        lon: 4.4 + i * 0.01,
        speedKts: i ? 8 : 18,
        shipType: i % 2 ? 'Cargo' : 'Tanker',
        destination: 'ROTTERDAM',
        courseDeg: 45,
      })),
    },
  });
  assert.equal(ships.ok, true);
  assert.equal(ships.layer, 'ais-live-vessels');
  assert.equal(ships.place, 'Rotterdam');
  assert.equal(ships.scene.shots.length, 4);
  assert.match(ships.narration[0].line, /9 vessels within 60 km; the fastest is EVER FAST at 18 knots/);
  assert.match(ships.narration[1].line, /most are bound for ROTTERDAM/);
  assert.doesNotThrow(() => validate(ships.scene));

  const fires = buildTour({
    theme: 'fires',
    seconds: 50,
    records: {
      'local-firms': [
        { id: 'F1', lat: 34.1, lon: -118.4, frp: 120, satellite: 'VIIRS' },
        { id: 'F2', lat: 34.15, lon: -118.45, frp: 40 },
      ],
    },
  });
  assert.equal(fires.layer, 'local-firms');
  assert.match(fires.narration[0].line, /2 fire detections within 60 km; the strongest burns at 120 megawatts/);
  assert.match(fires.narration[2].line, /Hotspot at 120 megawatts seen by VIIRS/);
  assert.doesNotThrow(() => validate(fires.scene));

  const now = Date.parse('2026-09-16T12:00:00Z');
  const quakes = buildTour({
    theme: 'earthquakes',
    seconds: 45,
    now,
    records: {
      earthquakes: [
        { id: 'Q1', lat: 35.7, lon: 139.7, magnitude: 5.2, depthKm: 30, timeMs: now - 90 * 60000, place: 'Chiba' },
        { id: 'Q2', lat: 35.6, lon: 139.8, magnitude: 3.1, depthKm: 10, timeMs: now - 5 * 60000 },
      ],
    },
  });
  assert.equal(quakes.layer, 'earthquakes');
  assert.equal(quakes.place, 'Tokyo');
  assert.match(quakes.narration[0].line, /the largest is magnitude 5.2/);
  assert.match(quakes.narration[2].line, /^Magnitude 5.2 near Chiba, 30 km deep, 2 hours ago\.$/);
  assert.doesNotThrow(() => validate(quakes.scene));
});

test('empty data falls back to an orbit of the current view, and to an error with no camera', () => {
  const tour = buildTour({ theme: 'airspace', seconds: 30, records: {}, camera: CAMERA });
  assert.equal(tour.ok, true);
  assert.equal(tour.theme, 'view');
  assert.equal(tour.layer, null);
  assert.equal(tour.fallback, 'no-data');
  assert.equal(tour.scene.shots.length, 4);
  assert.equal(tour.durationSec, 30);
  assert.deepEqual(tour.scene.shots[0].layers, {});
  assert.equal(tour.scene.shots[0].camera.alt, 12_000);
  assert.ok(tour.scene.shots.slice(1).every((shot) => shot.move?.from));
  assert.match(tour.narration[0].line, /^Orbiting /);
  assert.doesNotThrow(() => validate(tour.scene));

  const withNearby = buildTour({
    theme: 'view',
    seconds: 30,
    camera: CAMERA,
    records: { flights: [{ id: 'X', icao24: 'x', lat: 30.3, lon: -97.7, altitudeM: 5000 }] },
  });
  assert.equal(withNearby.fallback, null);
  assert.match(withNearby.narration[0].line, /1 aircraft within 100 km/);

  const nothing = buildTour({ theme: 'ships', seconds: 30, records: {}, camera: null });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.fallback, 'no-data');
  assert.match(nothing.error, /No live records/);
});

test('the time budget is clamped and the shot count follows it', () => {
  const short = buildTour({ theme: 'airspace', seconds: 3, records: { flights: flights() } });
  assert.equal(short.durationSec, 8);
  assert.equal(short.scene.shots.length, 4);
  const long = buildTour({ theme: 'airspace', seconds: 120, records: { flights: flights() } });
  assert.equal(long.durationSec, 120);
  assert.equal(long.scene.shots.length, 8);
  assert.equal(new Set(long.scene.shots.map((s) => s.id)).size, 8);
  assert.doesNotThrow(() => validate(long.scene));
});

test('airspace falls back to military records when flights are empty', () => {
  const tour = buildTour({
    theme: 'airspace',
    seconds: 40,
    records: {
      flights: [],
      military: [
        { id: 'RCH1', icao24: 'm1', callsign: 'RCH1', lat: 38.8, lon: -77.0, altitudeM: 8000, heading: 10, military: true },
        { id: 'RCH2', icao24: 'm2', callsign: 'RCH2', lat: 38.9, lon: -77.1, altitudeM: 9000, heading: 10, military: true },
      ],
    },
  });
  assert.equal(tour.layer, 'military');
  assert.equal(tour.place, 'Washington DC');
  assert.match(tour.narration[1].line, /2 military contacts/);
});
