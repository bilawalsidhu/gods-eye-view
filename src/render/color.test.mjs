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
  ]) {
    const c = Cesium.Color.fromCssColorString(css);
    assert.deepEqual(cssColor(css), [c.red, c.green, c.blue, c.alpha], css);
  }
  assert.equal(cssColor('not a colour'), null);
  assert.equal(cssColor(undefined), null);
});
