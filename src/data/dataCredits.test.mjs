import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_CREDITS, OURAIRPORTS_CREDIT } from './dataCredits.js';

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

test('OurAirports is credited even though its license does not require it', () => {
  // Public domain: "no need to credit us, though we appreciate it". The
  // courtesy credit is also the only place a reader can see WHICH database a
  // frequency came from, so it is not optional in practice.
  assert.ok(OURAIRPORTS_CREDIT.key);
  assert.match(OURAIRPORTS_CREDIT.html, /OurAirports/);
  assert.match(OURAIRPORTS_CREDIT.html, /public domain/);
  assert.match(
    OURAIRPORTS_CREDIT.html,
    /href="https:\/\/ourairports\.com\/data\/"/,
  );
  assert.ok(
    !DATA_CREDITS.some((entry) => entry.key === OURAIRPORTS_CREDIT.key),
    'a lazily registered credit must not also sit in the always-on list',
  );
});
