import assert from 'node:assert/strict';
import test from 'node:test';
import { hexColor } from './color.js';

test('hex colours become renderer colours at the given alpha', () => {
  assert.deepEqual(hexColor('#ff8000'), [1, 128 / 255, 0, 1]);
  assert.deepEqual(hexColor('#000000', 0.25), [0, 0, 0, 0.25]);
});

test('CSS colours read as the default renderer reads them', async () => {
  const Cesium = await import('cesium');
  const { cssColor } = await import('./color.js');
  for (const css of [
    '#39d5ff',
    ' #8fffd2 ',
    '#abc',
    '#abcd',
    '#11223344',
    'rgb(10, 20, 30)',
    'rgba(10,20,30,0.5)',
    'rgb(10% 20% 30% / 0.25)',
    'hsl(120, 50%, 25%)',
    'hsla(300, 100%, 75%, 0.4)',
    'hsl(30, 0%, 40%)',
    'red',
    ' Navy ',
    'DARKGREY',
    'lightSlateGray',
    'transparent',
    // Upper-cased as the default renderer does: dotless i and long s
    // upper-case to I and S.
    'wh\u0131te',
    '\u017Fnow',
  ]) {
    const c = Cesium.Color.fromCssColorString(css);
    assert.deepEqual(cssColor(css), [c.red, c.green, c.blue, c.alpha], css);
  }
  assert.equal(cssColor('not a colour'), null);
  assert.equal(cssColor('rebeccapurple'), null);
  assert.equal(cssColor('lavenderblush'), null);
  assert.equal(cssColor('constructor'), null);
  assert.equal(cssColor('__proto__'), null);
  // The Kelvin sign lower-cases to k, but does not upper-case to K.
  assert.equal(cssColor('\u212Ahaki'), null);
  assert.equal(cssColor(undefined), null);
});

test('HSL colours read as the default renderer computes them', async () => {
  const Cesium = await import('cesium');
  const { hslColor } = await import('./color.js');
  for (const [h, s, l, a] of [
    [0, 0.85, 0.6, 0.12],
    [0.3819660112501051, 0.9, 0.65, 0.85],
    [0.7639320225002102, 0.9, 0.7, 1],
    [1.25, 0.5, 0.25, 0.4],
    [0.5, 0, 0.4, 1],
  ]) {
    const c = Cesium.Color.fromHsl(h, s, l, a);
    assert.deepEqual(hslColor(h, s, l, a), [c.red, c.green, c.blue, c.alpha]);
  }
});

test('every colour name the default renderer knows reads as it does', async () => {
  const Cesium = await import('cesium');
  const { cssColor } = await import('./color.js');
  const names = Object.keys(Cesium.Color).filter(
    (key) => /^[A-Z_]+$/.test(key) && Cesium.Color[key] instanceof Cesium.Color,
  );
  assert.ok(names.length > 140);
  for (const name of names) {
    const c = Cesium.Color.fromCssColorString(name.toLowerCase());
    assert.deepEqual(
      cssColor(name.toLowerCase()),
      [c.red, c.green, c.blue, c.alpha],
      name,
    );
  }
});
