import { test } from 'node:test';
import assert from 'node:assert/strict';
import rome from './data/rome.json' with { type: 'json' };
import paris from './data/paris.json' with { type: 'json' };
import tokyo from './data/tokyo.json' with { type: 'json' };
import {
  boxesOverlap,
  matchTourQuery,
  normalizeTour,
  pickScript,
  pointInBox,
  slugifyTourId,
  tourBounds,
  transitConnectiveTemplates,
} from './tourSchema.js';

test('authored tours normalize with unique transit scripts', () => {
  const tours = [rome, paris, tokyo].map((raw) => normalizeTour(raw));
  for (const tour of tours) {
    assert.ok(tour.beats.length >= 7, tour.id);
    assert.ok(tour.beats.some((beat) => beat.kind === 'establish'));
    assert.ok(tour.beats.some((beat) => beat.kind === 'hold'));
    assert.ok(tour.beats.some((beat) => beat.kind === 'transit'));
    const used = new Set();
    const transitLines = tour.beats.filter((beat) => beat.kind === 'transit').map((beat) => pickScript(beat, used));
    assert.equal(new Set(transitLines).size, transitLines.length, `${tour.id} transit lines must not repeat`);
  }
  assert.equal(matchTourQuery(tours, 'show me a tour of Rome')?.id, 'rome');
  assert.equal(matchTourQuery(tours, 'tokyo')?.cityId, 'tokyo');
});

test('slugify and bbox overlap treat nested places as geographic', () => {
  assert.equal(slugifyTourId('Commercial Drive'), 'commercial-drive');
  const vancouver = { west: -123.27, east: -123.02, south: 49.2, north: 49.32 };
  const drive = { west: -123.08, east: -123.05, south: 49.27, north: 49.29 };
  const stanley = { west: -123.16, east: -123.12, south: 49.29, north: 49.32 };
  assert.equal(boxesOverlap(vancouver, drive), true);
  assert.equal(pointInBox(49.275, -123.069, drive), true);
  assert.equal(pointInBox(49.3, -123.14, drive), false);
  assert.ok(tourBounds({
    beats: [{ place: { lat: 49.28, lon: -123.07 } }, { place: { lat: 49.26, lon: -123.06 } }],
  }));
  assert.ok(transitConnectiveTemplates('transit').length >= 3);
});
