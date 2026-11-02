#!/usr/bin/env node
/** Joint regression gate. Run ONLY after temporarily merging #1426 into #1146:
 * node --test scripts/qa-conae-intensity.mjs
 * Deterministic fixtures; does not establish live-provider availability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptFirmsRecords } from '../src/data/firmsAdapt.js';
import { createFirmsState } from '../src/layers/firms/state.js';
import { createIngestion } from '../src/layers/firms/ingestion.js';
import { createQueries } from '../src/layers/firms/queries.js';
import { createModel } from '../src/layers/firms/model.js';
import { createRendering } from '../src/layers/firms/rendering.js';
import { composeCatalog } from '../src/tools/catalog.js';
import { getActiveFires } from '../src/tools/queries/hazards.js';
import {
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
} from '../src/data/layerState.js';
import {
  createDefaultShareViewState,
  encodeShareView,
  decodeShareView,
} from '../src/share/viewCodec.js';

const now = Date.UTC(2026, 9, 27, 12);
const goes = {
  lat: -27.4,
  lon: -55.9,
  provider: 'conae-goes',
  instrument: 'GOES',
  satellite: 'GOES-19',
  acqMs: now - 60_000,
  frp: null,
  confidence: null,
  brightness: null,
};
const viirs = {
  lat: -27.4,
  lon: -55.8,
  frp: 20,
  confidence: 'n',
  instrument: 'VIIRS',
  satellite: 'N20',
  acqDate: '2026-10-27',
  acqTime: '1145',
};
const mixed = [
  goes,
  { ...goes, lon: -55.7, frp: 50 },
  { ...viirs, frp: 0, confidence: 'h' },
  { ...viirs, lon: -55.6, frp: 300, confidence: 'l' },
  { ...viirs, lon: -55.5 },
];
const config = { id: 'local-firms', source: 'NASA FIRMS' };
const services = {
  anchors: { fireAnchorHeight: () => 0 },
  sprites: {},
  context: { clearSelectedEntityContextForLayer() {} },
};
async function harness(fires = mixed, params = null) {
  const state = createFirmsState({ services, config });
  if (params) state._filter = { ...params };
  state._enabled = true;
  state._dataSource = {};
  const components = {
    rendering: { renderCurrentLod() {} },
    selection: {
      clearFireSelection() {
        state._selectedFire = null;
      },
    },
  };
  components.model = createModel({ layerState: state, services });
  components.ingestion = createIngestion({
    layerState: state,
    services,
    components,
    config,
    feed: {
      getSnapshot: async () => ({
        fires,
        fetchedAt: now,
        sourceLabel: 'NASA FIRMS + CONAE GOES',
        sources: [{ source: 'CONAE GOES', ok: true }],
      }),
    },
  });
  await components.ingestion.loadHeatmap();
  assert.equal(state._error, null);
  return {
    state,
    components,
    query: createQueries({ layerState: state, services, components, config })
      .methods,
  };
}
const modes = [
  [{ minFrp: 0, confidence: 'all' }, 5],
  [{ minFrp: 20, confidence: 'all' }, 3],
  [{ minFrp: 0, confidence: 'nominal' }, 2],
  [{ minFrp: 0, confidence: 'high' }, 1],
  [{ minFrp: 20, confidence: 'high' }, 0],
];

test('mixed ingestion, agent and analyst queries agree for defaults and restrictive filters', async () => {
  const { state, query } = await harness();
  const catalog = composeCatalog({
    tools: [getActiveFires],
    services: { fires: { getSnapshot: async () => ({ fires: mixed }) } },
  });
  for (const [params, count] of modes) {
    query.setParams(params);
    assert.equal(query.getStats().count, count);
    assert.equal(query.getStats().total, 5);
    const result = await catalog.call('get_active_fires', {
      area: { bbox: [-56, -28, -55, -27] },
      min_frp_mw: params.minFrp,
      confidence: params.confidence,
    });
    assert.equal(result.data.total, count);
    assert.deepEqual(
      result.data.rows.map((r) => r.lon).sort(),
      query
        .getAnalystRecords(20)
        .map((r) => r.lon)
        .sort(),
    );
  }
  query.setParams({ minFrp: 0, confidence: 'all' });
  assert.equal(
    state._fires.find((f) => f.provider === 'conae-goes').confidence,
    null,
  );
  const result = await catalog.call('get_active_fires', {
    area: { bbox: [-56, -28, -55, -27] },
  });
  const unknown = result.data.rows.find((r) => r.lon === goes.lon);
  assert.equal(unknown.frp_mw, null);
  assert.equal(unknown.confidence, null);
  assert.equal(unknown.source, 'CONAE GOES');
  assert.equal(unknown.acquired, '2026-10-27T11:59:00.000Z');
  assert.match(getActiveFires.description, /not confirmed wildfire/);
  state._selectedFire = state._fires[0];
  query.setParams({ minFrp: 20, confidence: 'high' });
  assert.equal(state._selectedFire, null);
});

test('CONAE alone needs no NASA key and restrictive filters do not mutate unknown measurements', async () => {
  const { state, query } = await harness([goes]);
  assert.equal(query.getStats().keyRequired, false);
  assert.equal(query.getStats().count, 1);
  for (const params of [
    { minFrp: 1 },
    { minFrp: 0, confidence: 'nominal' },
    { confidence: 'high' },
  ]) {
    query.setParams(params);
    assert.equal(query.getStats().count, 0);
    assert.equal(query.getStats().keyRequired, false);
  }
  query.setParams({ minFrp: 0, confidence: 'all' });
  assert.equal(query.getStats().count, 1);
  assert.equal(state._fires[0].frp, null);
  assert.equal(state._fires[0].confidence, null);
});

test('six measured colors and neutral unknown agree across sprites, cards and aggregated cells', async () => {
  const { state, components } = await harness();
  const model = components.model;
  for (const [frp, color] of [
    [0, 'blue'],
    [5, 'teal'],
    [20, 'lime'],
    [50, 'amber'],
    [100, 'orange'],
    [300, 'red'],
    [null, 'unknown'],
  ]) {
    const [fire] = adaptFirmsRecords([{ ...goes, frp }]);
    assert.equal(model.detectionColorStop(fire).name, color);
    assert.equal(
      model.buildSelectedFireCard(fire, now).accent,
      model.cellAccent(frp),
    );
    assert.deepEqual(
      model.heatColor(frp, 1),
      model.detectionColorStop(fire).color,
    );
  }
  state._fires = adaptFirmsRecords([goes, { ...goes, lon: -55.8 }]);
  state._cellCacheByGrid.clear();
  const rendering = createRendering({
    layerState: state,
    services,
    components,
    config,
  });
  const cells = rendering.aggregateFires(
    { gridDegrees: 1, maxCells: 100 },
    null,
  );
  assert.equal(cells[0].maxFrp, null);
  assert.equal(cells[0].count, 2);
  assert.equal(
    model.buildCellCard(
      {
        cell: cells[0],
        position: {},
        accent: model.cellAccent(cells[0].maxFrp),
      },
      now,
    ).title,
    '2 DETECTIONS',
  );
  const card = model.buildSelectedFireCard(state._fires[0], now);
  assert.match(card.details.join(' '), /confidence not published.*CONAE|CONAE/);
  assert.match(card.details.join(' '), /not a confirmed wildfire/);
});

test('legacy and compact share codecs restore mixed-layer filters before and after ingestion', async () => {
  for (const [params, count] of modes) {
    const layerState = createDefaultLayerState();
    layerState.enabledLayerIds = ['local-firms'];
    layerState.options['local-firms'] = params;
    const encoded = new URLSearchParams();
    encodeLayerStateParams(encoded, layerState);
    encoded.set('v', '2');
    const legacy = decodeLayerStateParams(encoded);
    const view = createDefaultShareViewState();
    view.layerState = layerState;
    const decoded = decodeShareView(encodeShareView(view));
    assert.equal(decoded.ok, true);
    for (const restored of [
      legacy.options['local-firms'],
      decoded.state.layerState.options['local-firms'],
    ]) {
      assert.deepEqual(restored, params);
      const { query } = await harness();
      query.setParams(restored);
      assert.equal(query.getStats().count, count);
      const beforeLoad = await harness(mixed, restored);
      assert.equal(beforeLoad.query.getStats().count, count);
    }
  }
});
