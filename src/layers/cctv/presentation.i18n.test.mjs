// The CCTV HUD summary shows the CAL badge, source kind and view band in the
// UI language; English keeps its codes, and unknown source codes stay codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../i18n/index.js';
import { createPresentation } from './presentation.js';

function summary(sourceKind) {
  const camera = {
    id: 'c1',
    city: 'Austin',
    name: 'Cam',
    rangeM: 100,
    fovDeg: 60,
    feedType: 'image',
  };
  const record = { camera };
  const presentation = createPresentation({
    state: {
      _records: [record],
      _healthById: new Map(sourceKind ? [['c1', { sourceKind }]] : []),
      _showProjection: false,
      _coverageMode: 'sector',
    },
    services: {},
    parts: {
      selection: { getActiveRecord: () => record },
      model: {
        sectorAreaKm2: () => 1,
        currentViewContext: () => 'street:1:2',
      },
      geometry: { coverageNeighborCount: () => 0 },
      calibration: { deriveCalBadge: () => 'raw-prior' },
    },
    source: {},
  });
  return presentation.buildSummaryText();
}

test('en: CAL, SRC and CONTEXT keep their English codes', () => {
  setLocale('en');
  assert.match(summary('upstream'), /CAL RAW PRIOR · SRC UPSTREAM/);
  assert.match(summary(null), /SRC IMAGE · STREET CONTEXT/);
  assert.match(summary('upstream-image'), /SRC UPSTREAM-IMAGE/);
});

test('fr: CAL, SRC and CONTEXT values are translated', () => {
  setLocale('fr');
  try {
    assert.match(
      summary('upstream'),
      /CAL ESTIM\. INITIALE · SRC AMONT · CONTEXTE RUE/,
    );
    assert.match(summary('upstream-image'), /SRC UPSTREAM-IMAGE/);
  } finally {
    setLocale('en');
  }
});
