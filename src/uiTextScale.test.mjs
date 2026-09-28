import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  DEFAULT_TEXT_SCALE_ID,
  TEXT_SCALE_OPTIONS,
  TEXT_SCALE_PROPERTY,
  TEXT_SCALE_STORAGE_KEY,
  applyTextScale,
  normalizeTextScale,
  readAppliedTextScale,
  readStoredTextScale,
  scaleTextMetric,
  writeStoredTextScale,
} from './uiTextScale.js';
import {
  PANEL_STACK_MIN_HEIGHT_PX,
  allocatePanelStackHeights,
  panelStackAutoCollapseIndices,
} from './panelStackLayout.js';
import { resolveCyberCockpitPanelLane } from './cockpitUtilityLayout.js';

const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
};

const fakeRoot = () => {
  const props = new Map();
  return {
    dataset: {},
    style: {
      setProperty: (name, value) => props.set(name, value),
      getPropertyValue: (name) => props.get(name) ?? '',
    },
  };
};

test('steps are 100%, 115% and 130%, ascending, default first', () => {
  assert.deepEqual(
    TEXT_SCALE_OPTIONS.map(({ id, scale }) => [id, scale]),
    [
      ['default', 1],
      ['large', 1.15],
      ['larger', 1.3],
    ],
  );
  assert.equal(TEXT_SCALE_OPTIONS[0].id, DEFAULT_TEXT_SCALE_ID);
  assert.equal(TEXT_SCALE_STORAGE_KEY, 'gev:text-scale:v1');
});

test('normalizeTextScale accepts ids, factors and percentages', () => {
  assert.equal(normalizeTextScale('large').id, 'large');
  assert.equal(normalizeTextScale(' LARGER ').id, 'larger');
  assert.equal(normalizeTextScale(1.15).id, 'large');
  assert.equal(normalizeTextScale('1.3').id, 'larger');
  assert.equal(normalizeTextScale('115%').id, 'large');
  assert.equal(normalizeTextScale(130).id, 'larger');
  assert.equal(normalizeTextScale('100%').id, 'default');
});

test('normalizeTextScale clamps out-of-range values and snaps to the nearest step', () => {
  assert.equal(normalizeTextScale(0.5).id, 'default');
  assert.equal(normalizeTextScale('50%').id, 'default');
  assert.equal(normalizeTextScale(3).id, 'larger');
  assert.equal(normalizeTextScale('400%').id, 'larger');
  assert.equal(normalizeTextScale(1.07).id, 'default');
  assert.equal(normalizeTextScale(1.08).id, 'large');
  assert.equal(normalizeTextScale(1.25).id, 'larger');
});

test('normalizeTextScale falls back to the default for unreadable input', () => {
  for (const value of [null, undefined, '', 'huge', NaN, Infinity, -1, 0, {}, '%'])
    assert.equal(normalizeTextScale(value).id, 'default', String(value));
});

test('stored steps round-trip, and the default clears the key', () => {
  const storage = memoryStorage();
  assert.equal(readStoredTextScale(storage).id, 'default');
  assert.equal(writeStoredTextScale(storage, 'larger'), true);
  assert.equal(storage.data.get(TEXT_SCALE_STORAGE_KEY), 'larger');
  assert.equal(readStoredTextScale(storage).id, 'larger');
  assert.equal(writeStoredTextScale(storage, 'default'), true);
  assert.equal(storage.data.has(TEXT_SCALE_STORAGE_KEY), false);
});

test('a corrupt stored value reads as the default', () => {
  const storage = memoryStorage({ [TEXT_SCALE_STORAGE_KEY]: '{"bad":1}' });
  assert.equal(readStoredTextScale(storage).id, 'default');
});

test('storage failures never throw', () => {
  const throwing = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  assert.equal(readStoredTextScale(throwing).id, 'default');
  assert.equal(writeStoredTextScale(throwing, 'large'), false);
  assert.equal(writeStoredTextScale(throwing, 'default'), false);
  assert.equal(readStoredTextScale(null).id, 'default');
  assert.equal(readStoredTextScale(undefined).id, 'default');
  assert.equal(writeStoredTextScale(null, 'large'), false);
});

test('applyTextScale sets the custom property and data attribute', () => {
  const root = fakeRoot();
  assert.equal(applyTextScale(root, '130%').id, 'larger');
  assert.equal(root.style.getPropertyValue(TEXT_SCALE_PROPERTY), '1.3');
  assert.equal(root.dataset.gevTextScale, 'larger');
  assert.equal(readAppliedTextScale(root), 1.3);
  applyTextScale(root, 'nonsense');
  assert.equal(root.style.getPropertyValue(TEXT_SCALE_PROPERTY), '1');
  assert.equal(readAppliedTextScale(root), 1);
  assert.doesNotThrow(() => applyTextScale(null, 'large'));
  assert.equal(readAppliedTextScale(null), 1);
  assert.equal(readAppliedTextScale(fakeRoot()), 1);
});

