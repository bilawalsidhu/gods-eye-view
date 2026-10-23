import test from 'node:test';
import assert from 'node:assert/strict';
import { CctvControls } from './cctvControls.js';
import { railFixture } from './railTestFixture.mjs';
import { setLocale, t } from '../i18n/index.js';

function fixture(t) {
  const { document } = railFixture();
  const controls = new CctvControls({
    elements: {
      _cctvQualityChip: document.createElement('span'),
      _cctvSourceBadge: document.createElement('div'),
    },
    cctv: {},
    actions: { isEnabled: () => true, setPanelCollapsed() {} },
  });
  t.after(() => controls.destroy());
  return { controls, document };
}

test('source and frame states retain their distinct meanings, including retained pixels', (testContext) => {
  const { controls, document } = fixture(testContext);
  const camera = { sourceKind: 'snapshot', sourceStatus: 'degraded' };
  controls._cctvFrame = document.createElement('img');
  controls._cctvFrameWrap = document.createElement('div');
  controls._cctvFrame.removeAttribute = () => {};
  for (const node of [controls._cctvFrame, controls._cctvFrameWrap]) {
    node.classList.remove = (...names) =>
      names.forEach((name) => node.classList.toggle(name, false));
  }
  const expect = (label, state, active = camera, enabled = true) => {
    controls._syncCctvSourceBadge(active, enabled);
    assert.equal(controls._cctvSourceBadge.textContent, label);
    assert.equal(controls._cctvSourceBadge.dataset.frameState, state);
  };
  expect('SOURCE · UNKNOWN', 'idle', camera, false);
  expect('SOURCE · UNKNOWN', 'idle', null);
  controls._cctvFrame.dataset.loading = 'true';
  expect('FRAME · LOADING', 'loading');
  controls._cctvFrame.dataset.loading = '';
  controls._cctvFrame.dataset.error = 'true';
  expect('FRAME · UNAVAILABLE', 'error');
  // A refresh failure keeps the settled pixels and the provider's source status.
  controls._cctvFrameWrap.classList.toggle('has-frame', true);
  expect('SNAPSHOT · DEGRADED', 'ready');
  controls._cctvFrame.dataset.loading = 'true';
  expect('SNAPSHOT · DEGRADED', 'ready');
  controls._cctvFrame.dataset.loading = '';
  controls._cctvFrame.dataset.error = '';
  for (const status of ['ok', 'error', 'unknown', 'vendor-specific']) {
    expect(`SNAPSHOT · ${status.toUpperCase()}`, 'ready', {
      ...camera,
      sourceStatus: status,
    });
  }
  expect('LIVE · OK', 'ready', { feedType: 'live', sourceStatus: 'ok' });
});

test('calibration labels follow supplied provenance and dirty/save/reset transitions without writes to the camera', (testContext) => {
  const { controls } = fixture(testContext);
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
    controls._renderCctvState({
      enabled: true,
      activeCameraId: 'a',
      activeCamera,
    });
    assert.equal(controls._cctvQualityChip.textContent, label);
    assert.equal(
      controls._cctvQualityChip.dataset.calBadge,
      calDirty ? 'edited' : calBadge || '',
    );
  }
  controls._renderCctvState(null);
  assert.equal(controls._cctvQualityChip.textContent, 'CAL · --');
  assert.equal(controls._cctvQualityChip.dataset.calBadge, '');
});

test('localization changes badge copy while preserving machine state ids', (testContext) => {
  const { controls } = fixture(testContext);
  testContext.after(() => setLocale('en'));
  setLocale('ru');
  controls._syncCctvSourceBadge(
    { sourceKind: 'snapshot', sourceStatus: 'degraded' },
    true,
  );
  assert.equal(
    controls._cctvSourceBadge.textContent,
    `${t('SNAPSHOT')} · ${t('DEGRADED')}`,
  );
  assert.notEqual(controls._cctvSourceBadge.textContent, 'SNAPSHOT · DEGRADED');
  assert.equal(controls._cctvSourceBadge.dataset.frameState, 'ready');
  controls._renderCctvState({
    enabled: true,
    activeCameraId: 'a',
    activeCamera: { id: 'a', calBadge: 'curated', calDirty: true },
  });
  assert.equal(
    controls._cctvQualityChip.textContent,
    t('CAL · EDITED (UNSAVED)'),
  );
  assert.equal(controls._cctvQualityChip.dataset.calBadge, 'edited');
});
