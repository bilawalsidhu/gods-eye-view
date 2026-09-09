import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWarscopeCardDetails,
  compactEventTitle,
  compactSourceLink,
  createWarscopeOverlayEntry,
  eventOverlayPriority,
  selectWarscopeOverlayCohort,
} from './warscopeCards.js';

const SAMPLE_EVENT = Object.freeze({
  id: 'gdelt-1',
  title: 'Battles in Ukraine',
  eventType: 'Battles',
  subEventType: 'Armed clash',
  country: 'Ukraine',
  region: 'Donetsk',
  date: '2026-08-29',
  notes: 'Reported clash near the contact line.',
  source: 'GDELT Project',
  sourceUrl: 'https://example.com/story',
  fatalities: 2,
  quality: 0.82,
});

test('warscope card helpers format collapsed and expanded detail lines', () => {
  const collapsed = buildWarscopeCardDetails(SAMPLE_EVENT, false);
  assert.match(collapsed.join('|'), /Click card to expand/);
  assert.doesNotMatch(collapsed.join('|'), /Open source/);

  const expanded = buildWarscopeCardDetails(SAMPLE_EVENT, true);
  assert.match(expanded.join('|'), /Open source: example\.com\/story/);
  assert.match(expanded.join('|'), /Click card to collapse/);
  assert.match(expanded.join('|'), /Reported clash/);
});

test('warscope overlay entry stays a text card with optional outbound activate', () => {
  const position = { x: 1, y: 2, z: 3 };
  const collapsed = createWarscopeOverlayEntry({
    event: SAMPLE_EVENT,
    position,
    expanded: false,
  });
  assert.equal(collapsed.variant, 'card');
  assert.equal(collapsed.interactive, true);
  assert.equal(typeof collapsed.activate, 'function');
  assert.equal(collapsed.image, undefined);

  const expanded = createWarscopeOverlayEntry({
    event: SAMPLE_EVENT,
    position,
    expanded: true,
  });
  assert.equal(expanded.variant, 'card');
  assert.match(expanded.details.join('|'), /Open source/);
});

test('warscope cohort keeps expanded cards and highest-priority ambient cards', () => {
  const entries = [
    { id: 'a', priority: 10 },
    { id: 'b', priority: 900 },
    { id: 'c', priority: 800 },
    { id: 'd', priority: 50 },
  ];
  const cohort = selectWarscopeOverlayCohort(entries, new Set(['a']), 3);
  assert.deepEqual(cohort.map((entry) => entry.id), ['a', 'b', 'c']);
});

test('warscope overlay priority boosts expanded cards above ambient peers', () => {
  const base = eventOverlayPriority(SAMPLE_EVENT, false);
  const expanded = eventOverlayPriority(SAMPLE_EVENT, true);
  assert.ok(expanded > base);
  assert.equal(compactEventTitle('x'.repeat(80), 10).length, 10);
  assert.equal(compactSourceLink('https://news.example/path/to/article'), 'news.example/path/to/article');
});
