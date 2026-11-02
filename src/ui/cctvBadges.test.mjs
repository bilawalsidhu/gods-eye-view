import test from 'node:test';
import assert from 'node:assert/strict';
import { presentCctvSourceBadge } from './cctvFrames.js';
import { presentCctvPanel } from './cctvPresentation.js';
import { setLocale, t } from '../i18n/index.js';

const IDLE = Object.freeze({ loading: false, error: false, hasFrame: false });

test('source and frame states retain their distinct meanings, including retained pixels', () => {
  const camera = { sourceKind: 'snapshot', sourceStatus: 'degraded' };
  const expect = (label, state, frame, active = camera, enabled = true) =>
    assert.deepEqual(presentCctvSourceBadge(active, enabled, frame), {
      label,
      state,
    });
  expect('SOURCE · UNKNOWN', 'idle', IDLE, camera, false);
  expect('SOURCE · UNKNOWN', 'idle', IDLE, null);
  expect('FRAME · LOADING', 'loading', { ...IDLE, loading: true });
  expect('FRAME · UNAVAILABLE', 'error', { ...IDLE, error: true });
  // A refresh failure keeps the settled pixels and the provider's source status.
  const retained = { ...IDLE, error: true, hasFrame: true };
  expect('SNAPSHOT · DEGRADED', 'ready', retained);
  expect('SNAPSHOT · DEGRADED', 'ready', { ...retained, loading: true });
  for (const status of ['ok', 'error', 'unknown', 'vendor-specific']) {
    expect(`SNAPSHOT · ${status.toUpperCase()}`, 'ready', IDLE, {
      ...camera,
      sourceStatus: status,
    });
  }
  expect('LIVE · OK', 'ready', IDLE, { feedType: 'live', sourceStatus: 'ok' });
});

test('calibration labels follow supplied provenance and dirty/save/reset transitions without writes to the camera', () => {
  const cases = [
    ['raw-prior', false, 'CAL · RAW PRIOR'],
    ['curated', false, 'CAL · CURATED'],
    ['curated', true, 'CAL · EDITED (UNSAVED)'],
    ['calibrated', false, 'CAL · CALIBRATED'],
    ['calibrated', true, 'CAL · EDITED (UNSAVED)'],
    ['raw-prior', false, 'CAL · RAW PRIOR'],
    [null, false, 'CAL · --'],
  ];
  for (const [calBadge, calDirty, label] of cases) {
    const activeCamera = Object.freeze({ id: 'a', calBadge, calDirty });
    const { quality } = presentCctvPanel(
      { enabled: true, activeCameraId: 'a', activeCamera },
      true,
    );
    assert.deepEqual(quality, {
      label,
      calBadge: calDirty ? 'edited' : calBadge || '',
    });
  }
  assert.deepEqual(presentCctvPanel(null, false).quality, {
    label: 'CAL · --',
    calBadge: '',
  });
});

test('localization changes badge copy while preserving machine state ids', (testContext) => {
  testContext.after(() => setLocale('en'));
  setLocale('ru');
  const badge = presentCctvSourceBadge(
    { sourceKind: 'snapshot', sourceStatus: 'degraded' },
    true,
    IDLE,
  );
  assert.equal(badge.label, `${t('SNAPSHOT')} · ${t('DEGRADED')}`);
  assert.notEqual(badge.label, 'SNAPSHOT · DEGRADED');
  assert.equal(badge.state, 'ready');
  const { quality } = presentCctvPanel(
    {
      enabled: true,
      activeCameraId: 'a',
      activeCamera: { id: 'a', calBadge: 'curated', calDirty: true },
    },
    true,
  );
  assert.deepEqual(quality, {
    label: t('CAL · EDITED (UNSAVED)'),
    calBadge: 'edited',
  });
});
