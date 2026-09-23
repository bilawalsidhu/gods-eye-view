import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_CREDITS } from './dataCredits.js';

test('every credit carries a unique key and some markup to render', () => {
  const keys = DATA_CREDITS.map((entry) => entry.key);
  assert.equal(
    new Set(keys).size,
    keys.length,
    'a duplicate key would silently shadow one provider’s credit',
  );
  for (const entry of DATA_CREDITS) {
    assert.ok(entry.key, 'a credit without a key cannot be registered');
    assert.ok(
      entry.html && entry.html.trim().length > 0,
      `credit ${entry.key} has nothing to show`,
    );
  }
});

test('adsbdb is credited and carries its published route-data restriction', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'adsbdb');
  assert.ok(
    credit,
    'adsbdb supplies aircraft type and routes and must be credited',
  );
  // adsbdb publishes this restriction for its route data. Pin the provider's
  // credits and restriction here so a later edit cannot silently remove them.
  assert.match(credit.html, /David Taylor, Edinburgh/);
  assert.match(credit.html, /Jim Mason, Glasgow/);
  assert.match(
    credit.html,
    /may not be\s+copied, published, or incorporated into other databases/,
  );
  assert.match(credit.html, /explicit permission of David J Taylor, Edinburgh/);
  assert.match(credit.html, /PlaneBase/);
  assert.match(credit.html, /Guillaume Michel/);
  assert.match(credit.html, /href="https:\/\/www\.adsbdb\.com"/);
});

test('the repeater tables name both feeds and refuse to imply coverage', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'hamrig-repeaters');
  assert.ok(
    credit,
    'the Repeaters layer ships directory data and must credit it',
  );
  // Both upstream feeds are named because their provenance differs: the FM
  // table is a historic import, the D-STAR rows are a scrape. Pin the wording
  // so neither feed, nor the "not radio coverage" caveat, can quietly go away.
  assert.match(credit.html, /href="https:\/\/hamrig\.com"/);
  assert.match(credit.html, /historic import/);
  assert.match(credit.html, /hearham\.com/);
  assert.match(credit.html, /dstarinfo\.com/);
  assert.match(credit.html, /ircddb\.net/);
  assert.match(credit.html, /directory data, not radio coverage/);
});
