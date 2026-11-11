import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import { ICONIC_TINTS, WILDLIFE_SPRITE_PX } from './policy.js';
import {
  WILDLIFE_SPRITE_GROUPS,
  WILDLIFE_SPRITE_ICONIC,
  WILDLIFE_BADGE_GLYPHS,
  WILDLIFE_BADGE_OUTLINE_PX,
  createWildlifeSpriteCache,
  wildlifeSpriteCache,
  wildlifeSpriteGroup,
} from './sprites.js';

const sprites = wildlifeSpriteCache();

test('every taxon group has an explicit Material Symbol and tinted circle fallback', () => {
  assert.equal(Object.isFrozen(WILDLIFE_BADGE_GLYPHS), true);
  assert.deepEqual(WILDLIFE_BADGE_GLYPHS, {
    bird: 'raven',
    mammal: 'pets',
    reptile: 'egg_alt',
    amphibian: 'water_drop',
    fish: 'set_meal',
    insect: 'bug_report',
    arachnid: 'pest_control',
    plant: 'eco',
    fungus: 'umbrella',
    other: 'category',
    unknown: 'question_mark',
  });
  const textures = new Set();
  for (const group of WILDLIFE_SPRITE_GROUPS) {
    const texture = sprites.get(group);
    textures.add(texture);
    assert.equal(wildlifeSpriteGroup(WILDLIFE_SPRITE_ICONIC[group]), group);
    assert.equal(sprites.get(WILDLIFE_SPRITE_ICONIC[group]), texture);
    assert.equal(sprites.get(group), texture);
    const svg = decodeURIComponent(texture.slice(texture.indexOf(',') + 1));
    assert.match(svg, /<circle /);
    assert.ok(
      svg.includes(`fill="${ICONIC_TINTS[WILDLIFE_SPRITE_ICONIC[group]]}"`),
    );
    assert.match(svg, /stroke="#040c10"/);
    assert.match(svg, /stroke-width="1.5"/);
    assert.doesNotMatch(svg, /<path|<text|<image|href=|<script|<foreignObject/);
  }
  assert.equal(textures.size, Object.keys(ICONIC_TINTS).length);
});

test('unknown taxon keys share the slate fallback without allocating textures', () => {
  for (const value of [
    undefined,
    null,
    'Unknown',
    'Synthetic kingdom',
    '__proto__',
    'constructor',
    'toString',
  ]) {
    assert.equal(wildlifeSpriteGroup(value), 'unknown');
    assert.equal(sprites.get(value), sprites.get('unknown'));
  }
  assert.equal(sprites.get('Mollusca'), sprites.get('other'));
});

test('canvas badges wait for the icon font, paint once and notify existing consumers', async () => {
  let resolveFont;
  let fontLoads = 0;
  const canvases = [];
  const documentRef = {
    fonts: {
      load(font, glyphs) {
        fontLoads += 1;
        assert.match(font, /Material Symbols Outlined/);
        for (const glyph of Object.values(WILDLIFE_BADGE_GLYPHS))
          assert.ok(glyphs.includes(glyph));
        return new Promise((resolve) => {
          resolveFont = resolve;
        });
      },
    },
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const commands = [];
      const ctx = {
        scale(...args) {
          commands.push(['scale', ...args]);
        },
        beginPath() {},
        arc(...args) {
          commands.push(['arc', ...args]);
        },
        fill() {
          commands.push(['fill', this.fillStyle]);
        },
        stroke() {
          commands.push(['stroke', this.strokeStyle, this.lineWidth]);
        },
        fillText(...args) {
          commands.push(['text', this.fillStyle, this.font, ...args]);
        },
      };
      const canvas = { commands, getContext: () => ctx };
      canvases.push(canvas);
      return canvas;
    },
  };
  const cache = createWildlifeSpriteCache({ documentRef });
  const fallback = cache.get('Aves');
  let notifications = 0;
  const unsubscribe = cache.subscribe(() => {
    notifications += 1;
  });
  const loading = cache.load();
  assert.equal(cache.load(), loading);
  await Promise.resolve();
  assert.equal(fontLoads, 1);
  assert.equal(canvases.length, 0, 'no glyph is rasterized in a fallback font');
  assert.equal(cache.get('Aves'), fallback);
  resolveFont([{}]);
  assert.equal(await loading, true);
  assert.equal(notifications, 1);
  assert.equal(canvases.length, WILDLIFE_SPRITE_GROUPS.length);
  for (const group of WILDLIFE_SPRITE_GROUPS) {
    const canvas = cache.get(group);
    assert.equal(canvas, cache.get(WILDLIFE_SPRITE_ICONIC[group]));
    assert.equal(canvas.width, WILDLIFE_SPRITE_PX * 2);
    assert.equal(canvas.height, WILDLIFE_SPRITE_PX * 2);
    assert.deepEqual(
      canvas.commands.find(([op]) => op === 'fill'),
      ['fill', ICONIC_TINTS[WILDLIFE_SPRITE_ICONIC[group]]],
    );
    assert.deepEqual(
      canvas.commands.find(([op]) => op === 'stroke'),
      ['stroke', '#040c10', WILDLIFE_BADGE_OUTLINE_PX],
    );
    const glyph = canvas.commands.find(([op]) => op === 'text');
    assert.equal(glyph[1], '#ffffff');
    assert.match(glyph[2], /Material Symbols Outlined/);
    assert.equal(glyph[3], WILDLIFE_BADGE_GLYPHS[group]);
  }
  await cache.load();
  assert.equal(canvases.length, WILDLIFE_SPRITE_GROUPS.length);
  unsubscribe();
});

test('unavailable font keeps plain badges and does not paint a ligature word', async () => {
  const cache = createWildlifeSpriteCache({
    documentRef: {
      fonts: { load: async () => [] },
      createElement() {
        assert.fail('no canvas before the icon font is ready');
      },
    },
  });
  const fallback = cache.get('Aves');
  assert.equal(await cache.load(), false);
  assert.equal(cache.get('Aves'), fallback);
});

async function visiblePixels(texture, size) {
  const svg = texture.includes(';base64,')
    ? Buffer.from(texture.slice(texture.indexOf(',') + 1), 'base64')
    : Buffer.from(decodeURIComponent(texture.slice(texture.indexOf(',') + 1)));
  const { data, info } = await sharp(svg)
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let pixels = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (Math.max(data[i], data[i + 1], data[i + 2]) > 150 && data[i + 3] > 127)
      pixels += 1;
  return pixels;
}

test('compact badge fill remains legible at its near and far footprints', async () => {
  assert.equal(WILDLIFE_SPRITE_PX, 20);
  for (const size of [12, 16, WILDLIFE_SPRITE_PX, 22]) {
    const flightPixels = await visiblePixels(aircraftIcon('airliner'), size);
    for (const group of WILDLIFE_SPRITE_GROUPS)
      assert.ok(
        (await visiblePixels(sprites.get(group), size)) >= flightPixels,
        `${group} at ${size}px`,
      );
  }
});
