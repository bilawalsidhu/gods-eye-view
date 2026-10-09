import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPINE_STATIONS_INLINE_CREDIT,
  DATA_CREDITS,
  NYC_DOT_DISCLAIMER,
  hideAlpineStationsCredit,
  showAlpineStationsCredit,
} from './dataCredits.js';
import { ALPINE_NETWORKS } from '../layers/alpineStations/networks.js';

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

test('the NYC camera credit carries NYC DOT’s requested disclaimer', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'nyc-cctv');
  assert.ok(credit, 'NYC DOT camera frames must be credited');
  assert.ok(credit.html.includes(NYC_DOT_DISCLAIMER));
  assert.match(credit.html, /make no representation as to the accuracy/);
  assert.match(credit.html, /observe posted signage/);
});

test('every Street Level imagery source is in the attribution lightbox', () => {
  for (const key of [
    'mapillary',
    'google-street-view',
    'kartaview',
    'panoramax',
  ])
    assert.ok(
      DATA_CREDITS.some((entry) => entry.key === key),
      `${key} has no credit`,
    );
});

test('every Alpine station network is credited, with its licence and caveat', () => {
  // CC BY is a licence condition, not a courtesy: the credit lightbox is the
  // app's canonical attribution surface, so a network on screen without an
  // entry here is a licence breach rather than a cosmetic gap.
  const credit = DATA_CREDITS.find((entry) => entry.key === 'alpine-stations');
  assert.ok(credit, 'the layer has no attribution entry');
  for (const network of ALPINE_NETWORKS) {
    assert.ok(
      credit.html.includes(network.attribution),
      `${network.id} is not credited`,
    );
    assert.ok(credit.html.includes(network.homepage), `${network.id} homepage`);
  }
  assert.match(credit.html, /creativecommons\.org\/licenses\/by\/4\.0/);
  assert.match(credit.html, /CC BY 4\.0/);
  // Snow depth is a measurement; the operators' avalanche bulletins are a
  // separate product this layer does not reproduce.
  assert.match(credit.html, /not avalanche danger ratings/);
  for (const link of credit.html.matchAll(/<a [^>]*>/g))
    assert.match(link[0], /rel="noopener"/, link[0]);
});

test('the credited networks are exactly the ones the layer can draw', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'alpine-stations');
  const mentioned = ALPINE_NETWORKS.filter((network) =>
    credit.html.includes(network.attribution),
  );
  assert.equal(mentioned.length, ALPINE_NETWORKS.length);
});

test('the Alpine credit rides the globe, is idempotent, and is released', () => {
  // SLF's terms require a clearly visible, linked reference while the data is
  // displayed. The lightbox entry stays; this is the on-globe half.
  const added = [];
  const removed = [];
  const viewer = {
    creditDisplay: {
      addStaticCredit: (credit) => added.push(credit),
      removeStaticCredit: (credit) => removed.push(credit),
    },
    scene: { requestRender() {} },
  };
  assert.equal(showAlpineStationsCredit(viewer), true);
  assert.equal(added.length, 1);
  assert.equal(
    showAlpineStationsCredit(viewer),
    false,
    'idempotent per viewer',
  );
  assert.equal(added.length, 1);
  assert.equal(hideAlpineStationsCredit(viewer), true);
  assert.deepEqual(removed, added);
  assert.equal(hideAlpineStationsCredit(viewer), false);
  // Two viewers keep their own credit.
  const other = {
    creditDisplay: { addStaticCredit: () => {}, removeStaticCredit: () => {} },
  };
  assert.equal(showAlpineStationsCredit(other), true);
  assert.equal(showAlpineStationsCredit(viewer), true);
  assert.equal(showAlpineStationsCredit(null), false, 'no viewer, no credit');
});

test('the on-globe credit links every operator, and names SLF in full', () => {
  // "a clearly visible reference to the data source (WSL Institute for Snow
  // and Avalanche Research SLF), in the case of digital products as link
  // (www.slf.ch)" — the wording is the requirement, so it is pinned.
  assert.match(
    ALPINE_STATIONS_INLINE_CREDIT,
    /WSL Institute for Snow and Avalanche Research SLF/,
  );
  assert.match(ALPINE_STATIONS_INLINE_CREDIT, /href="https:\/\/www\.slf\.ch\//);
  for (const operator of ['MeteoSwiss', 'GeoSphere Austria'])
    assert.ok(ALPINE_STATIONS_INLINE_CREDIT.includes(operator), operator);
  assert.match(ALPINE_STATIONS_INLINE_CREDIT, /CC BY 4\.0/);
  for (const link of ALPINE_STATIONS_INLINE_CREDIT.matchAll(/<a [^>]*>/g))
    assert.match(link[0], /rel="noopener"/, link[0]);
});
