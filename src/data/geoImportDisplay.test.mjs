import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../geo/index.js';
import { GROUND_HARNESSES } from '../testSupport/groundDisplayEngines.mjs';
import { drawImportedFile } from './geoImportDisplay.js';
import { emptyRecords, geoJsonRecords } from './geoImportRecords.js';

// A 2D context that only records what draws.
const createCanvas = () => ({
  getContext: () =>
    new Proxy({}, { get: (_, key) => (key in {} ? undefined : () => {}) }),
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
      await drawing.refreshGround();
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
      } else engine.imagery.surface = () => 'tiles';
      engine.camera.height = () => 1000;
      engine.projector.worldToWindow = () => ({ x: 1, y: 1 });
      engine.projector.horizonVisible = () => true;
      const excluded = [];
      engine.surface.clampToHeight = (position, exclude) => {
        excluded.push(exclude);
        const at = geo.cartographic.fromCartesian(position);
        return geo.cartesian3.fromRadians(at.longitude, at.latitude, 2000);
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
    'an absolute overlay is raised to its altitude, a relative one drapes',
    async ({ engine }) => {
      const layers = overlayLayer(engine);
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
      const drawing = await drawImportedFile(engine, records, { createCanvas });
      assert.deepEqual(drawing.report, { drawn: 2, undrawn: 0, kinds: {} });
      assert.equal(layers[0].raise, 1000);
      assert.equal(layers[1].raise, undefined);
      drawing.destroy();
    },
  );

  displayTest(
    'tile clamps only sample visible pins and yield between batches',
    async ({ engine }) => {
      engine.imagery.surface = () => 'tiles';
      engine.camera.height = () => 1000;
      engine.projector.horizonVisible = () => true;
      let visible = false;
      engine.projector.worldToWindow = () => (visible ? { x: 1, y: 1 } : null);
      let clamps = 0;
      engine.surface.clampToHeight = (position) => {
        clamps++;
        return position;
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
      clearTimeout(heartbeat);
      assert.equal(beforeYield, 256);
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
