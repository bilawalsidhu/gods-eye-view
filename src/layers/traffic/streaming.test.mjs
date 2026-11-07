import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrafficSource } from './source.js';
import { createIngestion } from './ingestion.js';
import { tileToBBox } from '../../data/tomtomTiles.js';

for (const hasKey of [false, true])
  for (const flowFirst of [false, true]) {
    test(`${hasKey ? 'Hybrid' : 'keyless default'} source and ingestion replace snapshots with flow ${flowFirst ? 'before' : 'after'} tiles`, async () => {
      const detail = { z: 14, x: 3743, y: 6745 };
      const core = tileToBBox(detail.z, detail.x, detail.y);
      const local = {
        type: 'residential',
        oneway: 1,
        coordinates: [
          [core.west + 0.002, core.south + 0.002],
          [core.west + 0.004, core.south + 0.004],
        ],
      };
      const distant = {
        type: 'primary',
        oneway: 1,
        coordinates: [
          [core.east + 0.01, core.south],
          [core.east + 0.02, core.south],
        ],
      };
      const flow = [
        {
          roadType: 'Major road',
          trafficLevel: 0.5,
          coords: [
            [core.east + 0.01, core.north],
            [core.east + 0.02, core.north],
          ],
        },
      ];
      const bounds = {
        ...core,
        east: core.east + 0.03,
        coverage: {
          detail: [detail],
          coarse: [{ z: 12, x: 935, y: 1686 }],
          key: 'test',
        },
      };
      const source = createTrafficSource({
        mapTiles: {
          async fetchBounds(box, { zoom, onTile }) {
            const tile = { roads: zoom === 14 ? [local] : [distant] };
            onTile?.(tile);
            return {
              tiles: [tile],
              loadedTiles: zoom === 14 ? [detail] : bounds.coverage.coarse,
              partial: false,
            };
          },
        },
      });
      const returned = [],
        streams = [];
      const requestRoads = source.requestRoads;
      source.requestRoads = async (box, options) => {
        let streamed = [];
        const response = await requestRoads(box, {
          ...options,
          onTile(data) {
            if (data.replace) streamed = data.roads.slice();
            else streamed.push(...data.roads);
            options.onTile(data);
          },
        });
        const data = await response.json();
        returned.push(data.roads);
        streams.push(streamed);
        return response;
      };
      const painted = [];
      const state = {
        _enabled: true,
        _loadGeneration: 0,
        _tileCache: new Map(),
        _roadMode: hasKey ? 'hybrid' : null,
        _liveMode: hasKey,
        _parseRoads: (data) => data.roads,
      };
      const ingestion = createIngestion({
        state,
        source,
        services: {},
        parts: {
          viewport: {
            clampBounds: (b) => b,
            getBoundsCenter: () => ({ lat: 30.26, lon: -97.74 }),
          },
          flow: {
            warmFlow: () =>
              flowFirst
                ? Promise.resolve(hasKey ? flow : [])
                : new Promise((resolve) =>
                    setImmediate(() => resolve(hasKey ? flow : [])),
                  ),
            applyFlowThenRender: async (
              roads,
              box,
              generation,
              altitude,
              label,
            ) => {
              if (label === 'Loaded full') painted.push(roads);
              return true;
            },
          },
        },
      });
      await ingestion.loadRoadsForBounds(bounds, 350);
      assert.equal(returned.length, 2);
      assert.deepEqual(
        streams,
        returned,
        'each completed stream equals its authoritative graph',
      );
      assert.deepEqual(
        painted.at(-1),
        returned.at(-1),
        'ingestion paints that exact graph',
      );
      const ids = painted
        .at(-1)
        .map((r) =>
          JSON.stringify([r.coordinates, r.oneway, Boolean(r.directFlow)]),
        );
      assert.equal(ids.length, hasKey ? 3 : 2);
      assert.equal(new Set(ids).size, ids.length);
      ingestion.cancelActiveFetch();
      clearTimeout(state._retryTimer);
    });
  }
