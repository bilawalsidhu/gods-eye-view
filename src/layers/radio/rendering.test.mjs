import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDegrees, toLonLatH, WGS84 } from '../../geo/ellipsoid.js';
import { radioStationIdFromPick } from './rendering.js';
import {
  radioStationRow,
  withRadioLayer,
} from '../../testSupport/radioLayerHarness.mjs';
import { radioLayer } from '../../data/radio.js';

const station = (n, lon, lat, tags = ['news']) =>
  radioStationRow({
    id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    name: `Station ${n}`,
    lon,
    lat,
    tags,
    streamUrl: `https://radio.example.com/${n}.mp3`,
  });

/**
 * Camera and query ports over a flat projection, `pxPerDegree` CSS pixels a
 * degree from (-98, 31) at the top left, with an eye over Austin.
 */
function flatRenderer() {
  const listeners = new Set();
  const view = { pxPerDegree: 1000, height: 1_000_000 };
  const eye = () => fromDegrees(-97, 30, view.height);
  return {
    view,
    listeners,
    renderer: {
      canvas: { clientWidth: 2000, clientHeight: 1000 },
      camera: {
        pose: () => ({ position: eye(), height: view.height }),
        on(event, cb) {
          if (event !== 'changed') return () => {};
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
      query: {
        project(p) {
          const { lon, lat } = toLonLatH(p, WGS84);
          return {
            x: (lon + 98) * view.pxPerDegree,
            y: (31 - lat) * view.pxPerDegree,
          };
        },
      },
    },
  };
}

test('stations drawn close together on screen stand behind one cluster dot', async () => {
  const flat = flatRenderer();
  const stations = [
    station(1, -97.0, 30.0),
    station(2, -96.98, 30.0),
    station(3, -97.0, 29.98),
    station(4, -96.5, 30.0),
  ];
  await withRadioLayer(
    { stations, renderer: flat.renderer },
    async ({ draw }) => {
      const set = (suffix) =>
        [...draw.sets.values()].find(
          (record) => !record.disposed && record.spec.id.endsWith(suffix),
        );
      const shown = () =>
        [...set(':stations').items.values()]
          .filter((item) => item.show)
          .map((item) => item.id);
      const clusters = set(':clusters');
      assert.equal(clusters.items.size, 1, 'one cluster');
      const [cluster] = clusters.items.values();
      assert.equal(cluster.id, `radio:${stations[0].id}`, 'named by its seed');
      assert.deepEqual(
        cluster.meta.stationIds,
        stations.slice(0, 3).map((s) => s.id),
      );
      // At the mean of its stations, sized by its count, news blue.
      const { lon, lat } = toLonLatH(cluster.pos, WGS84);
      assert.ok(
        Math.abs(lon + 96.9933) < 1e-3 && Math.abs(lat - 29.9933) < 1e-3,
      );
      assert.equal(cluster.pixelSize, 12 + Math.log2(3) * 1.6);
      assert.equal(cluster.outlineWidth, 2);
      assert.deepEqual(
        shown(),
        [`radio:${stations[3].id}`],
        'only the lone one',
      );
      // A click on the cluster plays its seed station.
      assert.equal(
        radioStationIdFromPick({
          id: { set: clusters.spec.id, id: cluster.id },
        }),
        stations[0].id,
      );
      // Its badge is published with it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(radioLayer.getOverlayDiagnostics().clusterTexts.length, 1);

      // Closer in, the stations spread apart: the camera's move clusters
      // them again, and every station shows on its own.
      flat.view.pxPerDegree = 20_000;
      flat.view.height = 200_000;
      for (const cb of flat.listeners) cb();
      assert.equal(clusters.items.size, 0);
      assert.equal(shown().length, 4);
    },
  );
});

test('a filter that hides stations clusters them again at once', async () => {
  const flat = flatRenderer();
  const stations = [
    station(1, -97.0, 30.0, ['news']),
    station(2, -96.98, 30.0, ['news']),
    station(3, -97.0, 29.98, ['jazz']),
  ];
  await withRadioLayer(
    { stations, renderer: flat.renderer },
    async ({ draw }) => {
      const set = (suffix) =>
        [...draw.sets.values()].find(
          (record) => !record.disposed && record.spec.id.endsWith(suffix),
        );
      radioLayer.setFilter('all');
      assert.equal(set(':clusters').items.size, 1);
      radioLayer.setFilter('news');
      assert.equal(set(':clusters').items.size, 0, 'two left: no cluster');
      const shown = [...set(':stations').items.values()].filter((i) => i.show);
      assert.deepEqual(
        shown.map((item) => item.id),
        stations.slice(0, 2).map((s) => `radio:${s.id}`),
      );
    },
  );
});
