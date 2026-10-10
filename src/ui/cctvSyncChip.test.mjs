import assert from 'node:assert/strict';
import test from 'node:test';

import {
  repaintCctvSyncChipLabel,
  _updateCctvSyncChip,
} from './cctvPresentation.js';
import { setLocale, t } from '../i18n/index.js';

/** A fake `this` for the presentation mixins, with recorded flap writes. */
function createChipContext() {
  const labels = [];
  const timers = [];
  let nextTimer = 1;
  const fakeWindow = {
    setTimeout(callback, delay) {
      timers.push({ id: nextTimer, callback, delay });
      return nextTimer++;
    },
    clearTimeout() {
      timers.length = 0;
    },
  };
  const ctx = {
    destroyed: false,
    _cctvChipWasBusy: false,
    _cctvChipMode: null,
    _cctvChipHideTimer: null,
    _cctvSyncLabel: { textContent: '' },
    _cctvSyncProgress: { textContent: '' },
    _cctvSyncChip: { classList: { add() {}, remove() {} } },
    actions: {
      setSplitFlapText(element, text) {
        // The settled textContent is what the binder/owner race would clobber.
        element.textContent = String(text);
        labels.push(String(text));
      },
    },
    window: fakeWindow,
  };
  // The mixin reads the global `window` for its dwell timer; install the fake
  // for the duration of the test and restore whatever was there.
  const hadWindow = 'window' in globalThis;
  const originalWindow = globalThis.window;
  globalThis.window = fakeWindow;
  ctx.restoreWindow = () => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
  };
  return { ctx, labels, timers, restoreWindow: ctx.restoreWindow };
}

test('the sync chip walks loading -> grid-ready with honest counters', () => {
  const { ctx, labels, restoreWindow } = createChipContext();
  try {
    _updateCctvSyncChip.call(ctx, { active: true, total: 5, loaded: 2 }, true);
    assert.equal(ctx._cctvChipMode, 'loading');
    assert.equal(ctx._cctvSyncLabel.textContent, t('chrome.chips.cctvSync'));
    assert.equal(ctx._cctvSyncProgress.textContent, '2/5');

    _updateCctvSyncChip.call(ctx, { active: false, total: 5, loaded: 5 }, true);
    assert.equal(ctx._cctvChipMode, 'ready');
    assert.equal(ctx._cctvSyncLabel.textContent, t('cctv.sync.gridReady'));
    assert.equal(ctx._cctvSyncProgress.textContent, '5/5');
    assert.ok(ctx._cctvChipHideTimer, 'completion arms the dwell timer');
    assert.deepEqual(labels, [
      t('chrome.chips.cctvSync'),
      t('cctv.sync.gridReady'),
    ]);
  } finally {
    restoreWindow();
  }
});

test('P2: a locale switch during the completion dwell re-translates the label in place', () => {
  const { ctx, labels, timers, restoreWindow } = createChipContext();
  try {
    _updateCctvSyncChip.call(ctx, { active: true, total: 5, loaded: 4 }, true);
    _updateCctvSyncChip.call(ctx, { active: false, total: 5, loaded: 5 }, true);
    const timerCountBefore = timers.length;

    const previous = t('cctv.sync.gridReady');
    setLocale('zh-CN');
    try {
      repaintCctvSyncChipLabel.call(ctx);
      assert.notEqual(
        t('cctv.sync.gridReady'),
        previous,
        'the packs must differ for this assertion to mean anything',
      );
      assert.equal(ctx._cctvSyncLabel.textContent, t('cctv.sync.gridReady'));
      // The completion dwell is untouched: same timers, still the ready mode.
      assert.equal(ctx._cctvChipMode, 'ready');
      assert.equal(timers.length, timerCountBefore);
    } finally {
      setLocale('en');
    }
    assert.ok(labels.length >= 2);
  } finally {
    restoreWindow();
  }
});

test('P2: the REAL subscription order (render state, then repaint) re-translates the dwell label', () => {
  const { ctx, labels, timers, restoreWindow } = createChipContext();
  try {
    // Loading drives the chip, then completes: ready mode + 1500 ms dwell.
    _updateCctvSyncChip.call(ctx, { active: true, total: 5, loaded: 4 }, true);
    _updateCctvSyncChip.call(ctx, { active: false, total: 5, loaded: 5 }, true);
    assert.equal(ctx._cctvChipMode, 'ready');
    const timerCountBefore = timers.length;

    setLocale('zh-CN');
    try {
      // This is exactly what the CctvControls locale subscription runs, in
      // order: the state render calls _updateCctvSyncChip with the stored
      // (completed) state, and only then the label repaint happens. The
      // render pass must NOT clear the ready mode out from under it.
      _updateCctvSyncChip.call(
        ctx,
        { active: false, total: 5, loaded: 5 },
        true,
      );
      repaintCctvSyncChipLabel.call(ctx);

      assert.equal(ctx._cctvChipMode, 'ready');
      assert.equal(ctx._cctvSyncLabel.textContent, t('cctv.sync.gridReady'));
      assert.notEqual(
        ctx._cctvSyncLabel.textContent,
        'camera grid ready',
        'the old-language completion copy must be re-translated',
      );
      // Dwell untouched: same timer count, chip still visible-mode ready.
      assert.equal(timers.length, timerCountBefore);
    } finally {
      setLocale('en');
    }
  } finally {
    restoreWindow();
  }
});

test('the repaint is inert without a visible chip mode', () => {
  const { ctx, labels, restoreWindow } = createChipContext();
  try {
    repaintCctvSyncChipLabel.call(ctx);
    assert.deepEqual(labels, []);
  } finally {
    restoreWindow();
  }
});

test('the dwell timer clears the mode when it fires', () => {
  const { ctx, timers, restoreWindow } = createChipContext();
  try {
    _updateCctvSyncChip.call(ctx, { active: true, total: 3, loaded: 1 }, true);
    _updateCctvSyncChip.call(ctx, { active: false, total: 3, loaded: 3 }, true);
    assert.equal(ctx._cctvChipMode, 'ready');
    const hideTimer = timers.find(({ delay }) => delay === 1500);
    assert.ok(hideTimer, 'the 1500 ms dwell timer is armed');
    hideTimer.callback();
    assert.equal(ctx._cctvChipMode, null);
  } finally {
    restoreWindow();
  }
});
