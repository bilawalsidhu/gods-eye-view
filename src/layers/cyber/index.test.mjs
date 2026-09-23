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
  ArcType: { NONE: 'none', GEODESIC: 'geodesic' },
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
  Rectangle: { center: (rectangle) => rectangle.center },
  Ellipsoid: { WGS84: {} },
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
const kev = {
  provider: 'cisa-kev',
  attribution: 'CISA Known Exploited Vulnerabilities Catalog',
  catalogVersion: '2026.09.23',
  dateReleased: '2026-09-23T12:51:35.821Z',
  fetchedAt: '2026-09-23T13:00:00.000Z',
  stale: false,
  count: 1,
  vulnerabilities: [
    {
      cveId: 'CVE-2024-12345',
      vendor: 'Example Vendor',
      product: 'Example Product',
      name: 'Example vulnerability',
      dateAdded: '2026-09-22',
      shortDescription: 'Example description.',
      requiredAction: 'Apply the vendor update.',
      dueDate: '2026-10-01',
      ransomware: 'Unknown',
      forensicTriage: false,
      notes: null,
      cwes: [],
    },
  ],
};

test('renders Radar aggregates only and keeps DShield in the non-geographic row list', async () => {
  const layer = createCyberLayer({
    source: {
      getRadarSnapshot: async () => radar,
      getDshieldSnapshot: async () => dshield,
      getKevSnapshot: async () => kev,
    },
    cesium,
  });
  let dataSource;
  const viewer = {
    scene: { canvas: {}, pick: () => null },
    dataSources: {
      add: (source) => {
        if (source.name === 'cyber-activity') dataSource = source;
      },
      remove: () => {},
    },
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
      getKevSnapshot: async () => kev,
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

test('Shodan area search uses the visible map radius, renders devices, and exposes selected device details', async () => {
  let pickedId = null;
  let receivedArea;
  const device = {
    provider: 'shodan',
    ip: '8.8.4.4',
    latitude: 37.751,
    longitude: -97.822,
    organization: 'Example Org',
    services: [
      {
        port: 443,
        transport: 'tcp',
        product: 'HTTPS',
        vulnerabilities: ['CVE-2024-12345'],
      },
    ],
    hostnames: ['example.net'],
    domains: [],
    geographicPrecision: 'network-approximate',
    geographicMethod: 'IPwho.is IP geolocation',
    geographicProvenance:
      'Approximate IP network position; not a device location.',
    attribution: 'Shodan',
    fetchedAt: '2026-09-20T01:00:00Z',
  };
  const layer = createCyberLayer({
    source: {
      getRadarSnapshot: async () => radar,
      getDshieldSnapshot: async () => dshield,
      getKevSnapshot: async () => kev,
      searchShodanArea: async (area) => {
        receivedArea = area;
        return {
          provider: 'shodan',
          query: 'geo:40.0000,-75.0000,20',
          page: 1,
          pageLimit: 3,
          pageSize: 100,
          total: 2,
          fetchedAt: '2026-09-20T01:00:00Z',
          attribution: 'Shodan',
          matches: [device, { ...device, ip: '8.8.8.8' }],
        };
      },
    },
    cesium,
  });
  const rectangle = {
    south: (39.9 * Math.PI) / 180,
    north: (40.1 * Math.PI) / 180,
    west: (-75.1 * Math.PI) / 180,
    east: (-74.9 * Math.PI) / 180,
    center: {
      latitude: (40 * Math.PI) / 180,
      longitude: (-75 * Math.PI) / 180,
    },
  };
  let shodanDataSource;
  const states = [];
  layer.init({
    camera: { computeViewRectangle: () => rectangle },
    scene: {
      canvas: {},
      globe: { ellipsoid: {} },
      pick: () => ({ id: pickedId }),
    },
    dataSources: {
      add: (value) => {
        if (value.name === 'shodan-devices') shodanDataSource = value;
      },
      remove: () => {},
    },
  });
  layer.setThreatIntelListener((state) => states.push(state));
  layer.enable();
  await layer.update();
  await layer.getThreatIntelState().onShodanAreaSearch();
  assert.ok(Math.abs(receivedArea.latitude - 40) < 1e-9);
  assert.ok(Math.abs(receivedArea.longitude + 75) < 1e-9);
  assert.ok(receivedArea.radiusKm > 10 && receivedArea.radiusKm < 20);
  const entity = shodanDataSource.entities.getById('cyber-shodan:8.8.4.4');
  const secondEntity = shodanDataSource.entities.getById(
    'cyber-shodan:8.8.8.8',
  );
  assert.notEqual(entity.position.longitude, device.longitude);
  assert.notEqual(entity.position.longitude, secondEntity.position.longitude);
  const connector = shodanDataSource.entities.getById(
    'cyber-shodan-link:8.8.4.4',
  ).polyline;
  assert.ok(connector);
  assert.equal(connector.clampToGround, true);
  assert.equal(connector.arcType, cesium.ArcType.GEODESIC);
  assert.equal(entity.properties.geographicPrecision, 'network-approximate');
  pickedId = entity.id;
  latestSelectionHandler.actions.get('left-click')({
    position: { x: 1, y: 1 },
  });
  assert.equal(states.at(-1).selectedShodan.ip, '8.8.4.4');
  assert.ok(states.at(-1).selectedShodan.visualOffsetMeters > 0);
  assert.equal(
    states.at(-1).selectedShodan.kevMatches[0].cveId,
    'CVE-2024-12345',
  );
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
      getKevSnapshot: async () => kev,
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
