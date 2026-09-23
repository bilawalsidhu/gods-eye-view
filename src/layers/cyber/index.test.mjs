import test from 'node:test';
import assert from 'node:assert/strict';
import { createCyberLayer } from './index.js';

class EntityCollection {
  values = [];
  add(value) {
    const item = { ...value };
    this.values.push(item);
    return item;
  }
  getById(id) {
    return this.values.find((item) => item.id === id);
  }
  remove(entity) {
    this.values = this.values.filter((item) => item !== entity);
  }
  removeAll() {
    this.values = [];
  }
}
class CustomDataSource {
  constructor(name) {
    this.name = name;
    this.entities = new EntityCollection();
  }
}
const color = { withAlpha: () => color };
const cesium = {
  CustomDataSource,
  Cartesian3: {
    fromDegrees: (longitude, latitude) => ({ longitude, latitude }),
  },
  Color: { ORANGERED: color, DEEPSKYBLUE: color, WHITE: color },
  HeightReference: { CLAMP_TO_GROUND: 0 },
};

const radar = {
  provider: 'cloudflare-radar',
  fetchedAt: '2026-09-20T01:00:00Z',
  stale: false,
  observations: [
    {
      id: 'cloudflare-radar:origin:US',
      category: 'layer7-attack-origin',
      provider: 'cloudflare-radar',
      locationName: 'United States',
      locationCode: 'US',
      latitude: 39.8,
      longitude: -98.6,
      geographicPrecision: 'country',
      geographicMethod: 'Country reference',
      geographicProvenance: 'United States; aggregate',
      share: 5,
      rank: 1,
      windowStart: '2026-09-19T00:00:00Z',
      windowEnd: '2026-09-20T00:00:00Z',
      detail: 'Country aggregate only',
    },
  ],
};
const dshield = {
  provider: 'dshield',
  fetchedAt: '2026-09-20T01:00:00Z',
  stale: false,
  observations: [
    {
      id: 'dshield:top-ip:1:192.0.2.1',
      provider: 'dshield',
      category: 'reported-top-source-ip',
      indicator: { type: 'ipv4', value: '192.0.2.1' },
      rank: 1,
      hostname: null,
    },
  ],
  ports: [{ rank: 1, port: 443, protocol: 'tcp', label: 'https' }],
  notice: 'not a blocklist',
};

test('renders Radar aggregates only and keeps DShield in the non-geographic row list', async () => {
  const layer = createCyberLayer({
    source: {
      getRadarSnapshot: async () => radar,
      getDshieldSnapshot: async () => dshield,
    },
    cesium,
  });
  const viewer = { dataSources: { add: () => {}, remove: () => {} } };
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  const rows = layer.getRowControls();
  assert.equal(layer.getStats().count, 1);
  assert.equal(rows.list.items.length, 3);
  assert.ok(
    rows.list.items.some((row) => row.text.includes('no geographic data')),
  );
  assert.equal(
    layer.getAnalystRecords().find((row) => row.provider === 'dshield')
      .latitude,
    undefined,
  );
  const rendered = layer.getStats().count;
  assert.equal(rendered, 1);
  layer.destroy();
});

test('provider errors remain isolated and provider toggles remove their records', async () => {
  let radarCalls = 0;
  const layer = createCyberLayer({
    source: {
      getRadarSnapshot: async () => {
        radarCalls++;
        throw new Error('Radar offline');
      },
      getDshieldSnapshot: async () => dshield,
    },
    cesium,
  });
  layer.init({ dataSources: { add: () => {}, remove: () => {} } });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().dshieldCount, 1);
  assert.equal(layer.getStats().keyRequired, false);
  assert.equal(layer.getStats().error, null);
  layer.setParams({ dshieldEnabled: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(layer.getParams().dshieldEnabled, false);
  layer.disable();
  assert.equal(radarCalls, 2);
  layer.destroy();
});
