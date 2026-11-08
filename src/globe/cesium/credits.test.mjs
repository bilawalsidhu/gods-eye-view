import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCesiumCredits } from './credits.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

test('addStatic adds a Cesium credit and returns an idempotent remover', () => {
  const viewer = createFakeViewer();
  const { credits } = createCesiumCredits(viewer);
  const remove = credits.addStatic('<b>Source</b>', { onScreen: true });
  assert.equal(viewer.staticCredits.length, 1);
  const [credit] = viewer.staticCredits;
  assert.ok(credit instanceof Cesium.Credit);
  assert.equal(credit.html, '<b>Source</b>');
  assert.equal(credit.showOnScreen, true);
  remove();
  remove();
  assert.equal(viewer.staticCredits.length, 0);
  assert.equal(viewer.callsOf('creditDisplay.removeStaticCredit').length, 1);
  credits.addStatic('Off screen');
  assert.equal(viewer.staticCredits[0].showOnScreen, false);
});

test('destroy removes the credits the engine added', () => {
  const viewer = createFakeViewer();
  const { credits, destroy } = createCesiumCredits(viewer);
  credits.addStatic('a');
  const removeB = credits.addStatic('b');
  removeB();
  destroy();
  assert.equal(viewer.staticCredits.length, 0);
  assert.equal(viewer.callsOf('creditDisplay.removeStaticCredit').length, 2);
});

test('the display is Viewer.creditDisplay', () => {
  const added = [];
  const display = {
    addStaticCredit: (credit) => added.push(credit),
    removeStaticCredit: (credit) => added.splice(added.indexOf(credit), 1),
  };
  const { credits } = createCesiumCredits({
    creditDisplay: display,
  });
  const remove = credits.addStatic('frame state');
  assert.equal(added[0].html, 'frame state');
  remove();
  assert.deepEqual(added, []);
});
