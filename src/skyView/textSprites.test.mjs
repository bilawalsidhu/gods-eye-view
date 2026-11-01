import assert from 'node:assert/strict';
import test from 'node:test';
import { createTextSprites } from './textSprites.js';

/** A fake canvas factory that records what each sprite context drew. */
function fakeCanvases() {
  const made = [];
  const create = (w, h) => {
    const ops = [];
    const ctx = {
      measureText: (t) => ({
        width: t.length * 6,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: t.length * 6,
        actualBoundingBoxAscent: 6,
        actualBoundingBoxDescent: 6,
      }),
      setTransform: (...a) => ops.push(['setTransform', ...a]),
      strokeText: (...a) => ops.push(['strokeText', ...a]),
      fillText: (...a) => ops.push(['fillText', ...a]),
    };
    const canvas = { width: w, height: h, ops, getContext: () => ctx };
    made.push(canvas);
    return canvas;
  };
  return { made, create };
}

const STYLE = {
  font: '500 11px system-ui, sans-serif',
  fill: '#abc',
  stroke: 'rgba(0, 0, 0, 0.55)',
  strokeWidth: 3,
  align: 'center',
  baseline: 'middle',
};

function recorder() {
  const calls = [];
  const sets = [];
  const ctx = new Proxy(
    {},
    {
      get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])),
      set: (t, k, v) => (sets.push(k), (t[k] = v), true),
    },
  );
  return { ctx, calls, sets };
}

test('each (text, style, ratio) is rasterised once, then only blitted', () => {
  const { made, create } = fakeCanvases();
  const sprites = createTextSprites(create);
  const { ctx, calls, sets } = recorder();
  for (let i = 0; i < 5; i++) sprites.draw(ctx, 'Orion', 100.3, 50.7, STYLE, 2);
  assert.equal(sprites.rendered, 1);
  // one probe context + one sprite canvas
  assert.equal(made.length, 2);
  const sprite = made[1];
  assert.deepEqual(
    sprite.ops.map((o) => o[0]),
    ['setTransform', 'strokeText', 'fillText'],
  );
  const blits = calls.filter((c) => c[0] === 'drawImage');
  assert.equal(blits.length, 5);
  assert.ok(!calls.some((c) => c[0] === 'fillText' || c[0] === 'strokeText'));
  assert.ok(!sets.includes('font'), 'the main context never sets a font');
  // the blit is 1:1 on the device-pixel grid
  const [, img, dx, dy, dw, dh] = blits[0];
  assert.equal(img, sprite);
  assert.equal(dw, sprite.width / 2);
  assert.equal(dh, sprite.height / 2);
  assert.equal(Math.round(dx * 2), dx * 2);
  assert.equal(Math.round(dy * 2), dy * 2);
  // and puts the text anchor within half a device pixel of (x, y)
  const [, , ax, ay] = sprite.ops[2];
  assert.ok(Math.abs(dx + ax - 100.3) <= 0.25 + 1e-9);
  assert.ok(Math.abs(dy + ay - 50.7) <= 0.25 + 1e-9);
  // another colour, ratio or text is another sprite
  sprites.draw(ctx, 'Orion', 0, 0, { ...STYLE, fill: '#fff' }, 2);
  sprites.draw(ctx, 'Orion', 0, 0, STYLE, 1);
  sprites.draw(ctx, 'Lepus', 0, 0, STYLE, 2);
  assert.equal(sprites.rendered, 4);
});

test('maxWidth is passed to the glyph calls and is part of the key', () => {
  const { made, create } = fakeCanvases();
  const sprites = createTextSprites(create);
  const { ctx } = recorder();
  sprites.draw(ctx, 'ISS (ZARYA)', 0, 0, { ...STYLE, maxWidth: 40 }, 1);
  sprites.draw(ctx, 'ISS (ZARYA)', 0, 0, { ...STYLE, maxWidth: 50 }, 1);
  assert.equal(sprites.rendered, 2);
  assert.equal(made[1].ops[2][4], 40);
  assert.equal(made[2].ops[2][4], 50);
});

test('no canvas factory (or no 2-D context): plain fillText fallback', () => {
  for (const factory of [
    undefined,
    () => null,
    () => ({ getContext: () => null }),
  ]) {
    const sprites = createTextSprites(factory);
    const { ctx, calls } = recorder();
    sprites.draw(ctx, 'Vega', 10, 20, STYLE, 2);
    sprites.draw(ctx, 'Vega', 10, 20, STYLE, 2);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['strokeText', 'fillText', 'strokeText', 'fillText'],
    );
    assert.equal(ctx.font, STYLE.font);
    assert.equal(sprites.usable, false);
  }
});

test('the cache is bounded', () => {
  const { create } = fakeCanvases();
  const sprites = createTextSprites(create, { max: 8 });
  const { ctx } = recorder();
  for (let i = 0; i < 30; i++) sprites.draw(ctx, `t${i}`, 0, 0, STYLE, 1);
  assert.ok(sprites.size <= 8);
});
