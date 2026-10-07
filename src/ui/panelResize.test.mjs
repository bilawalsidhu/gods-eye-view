import assert from 'node:assert/strict';
import test from 'node:test';
import { resizeBox } from './panelResize.js';

const box = { left: 100, top: 100, width: 400, height: 300 };
const limits = {
  minWidth: 200,
  minHeight: 150,
  viewportWidth: 1000,
  viewportHeight: 800,
};

test('east and south edges grow away from the anchored corner', () => {
  assert.deepEqual(resizeBox(box, 'se', 50, 20, limits), {
    left: 100,
    top: 100,
    width: 450,
    height: 320,
  });
  assert.deepEqual(resizeBox(box, 'e', -30, 999, limits), {
    left: 100,
    top: 100,
    width: 370,
    height: 300,
  });
});

test('west and north edges keep the opposite edge pinned', () => {
  assert.deepEqual(resizeBox(box, 'w', -40, 0, limits), {
    left: 60,
    top: 100,
    width: 440,
    height: 300,
  });
  assert.deepEqual(resizeBox(box, 'nw', 40, 30, limits), {
    left: 140,
    top: 130,
    width: 360,
    height: 270,
  });
  assert.deepEqual(
    resizeBox(box, 'n', -50, 0, limits).top,
    100,
    'horizontal motion does not move a north edge',
  );
});

test('minimum size stops the moving edge, not the anchored one', () => {
  const small = resizeBox(box, 'w', 350, 0, limits);
  assert.deepEqual(small, { left: 300, top: 100, width: 200, height: 300 });
  assert.equal(resizeBox(box, 'ne', 0, 400, limits).height, 150);
  assert.equal(resizeBox(box, 'ne', 0, 400, limits).top, 250);
});

test('the viewport margin caps growth in every direction', () => {
  assert.equal(resizeBox(box, 'e', 2000, 0, limits).width, 1000 - 6 - 100);
  assert.equal(resizeBox(box, 's', 0, 2000, limits).height, 800 - 6 - 100);
  const west = resizeBox(box, 'w', -2000, 0, limits);
  assert.equal(west.left, 6);
  assert.equal(west.left + west.width, 500);
  const north = resizeBox(box, 'n', 0, -2000, limits);
  assert.equal(north.top, 6);
  assert.equal(north.top + north.height, 400);
});
