import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QLD_ROAD_EVENT_STYLES,
  buildQldRoadEventCard,
  qldRoadEventGlyph,
  qldRoadEventStyle,
  wrapCardLine,
} from './cards.js';
import { QLD_ROAD_EVENT_CATEGORIES } from './records.js';

const NOW = Date.parse('2026-09-28T02:00:00Z');
const event = {
  id: '830652',
  category: 'crash',
  type: 'Crash',
  subtype: 'Single vehicle',
  dueTo: null,
  priority: 'Medium',
  description: 'Exit 41',
  advice: 'Proceed with caution',
  road: 'Pacific Motorway',
  locality: 'Yatala',
  localGovernmentArea: 'Gold Coast City',
  direction: 'Northbound',
  towards: 'Brisbane',
  impactType: 'Lanes affected',
  impactSubtype: 'Lane or lanes reduced',
  delay: 'Delays expected',
  startMs: Date.parse('2026-09-27T20:00:00Z'),
  lastUpdatedMs: NOW - 25 * 60000,
  providedBy: 'Department of Transport and Main Roads',
  anchor: [153.239, -27.755],
};

test('every category has a style and a distinct cached glyph', () => {
  const uris = new Set();
  for (const category of QLD_ROAD_EVENT_CATEGORIES) {
    assert.ok(QLD_ROAD_EVENT_STYLES[category], category);
    const uri = qldRoadEventGlyph(category);
    assert.match(uri, /^data:image\/svg\+xml,/);
    assert.equal(qldRoadEventGlyph(category), uri);
    uris.add(uri);
  }
  assert.equal(uris.size, QLD_ROAD_EVENT_CATEGORIES.length);
  assert.equal(qldRoadEventGlyph('nope'), qldRoadEventGlyph('other'));
  assert.equal(qldRoadEventStyle('nope'), QLD_ROAD_EVENT_STYLES.other);
});

test('roadworks are subdued relative to incidents', () => {
  const works = QLD_ROAD_EVENT_STYLES.roadworks;
  for (const category of ['crash', 'flooding', 'hazard']) {
    const style = QLD_ROAD_EVENT_STYLES[category];
    assert.ok(style.rank > works.rank);
    assert.ok(style.scale > works.scale);
    assert.ok(style.lineAlpha > works.lineAlpha);
  }
  assert.equal(works.dashed, true);
});

test('the card carries type, road, impact, advice, age and the QLDTraffic link', () => {
  const card = buildQldRoadEventCard(event, NOW);
  assert.equal(card.id, 'qld-road-event-card:830652');
  assert.equal(card.title, 'CRASH · Pacific Motorway');
  assert.equal(card.accent, QLD_ROAD_EVENT_STYLES.crash.color);
  assert.equal(card.interactive, true);
  assert.match(card.accessibilityLabel, /QLDTraffic/);
  for (const line of card.details) assert.ok(line.length <= 64, line);
  assert.deepEqual(card.details.slice(0, 2), [
    'Single vehicle · Medium priority',
    'Pacific Motorway · Yatala · Gold Coast City',
  ]);
  const text = card.details.join(' ');
  assert.ok(
    text.includes(
      'Northbound towards Brisbane · Lane or lanes reduced · Delays expected',
    ),
  );
  assert.ok(text.includes('Exit 41 Advice: Proceed with caution'));
  assert.match(
    text,
    /updated 25m ago · since 28 Sep.* 2026 · Department of Transport and Main Roads/,
  );
  assert.equal(card.details.at(-1), 'QLDTraffic ↗ · click card to open');
});

test('a sparse event still produces a readable card', () => {
  const card = buildQldRoadEventCard(
    { id: 'x', category: 'other', lastUpdatedMs: null, startMs: null },
    NOW,
  );
  assert.equal(card.title, 'OTHER · Queensland road');
  assert.deepEqual(card.details, ['QLDTraffic ↗ · click card to open']);
});

test('long card lines wrap so the card stays narrow', () => {
  const streets =
    'Castlemaine Street / Caxton Street / Hale Street / Milton Road · Milton / Paddington / Petrie Terrace · Brisbane City';
  const card = buildQldRoadEventCard(
    {
      id: 'wide',
      category: 'special-event',
      type: 'Special event',
      road: 'Castlemaine Street / Caxton Street / Hale Street / Milton Road',
      locality: 'Milton / Paddington / Petrie Terrace',
      description: streets,
    },
    Date.now(),
  );
  assert.ok(card.title.length <= 64);
  for (const line of card.details) assert.ok(line.length <= 64, line);
  assert.equal(
    card.details.join(' ').includes('Brisbane City'),
    true,
    'wrapping keeps every word',
  );
});

test('wrapCardLine breaks at words and hard-cuts a single over-long word', () => {
  assert.deepEqual(wrapCardLine('aa bb cc', 5), ['aa bb', 'cc']);
  assert.deepEqual(wrapCardLine('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapCardLine('   ', 10), []);
  assert.deepEqual(wrapCardLine('short', 64), ['short']);
});
