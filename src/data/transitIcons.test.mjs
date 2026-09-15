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
    /stroke="#05080C" stroke-opacity="1" stroke-width="14\.77"/,
  );
  assert.ok(
    haloed.indexOf('#05080C') < haloed.indexOf('fill="white"'),
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

test('every mono raster preserves the normal silhouette mask and aspect at CRT display size', async () => {
  const sharp = (await import('sharp')).default;
  const { presetSpriteScale, presetSpriteOutlinePx } =
    await import('./transitPresetStyle.js');
  const rasterBody = async (svg) => {
    // Compare fills in the same frame; the separately tested external halo is excluded.
    const d =
      [...svg.matchAll(/<path d="([^"]+)" fill="white"/g)][0]?.[1] ??
      svg.match(/<path d="([^"]+)"\s+fill="white"/)[1];
    const { data, info } = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="-48 -48 96 96"><path d="${d}" fill="white"/></svg>`,
      ),
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const mask = [];
    let minX = info.width,
      minY = info.height,
      maxX = 0,
      maxY = 0;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const alpha = data[(y * info.width + x) * 4 + 3];
        mask.push(alpha);
        if (alpha > 127) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    return { mask, aspect: (maxX - minX + 1) / (maxY - minY + 1) };
  };
  for (const selected of [false, true])
    for (const kind of TRANSIT_ICON_KINDS) {
      const normal = await rasterBody(
        decode(transitIcon(kind, selected ? 96 : 48, { style: 'normal' })),
      );
      for (const style of ['surveillance', 'thermal', 'noir', 'nvg']) {
        const svg = decode(transitIcon(kind, selected ? 96 : 48, { style }));
        const mono = await rasterBody(svg);
        assert.deepEqual(
          mono.mask,
          normal.mask,
          `${kind}/${style}: no envelope`,
        );
        assert.ok(
          Math.abs(mono.aspect / normal.aspect - 1) <= 0.05,
          `${kind}/${style}: aspect`,
        );
        const display =
          (selected ? 30 : 20) * presetSpriteScale(style, selected);
        const crt = (selected ? 30 : 20) * presetSpriteScale('retro', selected);
        assert.equal(display, crt);
        const frame = haloFrame(
          presetSpriteOutlinePx(style, selected),
          display,
        );
        const crtFrame = haloFrame(
          presetSpriteOutlinePx('retro', selected),
          crt,
        );
        assert.equal(
          (display * frame.ratio) / frame.ratio,
          (crt * crtFrame.ratio) / crtFrame.ratio,
          'unpadded silhouette matches CRT; only external halo padding grows',
        );
        assert.equal(
          (svg.match(/<path /g) || []).length,
          2,
          'only outer halo and opaque silhouette',
        );
        assert.match(svg, /fill="white" \/>/);
      }
    }
});

test('sensor raster halo stays dark across its screen-space band on a white roof', async () => {
  const sharp = (await import('sharp')).default;
  const { presetSpriteScale, presetSpriteOutlinePx } =
    await import('./transitPresetStyle.js');
  const { reduceSensorContrast } =
    await import('../layers/transit/qaMetrics.js');
  const sides = {
    bus: 17,
    tram: 10,
    subway: 11.5,
    rail: 10.5,
    ferry: 12.5,
    unknown: 10,
  };
  for (const selected of [false, true]) {
    const pixels = [];
    for (const kind of TRANSIT_ICON_KINDS) {
      const display =
        (selected ? 30 : 20) * presetSpriteScale('thermal', selected);
      const frame = haloFrame(
        presetSpriteOutlinePx('thermal', selected),
        display,
      );
      const size = Math.round(display * frame.ratio * 8);
      const svg = decode(
        transitIcon(kind, selected ? 96 : 48, { style: 'thermal' }),
      );
      const { data, info } = await sharp(Buffer.from(svg))
        .resize(size, size)
        .flatten({ background: '#ffffff' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const sample = (offsetPx) => {
        const x = Math.floor(
          size / 2 + (offsetPx * size) / (display * frame.ratio),
        );
        const i = (Math.floor(size / 2) * info.width + x) * info.channels;
        return (
          (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255
        );
      };
      // The body stays at CRT size; the ring must cover this fixed external band.
      const ringMin = sample((sides[kind] * display) / 96 + 1.25);
      pixels.push({
        key: kind,
        verified: true,
        centre: sample(0),
        ringMin,
        ringMax: 1 - ringMin,
        background: 1,
      });
    }
    const white = reduceSensorContrast(pixels, 'white', 'thermal');
    assert.ok(white.pass, JSON.stringify({ selected, pixels, white }));
    const black = reduceSensorContrast(
      pixels.map((p) => ({ ...p, centre: 1 - p.centre })),
      'black',
      'thermal',
    );
    assert.ok(black.pass, JSON.stringify({ selected, black }));
  }
});
