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
let latestSelectionHandler;
const cesium = {
  CustomDataSource,
  PolylineArrowMaterialProperty: class {
    constructor(color) {
      this.color = color;
    }
  },
  ScreenSpaceEventHandler: class {
    constructor() {
      this.actions = new Map();
      latestSelectionHandler = this;
    }
    setInputAction(callback, type) {
      this.actions.set(type, callback);
    }
    destroy() {
      this.destroyed = true;
    }
  },
  ScreenSpaceEventType: { LEFT_CLICK: 'left-click' },
  ArcType: { NONE: 'none' },
  Cartesian3: {
    fromDegrees: (longitude, latitude, height = 0) => ({
      longitude,
      latitude,
      height,
    }),
  },
  Color: {
    ORANGERED: color,
    DEEPSKYBLUE: color,
    MEDIUMPURPLE: color,
    WHITE: color,
    GOLD: color,
  },
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
    {
      id: 'cloudflare-radar:target:US',
      category: 'layer7-attack-target',
      provider: 'cloudflare-radar',
      locationName: 'United States',
      locationCode: 'US',
      latitude: 39.8,
      longitude: -98.6,
      geographicPrecision: 'country',
      geographicMethod: 'Country reference',
      geographicProvenance: 'United States; aggregate',
      share: 7,
      rank: 2,
      windowStart: '2026-09-19T00:00:00Z',
      windowEnd: '2026-09-20T00:00:00Z',
      detail: 'Country aggregate only',
    },
  ],
  flows: [
    {
      id: 'cloudflare-radar:flow:US:CA',
      provider: 'cloudflare-radar',
      origin: {
        code: 'US',
        name: 'United States',
        latitude: 39.8,
        longitude: -98.6,
      },
      target: { code: 'CA', name: 'Canada', latitude: 56.1, longitude: -106.3 },
      share: 2.4,
      rank: 1,
      windowStart: '2026-09-19T00:00:00Z',
      windowEnd: '2026-09-20T00:00:00Z',
      geographicMethod: 'Country reference coordinates',
      geographicProvenance: 'Cloudflare Radar country-level pair',
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
  let dataSource;
  const viewer = {
    scene: { canvas: {}, pick: () => null },
    dataSources: { add: (source) => (dataSource = source), remove: () => {} },
  };
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  const rows = layer.getRowControls();
  assert.equal(layer.getStats().count, 2);
  const flowEntity = dataSource.entities.values.find((entity) =>
    String(entity.id).startsWith('cyber-flow:'),
  );
  assert.equal(flowEntity.polyline.positions[0].height, 0);
  assert.ok(flowEntity.polyline.width >= 7);
  assert.equal(flowEntity.polyline.positions.at(-1).height, 0);
  assert.ok(flowEntity.polyline.positions[16].height > 1_000_000);
  assert.equal(rows.list.items.length, 4);
  assert.ok(
    rows.list.items.some((row) => row.text.includes('no geographic data')),
  );
  assert.equal(
    layer.getAnalystRecords().find((row) => row.provider === 'dshield')
      .latitude,
    undefined,
  );
  const rendered = layer.getStats().count;
  assert.equal(rendered, 2);
  const flow = layer.getThreatIntelState().selectedRadar;
  assert.equal(flow, null);
  layer.destroy();
});

test('Radar map selection reports marker and paired-flow context and clears on disable', async () => {
  let pickedId = null;
  const states = [];
  const layer = createCyberLayer({
    source: {
      getRadarSnapshot: async () => radar,
      getDshieldSnapshot: async () => dshield,
    },
    cesium,
  });
  const viewer = {
    scene: { canvas: {}, pick: () => ({ id: pickedId }) },
    dataSources: { add: () => {}, remove: () => {} },
  };
  layer.init(viewer);
  layer.setThreatIntelListener((state) => states.push(state));
  layer.enable();
  await layer.update();
  const click = latestSelectionHandler.actions.get('left-click');
  pickedId = 'cyber:location:US';
  click({ position: { x: 10, y: 20 } });
  assert.equal(states.at(-1).selectedRadar.type, 'location');
  assert.equal(states.at(-1).selectedRadar.locationName, 'United States');
  assert.deepEqual(
    states.at(-1).selectedRadar.roles.map((role) => role.role),
    ['origin', 'target'],
  );
  pickedId = 'cyber-flow:cloudflare-radar:flow:US:CA';
  click({ position: { x: 10, y: 20 } });
  assert.equal(states.at(-1).selectedRadar.type, 'flow');
  assert.equal(states.at(-1).selectedRadar.target.name, 'Canada');
  layer.disable();
  assert.equal(states.at(-1).enabled, false);
  assert.equal(states.at(-1).selectedRadar, null);
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
  layer.init({
    scene: { canvas: {}, pick: () => null },
    dataSources: { add: () => {}, remove: () => {} },
  });
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
