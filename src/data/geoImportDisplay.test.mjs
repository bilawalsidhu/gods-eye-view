import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../geo/index.js';
import { GROUND_HARNESSES } from '../testSupport/groundDisplayEngines.mjs';
import {
  MAX_RAISED_RINGS,
  MAX_RAISED_VERTICES,
  OVERLAY_PIXEL_BUDGET,
} from './geoImportLimits.js';
import { drawImportedFile } from './geoImportDisplay.js';
import { emptyRecords, geoJsonRecords } from './geoImportRecords.js';

// A 2D context that only records what draws; its image data is one pixel.
const createCanvas = () => ({
  getContext: () =>
    new Proxy(
      { getImageData: () => ({ data: new Uint8ClampedArray(4) }) },
      {
        get: (target, key) => target[key] ?? (key in {} ? undefined : () => {}),
      },
    ),
});

for (const make of GROUND_HARNESSES) {
  const displayTest = (name, run) =>
    test(`${name} (${make.name})`, async (t) => {
      const harness = make({
        engineOptions: {
          imageryFactories: {
            loadImage: async () => ({ width: 1, height: 1 }),
          },
        },
      });
      const { engine, viewer } = harness;
      engine.projector.worldToWindow = () => ({ x: 1, y: 1 });
      if (viewer) {
        viewer.imageryLayers = new Cesium.ImageryLayerCollection();
        viewer.scene.globe.show = true;
        viewer.scene.globe.getHeight = () => 0;
      }
      t.after(() => harness.destroy());
      const pins = [];
      const create = engine.movers.createSet;
      engine.movers.createSet = (options) => {
        const set = create(options);
        const record = { options, items: [], set };
        pins.push(record);
        const write = set.set;
        set.set = (i, fields) => {
          write(i, fields);
          record.items[i] = { ...record.items[i], ...fields };
        };
        return set;
      };
      await run({ ...harness, pins });
    });

  displayTest(
    'an imported file draws through the contract and lets go',
    async ({ engine, viewer }) => {
      if (viewer) viewer.scene.globe.getHeight = () => 25;
      else engine.fake.script('terrainHeight', 25);
      const records = geoJsonRecords(
        {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { name: 'pin' },
              geometry: { type: 'Point', coordinates: [1, 2] },
            },
            {
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: [
                  [1, 2],
                  [2, 3],
                ],
              },
            },
            {
              type: 'Feature',
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 0],
                  ],
                ],
              },
            },
          ],
        },
        '#39d0ff',
      );
      records.lines.push({
        positions: [
          [0, 0, 100],
          [1, 1, 200],
        ],
        ground: false,
        color: [1, 0, 0, 1],
        widthPx: 2,
      });
      records.overlays.push({
        url: 'data:image/png;base64,AA',
        rectangle: { west: 0, south: 0, east: 1, north: 1 },
        color: [1, 1, 1, 1],
        rotation: 0,
      });
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      const ours = (list) =>
        list.filter(({ id }) => id.startsWith('geo-import-'));
      assert.deepEqual(
        ours(engine.ground.list()).map(({ kind }) => kind),
        ['polygon', 'corridor'],
      );
      assert.equal(
        ours(engine.movers.list()).reduce((n, set) => n + set.count, 0),
        1,
      );
      assert.equal(ours(engine.lines.list()).length, 1);
      assert.equal(ours(engine.imagery.list()).length, 1);
      assert.equal(drawing.report.drawn, 5);
      drawing.setShow(false);
      assert.ok(ours(engine.ground.list()).every(({ shown }) => !shown));
      assert.equal(ours(engine.movers.list())[0].count, 0);
      assert.ok(ours(engine.lines.list()).every(({ shown }) => !shown));
      assert.ok(ours(engine.imagery.list()).every(({ shown }) => !shown));
      await drawing.refreshGround();
      assert.equal(ours(engine.movers.list())[0].count, 0);
      drawing.setShow(true);
      assert.ok(ours(engine.ground.list()).every(({ shown }) => shown));
      assert.ok(ours(engine.lines.list()).every(({ shown }) => shown));
      assert.ok(ours(engine.imagery.list()).every(({ shown }) => shown));
      assert.equal(ours(engine.movers.list())[0].count, 1);
      drawing.destroy();
      drawing.destroy();
      assert.equal(
        ours(engine.ground.list()).length +
          ours(engine.movers.list()).length +
          ours(engine.lines.list()).length +
          ours(engine.imagery.list()).length,
        0,
      );
    },
  );

  displayTest(
    'pins preserve ground, relative and absolute heights across refreshes',
    async ({ engine, viewer, pins }) => {
      let ground = 25;
      if (viewer) viewer.scene.globe.getHeight = () => ground;
      else engine.fake.script('terrainHeight', () => ground);
      const records = geoJsonRecords(
        {
          type: 'MultiPoint',
          coordinates: [
            [1, 2],
            [1, 2, 10],
            [1, 2, 500],
          ],
        },
        '#39d0ff',
      );
      records.points[1].altitude = 'relative';
      records.points[2].altitude = 'absolute';
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      const heights = () =>
        pins.flatMap(({ items }) =>
          items.map(({ position }) =>
            Math.round(geo.cartographic.fromCartesian(position).height),
          ),
        );
      assert.deepEqual(heights(), [25, 35, 500]);
      assert.deepEqual(
        pins.map(({ options }) => options.depthTest),
        ['always', 'normal'],
      );
      assert.ok(pins.every(({ options }) => options.pickable === false));
      ground = 70;
      await engine.maps.setTerrain({ kind: 'ellipsoid' });
      engine.fake.frame();
      assert.deepEqual(heights(), [70, 80, 500]);
      ground = undefined;
      await drawing.refreshGround();
      assert.deepEqual(heights(), [70, 80, 500]);
      drawing.destroy();
    },
  );

  displayTest(
    'off the globe, ground pins sit on the scene drawn, never on an imported point',
    async ({ engine, viewer, pins }) => {
      // 3D tiles under a low camera: the globe is not drawn.
      if (viewer) {
        viewer.scene.globe.show = false;
        viewer.scene.clampToHeightSupported = true;
      } else await engine.maps.setPhotorealTiles({});
      engine.camera.height = () => 1000;
      engine.projector.worldToWindow = () => ({ x: 1, y: 1 });
      engine.projector.horizonVisible = () => true;
      const excluded = [];
      engine.surface.sampleHeight = (_position, exclude) => {
        excluded.push(exclude);
        return 2000;
      };
      const ground = await drawImportedFile(
        engine,
        geoJsonRecords({ type: 'Point', coordinates: [1, 2] }, '#39d0ff'),
        { createCanvas },
      );
      const raised = geoJsonRecords(
        { type: 'Point', coordinates: [1, 2, 5000] },
        '#39d0ff',
      );
      raised.points[0].altitude = 'absolute';
      const high = await drawImportedFile(engine, raised, { createCanvas });
      const height = () =>
        Math.round(
          geo.cartographic.fromCartesian(pins[0].items[0].position).height,
        );
      assert.equal(height(), 2000);
      assert.deepEqual(
        ground.footprint().map((p) => p.map(Math.round)),
        [[1, 2, 2000]],
        'a flight frames the pin where it draws',
      );
      await ground.refreshGround();
      assert.equal(height(), 2000);
      assert.deepEqual(
        new Set(excluded.at(-1)),
        new Set(pins.map(({ set }) => set)),
        "another file's point is not ground",
      );
      high.destroy();
      await ground.refreshGround();
      assert.deepEqual(excluded.at(-1), [pins[0].set]);
      ground.destroy();
    },
  );

  displayTest(
    'a pin on the tiles keeps its height while out of the window',
    async ({ engine }) => {
      await engine.maps.setPhotorealTiles({});
      engine.camera.height = () => 1000;
      engine.projector.horizonVisible = () => true;
      let visible = true;
      engine.projector.worldToWindow = () => (visible ? { x: 1, y: 1 } : null);
      engine.surface.sampleHeight = () => 500;
      const drawing = await drawImportedFile(
        engine,
        geoJsonRecords({ type: 'Point', coordinates: [1, 2] }, '#39d0ff'),
        { createCanvas },
      );
      const height = () => Math.round(drawing.footprint()[0][2]);
      assert.equal(height(), 500);
      visible = false;
      await drawing.refreshGround();
      assert.equal(height(), 500, 'the measured tile height was replaced');
      let projected;
      engine.projector.worldToWindow = (position) => {
        projected = Math.round(geo.cartographic.fromCartesian(position).height);
        return projected >= 500 ? { x: 1, y: 1 } : null;
      };
      engine.surface.sampleHeight = () => 700;
      await drawing.refreshGround();
      assert.equal(projected, 500, 'visibility uses the last measured height');
      assert.equal(height(), 700);
      engine.surface.sampleHeight = () => undefined;
      await drawing.refreshGround();
      assert.equal(
        height(),
        700,
        'a missing tile sample keeps the last height',
      );
      drawing.destroy();
    },
  );

  displayTest(
    'fills keep holes, raised outlines and plain overlays',
    async ({ engine, set }) => {
      const records = geoJsonRecords(
        {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [2, 0],
              [2, 2],
              [0, 0],
            ],
            [
              [0.5, 0.5],
              [1, 0.5],
              [1, 1],
              [0.5, 0.5],
            ],
          ],
        },
        '#39d0ff',
      );
      records.polygons[0].raised = true;
      records.polygons[0].rings = records.polygons[0].rings.map((ring) =>
        ring.map(([lon, lat]) => [lon, lat, 100]),
      );
      records.overlays.push({
        url: null,
        rectangle: { west: 4, south: 4, east: 5, north: 5 },
        color: [0, 1, 0, 1],
      });
      records.undrawn = { wall: 1, extruded: 2 };
      const drawing = await drawImportedFile(engine, records, {
        createCanvas,
        visible: false,
      });
      const fill = set(engine.ground.list()[0].id);
      assert.equal(fill.items.length, 1);
      assert.equal(engine.meshes.list().length, 1);
      assert.equal(fill.items[0].rings.length, 1);
      assert.ok(fill.items[0].rings.flat().every((p) => p.length === 2));
      assert.equal(fill.shown, false);
      assert.equal(engine.lines.list().length, 2);
      assert.ok(engine.lines.list().every((line) => !line.shown));
      assert.deepEqual(drawing.report, {
        drawn: 2,
        undrawn: 3,
        kinds: { wall: 1, extruded: 2 },
      });
      drawing.destroy();
    },
  );

  displayTest(
    'icon variants of one file stay within a canvas budget',
    async ({ engine }) => {
      const records = emptyRecords();
      for (let i = 0; i < 2000; i++)
        records.points.push({
          position: [1, 2, 0],
          altitude: 'ground',
          icon: { image: { url: 'blob:icon' }, scale: 10 + i / 1000 },
        });
      const canvases = [];
      const drawing = await drawImportedFile(engine, records, {
        createCanvas: () => {
          const canvas = createCanvas();
          canvases.push(canvas);
          return canvas;
        },
        loadImage: async () => ({ width: 32, height: 32 }),
        pixelRatio: 2,
      });
      const bytes = canvases.reduce((n, c) => n + c.width * c.height * 4, 0);
      assert.ok(bytes <= 64 * 2 ** 20, `canvas bytes ${bytes / 2 ** 20} MiB`);
      drawing.destroy();
    },
  );

  displayTest('a raised polygon fill keeps its heights', async ({ engine }) => {
    const meshes = [];
    const create = engine.meshes.createMesh;
    engine.meshes.createMesh = (options) => {
      meshes.push(options);
      return create(options);
    };
    const records = emptyRecords();
    records.polygons.push({
      rings: [
        [
          [0, 0, 1000],
          [1, 0, 1000],
          [1, 1, 1000],
        ],
      ],
      raised: true,
      fill: [1, 0, 0, 1],
      outline: { color: [1, 1, 1, 1], widthPx: 1 },
    });
    const drawing = await drawImportedFile(engine, records, { createCanvas });
    assert.equal(engine.ground.list().length, 0);
    assert.equal(meshes.length, 1);
    assert.equal(meshes[0].positions[0], 6379137);
    assert.equal(meshes[0].indices.length, 3);
    drawing.destroy();
  });

  displayTest(
    'a raised polygon whose vertices share one latitude keeps its fill',
    async ({ engine }) => {
      const records = emptyRecords();
      records.polygons.push({
        rings: [
          [
            [0, 85, 100000],
            [120, 85, 100000],
            [-120, 85, 100000],
          ],
        ],
        raised: true,
        fill: [0, 1, 0, 0.6],
        outline: null,
      });
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.equal(engine.meshes.list().length, 1, 'no fill mesh');
      drawing.destroy();
    },
  );

  displayTest(
    'a raised polygon with 20 000 vertices keeps its fill',
    async ({ engine }) => {
      const records = emptyRecords();
      const outer = Array.from({ length: 20_000 }, (_, i) => {
        const angle = (i * 2 * Math.PI) / 20_000;
        return [10 * Math.cos(angle), 10 * Math.sin(angle), 1000];
      });
      records.polygons.push({
        rings: [outer],
        raised: true,
        fill: [1, 0, 0, 1],
        outline: { color: [1, 1, 1, 1], widthPx: 1 },
      });
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.deepEqual(drawing.report, { drawn: 1, undrawn: 0, kinds: {} });
      assert.equal(engine.meshes.list().length, 1);
      assert.equal(engine.lines.list().length, 1);
      drawing.destroy();
    },
  );

  for (const rings of [MAX_RAISED_RINGS, MAX_RAISED_RINGS + 1])
    displayTest(
      `a raised polygon with ${rings} rings respects the ring bound`,
      async ({ engine }) => {
        const records = emptyRecords();
        const outer = [
          [0, 0, 1000],
          [10, 0, 1000],
          [10, 10, 1000],
          [0, 10, 1000],
        ];
        const holes = Array.from({ length: rings - 1 }, (_, i) => {
          const [x, y, d] = [
            0.1 + (i % 20) * 0.4,
            0.1 + Math.floor(i / 20) * 0.4,
            0.1,
          ];
          return [
            [x, y, 1000],
            [x + d, y, 1000],
            [x + d, y + d, 1000],
            [x, y + d, 1000],
          ];
        });
        records.polygons.push({
          rings: [outer, ...holes],
          raised: true,
          fill: [1, 0, 0, 1],
          outline: { color: [1, 1, 1, 1], widthPx: 1 },
        });
        const drawing = await drawImportedFile(engine, records, {
          createCanvas,
        });
        assert.deepEqual(
          drawing.report,
          rings === MAX_RAISED_RINGS
            ? { drawn: 1, undrawn: 0, kinds: {} }
            : { drawn: 0, undrawn: 1, kinds: { complexPolygon: 1 } },
        );
        assert.equal(
          engine.meshes.list().length,
          rings === MAX_RAISED_RINGS ? 1 : 0,
        );
        assert.equal(
          engine.lines.list().length,
          rings === MAX_RAISED_RINGS ? rings : 0,
        );
        drawing.destroy();
      },
    );

  displayTest(
    'a raised polygon with 10 000 holes does not block the import',
    async ({ engine }) => {
      const records = emptyRecords();
      const outer = Array.from({ length: 1000 }, (_, i) => {
        const a = (i / 1000) * 2 * Math.PI;
        return [10 * Math.cos(a), 10 * Math.sin(a), 1000];
      });
      const holes = [];
      for (let i = 0; i < 100; i++)
        for (let j = 0; j < 100; j++) {
          const [x, y, d] = [-6 + 0.12 * i, -6 + 0.12 * j, 0.03];
          holes.push([
            [x, y, 1000],
            [x + d, y, 1000],
            [x + d, y + d, 1000],
            [x, y + d, 1000],
          ]);
        }
      records.polygons.push({
        rings: [outer, ...holes],
        raised: true,
        fill: [0, 1, 0, 0.6],
        outline: { color: [1, 1, 1, 1], widthPx: 1 },
      });
      const started = performance.now();
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      const ms = Math.round(performance.now() - started);
      assert.ok(ms < 1000, `the import step took ${ms} ms (41 000 vertices)`);
      assert.deepEqual(drawing.report, {
        drawn: 0,
        undrawn: 1,
        kinds: { complexPolygon: 1 },
      });
      assert.equal(engine.meshes.list().length + engine.lines.list().length, 0);
      drawing.destroy();
    },
  );

  displayTest(
    'a raised fill past the vertex limit is counted, its outline drawn',
    async ({ engine }) => {
      const records = emptyRecords();
      const outer = Array.from({ length: MAX_RAISED_VERTICES + 1 }, (_, i) => {
        const angle = (i * 2 * Math.PI) / (MAX_RAISED_VERTICES + 1);
        return [10 * Math.cos(angle), 10 * Math.sin(angle), 1000];
      });
      records.polygons.push({
        rings: [outer],
        raised: true,
        fill: [1, 0, 0, 1],
        outline: { color: [1, 1, 1, 1], widthPx: 1 },
      });
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.deepEqual(drawing.report, {
        drawn: 1,
        undrawn: 1,
        kinds: { complexPolygon: 1 },
      });
      assert.equal(engine.meshes.list().length, 0);
      assert.equal(engine.lines.list().length, 1);
      drawing.destroy();
    },
  );

  displayTest(
    'polygon work yields after more than 8 ms and resets the clock after yielding',
    async ({ engine }) => {
      const records = emptyRecords();
      records.polygons = Array.from({ length: 7 }, () => ({
        rings: [
          [
            [0, 0, 1000],
            [1, 0, 1000],
            [1, 1, 1000],
          ],
        ],
        raised: true,
        fill: [1, 0, 0, 1],
        outline: null,
      }));
      let elapsed = 0;
      let created = 0;
      const create = engine.meshes.createMesh;
      engine.meshes.createMesh = (options) => {
        elapsed += 4;
        created++;
        return create(options);
      };
      const snapshots = [];
      const observe = (async () => {
        for (let i = 0; i < 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          snapshots.push(created);
          elapsed += 100;
        }
      })();
      const drawing = await drawImportedFile(engine, records, {
        createCanvas,
        now: () => elapsed,
      });
      await observe;
      assert.deepEqual(snapshots, [3, 6]);
      assert.equal(created, 7);
      assert.equal(drawing.report.drawn, 7);
      drawing.destroy();
    },
  );

  for (const cancellation of ['aborted', 'superseded', 'removed'])
    displayTest(
      `a draw ${cancellation} during a polygon yield stops and releases its geometry`,
      async ({ engine }) => {
        const records = geoJsonRecords(
          { type: 'Point', coordinates: [1, 2] },
          '#39d0ff',
        );
        records.polygons = Array.from({ length: 3 }, () => ({
          rings: [
            [
              [0, 0, 1000],
              [1, 0, 1000],
              [1, 1, 1000],
            ],
          ],
          raised: true,
          fill: [1, 0, 0, 1],
          outline: { color: [1, 1, 1, 1], widthPx: 1 },
        }));
        const controller = new AbortController();
        let current = records;
        const files = new Set([records]);
        let elapsed = 0;
        let created = 0;
        const create = engine.meshes.createMesh;
        engine.meshes.createMesh = (options) => {
          elapsed += 9;
          created++;
          return create(options);
        };
        let beforeCancel;
        const cancel = new Promise((resolve) =>
          setTimeout(() => {
            beforeCancel = [
              engine.meshes.list().length,
              engine.lines.list().length,
            ];
            if (cancellation === 'aborted') controller.abort();
            else if (cancellation === 'superseded') current = emptyRecords();
            else files.delete(records);
            resolve();
          }, 0),
        );
        await assert.rejects(
          drawImportedFile(engine, records, {
            createCanvas,
            now: () => elapsed,
            signal: controller.signal,
            isCurrent: () => current === records && files.has(records),
          }),
          cancellation === 'aborted'
            ? { name: 'AbortError' }
            : /The imported file was removed/,
        );
        await cancel;
        assert.deepEqual(beforeCancel, [1, 1]);
        assert.equal(created, 1);
        assert.equal(engine.meshes.list().length, 0);
        assert.equal(engine.lines.list().length, 0);
        assert.equal(engine.ground.list().length, 0);
        assert.equal(engine.movers.list().length, 0);
      },
    );

  displayTest(
    'a polygon with a degenerate hole draws its outer ring',
    async ({ engine }) => {
      const records = geoJsonRecords(
        {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [2, 0],
              [2, 2],
              [0, 2],
              [0, 0],
            ],
            [
              [1, 1],
              [1.1, 1.1],
              [1, 1],
            ],
          ],
        },
        '#39d0ff',
      );
      assert.equal(records.polygons[0].rings.length, 1);
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.deepEqual(drawing.report, { drawn: 1, undrawn: 0, kinds: {} });
      drawing.destroy();
    },
  );

  displayTest(
    'a ground polygon skips a short hole as Cesium does',
    async ({ engine }) => {
      const records = geoJsonRecords(
        {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [2, 0],
              [2, 2],
            ],
          ],
        },
        '#39d0ff',
      );
      records.polygons[0].rings.push([
        [1, 1],
        [1.1, 1.1],
        [1, 1],
      ]);
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.deepEqual(drawing.report, {
        drawn: 1,
        undrawn: 0,
        kinds: {},
      });
      drawing.destroy();
    },
  );

  for (const kind of ['Polygon', 'LineString'])
    displayTest(
      `a failed ${kind} ground set is released`,
      async ({ engine }) => {
        const create = engine.ground.createSet;
        engine.ground.createSet = (options) => {
          const set = create(options);
          set.replace = () => {
            throw new Error('replacement failed');
          };
          return set;
        };
        const positions = [
          [0, 0],
          [2, 0],
          [2, 2],
        ];
        const records = geoJsonRecords(
          {
            type: kind,
            coordinates: kind === 'Polygon' ? [positions] : positions,
          },
          '#39d0ff',
        );
        await assert.rejects(
          drawImportedFile(engine, records, { createCanvas }),
          /replacement failed/,
        );
        assert.equal(engine.ground.list().length, 0);
      },
    );

  displayTest(
    'failed icon composition releases geometry already created',
    async ({ engine }) => {
      const records = geoJsonRecords(
        {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [1, 2] },
            {
              type: 'LineString',
              coordinates: [
                [1, 2],
                [2, 3],
              ],
            },
          ],
        },
        '#39d0ff',
      );
      await assert.rejects(
        drawImportedFile(engine, records, {
          createCanvas: () => ({ getContext: () => null }),
        }),
        /need a canvas/,
      );
      assert.equal(engine.ground.list().length, 0);
      assert.equal(engine.movers.list().length, 0);
    },
  );
  displayTest(
    'ground pins follow the horizon and release frame listeners',
    async ({ engine, pins }) => {
      let front = true;
      engine.projector.horizonVisible = () => front;
      const records = geoJsonRecords(
        { type: 'Point', coordinates: [1, 2] },
        '#39d0ff',
      );
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.equal(pins[0].items[0].show, true);
      front = false;
      engine.frames.preRender.raiseEvent();
      assert.equal(pins[0].items[0].show, false);
      drawing.setShow(false);
      front = true;
      drawing.setShow(true);
      engine.frames.preRender.raiseEvent();
      assert.equal(pins[0].items[0].show, true);
      drawing.destroy();
      engine.frames.preRender.raiseEvent();
      assert.equal(engine.movers.list().length, 0);
    },
  );

  displayTest(
    'KML headings follow north as the camera rotates',
    async ({ engine, pins }) => {
      let heading = 0;
      engine.camera.pose = () => ({ heading });
      const records = geoJsonRecords(
        { type: 'Point', coordinates: [1, 2] },
        '#39d0ff',
      );
      records.points[0].icon.rotation = -Math.PI / 4;
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.equal(pins[0].items[0].rotation, -Math.PI / 4);
      heading = Math.PI / 2;
      engine.frames.preRender.raiseEvent();
      assert.equal(pins[0].items[0].rotation, Math.PI / 4);
      drawing.destroy();
    },
  );

  // A canvas whose context records the transform and holds one pixel.
  const recordingCanvas = () => {
    const calls = [];
    const pixels = { data: new Uint8ClampedArray([128, 64, 32, 128]) };
    const context = {
      translate: (...args) => calls.push(['translate', ...args]),
      rotate: (angle) => calls.push(['rotate', angle]),
      drawImage: (_image, ...args) => calls.push(['drawImage', ...args]),
      getImageData: () => pixels,
      putImageData: (value) => calls.push(['putImageData', value]),
    };
    return { calls, pixels, canvas: { getContext: () => context } };
  };
  const overlayLayer = (engine) => {
    const layers = [];
    const create = engine.imagery.createLayer;
    engine.imagery.createLayer = (options) => {
      layers.push(options);
      return create(options);
    };
    return layers;
  };

  displayTest(
    'overlay drawOrder ranks images stably above the raster layers',
    async ({ engine }) => {
      const layers = overlayLayer(engine);
      const records = emptyRecords();
      records.overlays = [10, -2, undefined, 10].map((drawOrder, index) => ({
        url: `blob:overlay-${index}`,
        drawOrder,
        color: [1, 1, 1, 1],
        rectangle: { west: 0, south: 0, east: 1, north: 1 },
      }));
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      const later = emptyRecords();
      later.overlays = [{ ...records.overlays[0], url: 'blob:later' }];
      later.overlays[0].drawOrder = -5;
      const over = await drawImportedFile(engine, later, { createCanvas });
      const urls = new Map(layers.map(({ id, source }) => [id, source.url]));
      assert.deepEqual(
        engine.imagery.list().map(({ id }) => urls.get(id)),
        [
          'blob:overlay-1',
          'blob:overlay-2',
          'blob:overlay-0',
          'blob:overlay-3',
          'blob:later',
        ],
        'bottom first; a file imported later draws over this one',
      );
      over.destroy();
      drawing.destroy();
    },
  );

  displayTest(
    'colored overlays multiply image RGB and retain layer alpha',
    async ({ engine }) => {
      const { calls, pixels, canvas } = recordingCanvas();
      const layers = overlayLayer(engine);
      const records = emptyRecords();
      records.overlays.push({
        url: 'blob:overlay',
        color: [1, 0, 0, 0.5],
        rectangle: { west: 0, south: 0, east: 1, north: 1 },
        rotation: 0,
      });
      const drawing = await drawImportedFile(engine, records, {
        createCanvas: () => canvas,
        loadImage: async () => ({ width: 32, height: 16 }),
      });
      assert.equal(layers[0].source.image, canvas);
      assert.deepEqual(
        { ...layers[0].source.rectangle },
        { west: 0, south: 0, east: 1, north: 1 },
      );
      assert.equal(layers[0].alpha, 0.5);
      assert.deepEqual([canvas.width, canvas.height], [32, 16]);
      assert.ok(
        calls.some(
          ([name, value]) => name === 'putImageData' && value === pixels,
        ),
      );
      assert.deepEqual([...pixels.data], [128, 0, 0, 128]);
      drawing.destroy();
    },
  );

  displayTest(
    'a rotated overlay turns its image counter-clockwise onto the box around it',
    async ({ engine }) => {
      const { calls, canvas } = recordingCanvas();
      const layers = overlayLayer(engine);
      const records = emptyRecords();
      records.overlays.push({
        url: 'blob:overlay',
        color: [1, 1, 1, 1],
        // Two degrees by one, across 180°, turned a quarter.
        rectangle: { west: 179, south: 10, east: -179, north: 11 },
        rotation: 90,
      });
      const drawing = await drawImportedFile(engine, records, {
        createCanvas: () => canvas,
        loadImage: async () => ({ width: 200, height: 100 }),
      });
      assert.equal(drawing.report.drawn, 1);
      assert.equal(drawing.report.undrawn, 0);
      const { rectangle } = layers[0].source;
      assert.ok(Math.abs(rectangle.west - 179.5) < 1e-9);
      assert.ok(Math.abs(rectangle.east + 179.5) < 1e-9);
      assert.ok(Math.abs(rectangle.south - 9.5) < 1e-9);
      assert.ok(Math.abs(rectangle.north - 11.5) < 1e-9);
      // 100 pixels a degree on both axes: the turned box is 1° by 2°.
      assert.deepEqual([canvas.width, canvas.height], [100, 200]);
      assert.deepEqual(
        calls.find(([name]) => name === 'rotate'),
        ['rotate', -Math.PI / 2],
      );
      assert.deepEqual(
        calls.find(([name]) => name === 'drawImage'),
        ['drawImage', -100, -50, 200, 100],
      );
      assert.equal(
        calls.some(([name]) => name === 'putImageData'),
        false,
      );
      drawing.destroy();
    },
  );

  displayTest(
    'a rotated overlay whose box passes a pole is reported undrawn',
    async ({ engine }) => {
      const records = emptyRecords();
      records.overlays.push({
        url: 'blob:overlay',
        color: [1, 1, 1, 1],
        rectangle: { west: 0, south: 80, east: 30, north: 89 },
        rotation: 45,
      });
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.deepEqual(drawing.report, {
        drawn: 0,
        undrawn: 1,
        kinds: { rotatedOverlay: 1 },
      });
      assert.equal(engine.imagery.list().length, 0);
      drawing.destroy();
    },
  );

  displayTest(
    'a rotated plain-colour overlay fills its turned corners',
    async ({ engine, set }) => {
      const records = emptyRecords();
      records.overlays.push({
        url: null,
        color: [0, 1, 0, 0.5],
        rectangle: { west: 0, south: 0, east: 2, north: 2 },
        rotation: 90,
      });
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      const fill = set(engine.ground.list()[0].id);
      const [ring] = fill.items[0].rings;
      const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
      assert.ok(near(ring[0], [2, 0]), JSON.stringify(ring));
      assert.ok(near(ring[1], [2, 2]), JSON.stringify(ring));
      assert.ok(near(ring[2], [0, 2]), JSON.stringify(ring));
      drawing.destroy();
    },
  );

  displayTest(
    'a turned plain-colour overlay past the pole does not fail the file',
    async ({ engine }) => {
      const records = geoJsonRecords(
        { type: 'Point', coordinates: [1, 2] },
        '#39d0ff',
      );
      records.overlays.push({
        url: null,
        color: [1, 0, 0, 0.5],
        rectangle: { west: 0, south: 80, east: 30, north: 89 },
        rotation: 45,
      });
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.deepEqual(drawing.report, {
        drawn: 1,
        undrawn: 1,
        kinds: { rotatedOverlay: 1 },
      });
      assert.equal(engine.ground.list().length, 0);
      drawing.destroy();
    },
  );

  displayTest(
    'a tinted, unturned overlay over all longitudes still draws',
    async ({ engine }) => {
      const layers = overlayLayer(engine);
      const records = emptyRecords();
      records.overlays.push({
        url: 'blob:overlay',
        color: [1, 0, 0, 1],
        rectangle: { west: -180, south: -90, east: 180, north: 90 },
        rotation: 0,
      });
      const drawing = await drawImportedFile(engine, records, {
        createCanvas,
        loadImage: async () => ({ width: 64, height: 32 }),
      });
      assert.deepEqual(drawing.report.kinds, {}, 'counted undrawn');
      assert.equal(layers.length, 1);
      assert.deepEqual(
        { ...layers[0].source.rectangle },
        { west: -180, south: -90, east: 180, north: 90 },
      );
      drawing.destroy();
    },
  );

  // Canvases made, their pixels counted.
  const countedCanvases = () => {
    const canvases = [];
    return {
      canvases,
      pixels: () => canvases.reduce((n, c) => n + c.width * c.height, 0),
      createCanvas: () => {
        const canvas = createCanvas();
        canvases.push(canvas);
        return canvas;
      },
    };
  };

  displayTest(
    'turned overlays sharing one small image share one bounded canvas',
    async ({ engine }) => {
      const counted = countedCanvases();
      const records = emptyRecords();
      for (let i = 0; i < 20; i++)
        records.overlays.push({
          url: 'blob:overlay',
          color: [1, 1, 1, 1],
          rectangle: { west: i, south: 10, east: i + 10, north: 10.01 },
          rotation: 45,
        });
      const drawing = await drawImportedFile(engine, records, {
        createCanvas: counted.createCanvas,
        loadImage: async () => ({ width: 64, height: 64 }),
      });
      assert.equal(drawing.report.drawn, 20);
      assert.equal(counted.canvases.length, 1, 'equal looks share a canvas');
      // Each of 20 overlays may hold a twentieth of the budget.
      const side = Math.floor(Math.sqrt(OVERLAY_PIXEL_BUDGET / 20));
      const [canvas] = counted.canvases;
      assert.ok(
        canvas.width <= side && canvas.height <= side,
        `${canvas.width}`,
      );
      drawing.destroy();
    },
  );

  displayTest(
    'distinct tints of a large image stay within the canvas budget',
    async ({ engine }) => {
      const counted = countedCanvases();
      const records = emptyRecords();
      for (let i = 0; i < 100; i++)
        records.overlays.push({
          url: 'blob:overlay',
          color: [1, i / 100, 0, 1],
          rectangle: { west: 0, south: 0, east: 1, north: 1 },
          rotation: 0,
        });
      const drawing = await drawImportedFile(engine, records, {
        createCanvas: counted.createCanvas,
        loadImage: async () => ({ width: 4096, height: 4096 }),
      });
      assert.equal(drawing.report.drawn, 100);
      assert.equal(counted.canvases.length, 100);
      assert.ok(
        counted.pixels() <= OVERLAY_PIXEL_BUDGET,
        `${Math.round((counted.pixels() * 4) / 2 ** 20)} MiB of canvas RGBA`,
      );
      drawing.destroy();
    },
  );

  displayTest(
    'a shared overlay canvas keeps each rectangle and its aspect ratio',
    async ({ engine }) => {
      const counted = countedCanvases();
      const layers = overlayLayer(engine);
      const records = emptyRecords();
      for (const rectangle of [
        { west: 0, south: 0, east: 2, north: 1 },
        { west: 10, south: 0, east: 12, north: 1 },
        { west: 0, south: 0, east: 1, north: 2 },
      ])
        records.overlays.push({
          url: 'blob:overlay',
          color: [1, 1, 1, 1],
          rectangle,
          rotation: 45,
        });
      const drawing = await drawImportedFile(engine, records, {
        createCanvas: counted.createCanvas,
        loadImage: async () => ({ width: 64, height: 32 }),
      });
      assert.equal(counted.canvases.length, 2);
      assert.equal(layers[0].source.image, layers[1].source.image);
      assert.notEqual(layers[0].source.image, layers[2].source.image);
      assert.ok(
        Math.abs(
          layers[1].source.rectangle.west -
            layers[0].source.rectangle.west -
            10,
        ) < 1e-9,
      );
      drawing.destroy();
    },
  );

  displayTest(
    'a turned overlay keeps every source pixel of an image squeezed on one axis',
    async ({ engine }) => {
      const { calls, canvas } = recordingCanvas();
      const records = emptyRecords();
      // 32 pixels a degree across, 64 up: both axes draw at 64.
      records.overlays.push({
        url: 'blob:overlay',
        color: [1, 1, 1, 1],
        rectangle: { west: 0, south: 0, east: 2, north: 1 },
        rotation: 30,
      });
      const drawing = await drawImportedFile(engine, records, {
        createCanvas: () => canvas,
        loadImage: async () => ({ width: 64, height: 64 }),
      });
      const [, , , width, height] = calls.find(
        ([name]) => name === 'drawImage',
      );
      assert.deepEqual([width, height], [128, 64]);
      drawing.destroy();
    },
  );

  displayTest(
    'an absolute overlay stays at its altitude while a relative one drapes',
    async ({ engine }) => {
      const layers = overlayLayer(engine);
      const meshes = [];
      const create = engine.meshes.createMesh;
      engine.meshes.createMesh = (options) => {
        meshes.push(options);
        return create(options);
      };
      const records = emptyRecords();
      for (const altitudeMode of ['absolute', 'relative'])
        records.overlays.push({
          url: 'blob:overlay',
          altitudeMode,
          altitude: 1000,
          color: [1, 1, 1, 1],
          rectangle: { west: 0, south: 0, east: 1, north: 1 },
          rotation: 0,
        });
      const drawing = await drawImportedFile(engine, records, {
        createCanvas,
        loadImage: async () => ({ width: 32, height: 32 }),
      });
      assert.deepEqual(drawing.report, { drawn: 2, undrawn: 0, kinds: {} });
      assert.equal(meshes.length, 1);
      assert.equal(layers.length, 1);
      assert.equal(layers[0].raise, undefined);
      const mesh = meshes[0];
      assert.equal(mesh.image.width, 32);
      assert.equal(mesh.uv.length, (mesh.positions.length / 3) * 2);
      // A fixed height, not imagery's shell that rises with the camera.
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const position = geo.cartesian3.create(
          ...mesh.positions.slice(i, i + 3),
        );
        const { height } = geo.cartographic.fromCartesian(position);
        assert.ok(Math.abs(height - 1000) < 0.01, `${height}`);
      }
      drawing.destroy();
      assert.equal(engine.meshes.list().length, 0);
    },
  );

  displayTest(
    'absolute overlays share decoded images and report missing ones',
    async ({ engine }) => {
      const records = emptyRecords();
      for (const url of ['blob:overlay', 'blob:overlay', 'blob:missing'])
        records.overlays.push({
          url,
          altitudeMode: 'absolute',
          altitude: 1000,
          color: [1, 1, 1, 1],
          rectangle: { west: 0, south: 0, east: 1, north: 1 },
        });
      let loads = 0;
      const drawing = await drawImportedFile(engine, records, {
        createCanvas,
        loadImage: async (url) => {
          loads++;
          if (url === 'blob:missing') throw new Error('image unavailable');
          return { width: 32, height: 32 };
        },
      });
      assert.equal(loads, 2);
      assert.equal(engine.meshes.list().length, 2);
      assert.deepEqual(drawing.report, {
        drawn: 2,
        undrawn: 1,
        kinds: { raisedOverlay: 1 },
      });
      drawing.destroy();
    },
  );

  displayTest(
    'tile samples only measure visible pins and yield between passes',
    async ({ engine }) => {
      await engine.maps.setPhotorealTiles({});
      engine.camera.height = () => 1000;
      engine.projector.horizonVisible = () => true;
      let visible = false;
      engine.projector.worldToWindow = () => (visible ? { x: 1, y: 1 } : null);
      let clamps = 0;
      engine.surface.sampleHeight = () => {
        clamps++;
        return 0;
      };
      const records = geoJsonRecords(
        {
          type: 'MultiPoint',
          coordinates: Array.from({ length: 600 }, () => [1, 2]),
        },
        '#39d0ff',
      );
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.equal(clamps, 0);
      visible = true;
      let beforeYield;
      const heartbeat = setTimeout(() => {
        beforeYield = clamps;
      }, 0);
      await drawing.refreshGround();
      await new Promise((resolve) => setTimeout(resolve, 0));
      clearTimeout(heartbeat);
      assert.ok(beforeYield > 0 && beforeYield <= 16);
      while (clamps < 600)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(clamps, 600);
      drawing.destroy();
    },
  );

  displayTest(
    'an aborted ground refresh leaves the existing drawing owned',
    async ({ engine }) => {
      const records = geoJsonRecords(
        { type: 'Point', coordinates: [1, 2] },
        '#39d0ff',
      );
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      await assert.rejects(drawing.refreshGround(AbortSignal.abort()), {
        name: 'AbortError',
      });
      assert.equal(engine.movers.list()[0].count, 1);
      drawing.destroy();
    },
  );
}
