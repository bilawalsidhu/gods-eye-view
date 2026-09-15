import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLEET_SCREEN_PX,
  TRANSIT_ICON_KINDS,
  haloFrame,
  transitIcon,
  transitIconCacheSize,
} from './transitIcons.js';

const decode = (uri) =>
  Buffer.from(uri.replace('data:image/svg+xml;base64,', ''), 'base64').toString(
    'utf8',
  );

test('a halo is sized in screen pixels and pads the frame so it cannot clip', () => {
  const none = haloFrame(0);
  assert.deepEqual(none, { units: 0, pad: 0, ratio: 1 });
  const two = haloFrame(2, FLEET_SCREEN_PX);
  // Two pixels of ring on an eighteen-pixel glyph is a 4-px stroke: 21.3 of 96 units.
  assert.ok(Math.abs(two.units - (4 * 96) / 20) < 1e-9);
  assert.ok(
    two.pad >= two.units / 2,
    'padding covers the half-stroke outside the body',
  );
  assert.ok(two.ratio > 1, 'and the billboard grows by the same ratio');
});

test('a haloed glyph draws the dark ring under the shipped white body', () => {
  const plain = decode(transitIcon('bus'));
  const haloed = decode(transitIcon('bus', 48, { haloScreenPx: 2 }));
  assert.notEqual(plain, haloed);
  assert.match(
    haloed,
    /stroke="#000000" stroke-opacity="1" stroke-width="13\.71"/,
  );
  assert.ok(
    haloed.indexOf('#000000') < haloed.indexOf('fill="white"'),
    'ring first, body on top',
  );
  assert.match(haloed, /viewBox="-\d+ -\d+ \d+ \d+"/, 'padded frame');
  assert.match(plain, /stroke-width="9\.60"/, 'normal has a one-pixel halo');
});

test('the raster cache is bounded by kind, size and halo — never by call count', () => {
  const before = transitIconCacheSize();
  for (let i = 0; i < 50; i += 1) {
    transitIcon('tram', 48, { haloScreenPx: 2 });
    transitIcon('tram', 48);
    transitIcon('tram', 128, { haloScreenPx: 1.25 });
  }
  assert.ok(
    transitIconCacheSize() - before <= 3,
    `three variants, not ${transitIconCacheSize() - before}`,
  );
  assert.equal(
    transitIcon('tram', 48, { haloScreenPx: 2 }),
    transitIcon('tram', 48, { haloScreenPx: 2 }),
  );
  for (const kind of TRANSIT_ICON_KINDS)
    transitIcon(kind, 48, { haloScreenPx: 2 });
  assert.ok(transitIconCacheSize() <= before + 3 + TRANSIT_ICON_KINDS.length);
});

test('all 36 variants retain the specified final halo at both display sizes', async () => {
  const { presetSpriteScale, presetSpriteOutlinePx } =
    await import('./transitPresetStyle.js');
  for (const kind of TRANSIT_ICON_KINDS) {
    for (const selected of [false, true]) {
      for (const style of ['normal', 'thermal', 'retro']) {
        const display =
          (selected ? 30 : 20) * presetSpriteScale(style, selected);
        const svg = decode(transitIcon(kind, selected ? 96 : 48, { style }));
        const units = Number(
          svg.match(/stroke-opacity="(?:0.95|1)" stroke-width="([\d.]+)"/)[1],
        );
        assert.ok(
          Math.abs(
            (units * display) / 192 - presetSpriteOutlinePx(style, selected),
          ) < 0.001,
        );
        const frame = haloFrame(
          presetSpriteOutlinePx(style, selected),
          display,
        );
        assert.match(
          svg,
          new RegExp(
            `width="${Math.round((selected ? 96 : 48) * frame.ratio)}"`,
          ),
        );
      }
    }
  }
  for (let i = 0; i < 100; i++)
    transitIcon('invalid', i, { haloScreenPx: i, screenPx: i });
  assert.equal(transitIconCacheSize(), 36);
});

test('sensor bodies cover sixty percent of the padded display with opaque white', async () => {
  const sharp = (await import('sharp')).default;
  const { presetSpriteScale, presetSpriteOutlinePx } =
    await import('./transitPresetStyle.js');
  for (const selected of [false, true])
    for (const kind of TRANSIT_ICON_KINDS) {
      const display =
        (selected ? 30 : 20) * presetSpriteScale('thermal', selected);
      assert.equal(display, selected ? 36 : 28);
      assert.equal(presetSpriteOutlinePx('thermal', selected), 2);
      const svg = decode(
        transitIcon(kind, selected ? 96 : 48, { style: 'thermal' }),
      );
      const frame = haloFrame(2, display);
      const width = Math.round(display * frame.ratio);
      const { data, info } = await sharp(Buffer.from(svg))
        .resize(width, width)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let white = 0;
      for (let i = 0; i < data.length; i += 4)
        if (
          data[i] >= 240 &&
          data[i + 1] >= 240 &&
          data[i + 2] >= 240 &&
          data[i + 3] >= 240
        )
          white++;
      assert.ok(
        white / (info.width * info.height) >= 0.6,
        `${kind}/${display}: white ${white / (info.width * info.height)}`,
      );
      const c = (Math.floor(width / 2) * width + Math.floor(width / 2)) * 4;
      assert.deepEqual([...data.subarray(c, c + 4)], [255, 255, 255, 255]);
    }
});
