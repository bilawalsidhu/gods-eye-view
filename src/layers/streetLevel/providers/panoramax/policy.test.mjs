import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLORS,
  PICK_PREFIX,
  isEquirectangular,
  licenseLabel,
  normalizeItem,
  panoramaxPictureUrl,
  panoramaxTimeMs,
} from './policy.js';
import { PROVIDER_COLORS } from '../../policy.js';
import { stacItem } from '../../../../testSupport/panoramaxFixtures.mjs';

test('Panoramax draws in its own orange, and every pick id starts pnx:', () => {
  assert.equal(COLORS.coverage, '#ff6f00');
  assert.equal(PROVIDER_COLORS.panoramax, '#ff6f00');
  for (const prefix of Object.values(PICK_PREFIX))
    assert.ok(prefix.startsWith('pnx:'));
  // One colour per source.
  assert.equal(
    new Set(Object.values(PROVIDER_COLORS)).size,
    Object.keys(PROVIDER_COLORS).length,
  );
});

test('capture times parse in the API’s ISO form, the tiles’ Postgres form, and as bare days', () => {
  assert.equal(
    panoramaxTimeMs('2023-12-12T07:54:47+00:00'),
    Date.UTC(2023, 11, 12, 7, 54, 47),
  );
  assert.equal(
    panoramaxTimeMs('2023-12-12 07:56:37+00'),
    Date.UTC(2023, 11, 12, 7, 56, 37),
  );
  assert.equal(
    panoramaxTimeMs('2025-08-13 07:45:51.98+00'),
    Date.UTC(2025, 7, 13, 7, 45, 51, 980),
  );
  // Microseconds are cut to what Date.parse reads.
  assert.equal(
    panoramaxTimeMs('2025-08-03T14:38:51.838000+00:00'),
    Date.UTC(2025, 7, 3, 14, 38, 51, 838),
  );
  // A sequence's day: its trailing "-11" is the day, not a UTC offset.
  assert.equal(panoramaxTimeMs('2025-08-11'), Date.UTC(2025, 7, 11));
  assert.equal(
    panoramaxTimeMs('2025-08-13 09:00:00+02'),
    Date.UTC(2025, 7, 13, 7),
  );
  for (const bad of ['', 'junk', '1970-01-01', null, 42])
    assert.equal(panoramaxTimeMs(bad), null, String(bad));
});

test('a STAC item becomes a picture: position, heading, 360°, licence, links and assets', () => {
  const photo = normalizeItem(
    stacItem({
      id: 'a',
      lon: 2.35,
      lat: 48.85,
      sequenceId: 's',
      heading: 370,
      pano: true,
      license: 'etalab-2.0',
      prevId: 'p',
      nextId: 'n',
    }),
  );
  assert.deepEqual(
    {
      id: photo.id,
      sequenceId: photo.sequenceId,
      lon: photo.lon,
      lat: photo.lat,
      heading: photo.heading,
      isPano: photo.isPano,
      license: photo.license,
      width: photo.width,
      prevId: photo.prevId,
      nextId: photo.nextId,
      creator: photo.creator,
    },
    {
      id: 'a',
      sequenceId: 's',
      lon: 2.35,
      lat: 48.85,
      heading: 10,
      isPano: true,
      license: 'Licence Ouverte 2.0',
      width: 5760,
      prevId: 'p',
      nextId: 'n',
      creator: 'tester',
    },
  );
  assert.equal(
    photo.urls.sd,
    'https://panoramax.example.org/pictures/a/sd.jpg',
  );
  assert.equal(photo.capturedAt, Date.UTC(2025, 5, 1, 10));
});

test('a picture without links, heading or a usable position', () => {
  const bare = normalizeItem({
    id: 7,
    geometry: { coordinates: [1, 2] },
    properties: {},
  });
  assert.equal(bare.id, '7');
  assert.equal(bare.heading, null);
  assert.equal(bare.prevId, null);
  assert.equal(bare.nextId, null);
  assert.equal(bare.sequenceId, null);
  assert.equal(bare.isPano, false);
  assert.equal(bare.capturedAt, null);
  assert.deepEqual(bare.urls, { thumb: null, sd: null, hd: null });
  for (const item of [
    null,
    { geometry: { coordinates: [1, 2] } },
    { id: 'x', geometry: { coordinates: ['a', 2] } },
    { id: 'x', geometry: { coordinates: [181, 2] } },
    { id: 'x', geometry: { coordinates: [1, 91] } },
    { id: 'x' },
  ])
    assert.equal(normalizeItem(item), null, JSON.stringify(item));
});

test('asset links that are not https are dropped', () => {
  const item = stacItem({ id: 'a', lon: 1, lat: 2 });
  item.assets.sd.href = 'http://insecure.example/sd.jpg';
  item.assets.hd.href = 'javascript:alert(1)';
  const photo = normalizeItem(item);
  assert.equal(photo.urls.sd, null);
  assert.equal(photo.urls.hd, null);
  assert.ok(photo.urls.thumb.startsWith('https://'));
});

test('an account named by an email address is not shown as the creator', () => {
  const named = (producer) =>
    normalizeItem(stacItem({ id: 'a', lon: 1, lat: 2, producer })).creator;
  assert.equal(named('someone@city.example.fr'), null);
  assert.equal(named('Robot8A'), 'Robot8A');
  assert.equal(named('  padded  '), 'padded');
  assert.equal(named('x'.repeat(200)).length, 80);
  // The producer role among the providers serves when the property is missing.
  const item = stacItem({ id: 'a', lon: 1, lat: 2 });
  delete item.properties['geovisio:producer'];
  item.providers = [
    { name: 'host', roles: ['host'] },
    { name: 'mapper', roles: ['producer'] },
  ];
  assert.equal(normalizeItem(item).creator, 'mapper');
});

