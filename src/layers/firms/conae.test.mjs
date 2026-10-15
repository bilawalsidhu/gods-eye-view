import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptFirmsRecords } from '../../data/firmsAdapt.js';
import { fireDetectionKey } from '../../data/firmsLabels.js';
import { createModel } from './model.js';
import { createIngestion } from './ingestion.js';
import { createQueries } from './queries.js';
import { createSelection } from './selection.js';

const NOW = Date.UTC(2026, 9, 15, 4);
const raw = {
  lat: -27.4,
  lon: -55.9,
  provider: 'conae-goes',
  frp: 12.5,
  brightness: null,
  confidence: null,
  instrument: 'GOES',
  satellite: 'GOES-19',
  acqMs: NOW - 60_000,
};
const services = { anchors: { fireAnchorHeight: () => 0 } };
const model = createModel({ layerState: {}, services });
const [fire] = adaptFirmsRecords([raw]);

test('GOES keeps unknown measurements and source identity through cards and analyst records', () => {
  assert.equal(fire.confidence, null);
  assert.equal(fire.brightness, null);
  assert.equal(fire.acqMs, raw.acqMs);
  const selected = model.buildSelectedFireCard(fire, NOW);
  assert.match(selected.title, /THERMAL DETECTION/);
  assert.match(selected.details.join(' '), /confidence not published/);
  assert.match(selected.details.join(' '), /CONAE GOES/);
  assert.doesNotMatch(selected.details.join(' '), /low conf/);
  const ambient = model.buildFireCard({ fire, position: {} }, NOW);
  assert.match(ambient.details[0], /GOES-19.*CONAE/);
  const record = model.mapAnalystRecord(fire);
  assert.equal(record.source, 'CONAE GOES');
  assert.equal(record.confidence, null);
  assert.equal(record.acqTime, raw.acqMs);
  const [unknown] = adaptFirmsRecords([{ ...raw, frp: null }]);
  assert.equal(unknown.frp, null);
  assert.match(model.buildSelectedFireCard(unknown, NOW).title, /FRP n\/a/);
  assert.equal(model.mapAnalystRecord(unknown).frp, null);
});

test('GOES acquisition and provider identities do not collapse into FIRMS or other satellites', () => {
  assert.notEqual(
    fireDetectionKey(fire),
    fireDetectionKey({ ...fire, provider: 'firms' }),
  );
  assert.notEqual(
    fireDetectionKey(fire),
    fireDetectionKey({ ...fire, satellite: 'GOES-16' }),
  );
  assert.notEqual(
    fireDetectionKey(fire),
    fireDetectionKey({ ...fire, acqMs: fire.acqMs + 600_000 }),
  );
  assert.equal(
    fireDetectionKey(fire),
    fireDetectionKey({ ...fire, index: 99 }),
  );
});

test('mixed cells count observations and do not invent an FRP measurement', () => {
  const card = model.buildCellCard(
    {
      cell: { count: 2, maxFrp: null, hasConae: true },
      position: {},
    },
    NOW,
  );
  assert.equal(card.title, '2 DETECTIONS');
  assert.equal(card.details[0], 'FRP n/a');
});

test('keyless CONAE ingestion exposes partial provider failures and correct selection context', async () => {
  const sources = [
    { source: 'NASA FIRMS', ok: false, count: 0 },
    { source: 'CONAE GOES', ok: true, count: 1 },
  ];
  const state = {
    _dataSource: {},
    _enabled: true,
    _fires: [],
    _cellCacheByGrid: new Map(),
    _contextIds: new Set(),
    _selectedFire: null,
  };
  let context;
  const svc = {
    ...services,
    picking: {},
    focus: {},
    context: {
      clearSelectedEntityContextForLayer() {},
      registerEntityContext(entity, record) {
        context = record;
      },
    },
  };
  const components = {
    model,
    rendering: { renderCurrentLod() {} },
    selection: {},
  };
  const config = {
    id: 'local-firms',
    name: 'Active Fires',
    source: 'NASA FIRMS',
  };
  const feed = {
    getSnapshot: async () => ({
      fires: [raw],
      fetchedAt: NOW,
      stale: false,
      sourceLabel: 'CONAE GOES',
      sources,
    }),
  };
  await createIngestion({
    layerState: state,
    services: svc,
    components,
    config,
    feed,
  }).loadHeatmap();
  const query = createQueries({
    layerState: state,
    services: svc,
    components,
    config,
  }).methods;
  assert.equal(query.getStats().keyRequired, false);
  assert.equal(query.getStats().count, 1);
  assert.match(query.getStats().error, /PARTIAL.*NASA FIRMS/);
  assert.equal(state._sourceLabel, 'CONAE GOES');
  state._selectedFire = state._fires[0];
  assert.equal(query.getSelectedInfo().confidencePct, null);
  assert.equal(query.getSelectedInfo().source, 'CONAE GOES');
  createSelection({
    layerState: state,
    services: svc,
    components,
    config,
  }).registerFireContext(state._selectedFire);
  assert.equal(context.source, 'CONAE GOES');
  assert.equal(context.properties.confidence, 'not published');
  assert.match(context.label, /Thermal detection/);
});
