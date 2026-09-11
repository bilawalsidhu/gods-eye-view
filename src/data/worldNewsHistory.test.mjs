import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_DESK_ERA_START,
  WORLD_DESK_ERA_END,
  WORLD_DESK_HISTORY,
  eventActiveInYear,
  eventsVisibleOnPlayhead,
  filterWorldDeskEvents,
  formatWorldDeskYear,
} from './worldNewsHistory.js';

test('catalog spans 5000 years and includes the requested desks', () => {
  assert.equal(WORLD_DESK_ERA_START, -3000);
  assert.ok(WORLD_DESK_ERA_END >= 2026);
  assert.ok(WORLD_DESK_HISTORY.length >= 200);
  const cats = new Set(WORLD_DESK_HISTORY.map((row) => row.category));
  for (const id of ['calamity', 'war', 'prophet', 'saint', 'birth', 'death']) {
    assert.ok(cats.has(id), `missing ${id}`);
  }
  assert.ok(WORLD_DESK_HISTORY.some((row) => /Shankara/i.test(row.title)));
  const years = WORLD_DESK_HISTORY.map((row) => row.year);
  assert.ok(Math.min(...years) <= -2500);
  assert.ok(Math.max(...years) >= 2022);
});

test('year formatting and range filters', () => {
  assert.equal(formatWorldDeskYear(-2560), '2560 BCE');
  assert.equal(formatWorldDeskYear(1969), '1969 CE');
  assert.equal(eventActiveInYear({ year: 1939, yearEnd: 1945 }, 1942), true);
  assert.equal(eventActiveInYear({ year: 1939, yearEnd: 1945 }, 1914), false);
  const wars = filterWorldDeskEvents(WORLD_DESK_HISTORY, { categories: ['war'] });
  assert.ok(wars.length > 20);
  assert.ok(wars.every((row) => row.category === 'war'));
  const at79 = eventsVisibleOnPlayhead(WORLD_DESK_HISTORY, 79, 40);
  assert.ok(at79.some((row) => /Pompeii|Vesuvius/i.test(row.title)));
});
