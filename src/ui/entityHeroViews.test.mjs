// src/ui/entityHeroViews.test.mjs — which top image a card shows for each
// kind of item, and which views its switch offers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { onTileMap } from './mapTiles.js';
import {
  HERO_AUTOPLAY_MS,
  HERO_READY_WAIT_MS,
  heroKindOf,
  heroModelReady,
  heroViews,
  nextHeroView,
  shownHeroView,
} from './entityHeroViews.js';

// The fleet's own catalog and type map, every model's bytes standing in.
const read = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../../public/models/fleet/${name}`, import.meta.url),
      'utf8',
    ),
  );
const catalog = read('catalog.json');
const set = {
  catalog,
  types: read('types.json'),
  bytes: new Map(Object.keys(catalog).map((name) => [name, new Uint8Array(1)])),
};

const SUBJECTS = {
  aircraft: {
    fleet: 'aircraft',
    typeCode: 'A320',
    category: null,
    callsign: 'DAL123',
  },
  military: {
    fleet: 'aircraft',
    typeCode: 'F16',
    category: null,
    callsign: null,
  },
  vessel: {
    fleet: 'vessel',
    type: 'Cargo',
    mmsi: '366999999',
    virtual: false,
    length: null,
    beam: null,
    name: 'EVER GIVEN',
  },
  transit: { fleet: 'transit', mode: 'bus', routeType: null },
  rail: { fleet: 'transit', railCategory: 'regional', railMode: 'rail' },
};

test('every kind drawn with a fleet model has one for its card', () => {
  for (const [kind, subject] of Object.entries(SUBJECTS))
    assert.equal(heroModelReady(subject, { set }), true, kind);
  assert.equal(
    heroModelReady(null, { set }),
    false,
    'a satellite, a fire, a camera: no model',
  );
  assert.equal(
    heroModelReady({ ...SUBJECTS.vessel, virtual: true }, { set }),
    false,
    'a virtual aid to navigation is drawn without one',
  );
  assert.equal(
    heroModelReady({ fleet: 'spacecraft' }, { set }),
    false,
    'an unknown table',
  );
});

test('a model whose bytes failed to load, or with no set at all, is not offered; one still loading is', () => {
  const missing = { ...set, bytes: new Map() };
  assert.equal(heroModelReady(SUBJECTS.vessel, { set: missing }), false);
  assert.equal(
    heroModelReady(SUBJECTS.vessel, {}),
    false,
    'no layer loaded the set',
  );
  assert.equal(
    heroModelReady(SUBJECTS.vessel, { loading: Promise.resolve(set) }),
    true,
    'the view waits for the set',
  );
});

test('the top image per kind: anything with a model leads with the model views', () => {
  const at = { position: true };
  assert.equal(
    heroKindOf({ kind: 'aircraft', layerId: 'flights', model: true, ...at }),
    'flight',
  );
  assert.equal(
    heroKindOf({ kind: 'aircraft', layerId: 'military', model: true, ...at }),
    'flight',
  );
  assert.equal(
    heroKindOf({ kind: 'aircraft', layerId: 'flights', ...at }),
    'map',
    'no photo, route or model: the close-up map',
  );
  assert.equal(
    heroKindOf({
      kind: 'vessel',
      layerId: 'ais-live-vessels',
      model: true,
      ...at,
    }),
    'model',
  );
  assert.equal(
    heroKindOf({
      kind: 'vessel',
      layerId: 'ais-live-vessels',
      model: true,
      photo: true,
      ...at,
    }),
    'model',
    'the photo is one of its views',
  );
  assert.equal(
    heroKindOf({
      kind: 'vessel',
      layerId: 'ais-live-vessels',
      photo: true,
      ...at,
    }),
    'photo',
    'its model failed: the photo alone',
  );
  assert.equal(
    heroKindOf({ kind: 'vessel', layerId: 'ais-live-vessels', ...at }),
    'map',
  );
  assert.equal(
    heroKindOf({ kind: 'train', layerId: 'rail', model: true, ...at }),
    'model',
  );
  assert.equal(
    heroKindOf({ kind: 'satellite', layerId: 'satellites', ...at }),
    'satellite',
    'a satellite keeps the ground beneath it',
  );
  assert.equal(
    heroKindOf({ kind: 'camera', layerId: 'cctv', ...at }),
    'camera',
  );
  assert.equal(
    heroKindOf({ kind: 'street photo', layerId: 'street-level', ...at }),
    'street',
  );
  assert.equal(
    heroKindOf({
      kind: 'place',
      layerId: 'picked-place',
      placeStreet: true,
      ...at,
    }),
    'place-street',
  );
  assert.equal(heroKindOf({ kind: 'feature', layerId: 'news' }), 'none');
});

test('a photo, else the model, shows until another view is picked or reached', () => {
  const vessel = heroViews({ model: true, position: true });
  assert.deepEqual(vessel, ['model', 'map']);
  assert.equal(shownHeroView(vessel), 'model');
  assert.equal(shownHeroView(vessel, 'map'), 'map');

  const flight = heroViews({
    route: true,
    model: true,
    cockpit: true,
    position: true,
  });
  assert.deepEqual(flight, ['route', 'model', 'cockpit', 'map']);
  assert.equal(shownHeroView(flight), 'model', 'the model leads the route');
  assert.equal(shownHeroView(flight, 'cockpit'), 'cockpit');

  const photographed = heroViews({ photo: true, model: true, position: true });
  assert.deepEqual(photographed, ['photo', 'model', 'map']);
  assert.equal(shownHeroView(photographed), 'photo', 'a photo leads');
  assert.equal(shownHeroView(photographed, 'model'), 'model');
});

test('a view the item no longer has gives way to the first', () => {
  const flight = heroViews({ route: true, model: false, position: true });
  assert.equal(shownHeroView(flight, 'model'), 'route');
  assert.equal(
    shownHeroView(heroViews({ model: false, position: true }), 'model'),
    'map',
  );
  assert.equal(shownHeroView(heroViews({})), null);
});

test('the views take turns in the switch order, round to the first', () => {
  const views = ['photo', 'route', 'model', 'cockpit', 'map'];
  assert.equal(nextHeroView(views, 'photo'), 'route');
  assert.equal(nextHeroView(views, 'cockpit'), 'map');
  assert.equal(
    nextHeroView(views, 'map'),
    'photo',
    'after the last, the first',
  );
  assert.equal(nextHeroView(views, 'gone'), 'photo');
  assert.equal(nextHeroView(['map'], 'map'), 'map');
  assert.equal(nextHeroView([], null), null);
});

test('a view shows for about six seconds once drawn', () => {
  assert.equal(HERO_AUTOPLAY_MS, 6000);
  assert.ok(HERO_READY_WAIT_MS > HERO_AUTOPLAY_MS);
});

test('past the tile map’s ±85.05° an item has no close-up map', () => {
  const fire = { kind: 'fire', layerId: 'local-firms', position: true };
  assert.equal(heroKindOf({ ...fire, mapped: false }), 'none');
  assert.equal(heroKindOf(fire), 'map');
  assert.equal(
    heroKindOf({ layerId: 'satellites', position: true, mapped: false }),
    'satellite',
  );
  assert.equal(onTileMap(85.05), true);
  assert.equal(onTileMap(85.06), false);
  assert.equal(onTileMap(-89), false);
});
