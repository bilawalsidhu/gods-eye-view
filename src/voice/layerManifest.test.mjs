import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICATION_LAYER_METADATA } from '../app/constructCatalog.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { ANALYST_LAYERS } from '../data/analystEngine.js';
import {
  VOICE_LAYER_MANIFEST,
  VOICE_OFF_LAYERS,
  VOICE_TOGGLE_LAYER_IDS,
  VOICE_CONTEXT_LAYER_IDS,
  VOICE_QUERY_LAYER_IDS,
  voiceLayerAliasMap,
} from './layerManifest.js';

const catalogIds = APPLICATION_LAYER_METADATA.map((layer) => layer.id);
const manifestIds = VOICE_LAYER_MANIFEST.map((entry) => entry.id);
const tool = (name) => GEV_REALTIME_TOOLS.find((entry) => entry.name === name);

test('every catalog layer is in the voice manifest or explicitly voice-off', () => {
  const missing = catalogIds.filter(
    (id) => !manifestIds.includes(id) && !Object.hasOwn(VOICE_OFF_LAYERS, id),
  );
  assert.deepEqual(missing, [], `add a voice manifest entry for: ${missing.join(', ')}`);
  for (const id of Object.keys(VOICE_OFF_LAYERS)) {
    assert.ok(catalogIds.includes(id), `${id} is voice-off but not in the catalog`);
    assert.ok(!manifestIds.includes(id), `${id} is both voice-off and in the manifest`);
  }
  const unknown = manifestIds.filter((id) => !catalogIds.includes(id));
  assert.deepEqual(unknown, [], 'the manifest names only catalog layers');
  assert.equal(new Set(manifestIds).size, manifestIds.length, 'one entry per layer');
});

test('each layer declares a query or the reason it has none', () => {
  for (const entry of VOICE_LAYER_MANIFEST) {
    assert.ok(
      Boolean(entry.query) !== Boolean(entry.noQuery),
      `${entry.id} needs exactly one of query / noQuery`,
    );
    if (entry.query) assert.ok(Object.keys(entry.query.fields).length > 0);
  }
});

test('tool enums are generated from the manifest', () => {
  const toggle = tool('set_layer_visibility').parameters.properties.layerId.enum;
  assert.deepEqual(toggle, [...VOICE_TOGGLE_LAYER_IDS]);
  for (const id of [
    'transit',
    'recent-imagery',
    'wind',
    'weather-radar',
    'weather-satellite',
    'weather-lightning',
    'weather-cyclones',
    'military-installations',
    'directions',
    'rocket-launches',
    'bikeshare',
    'local-adsb',
  ])
    assert.ok(toggle.includes(id), `${id} is voice-toggleable`);
  assert.ok(!toggle.includes('military-awareness'), 'Global Context is reached through set_context_mode');
  assert.deepEqual(
    tool('show_data_layers_menu').parameters.properties.layerId.enum,
    [...VOICE_TOGGLE_LAYER_IDS],
  );
  assert.deepEqual(
    tool('get_entity_context').parameters.properties.layerId.enum,
    [...VOICE_CONTEXT_LAYER_IDS],
  );
  assert.ok(!VOICE_CONTEXT_LAYER_IDS.includes('telegeography-submarine-cables'), 'cables register no context records');
  assert.deepEqual(
    tool('analyst_query').parameters.properties.layers.items.enum,
    [...VOICE_QUERY_LAYER_IDS],
  );
  assert.deepEqual(Object.keys(ANALYST_LAYERS), [...VOICE_QUERY_LAYER_IDS]);
  const panels = tool('set_panel_open').parameters.properties.panelId.enum;
  assert.ok(panels.includes('weather-panel') && panels.includes('recent-imagery-panel'));
});

test('spoken aliases resolve to real layers, keep every legacy phrase and never collide', () => {
  const aliases = voiceLayerAliasMap();
  for (const id of aliases.values()) assert.ok(manifestIds.includes(id), id);
  const legacy = {
    planes: 'flights', aircraft: 'flights', 'military flights': 'military', quakes: 'earthquakes',
    'space mission': 'rocket-launches', 'space missions': 'rocket-launches', missions: 'rocket-launches',
    'street traffic': 'traffic', cameras: 'cctv', 'internet radio': 'radio', 'radio stations': 'radio',
    bikes: 'bikeshare', ais: 'ais-live-vessels', ships: 'ais-live-vessels', vessels: 'ais-live-vessels',
    'live vessels': 'ais-live-vessels', datacenters: 'local-datacenters', 'data centers': 'local-datacenters',
    'data centres': 'local-datacenters', dams: 'local-dams', 'submarine cables': 'telegeography-submarine-cables',
    cables: 'telegeography-submarine-cables', telegeography: 'telegeography-submarine-cables',
    firms: 'local-firms', fires: 'local-firms', 'active fires': 'local-firms', alpr: 'alpr-cameras',
    'alpr cameras': 'alpr-cameras', 'flock cameras': 'alpr-cameras', 'license plate readers': 'alpr-cameras',
    'license plate cameras': 'alpr-cameras', 'plate readers': 'alpr-cameras', 'local-adsb': 'local-adsb',
    'local adsb': 'local-adsb', 'local ads-b': 'local-adsb', 'my receiver': 'local-adsb',
    'my antenna': 'local-adsb', 'my sdr': 'local-adsb',
  };
  for (const [phrase, id] of Object.entries(legacy)) assert.equal(aliases.get(phrase), id, phrase);
  const added = {
    buses: 'transit', trains: 'transit', hurricanes: 'weather-cyclones', cyclones: 'weather-cyclones',
    'weather radar': 'weather-radar', lightning: 'weather-lightning', 'military bases': 'military-installations',
    'recent imagery': 'recent-imagery', 'bike share': 'bikeshare', 'rocket launches': 'rocket-launches',
    wind: 'wind', directions: 'directions', 'fire perimeters': 'fire-perimeters',
    'wildfire perimeters': 'fire-perimeters', 'burn areas': 'fire-perimeters',
  };
  for (const [phrase, id] of Object.entries(added)) assert.equal(aliases.get(phrase), id, phrase);
  const claimed = new Map();
  for (const entry of VOICE_LAYER_MANIFEST)
    for (const alias of entry.aliases) {
      assert.ok(!claimed.has(alias), `"${alias}" claimed by ${claimed.get(alias)} and ${entry.id}`);
      claimed.set(alias, entry.id);
    }
});