test('360°: a full field of view, or the equirectangular projection', () => {
  assert.equal(
    isEquirectangular({
      properties: { 'pers:interior_orientation': { field_of_view: 360 } },
    }),
    true,
  );
  assert.equal(
    isEquirectangular({ properties: { 'pers:projection': 'equirectangular' } }),
    true,
  );
  assert.equal(
    isEquirectangular({
      properties: { 'pers:interior_orientation': { field_of_view: 92 } },
    }),
    false,
  );
  assert.equal(isEquirectangular(null), false);
});

test('licences read as the caption names them', () => {
  assert.equal(licenseLabel('CC-BY-SA-4.0'), 'CC BY-SA 4.0');
  assert.equal(licenseLabel('etalab-2.0'), 'Licence Ouverte 2.0');
  assert.equal(licenseLabel('CC0-1.0'), 'CC0');
  assert.equal(licenseLabel('ODbL-1.0'), 'ODbL-1.0');
  assert.equal(licenseLabel('proprietary'), null);
  assert.equal(licenseLabel(''), null);
  assert.equal(licenseLabel(undefined), null);
  assert.equal(licenseLabel('x'.repeat(100)).length, 40);
});

test('the caption link opens the picture in the Panoramax viewer', () => {
  assert.equal(
    panoramaxPictureUrl('d5467bbb-4357'),
    'https://api.panoramax.xyz/#pic=d5467bbb-4357&focus=pic',
  );
  assert.equal(panoramaxPictureUrl(''), 'https://api.panoramax.xyz/');
  assert.equal(panoramaxPictureUrl(null), 'https://api.panoramax.xyz/');
  assert.ok(panoramaxPictureUrl('a&b=c').includes('pic=a%26b%3Dc'));
});

test('hostile item data: a malformed link escape, null coordinates, a huge producer name', () => {
  const item = stacItem({ id: 'a', lon: 1, lat: 2, nextId: 'n' });
  item.links.push({
    rel: 'prev',
    href: 'https://api.panoramax.xyz/api/collections/s/items/%E0%A4%A',
  });
  const photo = normalizeItem(item);
  assert.equal(photo.prevId, null, 'no link, no throw');
  assert.equal(photo.nextId, 'n');
  for (const coordinates of [[null, null], ['', ''], ['2.35', '48.85'], [2.35]])
    assert.equal(
      normalizeItem({ id: 'x', geometry: { coordinates } }),
      null,
      JSON.stringify(coordinates),
    );
  // A million characters without spaces is checked in linear time.
  const started = Date.now();
  const huge = normalizeItem(
    stacItem({ id: 'a', lon: 1, lat: 2, producer: 'a'.repeat(1_000_000) }),
  );
  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
  assert.equal(huge.creator.length, 80);
  const named = (producer) =>
    normalizeItem(stacItem({ id: 'a', lon: 1, lat: 2, producer })).creator;
  assert.equal(named(`${'x'.repeat(200_000)}@example.org`), null);
  assert.equal(
    named('Carto@Cité'),
    'Carto@Cité',
    'an @ without a domain is a name',
  );
  // The address need not follow the first '@'.
  assert.equal(named('@team someone@example.org'), null);
  assert.equal(named('Carto@Cité (mapper@example.org)'), null);
  assert.equal(named(`${'@'.repeat(100_000)}x`), `${'@'.repeat(80)}`);
});

test('thousands of producers are credited in linear time', () => {
  const item = stacItem({ id: 'a', lon: 1, lat: 2 });
  item.providers = Array.from({ length: 50_000 }, (_, i) => ({
    name: `producer-${i}`,
    roles: ['producer'],
  }));
  const started = performance.now();
  const { creator } = normalizeItem(item);
  assert.ok(performance.now() - started < 1000);
  assert.ok(creator.startsWith('tester, producer-0, producer-1'));
  assert.ok(creator.length <= 120);
});

test('the instance holding a picture is named (its via host), never as its author', () => {
  const item = stacItem({
    id: 'a',
    lon: 1,
    lat: 2,
    producer: 'someone@ign.example.fr',
  });
  item.links.push({ rel: 'via', href: 'https://panoramax.ign.fr' });
  assert.equal(normalizeItem(item).creator, null);
  assert.equal(normalizeItem(item).via, 'panoramax.ign.fr');
  item.links.at(-1).href = 'http://insecure.example';
  assert.equal(normalizeItem(item).via, null);
  item.links.at(-1).href = 'not a url';
  assert.equal(normalizeItem(item).via, null);
});

test('every producer is credited once: the uploading app and its photographer', () => {
  const item = stacItem({ id: 'a', lon: 1, lat: 2, producer: 'mapcomplete' });
  item.providers = [
    { name: 'mapcomplete', roles: ['producer'] },
    { name: 'pyrog', roles: ['producer'] },
    { name: 'MapComplete', roles: ['producer'] },
    { name: 'someone@example.org', roles: ['producer'] },
    { name: 'host', roles: ['host'] },
  ];
  assert.equal(normalizeItem(item).creator, 'mapcomplete, pyrog');
  const hidden = stacItem({ id: 'b', lon: 1, lat: 2, producer: 'a@b.org' });
  hidden.providers = [{ name: 'c@d.org', roles: ['producer'] }];
  assert.equal(normalizeItem(hidden).creator, null);
  const many = stacItem({ id: 'c', lon: 1, lat: 2 });
  many.providers = Array.from({ length: 50 }, (_, i) => ({
    name: `producer-${i}`,
    roles: ['producer'],
  }));
  assert.ok(normalizeItem(many).creator.length <= 120);
});
