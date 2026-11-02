// src/ui/statusChipOwners.test.mjs — what ShellFeedback and the CCTV
// presentation publish for the road network and camera grid chips.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= {
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
  // The layer panel reaches Vue, whose DOM runtime creates one element as it
  // loads.
  createElement: () => ({}),
  hidden: false,
};
const { ShellFeedback } = await import('./shellFeedback.js');
const { _publishCctvChip, _updateCctvSyncChip } =
  await import('./cctvPresentation.js');

test('the road network chip clears its progress once the sync lands and keeps its label', () => {
  const published = [];
  let stats = { loading: true, phaseProgressPct: 40, phaseLabel: 'LIVE' };
  const feedback = new ShellFeedback({
    readLayers: () => [{ id: 'traffic', enabled: true, stats }],
    store: {
      publishTraffic: (view) => published.push(view),
      publishLoading() {},
    },
  });
  feedback._updateTrafficSyncChip(false, 0);
  assert.deepEqual(published.at(-1), {
    visible: true,
    label: 'LIVE',
    immediate: false,
    progress: '40%',
    stopped: false,
  });
  feedback._updateTrafficSyncChip(false, 10);
  assert.equal(published.length, 1, 'an unchanged chip is not republished');
  stats = { phaseProgressPct: 100, phaseLabel: 'LIVE · 80% cov' };
  feedback._updateTrafficSyncChip(false, 20);
  assert.deepEqual(published.at(-1), {
    visible: true,
    label: 'LIVE · 80% cov',
    immediate: true,
    progress: '',
    stopped: false,
  });
  feedback._updateTrafficSyncChip(false, 60_000);
  assert.deepEqual(published.at(-1), {
    visible: false,
    label: 'LIVE · 80% cov',
    immediate: true,
    progress: '',
    stopped: false,
  });
  feedback.destroy();
  assert.equal(published.at(-1).stopped, true, 'destroy rests the label');
});

function cctvOwner() {
  const published = [];
  const owner = {
    destroyed: false,
    _cctvChip: null,
    _cctvChipWasBusy: false,
    _cctvChipHideTimer: null,
    statusStore: { publishCctv: (view) => published.push(view) },
  };
  owner._publishCctvChip = _publishCctvChip.bind(owner);
  const update = _updateCctvSyncChip.bind(owner);
  return { owner, published, update };
}

test('the camera grid chip counts frames, flashes the total, then hides', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.window ??= globalThis;
  const { published, update } = cctvOwner();
  update({ active: true, loaded: 3, total: 12 }, true);
  assert.deepEqual(published.at(-1), {
    visible: true,
    label: 'loading frames',
    immediate: false,
    progress: '3/12',
    stopped: false,
  });
  update({ active: false, loaded: 12, total: 12 }, true);
  assert.deepEqual(published.at(-1), {
    visible: true,
    label: 'camera grid ready',
    immediate: false,
    progress: '12/12',
    stopped: false,
  });
  update({ active: false, loaded: 12, total: 12 }, true);
  assert.equal(published.length, 2, 'the flash holds until its timer');
  t.mock.timers.tick(1500);
  assert.deepEqual(published.at(-1), {
    visible: false,
    label: 'camera grid ready',
    immediate: false,
    progress: '12/12',
    stopped: false,
  });
});

test('a camera grid chip that never showed publishes its first hide once', () => {
  const { published, update } = cctvOwner();
  update(null, false);
  update(null, false);
  assert.deepEqual(published, [
    {
      visible: false,
      label: 'loading frames',
      immediate: false,
      progress: '0/0',
      stopped: false,
    },
  ]);
});
