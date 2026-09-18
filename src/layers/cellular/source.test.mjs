import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCellularNetworksSource,
  normalizeCellularCell,
  normalizeCellularSite,
  technologiesFromOsmTags,
  validCellularViewport,
} from './source.js';

test('OSM mobile site normalization preserves mapped operator, technology, and sector directions', () => {
  const site = normalizeCellularSite({
    type: 'node',
    id: 42,
    lat: 43.65,
    lon: -79.38,
    tags: {
      name: 'Example rooftop',
      operator: 'Example Mobile',
      man_made: 'mast',
      'communication:mobile_phone': 'yes',
      'communication:lte': 'yes',
      'communication:5g': 'yes',
      'lte:direction': '0;120;240',
      height: '35',
    },
  });
  assert.equal(site.id, 'cellular:site:osm:node:42');
  assert.equal(site.operator, 'Example Mobile');
  assert.deepEqual(site.technologies.sort(), ['LTE', 'NR']);
  assert.deepEqual(site.sectorAzimuths, [0, 120, 240]);
  assert.equal(site.heightM, 35);
});

test('logical cell normalization creates stable radio/PLMN/area/cell identity', () => {
  const cell = normalizeCellularCell({
    radio: 'LTE',
    mcc: 302,
    mnc: 720,
    tac: 1234,
    cellid: 987654,
    pci: 184,
    lat: 43.651,
    lon: -79.382,
    range: 850,
    samples: 23,
  });
  assert.equal(cell.id, 'cellular:cell:LTE:302:720:1234:987654');
  assert.equal(cell.plmn, '302-720');
  assert.equal(cell.tac, 1234);
  assert.equal(cell.pci, 184);
  assert.equal(cell.rangeM, 850);
  assert.equal(cell.samples, 23);
});

test('OSM technology inference stays conservative', () => {
  assert.deepEqual(
    technologiesFromOsmTags({ 'communication:mobile_phone': 'yes' }),
    [],
  );
  assert.deepEqual(
    technologiesFromOsmTags({
      'technology:mobile_phone': 'GSM;UMTS;LTE;5G',
    }).sort(),
    ['GSM', 'LTE', 'NR', 'UMTS'],
  );
});

test('cellular source only accepts bounded non-dateline viewports', () => {
  assert.equal(
    validCellularViewport({ south: 43, west: -80, north: 44, east: -79 }),
    true,
  );
  assert.equal(
    validCellularViewport({ south: 40, west: -80, north: 44, east: -79 }),
    false,
  );
  assert.equal(
    validCellularViewport({ south: 43, west: 179, north: 44, east: -179 }),
    false,
  );
});

test('cellular source normalizes server payload and forwards technology filter', async () => {
  let requested = '';
  const source = createCellularNetworksSource({
    fetchImpl: async (url) => {
      requested = String(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            elements: [
              {
                type: 'node',
                id: 1,
                lat: 43.65,
                lon: -79.38,
                tags: { 'communication:mobile_phone': 'yes' },
              },
            ],
            cells: [
              {
                radio: 'NR',
                mcc: 302,
                mnc: 720,
                tac: 10,
                cellid: 20,
                lat: 43.65,
                lon: -79.38,
              },
            ],
            sitesStatus: 'ready',
            cellStatus: 'ready',
            siteSaturated: false,
            cellSaturated: false,
            cellAreaKm2: 1.2,
            cellTileCount: 4,
            cellTilesQueried: 4,
            cellCachedTiles: 2,
            cellFailedTiles: 0,
            cellSaturatedTiles: 1,
            cellTileLimit: 36,
            cellViewportPartial: true,
            retrievedAt: '2026-09-17T00:00:00.000Z',
          };
        },
      };
    },
  });
  const snapshot = await source.getSnapshot(
    { south: 43.64, west: -79.39, north: 43.66, east: -79.37 },
    { radio: 'NR' },
  );
  assert.match(requested, /radio=NR/);
  assert.equal(snapshot.sites.length, 1);
  assert.equal(snapshot.cells[0].radio, 'NR');
  assert.equal(snapshot.cellStatus, 'ready');
  assert.equal(snapshot.cellTileCount, 4);
  assert.equal(snapshot.cellCachedTiles, 2);
  assert.equal(snapshot.cellSaturatedTiles, 1);
});

test('cell normalization does not manufacture zero-valued optional fields from nulls', () => {
  const cell = normalizeCellularCell({
    radio: 'LTE',
    mcc: 302,
    mnc: 720,
    tac: 30013,
    cellid: 12345,
    lat: 45.42,
    lon: -75.69,
    unit: null,
    pci: null,
    psc: null,
  });
  assert.equal(cell.unit, null);
  assert.equal(cell.pci, null);
  assert.equal(cell.psc, null);
});

test('cellular source supports independent site and cell requests for progressive loading', async () => {
  const requested = [];
  const source = createCellularNetworksSource({
    fetchImpl: async (url) => {
      requested.push(String(url));
      const isSites = String(url).includes('part=sites');
      return {
        ok: true,
        status: 200,
        async json() {
          return isSites
            ? {
                elements: [
                  {
                    type: 'node',
                    id: 7,
                    lat: 45.42,
                    lon: -75.69,
                    tags: { 'communication:mobile_phone': 'yes' },
                  },
                ],
                sitesStatus: 'ready',
                siteSaturated: false,
              }
            : {
                cells: [
                  {
                    radio: 'LTE',
                    mcc: 302,
                    mnc: 610,
                    tac: 11651,
                    cellid: 30482728,
                    lat: 45.42,
                    lon: -75.694,
                  },
                ],
                cellStatus: 'ready',
                cellSaturated: false,
                cellTileCount: 1,
                cellTilesQueried: 1,
                cellCachedTiles: 0,
                cellFailedTiles: 0,
                cellSaturatedTiles: 0,
                cellTileLimit: 36,
              };
        },
      };
    },
  });

  const box = { south: 45.41, west: -75.71, north: 45.43, east: -75.68 };
  const [sites, cells] = await Promise.all([
    source.getSites(box),
    source.getCells(box, { radio: 'LTE' }),
  ]);

  assert.equal(sites.sites.length, 1);
  assert.equal(cells.cells.length, 1);
  assert.match(requested[0], /part=sites/);
  assert.match(requested[1], /part=cells/);
  assert.match(requested[1], /radio=LTE/);
});
