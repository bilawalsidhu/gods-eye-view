import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_CREDITS, XWEATHER_CREDIT } from './dataCredits.js';

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

test('Xweather is credited with the linked text its attribution guide gives', () => {
  // https://www.xweather.com/docs/weather-api/resources/attribution asks for
  // "Powered by Vaisala Xweather" linked to https://www.xweather.com/.
  assert.equal(XWEATHER_CREDIT.key, 'xweather');
  assert.match(
    XWEATHER_CREDIT.html,
    /^<a href="https:\/\/www\.xweather\.com\/" [^>]*>Powered by Vaisala Xweather<\/a>$/,
  );
});
