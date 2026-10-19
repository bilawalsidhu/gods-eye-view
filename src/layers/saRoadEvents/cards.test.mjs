import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SA_ROAD_EVENT_KIND_LABELS,
  buildSaRoadEventCard,
  feedUpdatedText,
  formatAdelaideClock,
  formatAdelaideDateTime,
  roadEventColor,
  wrapCardLine,
} from './cards.js';
import {
  normalizeSaRoadEventLines,
  normalizeSaRoadEventPoints,
} from './records.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../data/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
const points = normalizeSaRoadEventPoints(
  fixture('trafficsa-points-sample.json'),
).records;
const lines = normalizeSaRoadEventLines(
  fixture('trafficsa-lines.json'),
).records;
// 2026-10-13 04:50 UTC is 15:20 in Adelaide (ACDT, daylight time).
const NOW = Date.UTC(2026, 9, 13, 4, 50);

test('kind colours are distinct per kind and fall back to grey', () => {
  const colors = ['incident', 'works24', 'works', 'detour', 'unknown'].map(
    roadEventColor,
  );
  assert.equal(new Set(colors).size, colors.length);
  assert.equal(roadEventColor('incident'), '#ff3b30');
  assert.equal(roadEventColor('closure'), roadEventColor('incident'));
  assert.equal(roadEventColor('nonsense'), roadEventColor('unknown'));
  assert.equal(roadEventColor(undefined), roadEventColor('unknown'));
  for (const color of colors) assert.match(color, /^#[0-9a-f]{6}$/);
  for (const kind of Object.keys(SA_ROAD_EVENT_KIND_LABELS))
    assert.ok(roadEventColor(kind));
});

test('times are Adelaide local time with the right daylight abbreviation', () => {
  assert.equal(formatAdelaideClock(NOW), '15:20 ACDT');
  assert.equal(formatAdelaideClock(Date.UTC(2026, 6, 1, 3, 5)), '12:35 ACST');
  assert.equal(formatAdelaideClock(NaN), null);
  assert.equal(formatAdelaideClock(null), null);
  // Daylight saving starts on Sunday 4 Oct 2026 at 02:00 ACST.
  assert.equal(
    formatAdelaideDateTime(Date.UTC(2026, 9, 1, 9, 30), NOW),
    'Thu 01 Oct 07:00 PM ACST',
  );
  assert.equal(
    formatAdelaideDateTime(Date.UTC(2026, 9, 5, 9, 30), NOW),
    'Mon 05 Oct 08:00 PM ACDT',
  );
  assert.equal(
    formatAdelaideDateTime(Date.UTC(2026, 9, 5, 0, 0), NOW),
    'Mon 05 Oct 10:30 AM ACDT',
    'midday and midnight hours use a 12 hour clock',
  );
  assert.equal(
    formatAdelaideDateTime(1756756800000, NOW),
    'Tue 02 Sep 2025 05:30 AM ACST',
    'a year other than the current one is shown',
  );
  assert.equal(formatAdelaideDateTime(undefined, NOW), null);
});

test('the feed line states the time and flags stale data', () => {
  assert.equal(feedUpdatedText(NOW), 'Feed updated 15:20 ACDT');
  assert.match(feedUpdatedText(NOW, true), /^Feed updated 15:20 ACDT · STALE/);
  assert.equal(feedUpdatedText(null), 'Feed time unavailable');
});

test('a point card carries kind, place, traffic facts, times and the feed time', () => {
  const works = points.find(({ id }) => id === '3398487791');
  const card = buildSaRoadEventCard(works, {
    nowMs: NOW,
    feedUpdatedMs: NOW,
    stale: false,
  });
  assert.equal(card.id, 'sa-road-event-card:point:3398487791');
  assert.equal(card.title, 'ROADWORKS · Findon Road');
  assert.equal(card.accent, roadEventColor('works'));
  assert.equal(card.selected, true);
  assert.equal(card.interactive, false);
  for (const line of card.details) assert.ok(line.length <= 64, line);
  const text = card.details.join(' ');
  assert.match(text, /Aerial Cabling/);
  assert.match(text, /Findon Road at Patricia St · Woodville South/);
  assert.match(
    text,
    /Direction: South Bound · Lanes closed: One Lane · Speed limit: 40 km\/h/,
  );
  assert.match(text, /Start: Mon 05 Oct 09:00 AM ACDT/);
  assert.match(text, /End: Mon 19 Oct 04:00 PM ACDT/);
  assert.equal(card.details.at(-1), 'Feed updated 15:20 ACDT');
});

test('an incident with no end time and no direction still reads cleanly', () => {
  const incident = points.find(({ kind }) => kind === 'incident');
  const card = buildSaRoadEventCard(incident, {
    nowMs: NOW,
    feedUpdatedMs: NOW,
    stale: true,
  });
  assert.equal(card.title, 'INCIDENT · Birdsville Track');
  const text = card.details.join(' ');
  assert.match(text, /Ferry Closed/);
  assert.match(text, /End: not published/);
  assert.ok(!text.includes('Direction'));
  assert.ok(!text.includes('Speed limit'));
  assert.match(card.details.at(-1), /^Feed updated 15:20 ACDT · STALE/);
});

test('a line card reads start to end streets and keeps the CRLF details readable', () => {
  const closure = lines.find(({ id }) => id === '105527');
  const card = buildSaRoadEventCard(closure, {
    nowMs: NOW,
    feedUpdatedMs: NOW,
  });
  assert.equal(card.id, 'sa-road-event-card:line:105527');
  assert.equal(card.title, 'ROAD CLOSURE · MORGAN VALE ROAD');
  assert.equal(card.accent, roadEventColor('closure'));
  const text = card.details.join(' ');
  assert.match(text, /MORGAN MAIL RD Closed due to flooding over road/);
  assert.match(
    text,
    /From PINE VALLEY RD \(PINE VALLEY STATION\) to MORGAN MAIL RD \(CANEGRASS\)/,
  );
  assert.match(text, /End: not published/);
  assert.ok(!text.includes('\r'));
  assert.ok(card.details.every((line) => !line.includes('\n')));
});

test('cards are text only: markup in a record is never turned into elements', () => {
  const card = buildSaRoadEventCard(
    {
      id: 'x',
      kind: 'incident',
      description: '<img src=x onerror=alert(1)> & "quotes"',
      road: '<b>Road</b>',
      startMs: null,
      endMs: null,
    },
    { nowMs: NOW, feedUpdatedMs: NOW },
  );
  for (const line of [card.title, ...card.details])
    assert.equal(typeof line, 'string');
  assert.ok(card.details.join(' ').includes('<img src=x onerror=alert(1)>'));
  assert.equal(JSON.stringify(card).includes('innerHTML'), false);
});

test('a sparse record and a very long description stay bounded', () => {
  const sparse = buildSaRoadEventCard(
    { id: 's', kind: 'weird', startMs: null, endMs: null },
    { nowMs: NOW },
  );
  assert.equal(sparse.title, 'OTHER · South Australia');
  assert.deepEqual(sparse.details, [
    'End: not published',
    'Feed time unavailable',
  ]);
  const long = buildSaRoadEventCard(
    {
      id: 'l',
      kind: 'incident',
      description: 'word '.repeat(1000),
      road: 'R'.repeat(200),
      startMs: null,
      endMs: null,
    },
    { nowMs: NOW, feedUpdatedMs: NOW },
  );
  assert.ok(long.title.length <= 64);
  assert.ok(long.details.length <= 14);
  for (const line of long.details) assert.ok(line.length <= 64, line);
});

test('wrapCardLine breaks at words and hard-cuts a single over-long word', () => {
  assert.deepEqual(wrapCardLine('aa bb cc', 5), ['aa bb', 'cc']);
  assert.deepEqual(wrapCardLine('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapCardLine('   ', 10), []);
  assert.deepEqual(wrapCardLine('short', 64), ['short']);
});
