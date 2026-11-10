import { readFileSync } from 'node:fs';
import { cameraTile } from '../fixtures/layers/alpr.mjs';
import { tilesFixtureRoutes } from '../qa-strict-harness.mjs';

const { extras } = JSON.parse(
  readFileSync(new URL('../fixtures/tiles3d/tileset.json', import.meta.url)),
);
export const center = extras.probes.block50;
export const points = [-1, 0, 1].map((n, i) => ({
  id: `surface-${i}`,
  lon: center.lon + n * 0.00018,
  lat: center.lat + n * 0.00018,
}));
export const layers = [
  'import',
  'infrastructure',
  'alpr',
  'directions',
  'bikeshare',
  'story',
];
export const offsets = {
  import: 0,
  infrastructure: 0,
  alpr: 1.5,
  directions: 0,
  bikeshare: 2,
  story: 0,
};
export const counts = {
  import: 3,
  infrastructure: 6,
  alpr: 3,
  directions: 4,
  bikeshare: 3,
  story: 1,
};

export const features = points.map(({ id, lon, lat }) => ({
  type: 'Feature',
  id,
  properties: { name: id },
  geometry: { type: 'Point', coordinates: [lon, lat] },
}));

export function fixtureRoutes(origin, tiles) {
  const json = (value) => ({
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
  const event = JSON.parse(
    readFileSync(
      new URL(
        '../../public/events/bhote-koshi-2026/event.json',
        import.meta.url,
      ),
    ),
  );
  event.evidenceSpine = [];
  event.fieldReports = [];
  event.reconstruction.corridor = points.map((p, i) => ({
    ...p,
    chainageM: i * 30,
    elevationM: 0,
  }));
  event.reconstruction.storyFloodWindow = { start: 0, end: 1 };
  event.imagery.rectangle = {
    west: center.lon - 0.0004,
    east: center.lon + 0.0004,
    south: center.lat - 0.0004,
    north: center.lat + 0.0004,
  };
  const cameras = points.map((p, i) => ({
    latitude: p.lat,
    longitude: p.lon,
    osmId: 9100000 + i,
    operator: 'Surface fixture',
    brand: 'Fixture',
    cameraType: 'fixed',
    direction: '',
  }));
  return [
    ...(tiles ? tilesFixtureRoutes(origin) : []),
    ...['datacenters', 'dams'].map((name) => ({
      pattern: `${origin}/*${name}*.geojsonl*`,
      respond: () => ({
        contentType: 'application/json',
        body: features
          .map((f) =>
            JSON.stringify(
              name === 'dams'
                ? {
                    ...f,
                    geometry: {
                      ...f.geometry,
                      coordinates: [
                        f.geometry.coordinates[0],
                        f.geometry.coordinates[1] + 0.0001,
                      ],
                    },
                  }
                : f,
            ),
          )
          .join('\n'),
      }),
    })),
    {
      pattern: `${origin}/events/bhote-koshi-2026/event.json*`,
      respond: () => json(event),
    },
    {
      pattern: `${origin}/api/terrain/heights*`,
      respond: ({ url }) =>
        json({
          results: new URL(url).searchParams
            .get('points')
            .split(';')
            .map(() => ({ ellipsoid: tiles ? 50 : 150 })),
        }),
    },
    {
      pattern: `${origin}/api/route*`,
      respond: () =>
        json({
          ok: true,
          geometry: points.map((p) => [p.lon, p.lat]),
          distanceM: 60,
          durationS: 30,
          steps: [],
        }),
    },
    {
      pattern: `${origin}/api/gbfs/*`,
      respond: ({ url }) => {
        const upstream = decodeURIComponent(
          new URL(url).pathname.slice('/api/gbfs/'.length),
        );
        const information = upstream.includes('station_information');
        return json({
          last_updated: 1785153600,
          ttl: 3600,
          version: '2.3',
          data: {
            stations: points.map((p) =>
              information
                ? {
                    station_id: p.id,
                    name: p.id,
                    lat: p.lat,
                    lon: p.lon,
                    capacity: 20,
                  }
                : {
                    station_id: p.id,
                    num_bikes_available: 10,
                    num_docks_available: 10,
                    is_installed: 1,
                    is_renting: 1,
                    is_returning: 1,
                  },
            ),
          },
        });
      },
    },
    {
      pattern: 'https://tiles.dontgetflocked.com/*',
      respond: ({ url }) => {
        const path = new URL(url).pathname;
        if (path.endsWith('.json'))
          return json({
            tiles: [
              'https://tiles.dontgetflocked.com/cameras-us-hourly/{z}/{x}/{y}.mvt',
            ],
            bounds: [-160, 17, -64, 59],
          });
        const match = path.match(/\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
        if (!match)
          throw new Error(`Unexpected camera fixture request: ${path}`);
        return {
          contentType: 'application/x-protobuf',
          body: cameraTile(...match.slice(1).map(Number), cameras),
        };
      },
    },
    {
      // Auxiliary startup services must never turn this fixture run into live feeds.
      pattern: `${origin}/api/*`,
      respond: ({ url }) => {
        const path = new URL(url).pathname;
        if (
          ['/api/google/tiles-token', '/api/realtime/debug-log'].includes(path)
        )
          return { status: 204 };
        if (path.endsWith('/status')) return json({ configured: false });
        return {
          status: 503,
          ...json({ error: 'Unavailable in surface fixture' }),
        };
      },
    },
  ];
}

/** Observe committed positions: neither revision's mover registry exposes instances. */
export function observeSurfaceMovers() {
  const { engine } = window.__godsEyeView;
  const records = new Map();
  let frames = 0;
  const offFrame = engine.frames.postRender.addEventListener(() => {
    frames++;
  });
  const create = engine.movers.createSet;
  const layerOf = (id) => {
    if (/^geo-import-.*-pins-/.test(id)) return 'import';
    if (/^local-(datacenters|dams)-pins$/.test(id)) return 'infrastructure';
    if (id === 'alpr-cameras') return 'alpr';
    if (/^directions-(markers|marker-letters)$/.test(id)) return 'directions';
    if (id === 'bikeshare') return 'bikeshare';
    if (id === 'bhote-koshi-flood-bhote-koshi-surge-front') return 'story';
    return null;
  };
  engine.movers.createSet = function (options) {
    const set = create.call(this, options);
    const layer = layerOf(options.id);
    if (!layer) return set;
    const record = { layer, set, items: [], committed: [] };
    records.set(options.id, record);
    const write = set.set,
      commit = set.commit,
      destroy = set.destroy;
    set.set = function (index, fields) {
      const result = write.call(this, index, fields);
      record.items[index] = {
        ...record.items[index],
        ...fields,
        ...(fields.position ? { position: { ...fields.position } } : {}),
        ...(fields.pickId
          ? { pickId: String(fields.pickId.id ?? fields.pickId) }
          : {}),
      };
      return result;
    };
    set.commit = function () {
      const result = commit.call(this);
      record.committed = record.items
        .slice(0, set.count())
        .map((p) => ({ ...p }));
      return result;
    };
    set.destroy = function () {
      const result = destroy.call(this);
      records.delete(options.id);
      return result;
    };
    return set;
  };
  window.qaSurfaceMovers = {
    frames: () => frames,
    read(layer) {
      const registry = engine.movers.list();
      return [...records]
        .filter(([, r]) => r.layer === layer)
        .flatMap(([id, r]) => {
          const live = registry.find((s) => s.id === id);
          if (!live || live.count !== r.committed.length)
            throw new Error(`Uncommitted mover count: ${id}`);
          return r.committed.map((p, index) => ({
            setId: id,
            index,
            id: p.pickId ?? String(index),
            position: p.position,
            shown: live.shown && p.show !== false,
            ready: r.set.ready(index),
          }));
        });
    },
    restore() {
      offFrame();
      engine.movers.createSet = create;
    },
  };
}

/** A settled camera alone does not mean asynchronous placement has committed. */
export async function settledPositions(page, layer, count) {
  await page.evaluate(() => {
    window.qaSurfaceStable = null;
  });
  const handle = await page
    .waitForFunction(
      (layer, count) => {
        const { engine, dataManager, surfaceServices } = window.__godsEyeView;
        engine.render.request('qa-surface-heights');
        const rows = window.qaSurfaceMovers.read(layer);
        let ready =
          engine.surface.tilesLoaded() &&
          rows.length === count &&
          rows.every(
            (p) =>
              p.shown &&
              p.ready &&
              ['x', 'y', 'z'].every((axis) =>
                Number.isFinite(p.position?.[axis]),
              ),
          );
        if (layer === 'alpr') {
          const mod = dataManager.layers.get('alpr-cameras').module;
          ready &&=
            !mod.getStats().loading &&
            mod
              .getAnalystRecords()
              .every((p) =>
                Number.isFinite(
                  surfaceServices.groundFloor.cachedGroundFloor(p.lat, p.lon),
                ),
              );
        }
        if (layer === 'bikeshare')
          ready &&= !dataManager.layers.get('bikeshare').module.getStats()
            .loading;
        const signature = JSON.stringify(
          rows.map((p) => [
            p.setId,
            p.id,
            p.position &&
              ['x', 'y', 'z'].map((axis) =>
                Math.round(p.position[axis] * 1000),
              ),
          ]),
        );
        const previous = window.qaSurfaceStable;
        const drawn = window.qaSurfaceMovers.frames();
        const stable =
          ready && previous?.signature === signature
            ? previous.frames + (drawn > previous.drawn ? 1 : 0)
            : 0;
        window.qaSurfaceStable = { signature, frames: stable, drawn, rows };
        return stable >= 10 ? rows : false;
      },
      { polling: 'raf', timeout: 90000 },
      layer,
      count,
    )
    .catch(async (cause) => {
      const state = await page
        .evaluate(() => window.qaSurfaceStable)
        .catch(() => null);
      throw new Error(
        `Placement readiness failed for ${layer}: expected ${count} points; ${JSON.stringify(state)}`,
        { cause },
      );
    });
  try {
    return await handle.jsonValue();
  } finally {
    await handle.dispose();
  }
}