test('scaleTextMetric multiplies, treating invalid factors as 1', () => {
  assert.equal(scaleTextMetric(96, 1.3), 96 * 1.3);
  assert.equal(scaleTextMetric(96, 0), 96);
  assert.equal(scaleTextMetric(96, 'x'), 96);
  assert.equal(scaleTextMetric(undefined, 1.3), 0);
});

test('the stylesheet defaults the scale to 1 so unset roots render at 100%', () => {
  const css = fs.readFileSync(
    new URL('./ui/styles/foundation.css', import.meta.url),
    'utf8',
  );
  assert.match(css, /:root\s*\{[^}]*--gev-text-scale:\s*1;/);
});

test('every stylesheet font size routes through the scale, except icon glyphs and the credit line', () => {
  const dir = new URL('./ui/styles/', import.meta.url);
  const unscaled = [];
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.css'))) {
    const css = fs.readFileSync(new URL(name, dir), 'utf8');
    // Strip comments, then walk `selector { declarations }` blocks.
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/material-symbols|icon|glyph|#cesium-credits/i.test(selector)) continue;
      if (/font-family:\s*'Material Symbols/.test(body)) continue;
      for (const [, prop, value] of body.matchAll(/(?:^|;)\s*(font-size|font)\s*:\s*([^;]+)/g)) {
        if (!/\d(px|rem)\b/.test(value)) continue;
        if (!value.includes('var(--gev-text-scale)'))
          unscaled.push(`${name}: ${selector.trim()} { ${prop}: ${value.trim()} }`);
      }
    }
  }
  assert.deepEqual(unscaled, []);
});

test('the panel-stack floor grows with text size and still fits a two-panel corridor', () => {
  const naturalHeights = [420, 360];
  for (const { scale } of TEXT_SCALE_OPTIONS) {
    const minimumHeight = scaleTextMetric(PANEL_STACK_MIN_HEIGHT_PX, scale);
    for (const availableHeight of [180, 260, 400, 700, 900]) {
      const heights = allocatePanelStackHeights({
        naturalHeights,
        availableHeight,
        minimumHeight,
      });
      const total = heights.reduce((sum, height) => sum + height, 0);
      assert.ok(total <= Math.max(availableHeight, 0) + 1e-6, `overflow at ${scale}/${availableHeight}`);
      heights.forEach((height, index) => assert.ok(height <= naturalHeights[index] + 1e-6));
      if (availableHeight >= minimumHeight * 2)
        heights.forEach((height) => assert.ok(height >= minimumHeight - 1e-6, `floor at ${scale}/${availableHeight}`));
    }
  }
  // At 130% a 260px corridor can no longer give both panels a usable floor
  // plus half their height, so the later one collapses instead of clipping.
  const tight = allocatePanelStackHeights({
    naturalHeights,
    availableHeight: 260,
    minimumHeight: scaleTextMetric(PANEL_STACK_MIN_HEIGHT_PX, 1.3),
  });
  assert.deepEqual(
    panelStackAutoCollapseIndices({ naturalHeights, allocatedHeights: tight }),
    [1],
  );
});

test('Cyber cockpit lane reserves scaled footer rows when they are not measured', () => {
  for (const viewportHeight of [673, 790, 986, 1376]) {
    const top = Math.max(164, Math.min(204, viewportHeight * 0.19));
    let previousPanel = Infinity;
    for (const { scale } of TEXT_SCALE_OPTIONS) {
      const lane = resolveCyberCockpitPanelLane({ viewportHeight, top, textScale: scale });
      const signalHeight = 44 * scale;
      const contactHeight = 64 * scale;
      assert.ok(lane.panelHeight >= 120);
      assert.ok(lane.panelHeight <= previousPanel, 'larger text never grows the panel slot');
      previousPanel = lane.panelHeight;
      if (lane.panelHeight > 120) {
        assert.ok(top + lane.panelHeight + 8 + contactHeight <= viewportHeight * 0.82 + 0.01);
        assert.ok(lane.signalTop + signalHeight <= viewportHeight * 0.82 + 0.01);
      }
    }
  }
  // At 100% the unmeasured defaults are the historical 60/44/64 px.
  assert.deepEqual(
    resolveCyberCockpitPanelLane({ viewportHeight: 790, top: 164 }),
    resolveCyberCockpitPanelLane({
      viewportHeight: 790,
      top: 164,
      launcherHeight: 60,
      signalHeight: 44,
      contactHeight: 64,
    }),
  );
  // Measured heights win over the scaled defaults.
  assert.deepEqual(
    resolveCyberCockpitPanelLane({ viewportHeight: 790, top: 164, signalHeight: 50, textScale: 1.3 }).signalTop,
    resolveCyberCockpitPanelLane({ viewportHeight: 790, top: 164, signalHeight: 50, launcherHeight: 78, contactHeight: 64 * 1.3 }).signalTop,
  );
});
