import { layerFeedState } from '../../data/feedState.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChesterCountyEmsLayer } from './index.js';
import { createCountyFilterPreferences, COUNTY_FILTER_STORAGE_KEY } from './filterPreferences.js';

function setup(source, options = {}) {
  const entries = new Map();
  let entities;
  const viewer = {
    dataSources: {
      add(source) {
        entities = source.entities;
      },
      remove() {},
    },
    scene: { requestRender() {} },
    camera: { flyTo() {} },
  };
  const layer = createChesterCountyEmsLayer({
    source,
    ...options,
    overlayHost: {
      setVisible() {},
      clearSource(id) {
        entries.delete(id);
      },
      setEntries(id, rows) {
        entries.set(id, rows);
      },
    },
  });
  layer.init(viewer);
  layer.enable();
  return { layer, entries, entities };
}
const row = {
  id: 'ems:F26000001',
  incidentNumber: 'F26000001',
  category: 'ems',
  municipality: 'Example Township',
  mapPosition: { lat: 40, lon: -75.7, kind: 'intersection', approximate: true },
  type: 'TEST',
  location: 'EXAMPLE RD',
  dispatched: '11-03-2026 10:00:00',
  station: '01',
};
const snapshot = (rows) => ({
  rows,
  fetchedAt: Date.now(),
  observedAt: Date.now(),
  stale: false,
});
test('explicit filters survive layer recreation; transient changes and incident selection never overwrite saved choices', async () => {
  const saved = new Map();
  const storage = () => ({getItem:(key)=>saved.get(key),setItem:(key,value)=>saved.set(key,value)});
  const boot = () => setup({getSnapshot:async()=>snapshot([row])}, {filterPreferences:createCountyFilterPreferences({storage})}).layer;
  let layer = boot();
  layer.setParams({categories:['ems'],counties:['montgomery-pa']},{origin:'user'});
  layer.setParams({categories:['fire']},{origin:'scene'});
  layer.setParams({counties:['chester-pa']},{origin:'user'});
  const beforeSelection = saved.get(COUNTY_FILTER_STORAGE_KEY);
  await layer.update(); layer.setParams({selectedIncident:row.id},{origin:'user'});
  assert.equal(saved.get(COUNTY_FILTER_STORAGE_KEY),beforeSelection);
  layer.disable(); layer.destroy();
  layer = boot();
  assert.deepEqual(layer.getParams(),{categories:['ems'],counties:['chester-pa']});
  assert.equal(layer.getIncidentPanelState().list.items.some(item=>item.active),false);
  layer.setParams({categories:[],counties:[]},{origin:'tool'}); layer.destroy();
  layer = boot(); assert.deepEqual(layer.getParams(),{categories:[],counties:[]});layer.destroy();
});
test('Pike starts unchecked and list-only public details remain accessible without a map target', async () => {
  const pike = { ...row, id:'pike-pa:fire:2611000001', incidentNumber:'2611000001', countyId:'pike-pa',category:'fire',mapPosition:null,locationStatus:'not-published',reportKind:'completed',timeBasis:'received',detailUrl:'https://webcad.pikepa.org/pages/public/FeedReader.asp' };
  const {layer,entities,entries} = setup({getSnapshot:async()=>snapshot([pike]),getIncidentDetails:async()=>({id:pike.id,incidentNumber:pike.incidentNumber,observedAt:Date.now(),assignmentOnly:true,units:[{unit:'TEST01',status:'Assigned',entered:'',enteredAt:null}]})});
  await layer.update();
  assert.equal(layer.getIncidentPanelState().counties.length,9);
  assert.equal(layer.getIncidentPanelState().counties.find(c=>c.id==='pike-pa').active,false);
  assert.deepEqual(layer.getRowControls().chips.map(c=>c.id),['fire','ems','traffic']);
  assert.equal(layer.getIncidentPanelState().list.items.length,0);
  layer.setParams({counties:['pike-pa'],selectedIncident:pike.id});await settle();
  assert.equal(entities.values.length,0); assert.equal(entries.has('chester-county-ems-selected'),false);
  const selection=layer.getIncidentPanelState().selection;
  assert.match(selection.lines.join(' '),/Completed report; not an active incident/);
  assert.match(selection.lines.join(' '),/TEST01 · Assigned/);
  assert.equal(layer.getIncidentPanelState().chips.some(c=>c.id.startsWith('source:')),false);
  layer.setParams({categories:[]});assert.equal(layer.getIncidentPanelState().selection,null);
  layer.destroy();
});
test('renders individual street markers, selects card, removes expired incidents and tears down', async () => {
  let rows = [row, { ...row, id: 'F26000002' }];
  const { layer, entries, entities } = setup({
    getSnapshot: async () => snapshot(rows),
  });
  await layer.update();
  assert.equal(entries.has('chester-county-ems'), false);
  assert.equal(entities.values.length, 2);
  assert.equal(layer.getStats().count, 2);
  assert.equal(
    layer.getRowControls().list,
    undefined,
    'active reports belong to the dedicated app, not the Data Layers row',
  );
  layer.setParams({ selectedIncident: row.id });
  assert.doesNotMatch(
    entries.get('chester-county-ems-selected')[0].details.join(' '),
    /Approximate intersection/,
  );
  rows = [];
  await layer.update();
  assert.equal(layer.getStats().count, 0);
  assert.equal(entries.has('chester-county-ems-selected'), false);
  layer.destroy();
  assert.equal(entries.size, 0);
});
test('late response after disable cannot repaint', async () => {
  let finish;
  const { layer, entries } = setup({
    getSnapshot: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = layer.update();
  layer.disable();
  finish(snapshot([row]));
  assert.equal(await pending, false);
  assert.equal(entries.size, 0);
  assert.equal(layer.getStats().count, 0);
  layer.destroy();
});
test('failed refresh retains last report as stale; unlocated reports stay in list', async () => {
  let fail = false;
  const { layer } = setup({
    getSnapshot: async () => {
      if (fail) throw new Error('offline');
      return snapshot([{ ...row, mapPosition: null }]);
    },
  });
  await layer.update();
  assert.equal(layer.getIncidentPanelState().list.items.length, 1);
  fail = true;
  await layer.update();
  assert.equal(layer.getStats().stale, true);
  assert.match(
    layer.getIncidentPanelState().info,
    /County incidents unavailable/,
  );
  assert.equal(layer.getStats().count, 1);
  layer.destroy();
});

test('three categories have distinct flame, red cross and siren billboards', async () => {
  const rows = ['fire', 'ems', 'traffic'].map((category) => ({
    ...row,
    category,
    id: `${category}:test`,
  }));
  const { layer, entities } = setup({
    getSnapshot: async () => snapshot(rows),
  });
  await layer.update();
  const images = entities.values.map((e) =>
    decodeURIComponent(e.billboard.image.getValue()),
  );
  assert.equal(new Set(images).size, 3);
  assert.match(images[0], /#ff761a/);
  assert.match(images[1], /#ed2438/);
  assert.match(images[2], /#3285ff/);
  layer.destroy();
});

test('fresh unresolved records show explicit coverage without claiming feed degradation', async () => {
  const { layer } = setup({
    getSnapshot: async () => ({
      ...snapshot([{ ...row, mapPosition: null, locationStatus: 'unmatched' }]),
      locationCoverage: { matched: 0, unmatched: 1, unavailable: 0 },
    }),
  });
  await layer.update();
  assert.equal(layerFeedState(layer.getStats()), 'nominal');
  assert.equal(layer.getStats().unresolvedCount, 1);
  assert.match(
    layer.getIncidentPanelState().info,
    /0 mapped · 1 unresolved · 0 lookup errors/,
  );
  assert.match(
    layer.getIncidentPanelState().list.items[0].text,
    /No location match/,
  );
  layer.destroy();
});
test('actual GIS errors remain degraded and feed staleness takes precedence', async () => {
  let isStale = false;
  const { layer } = setup({
    getSnapshot: async () => ({
      ...snapshot([
        { ...row, mapPosition: null, locationStatus: 'unavailable' },
      ]),
      stale: isStale,
      locationCoverage: { matched: 0, unmatched: 0, unavailable: 1 },
    }),
  });
  await layer.update();
  assert.equal(layerFeedState(layer.getStats()), 'degraded');
  assert.match(layer.getIncidentPanelState().info, /1 lookup errors/);
  isStale = true;
  await layer.update();
  assert.equal(layerFeedState(layer.getStats()), 'stale');
  layer.destroy();
});

const linkedRow = {
  ...row,
  detailUrl:
    'https://webcad.chesco.org/WebCad/livecadcomments-ems.asp?eid=123&incidentno=F26000001',
};
const units = {
  observedAt: Date.now(),
  units: [
    { unit: 'MEDIC01', status: 'On Scene', entered: '11-03-2026 10:05:00' },
  ],
  stale: false,
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
test('clicking an icon opens the enriched source card, respects pointer ownership and cleans up picking', async () => {
  let click,
    picked,
    owned,
    destroyed = 0,
    free = true,
    opened;
  const { layer, entries } = setup(
    {
      getSnapshot: async () => snapshot([linkedRow]),
      getIncidentDetails: async () => units,
    },
    {
      picking: {
        registerPickOwner(id, predicate) {
          owned = predicate;
        },
        unregisterPickOwner() {
          owned = null;
        },
        resolvePickId: (p) => p?.id,
        isOwnedByOtherLayer: () => false,
      },
      pointer: { isPointerFree: () => free },
      screenSpaceEventHandlerFactory(viewer) {
        viewer.scene.pick = () => picked;
        return {
          setInputAction(fn) {
            click = fn;
          },
          destroy() {
            destroyed++;
          },
        };
      },
      openExternal: (url) => {
        opened = url;
      },
    },
  );
  await layer.update();
  assert.equal(entries.has('chester-county-ems-selected'), false);
  assert.equal(owned(`chester-county-ems:${row.id}`), true);
  picked = { id: `chester-county-ems:${row.id}` };
  free = false;
  click({ position: { x: 1, y: 1 } });
  assert.equal(entries.has('chester-county-ems-selected'), false);
  free = true;
  click({ position: { x: 1, y: 1 } });
  await settle();
  const card = entries.get('chester-county-ems-selected')[0];
  assert.match(card.details.join(' '), /MEDIC01 · On Scene/);
  assert.doesNotMatch(card.details.join(' '), /Approximate intersection/);
  assert.equal(card.activate(), true);
  assert.equal(opened, linkedRow.detailUrl);
  picked = null;
  click({ position: { x: 2, y: 2 } });
  assert.equal(entries.has('chester-county-ems-selected'), false);
  layer.disable();
  assert.equal(owned, null);
  assert.equal(destroyed, 1);
  layer.destroy();
});
test('old detail responses cannot populate another incident or revive a disabled card', async () => {
  const pending = [];
  const other = {
    ...linkedRow,
    id: 'ems:F26000002',
    incidentNumber: 'F26000002',
    detailUrl: linkedRow.detailUrl.replace('F26000001', 'F26000002'),
  };
  const { layer, entries } = setup({
    getSnapshot: async () => snapshot([linkedRow, other]),
    getIncidentDetails: (id, { signal }) =>
      new Promise((resolve) => pending.push({ id, signal, resolve })),
  });
  await layer.update();
  layer.setParams({ selectedIncident: linkedRow.id });
  layer.setParams({ selectedIncident: other.id });
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(units);
  await settle();
  assert.doesNotMatch(
    entries.get('chester-county-ems-selected')[0].details.join(' '),
    /MEDIC01/,
  );
  layer.disable();
  pending[1].resolve(units);
  await settle();
  assert.equal(entries.has('chester-county-ems-selected'), false);
  layer.destroy();
});
test('selected unit failures keep the summary and previous units without degrading the feed', async () => {
  let fail = false;
  const { layer, entries } = setup({
    getSnapshot: async () => snapshot([linkedRow]),
    getIncidentDetails: async () => {
      if (fail) throw new Error('offline');
      return units;
    },
  });
  await layer.update();
  layer.setParams({ selectedIncident: linkedRow.id });
  await settle();
  fail = true;
  await layer.update();
  await settle();
  const text = entries.get('chester-county-ems-selected')[0].details.join(' ');
  assert.match(text, /MEDIC01/);
  assert.match(text, /Unit status is stale/);
  assert.equal(layerFeedState(layer.getStats()), 'nominal');
  layer.destroy();
});

test('category filters affect the map and app list without refetching or dropping feed coverage', async () => {
  let fetches = 0;
  const rows = ['fire', 'ems', 'traffic'].map((category) => ({
    ...row,
    id: `${category}:test`,
    category,
  }));
  const { layer, entities, entries } = setup({
    getSnapshot: async () => {
      fetches++;
      return snapshot(rows);
    },
  });
  await layer.update();
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.chips.map(({ id, label, active }) => ({ id, label, active })),
    [
      { id: 'fire', label: 'Fire', active: true },
      { id: 'ems', label: 'EMS', active: true },
      { id: 'traffic', label: 'Traffic', active: true },
    ],
  );
  let rowChanges = 0,
    appChanges = 0;
  layer.setRowControlsListener(() => rowChanges++);
  const unsubscribe = layer.subscribeIncidentPanel(() => appChanges++);
  layer.setParams({ selectedIncident: 'ems:test' });
  assert.ok(entries.has('chester-county-ems-selected'));
  layer.setParams(controls.chips.find(({ id }) => id === 'ems').params);
  assert.ok(rowChanges > 0);
  assert.ok(appChanges > 0);
  assert.deepEqual(layer.getIncidentPanelState().categories, [
    'fire',
    'traffic',
  ]);
  assert.equal(
    layer.getRowControls().chips.find(({ id }) => id === 'ems').active,
    false,
  );
  assert.equal(entries.has('chester-county-ems-selected'), false);
  assert.equal(entities.values.length, 2);
  assert.equal(layer.getIncidentPanelState().list.items.length, 2);
  assert.equal(layer.getStats().count, 3);
  assert.equal(layer.getStats().displayCount, 2);
  layer.setParams({ selectedIncident: 'ems:test' });
  assert.equal(entries.has('chester-county-ems-selected'), false);
  layer.setParams({ categories: [] });
  assert.equal(entities.values.length, 0);
  assert.match(layer.getIncidentPanelState().info, /No matching incidents/);
  assert.equal(layer.getIncidentPanelState().enabled, true);
  layer.setParams({ categories: ['fire', 'ems', 'traffic'] });
  assert.equal(entities.values.length, 3);
  assert.ok(layer.getRowControls().chips.every(({ active }) => active));
  layer.setParams({ categories: ['invalid'] });
  assert.deepEqual(layer.getParams().categories, ['fire', 'ems', 'traffic']);
  assert.equal(fetches, 1);
  unsubscribe();
  layer.setRowControlsListener(null);
  const detachedCounts = [rowChanges, appChanges];
  layer.setParams({ categories: [] });
  assert.deepEqual([rowChanges, appChanges], detachedCounts);
  layer.destroy();
});

test('county filters isolate map/list selection and preserve independent county health on cards', async () => {
  const montgomery = {
    ...row,
    id: 'montgomery-pa:ems:E2600001',
    incidentNumber: 'E2600001',
    countyId: 'montgomery-pa',
    county: 'Montgomery County, PA',
    detailUrl:
      'https://webapp07.montcopa.org/eoc/cadinfo/livecad-incidents.asp?incident=E2600001',
  };
  const { layer, entities, entries } = setup({
    getSnapshot: async () => ({
      ...snapshot([row, montgomery]),
      stale: true,
      countyFeeds: [
        {
          id: 'chester-pa',
          county: 'Chester County, PA',
          stale: true,
          count: 1,
          observedAt: Date.now(),
        },
        {
          id: 'montgomery-pa',
          county: 'Montgomery County, PA',
          stale: false,
          count: 1,
          observedAt: Date.now(),
        },
      ],
    }),
    getIncidentDetails: async () => ({ ...units, timestampBasis: 'retrieved' }),
  });
  await layer.update();
  layer.setParams({ selectedIncident: montgomery.id });
  await settle();
  const card = entries.get('chester-county-ems-selected')[0];
  assert.match(card.details.join(' '), /County: Montgomery County, PA/);
  assert.match(card.details.join(' '), /Unit status checked:/);
  assert.equal(card.details.includes('Stale data'), false);
  layer.setParams({ counties: ['chester-pa'] });
  assert.equal(entities.values.length, 1);
  assert.equal(entries.has('chester-county-ems-selected'), false);
  assert.deepEqual(
    layer.getIncidentPanelState().list.items.map((r) => r.id),
    [row.id],
  );
  assert.equal(
    layer.getIncidentPanelState().counties.find((c) => c.id === 'montgomery-pa')
      .active,
    false,
  );
  layer.setParams({ counties: [] });
  assert.equal(entities.values.length, 0);
  assert.match(layer.getIncidentPanelState().info, /No matching incidents/);
  layer.setParams({ counties: ['unknown'] });
  assert.deepEqual(layer.getParams().counties, []);
  layer.destroy();
});

test('Lancaster public reports and Delco dispatch cards never claim unpublished statuses or expose internal IDs', async () => {
  const lancaster = {
    ...row,
    id: 'lancaster-pa:ems:' + 'a'.repeat(24),
    countyId: 'lancaster-pa',
    incidentNumber: null,
    detailUrl: 'https://www.lcwc911.us/live-incident-list',
  };
  const delco = {
    ...row,
    id: 'delaware-pa:ems:F26000001',
    countyId: 'delaware-pa',
    reportKind: 'dispatch',
    timeBasis: 'received',
    sourceName: 'Delco Dispatch',
    detailUrl: 'https://delcodispat.ch/d/pa/delco',
  };
  const { layer, entries, entities } = setup({
    getSnapshot: async () => snapshot([lancaster, delco]),
    getIncidentDetails: async (id) => ({
      id,
      incidentNumber: id === lancaster.id ? null : row.incidentNumber,
      observedAt: Date.now(),
      timestampBasis: 'retrieved',
      assignmentOnly: true,
      units: [{ unit: 'AMB01', status: 'Assigned', entered: '' }],
    }),
  });
  await layer.update();
  layer.setParams({ selectedIncident: delco.id });
  await settle();
  let card = entries.get('chester-county-ems-selected')[0];
  assert.match(
    card.details.join(' '),
    /Recent dispatch; active status unknown/,
  );
  assert.match(card.details.join(' '), /Community source: Delco Dispatch/);
  assert.match(card.details.join(' '), /Received:/);
  assert.match(card.details.join(' '), /Assignments checked:/);
  assert.match(card.details.join(' '), /AMB01 · Assigned/);
  assert.doesNotMatch(card.details.join(' '), /Unit status updated:/);
  layer.setParams({ counties: ['lancaster-pa'] });
  assert.equal(entities.values.length, 1);
  assert.equal(entries.has('chester-county-ems-selected'), false);
  layer.setParams({ selectedIncident: lancaster.id });
  await settle();
  card = entries.get('chester-county-ems-selected')[0];
  assert.match(card.title, /Public report/);
  assert.equal(card.title.includes('a'.repeat(24)), false);
  layer.destroy();
});
