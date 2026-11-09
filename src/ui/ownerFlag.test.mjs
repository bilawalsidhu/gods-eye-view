// src/ui/ownerFlag.test.mjs — a satellite owner's mark: a country's flag with
// its localized name, a text badge for an organisation, nothing when unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFlagUrl,
  ownerMark,
  regionName,
  shownOwnerMark,
} from './ownerFlag.js';

const FLAG = (code) => `/node_modules/flag-icons/flags/4x3/${code}.svg`;
const LOADERS = Object.freeze({
  [FLAG('us')]: async () => '/assets/us-abc.svg',
  [FLAG('fr')]: async () => '/assets/fr-def.svg',
});

test('an owner country shows its flag, named in the reader language', () => {
  assert.deepEqual(
    ownerMark({ countryCode: 'us', label: 'USA' }, { loaders: LOADERS }),
    { kind: 'flag', code: 'US', label: 'United States' },
  );
  assert.equal(
    ownerMark(
      { countryCode: 'FR', label: null },
      { locale: 'de', loaders: LOADERS },
    ).label,
    'Frankreich',
  );
});

test('an organisation without a country shows a text badge', () => {
  assert.deepEqual(
    ownerMark({ countryCode: null, label: 'ESA' }, { loaders: LOADERS }),
    { kind: 'badge', label: 'ESA', title: 'ESA' },
  );
});

test('a country with no flag to show falls back to a badge', () => {
  assert.deepEqual(
    ownerMark({ countryCode: 'DE', label: 'Germany' }, { loaders: LOADERS }),
    { kind: 'badge', label: 'Germany', title: 'Germany' },
  );
  // Natural Earth and UCS write -99 or names, never a flag code.
  assert.deepEqual(
    ownerMark(
      { countryCode: '-99', label: 'Multinational' },
      { loaders: LOADERS },
    ),
    { kind: 'badge', label: 'Multinational', title: 'Multinational' },
  );
});

test('an unknown owner shows nothing', () => {
  assert.equal(ownerMark(null, { loaders: LOADERS }), null);
  assert.equal(
    ownerMark({ countryCode: null, label: '  ' }, { loaders: LOADERS }),
    null,
  );
});

test('only the flag asked for loads', async () => {
  assert.equal(await loadFlagUrl('US', LOADERS), '/assets/us-abc.svg');
  assert.equal(await loadFlagUrl('DE', LOADERS), null);
  assert.equal(
    await loadFlagUrl('FR', {
      [FLAG('fr')]: async () => {
        throw new Error('offline');
      },
    }),
    null,
  );
});

test('a region name comes from Intl, never the bare code', () => {
  assert.equal(regionName('JP', 'en'), 'Japan');
  assert.equal(regionName('XX', 'en'), null);
});

test('a flag that will not load falls back to its country code, never to nothing', () => {
  const flag = { kind: 'flag', code: 'us', label: 'United States' };
  assert.equal(shownOwnerMark(flag), null, 'nothing while it loads');
  assert.deepEqual(shownOwnerMark(flag, { url: '/flags/us.svg' }), {
    kind: 'flag',
    url: '/flags/us.svg',
    label: 'United States',
  });
  assert.deepEqual(shownOwnerMark(flag, { failed: true }), {
    kind: 'badge',
    label: 'US',
    title: 'United States',
  });
  const badge = { kind: 'badge', label: 'ESA', title: 'ESA' };
  assert.equal(shownOwnerMark(badge, { failed: true }), badge);
  assert.equal(shownOwnerMark(null), null);
});

test('flags ship as a map of URLs, not one JS chunk per flag', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('./ownerFlag.js', import.meta.url),
    'utf8',
  );
  // A lazy glob emits a stub chunk for each of ~270 flags; eager URLs ship
  // only strings, and each SVG still loads when an <img> shows it.
  assert.match(source, /eager:\s*true/);
  assert.match(source, /query:\s*'\?url&no-inline'/);
});
