import assert from 'node:assert/strict';
import test from 'node:test';
import { boxesOverlap, labelBox, placeLabels, textWidth } from './skyLabels.js';

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('ACCEPTANCE (label collision): a dense random sky places no two overlapping labels', () => {
  const random = rng(42);
  const width = 800;
  const height = 500;
  const reserved = [{ x0: 0, y0: 466, x1: 800, y1: 500 }]; // compass strip
  const candidates = Array.from({ length: 600 }, (_, i) => ({
    text: `Label ${i}`,
    x: random() * width,
    y: random() * height,
    width: 30 + random() * 60,
    height: 13,
    align: ['left', 'center', 'right'][i % 3],
    priority: Math.floor(random() * 5),
  }));
  const placed = placeLabels(candidates, { width, height, reserved });
  assert.ok(placed.length > 40 && placed.length < 600, `${placed.length}`);
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i].box;
    assert.ok(a.x0 >= 0 && a.y0 >= 0 && a.x1 <= width && a.y1 <= height);
    assert.ok(!boxesOverlap(a, reserved[0]), 'kept off the compass strip');
    for (let j = i + 1; j < placed.length; j++)
      assert.ok(!boxesOverlap(a, placed[j].box), `${i} overlaps ${j}`);
  }
});

test('priority wins a conflict; ties keep input order', () => {
  const base = { width: 50, height: 12, align: 'left' };
  const placed = placeLabels(
    [
      { ...base, text: 'star', x: 100, y: 100, priority: 30 },
      { ...base, text: 'Jupiter', x: 110, y: 102, priority: 100 },
      { ...base, text: 'first', x: 300, y: 100, priority: 5 },
      { ...base, text: 'second', x: 305, y: 100, priority: 5 },
    ],
    { width: 600, height: 400 },
  );
  assert.deepEqual(
    placed.map((p) => p.text),
    ['Jupiter', 'first'],
  );
});

test('boxes: alignment and padding; width from measureText or an estimate', () => {
  assert.deepEqual(
    labelBox({ x: 100, y: 50, width: 40, height: 10, align: 'center' }),
    { x0: 78, y0: 43, x1: 122, y1: 57 },
  );
  assert.deepEqual(
    labelBox({ x: 100, y: 50, width: 40, height: 10, align: 'right', pad: 0 }),
    { x0: 60, y0: 45, x1: 100, y1: 55 },
  );
  assert.equal(
    textWidth({ measureText: (t) => ({ width: t.length * 3 }) }, 'abcd'),
    12,
  );
  assert.ok(Math.abs(textWidth(null, 'abcd', '500 10px x') - 23.2) < 1e-9);
});

test('textWidth caches the measure per (font, text); no font = no cache', () => {
  let calls = 0;
  const ctx = {
    font: '',
    measureText: (t) => {
      calls += 1;
      return { width: t.length * 4 };
    },
  };
  const font = '500 13px cache-test';
  assert.equal(textWidth(ctx, 'Orion', font), 20);
  assert.equal(textWidth(ctx, 'Orion', font), 20);
  assert.equal(textWidth(ctx, 'Orion', font), 20);
  assert.equal(calls, 1, 'repeat labels are measured once');
  assert.equal(textWidth(ctx, 'Orion', '600 16px cache-test'), 20);
  assert.equal(calls, 2, 'another font is measured again');
  textWidth(ctx, 'Lyra');
  textWidth(ctx, 'Lyra');
  assert.equal(calls, 4, 'without an explicit font nothing is cached');
});
