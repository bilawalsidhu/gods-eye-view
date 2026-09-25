import test from 'node:test';
import assert from 'node:assert/strict';
import { createRailTimeline } from './railTimeline.js';
import { railFixture } from './railTestFixture.mjs';
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
test('preview is immediate, commits are coalesced and the drag DOM and tick mapping stay stable', (t) => {
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
  const row = slider.parent;
  assert.equal(slider.getAttribute('aria-label'), 'Observed history');
  slider.value = '0';
  slider.dispatchEvent(new Event('input'));
  assert.deepEqual(commits, []);
  assert.deepEqual(previews, [ticks[0]]);
  assert.equal(slider.getAttribute('aria-valuetext'), '09-22 01:00 UTC');
  view.update({
    ...props,
    ticks: ticks.slice(1),
    index: 1,
    readout: 'Refresh',
  });
  assert.equal(slider.parent, row);
  assert.equal(row.children[1], slider);
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
  assert.equal(slider.max, '1');
  view.destroy();
});
test('identical updates write nothing; controls call actions and destruction cancels commits', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0;
  const f = railFixture(() => writes++);
  const calls = [];
  const view = createRailTimeline({
    ...f,
    onCommit: () => calls.push('commit'),
    onStep: (n) => calls.push(n),
    onLatest: () => calls.push('latest'),
    onPlay: () => calls.push('play'),
  });
  view.update({ ...props, index: 1 });
  writes = 0;
  view.update({ ...props, index: 1 });
  assert.equal(writes, 0);
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
  assert.equal(endpoints.parent.className, 'rail-timeline-track');
  assert.deepEqual(
    endpoints.children.map((n) => n.textContent),
    ['01:00 UTC', '01:10 UTC'],
  );
  view.update({ ...props, ticks: ticks.slice(1) });
  assert.equal(endpoints.children[0].textContent, '01:05 UTC');
  view.destroy();
});
