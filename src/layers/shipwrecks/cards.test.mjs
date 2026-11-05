import test from 'node:test';
import assert from 'node:assert/strict';
import { describeShipwreck, positionLine } from './cards.js';
import { EMODNET_PAGE_URL } from './records.js';

test('a Wikidata card shows the ship facts and links its article', () => {
  const card = describeShipwreck({
    source: 'wikidata',
    alsoIn: 'emodnet',
    name: 'HMS Havant',
    vesselType: 'destroyer',
    date: '1940-06-01',
    year: 1940,
    cause: 'Was sunk on 06/01/1940 by the German air force',
    casualties: 8,
    survivors: 120,
    depth: 14.72,
    depthQuality: 'Least depth known',
    positionAccuracy: 3.1,
    notes: '1939 G and H-class destroyer',
    country: 'France',
    url: 'https://en.wikipedia.org/wiki/HMS_Havant_(H32)',
  });
  assert.equal(card.title, 'Shipwreck · HMS Havant');
  assert.equal(card.link, 'https://en.wikipedia.org/wiki/HMS_Havant_(H32)');
  const text = card.details.join('\n');
  assert.equal(card.details[0], 'Fatalities: 8 · Survivors: 120');
  assert.match(card.details[1], /1940 · France$/);
  assert.match(text, /Vessel: destroyer/);
  assert.match(text, /What happened: Was sunk/);
  assert.match(text, /Depth: 15 m \(Least depth known\)/);
  assert.match(text, /Position surveyed \(within about 3\.1 m\)/);
  assert.match(text, /Source: Wikidata · EMODnet/);
  assert.match(text, /open the article/);
});

test('an EMODnet card without a page links the portal', () => {
  const card = describeShipwreck({
    source: 'emodnet',
    name: null,
    year: null,
    dating: 'C1st AD',
    originator: 'The Oxford Roman Economy Project',
    protected: true,
    url: null,
  });
  assert.equal(card.title, 'Shipwreck');
  assert.equal(card.link, EMODNET_PAGE_URL);
  const text = card.details.join('\n');
  assert.equal(card.details[0], 'C1st AD');
  assert.match(text, /Protected wreck/);
  assert.match(text, /EMODnet \(The Oxford Roman Economy Project\)/);
  assert.match(text, /open EMODnet/);
});

test('position lines read the accuracy', () => {
  assert.equal(positionLine({}), null);
  assert.match(positionLine({ positionAccuracy: 1852 }), /about 1\.9 km/);
  assert.match(
    positionLine({ positionNote: 'x' }),
    /centre of the protected area/,
  );
});
