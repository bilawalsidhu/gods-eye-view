import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { nextTick } from 'vue';
import { createRailTimeline } from './railTimeline.js';
import { railDocumentFixture as railFixture } from './railTestFixture.mjs';
const ticks = [
  '2026-09-22T01:00:00Z',
  '2026-09-22T01:05:00Z',
  '2026-09-22T01:10:00Z',
];
const props = {
  ticks,
  index: 2,
  mode: 'latest',
  playing: false,
  readout: 'Latest',
  disabled: false,
};
test('preview is immediate, commits are coalesced and the drag DOM and tick mapping stay stable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = railFixture();
  const previews = [];
  const commits = [];
  const view = createRailTimeline({
    ...f,
    onPreview: (tick) => {
      previews.push(tick);
      return tick;
    },
    onCommit: (tick) => commits.push(tick),
  });
  view.update(props);
  const slider = f.find((n) => n.tagName === 'INPUT');
  const row = slider.parentElement;
  assert.equal(slider.getAttribute('aria-label'), 'Observed history');
  slider.value = '0';
  slider.dispatchEvent(new Event('input'));
  assert.deepEqual(commits, []);
  assert.deepEqual(previews, [ticks[0]]);
  await nextTick();
  assert.equal(slider.getAttribute('aria-valuetext'), '09-22 01:00 UTC');
  view.update({
    ...props,
    ticks: ticks.slice(1),
    index: 1,
    readout: 'Refresh',
  });
  assertSameNode(slider.parentElement, row);
  assertSameNode(row.children[1], slider);
  assert.equal(slider.value, '0');
  assert.equal(slider.max, '2');
  assert.equal(
    f.find((n) => n.className === 'rail-timeline-readout').textContent,
    ticks[0],
  );
  t.mock.timers.tick(149);
  assert.equal(commits.length, 0);
  slider.value = '1';
  slider.dispatchEvent(new Event('input'));
  t.mock.timers.tick(1);
  assert.deepEqual(commits, [ticks[1]]);
  slider.value = '2';
  slider.dispatchEvent(new Event('input'));
  slider.dispatchEvent(new Event('change'));
  assert.deepEqual(commits, [ticks[1], ticks[2]]);
  t.mock.timers.tick(150);
  assert.equal(commits.length, 2);
  await nextTick();
  assert.equal(slider.max, '1', 'release applies the latest update');
  view.destroy();
});
test('identical updates write nothing; controls call actions and destruction cancels commits', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = railFixture();
  const calls = [];
  const view = createRailTimeline({
    ...f,
    onCommit: () => calls.push('commit'),
    onStep: (n) => calls.push(n),
    onLatest: () => calls.push('latest'),
    onPlay: () => calls.push('play'),
  });
  view.update({ ...props, index: 1 });
  f.writes();
  view.update({ ...props, index: 1 });
  assert.equal(f.writes(), 0);
  for (const label of ['‹', '›', 'Latest', 'Play'])
    f.find((n) => n.textContent === label).click();
  assert.deepEqual(calls, [-1, 1, 'latest', 'play']);
  view.update({ ...props, playing: true });
  assert.ok(f.find((n) => n.textContent === 'Pause'));
  const slider = f.find((n) => n.tagName === 'INPUT');
  slider.value = '0';
  slider.dispatchEvent(new Event('change'));
  assert.equal(calls.at(-1), 'commit');
  slider.dispatchEvent(new Event('input'));
  view.destroy();
  t.mock.timers.tick(150);
  assert.equal(calls.length, 5);
  assert.equal(f.container.children.length, 0);
});

test('observed history label and endpoint times track the advertised tick range', () => {
  const f = railFixture();
  const view = createRailTimeline(f);
  view.update(props);
  assert.equal(
    f.find((n) => n.className === 'panel-title').textContent,
    'Observed history',
  );
  const endpoints = f.find((n) => n.className === 'rail-timeline-endpoints');
  assert.equal(endpoints.parentElement.className, 'rail-timeline-track');
  assert.deepEqual(
    [...endpoints.children].map((n) => n.textContent),
    ['01:00 UTC', '01:10 UTC'],
  );
  view.update({ ...props, ticks: ticks.slice(1) });
  assert.equal(endpoints.children[0].textContent, '01:05 UTC');
  view.destroy();
});

test('an update from inside the preview neither moves the handle back nor survives a disable', async () => {
  const f = railFixture();
  let view;
  let next = null;
  const commits = [];
  view = createRailTimeline({
    ...f,
    onPreview: () => {
      if (next) view.update(next);
      return 'preview';
    },
    onCommit: (tick, index) => commits.push(index),
  });
  view.update(props);
  const slider = f.find((n) => n.tagName === 'INPUT');
  next = { ...props, readout: 'Refresh' };
  slider.value = '0';
  slider.dispatchEvent(new Event('input'));
  assert.equal(slider.value, '0');
  slider.dispatchEvent(new Event('change'));
  assert.deepEqual(commits, [0]);
  next = { ...props, disabled: true };
  slider.value = '1';
  slider.dispatchEvent(new Event('input'));
  await nextTick();
  assert.equal(slider.value, '2', 'the disabled owner keeps its position');
  assert.equal(slider.getAttribute('aria-valuetext'), '09-22 01:10 UTC');
  view.destroy();
});
test('a drag that ends where it began puts the handle back on the shown index', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = railFixture();
  const commits = [];
  const view = createRailTimeline({
    ...f,
    onCommit: (tick) => commits.push(tick),
  });
  view.update(props);
  await nextTick();
  const slider = f.find((n) => n.tagName === 'INPUT');
  slider.value = '0';
  slider.dispatchEvent(new Event('input'));
  slider.dispatchEvent(new Event('pointercancel'));
  await nextTick();
  assert.equal(slider.value, '2', 'a cancelled drag');
  assert.deepEqual(commits, []);
  // A refused commit: the owner keeps its index.
  slider.value = '1';
  slider.dispatchEvent(new Event('input'));
  slider.dispatchEvent(new Event('change'));
  await nextTick();
  assert.deepEqual(commits, [ticks[1]]);
  assert.equal(slider.value, '2', 'a refused commit');
  view.destroy();
});
