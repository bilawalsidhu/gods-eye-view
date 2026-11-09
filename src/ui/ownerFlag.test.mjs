// src/ui/ownerFlag.test.mjs — a satellite owner's mark: a country's flag with
// its localized name, drawn from the owner flag sheet; a text badge for an
// organisation; nothing when unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OWNER_COUNTRY_CODES } from '../layers/satellites/classes.js';
import { OWNER_FLAG_SHEET } from './ownerFlagSheet.js';
import {
  OWNER_FLAG_SHEET_URL,
  ownerFlagStyle,
  ownerMark,
  preloadOwnerFlags,
  regionName,
  shownOwnerMark,
} from './ownerFlag.js';

test('an owner country shows its flag, named in the reader language', () => {
  assert.deepEqual(ownerMark({ countryCode: 'us', label: 'USA' }), {
    kind: 'flag',
    code: 'US',
    label: 'United States',
  });
  assert.equal(
    ownerMark({ countryCode: 'FR', label: null }, { locale: 'de' }).label,
    'Frankreich',
  );
});

test('an organisation without a country shows a text badge', () => {
  assert.deepEqual(ownerMark({ countryCode: null, label: 'ESA' }), {
    kind: 'badge',
    label: 'ESA',
    title: 'ESA',
  });
});

test('a country with no flag on the sheet falls back to a badge', () => {
  assert.deepEqual(
    ownerMark(
      { countryCode: 'DE', label: 'Germany' },
      { flags: new Set(['US']) },
    ),
    { kind: 'badge', label: 'Germany', title: 'Germany' },
  );
  // Natural Earth and UCS write -99 or names, never a flag code.
  assert.deepEqual(ownerMark({ countryCode: '-99', label: 'Multinational' }), {
    kind: 'badge',
    label: 'Multinational',
    title: 'Multinational',
  });
});

test('an unknown owner shows nothing', () => {
  assert.equal(ownerMark(null), null);
  assert.equal(ownerMark({ countryCode: null, label: '  ' }), null);
});

test('a region name comes from Intl, never the bare code', () => {
  assert.equal(regionName('JP', 'en'), 'Japan');
  assert.equal(regionName('XX', 'en'), null);
});

test('the sheet holds every owner country a satellite can be marked with', () => {
  assert.deepEqual([...OWNER_FLAG_SHEET.codes], [...OWNER_COUNTRY_CODES]);
  assert.equal(
    OWNER_FLAG_SHEET.rows,
    Math.ceil(OWNER_FLAG_SHEET.codes.length / OWNER_FLAG_SHEET.columns),
  );
  // The PNG is as large as its layout says (width and height at bytes 16-23).
  const png = readFileSync(new URL(OWNER_FLAG_SHEET_URL));
  const { cellWidthPx, cellHeightPx, gutterPx } = OWNER_FLAG_SHEET;
  assert.equal(
    png.readUInt32BE(16),
    OWNER_FLAG_SHEET.columns * (cellWidthPx + gutterPx),
  );
  assert.equal(
    png.readUInt32BE(20),
    OWNER_FLAG_SHEET.rows * (cellHeightPx + gutterPx),
  );
});

test('a flag is drawn from its cell of the sheet, at the size asked', () => {
  // 40 × 30 sheet cells with a 2 px gutter, drawn at 20 × 15: each cell and
  // its gutter is 21 × 16 CSS pixels.
  assert.equal(OWNER_FLAG_SHEET.cellWidthPx, 40);
  assert.equal(OWNER_FLAG_SHEET.cellHeightPx, 30);
  assert.equal(OWNER_FLAG_SHEET.gutterPx, 2);
  const columns = OWNER_FLAG_SHEET.columns;
  const index = OWNER_FLAG_SHEET.codes.indexOf('US');
  const style = ownerFlagStyle('US');
  assert.equal(style.backgroundImage, `url("${OWNER_FLAG_SHEET_URL}")`);
  assert.equal(
    style.backgroundSize,
    `${columns * 21}px ${OWNER_FLAG_SHEET.rows * 16}px`,
  );
  assert.equal(
    style.backgroundPosition,
    `${-(index % columns) * 21}px ${-Math.floor(index / columns) * 16}px`,
  );
  // The first flag sits at the corner.
  assert.equal(
    ownerFlagStyle(OWNER_FLAG_SHEET.codes[0]).backgroundPosition,
    '0px 0px',
  );
  assert.equal(ownerFlagStyle('XX'), null);
});

test('the flag shows once the sheet is ready; a failed sheet shows the code', () => {
  const flag = { kind: 'flag', code: 'US', label: 'United States' };
  assert.equal(shownOwnerMark(flag), null, 'nothing while it loads');
  assert.deepEqual(shownOwnerMark(flag, { ready: true }), {
    kind: 'flag',
    style: ownerFlagStyle('US'),
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

test('the sheet loads once; a failed load is asked again', async () => {
  const images = [];
  const createImage = () => {
    const image = { onload: null, onerror: null, src: '' };
    images.push(image);
    return image;
  };
  const first = preloadOwnerFlags({ createImage });
  assert.equal(images.length, 1);
  assert.equal(images[0].src, OWNER_FLAG_SHEET_URL);
  assert.equal(preloadOwnerFlags({ createImage }), first, 'one load at a time');
  images[0].onerror();
  assert.equal(await first, false);
  const second = preloadOwnerFlags({ createImage });
  assert.equal(images.length, 2, 'asked again after a failure');
  images[1].onload();
  assert.equal(await second, true);
  assert.equal(preloadOwnerFlags({ createImage }), second, 'kept once loaded');
  assert.equal(images.length, 2);
});
