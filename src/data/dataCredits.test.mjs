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

test('OpenStreetMap has one generic data credit with separate tile and names distributors', () => {
  const osm = DATA_CREDITS.filter((entry) =>
    entry.html.includes('openstreetmap.org/copyright'),
  );
  assert.equal(osm.length, 1);
  assert.equal(osm[0].key, 'openstreetmap');
  assert.match(osm[0].html, /Map and place data/);
  assert.match(osm[0].html, /© OpenStreetMap contributors/);
  assert.match(
    DATA_CREDITS.find((entry) => entry.key === 'openfreemap').html,
    /Vector tiles:/,
  );
  assert.match(
    DATA_CREDITS.find((entry) => entry.key === 'overture-military-names').html,
    /Overture Maps Foundation/,
  );
});

test('inline OSM attribution persists until its last display owner leaves', async (t) => {
  const { showOsmCredit, hideOsmCredit } = await import('./dataCredits.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const visible = new Set();
  const viewer = {
    creditDisplay: {
      addStaticCredit: (c) => visible.add(c),
      removeStaticCredit: (c) => visible.delete(c),
    },
    scene: { requestRender() {} },
  };
  assert.equal(showOsmCredit(viewer, 'alpr'), true);
  assert.equal(showOsmCredit(viewer, 'alpr'), false);
  assert.equal(visible.size, 1);
  assert.match(
    [...visible][0].html,
    /href="https:\/\/www.openstreetmap.org\/copyright"/,
  );
  assert.match([...visible][0].html, />© OpenStreetMap</);
  assert.ok([...visible][0].showOnScreen);
  t.mock.timers.tick(60000);
  assert.equal(visible.size, 1);
  showOsmCredit(viewer, 'traffic', { openMapTiles: true });
  assert.equal(visible.size, 2);
  hideOsmCredit(viewer, 'alpr');
  assert.equal(visible.size, 2, 'traffic still owns both credits');
  showOsmCredit(viewer, 'datacenters');
  hideOsmCredit(viewer, 'traffic');
  assert.equal(
    visible.size,
    1,
    'bundled data does not retain the tile distributor',
  );
  hideOsmCredit(viewer, 'datacenters');
  assert.equal(visible.size, 0);
  assert.equal(hideOsmCredit(viewer, 'datacenters'), false);
  showOsmCredit(viewer, 'alpr');
  assert.equal(visible.size, 1, 'reenabling restores the short credit');
});

test('tile attribution follows source changes and viewers have independent ownership', async () => {
  const { showOsmCredit, hideOsmCredit } = await import('./dataCredits.js');
  const create = () => {
    const credits = new Set();
    return {
      credits,
      creditDisplay: {
        addStaticCredit: (c) => credits.add(c),
        removeStaticCredit: (c) => credits.delete(c),
      },
    };
  };
  const a = create(),
    b = create();
  showOsmCredit(a, 'installations', { openMapTiles: true });
  showOsmCredit(b, 'installations');
  assert.equal(a.credits.size, 2);
  assert.equal(b.credits.size, 1);
  showOsmCredit(a, 'installations');
  assert.equal(a.credits.size, 1, 'wide names no longer use tiles');
  hideOsmCredit(a, 'installations');
  assert.equal(a.credits.size, 0);
  assert.equal(b.credits.size, 1);
});
