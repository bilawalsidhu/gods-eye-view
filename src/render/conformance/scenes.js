/**
 * @module render/conformance/scenes
 * @description The reference scenes: one per primitive family, a city scene
 * that mixes them, and a calibration path. Each is built from contract calls
 * only, so any renderer can draw it, and each has fixed views to capture.
 *
 * The scenes load nothing from the network: the globe is bare (no imagery,
 * no photoreal tiles, no atmosphere), so what a capture shows depends on the
 * renderer alone. Images are inline SVG.
 *
 * A scene is `{ id, family, capability, build(renderer, ctx), views }`:
 * `build` returns a disposer; `ctx` has `toEcef` and optional `assets`
 * (`model`: a glTF URL). A scene whose capability the renderer lacks, or
 * whose asset the context lacks, is not drawn.
 */
import { AUSTIN } from './cameraScripts.js';

/** Looking down at Austin from `height`, tilted by `pitch`. */
const over = (height, pitch = -Math.PI / 2, heading = 0, at = AUSTIN) => ({
  destination: { ...at, height },
  orientation: { heading, pitch, roll: 0 },
});

/** A point `east`, `north` metres from `center`, approximately. */
function offsetFrom(center, east, north, height = 0) {
  return {
    lon: center.lon + east / (111320 * Math.cos((center.lat * Math.PI) / 180)),
    lat: center.lat + north / 110540,
    height,
  };
}

/** A point `east`, `north` metres from Austin, approximately. */
const offset = (east, north, height = 0) =>
  offsetFrom(AUSTIN, east, north, height);

const svg = (body, size = 32) => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${body}</svg>`,
});
const ICONS = {
  dot: svg('<circle cx="16" cy="16" r="14" fill="#ffffff"/>'),
  arrow: svg('<path d="M16 2 L28 30 L16 23 L4 30 Z" fill="#ffffff"/>'),
  square: svg(
    '<rect x="3" y="3" width="26" height="26" fill="#ffffff" stroke="#000000" stroke-width="3"/>',
  ),
};

const BG = {
  sky: {
    atmosphere: false,
    stars: false,
    milkyWay: 0,
    sun: false,
    moon: false,
    fog: false,
    lighting: false,
  },
};

/** Bare globe, empty sky: nothing in a capture but the scene. */
async function bare(r) {
  await r.globe.setBase({
    photoreal: null,
    terrain: { kind: 'ellipsoid' },
    imagery: [],
  });
  r.globe.setGlobeVisible(true);
  r.globe.sky.set(BG.sky);
}

/** Disposes every set it was given. */
const disposeAll =
  (...handles) =>
  () =>
    handles.forEach((h) => h.dispose());

const ring = (ctx, center, radius, count, height = 0) =>
  Array.from({ length: count + 1 }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    return ctx.toEcef(
      offsetFrom(center, Math.cos(a) * radius, Math.sin(a) * radius, height),
    );
  });

/** @type {ReadonlyArray<object>} */
export const REFERENCE_SCENES = Object.freeze([
  {
    id: 'icons',
    family: 'icons',
    capability: null,
    async build(r, ctx) {
      await bare(r);
      const set = r.draw.icons({ id: 'ref:icons' });
      const items = [];
      const colors = ['#ff3b30', '#34c759', '#0a84ff', '#ffd60a'];
      for (let row = 0; row < 4; row++)
        for (let col = 0; col < 6; col++) {
          const id = `i${row}${col}`;
          const pos = ctx.toEcef(offset((col - 2.5) * 250, (1.5 - row) * 250));
          // Drawn over the globe: at 0 m a tilted view would hide their lower half.
          const base = {
            id,
            pos,
            size: [24 + col * 4, 24 + col * 4],
            color: colors[row],
            disableDepthTest: Infinity,
          };
          if (row === 0) items.push({ ...base, image: ICONS.dot });
          if (row === 1)
            items.push({
              ...base,
              image: ICONS.arrow,
              rotationMode: 'screen',
              rotation: (col * Math.PI) / 6,
            });
          if (row === 2)
            items.push({
              ...base,
              image: ICONS.arrow,
              rotationMode: 'course',
              course: col * 60,
            });
          if (row === 3)
            items.push({
              ...base,
              image: ICONS.square,
              anchor: col % 2 ? 'bottom' : 'center',
              alpha: 0.4 + col * 0.1,
            });
        }
      set.set(items);
      return disposeAll(set);
    },
    views: [
      { name: 'top', view: over(3000) },
      { name: 'tilted', view: over(1500, -0.6, 0, offset(0, -2300)) },
    ],
  },
  {
    id: 'points',
    family: 'points',
    capability: null,
    async build(r, ctx) {
      await bare(r);
      const set = r.draw.points({ id: 'ref:points' });
      const items = [];
      for (let i = 0; i < 8; i++)
        items.push({
          id: `p${i}`,
          pos: ctx.toEcef(offset((i - 3.5) * 180, 150)),
          pixelSize: 4 + i * 3,
          color: [1, i / 7, 0, 1],
        });
      for (let i = 0; i < 8; i++)
        items.push({
          id: `q${i}`,
          pos: ctx.toEcef(offset((i - 3.5) * 180, -150)),
          pixelSize: 18,
          color: '#0a84ff',
          outlineColor: '#ffffff',
          outlineWidth: i,
        });
      set.set(items);
      return disposeAll(set);
    },
    views: [{ name: 'top', view: over(2500) }],
  },
  {
    id: 'lines',
    family: 'lines',
    capability: null,
    async build(r, ctx) {
      await bare(r);
      const set = r.draw.lines({ id: 'ref:lines' });
      const row = (north, height = 0) => [
        ctx.toEcef(offset(-1200, north, height)),
        ctx.toEcef(offset(1200, north, height)),
      ];
      set.set([
        {
          id: 'solid',
          positions: row(600),
          widthPx: 2,
          mode: '3d',
          style: { kind: 'solid', color: '#ffffff' },
        },
        {
          id: 'wide',
          positions: row(400),
          widthPx: 8,
          mode: '3d',
          style: { kind: 'solid', color: '#ff3b30' },
        },
        {
          id: 'glow',
          positions: row(200),
          widthPx: 12,
          mode: '3d',
          style: { kind: 'glow', color: '#34c759', power: 0.25 },
        },
        {
          id: 'dash',
          positions: row(0),
          widthPx: 4,
          mode: '3d',
          style: { kind: 'dash', color: '#ffd60a', length: 16 },
        },
        {
          id: 'arrow',
          positions: row(-200),
          widthPx: 14,
          mode: '3d',
          style: { kind: 'arrow', color: '#0a84ff' },
        },
        {
          id: 'raised',
          positions: row(-400, 300),
          widthPx: 3,
          mode: '3d',
          style: { kind: 'solid', color: '#bf5af2' },
        },
        {
          id: 'geodesic',
          positions: row(-600),
          widthPx: 3,
          mode: 'geodesic',
          style: { kind: 'solid', color: '#64d2ff' },
        },
        {
          id: 'loop',
          positions: ring(ctx, offset(0, 0), 900, 48),
          widthPx: 2,
          mode: '3d',
          style: { kind: 'solid', color: '#ff9f0a' },
        },
      ]);
      return disposeAll(set);
    },
    views: [
      { name: 'top', view: over(4500) },
      { name: 'tilted', view: over(2500, -0.45, 0, offset(0, -3500)) },
    ],
  },
  {
    id: 'shapes',
    family: 'shapes',
    capability: null,
    async build(r, ctx) {
      await bare(r);
      const set = r.draw.shapes({ id: 'ref:shapes' });
      // Flat shapes sit 5 m up: at 0 m they share depth with the globe.
      const lift = 5;
      const square = (east, north, half) => [
        offset(east - half, north - half, lift),
        offset(east + half, north - half, lift),
        offset(east + half, north + half, lift),
        offset(east - half, north + half, lift),
      ];
      set.set([
        {
          id: 'polygon',
          geometry: { kind: 'polygon', rings: [square(-700, 400, 250)] },
          fill: [1, 0.23, 0.19, 0.8],
          outline: '#ffffff',
        },
        {
          id: 'holed',
          geometry: {
            kind: 'polygon',
            rings: [square(0, 400, 280), square(0, 400, 120)],
          },
          fill: '#34c759',
        },
        {
          id: 'extruded',
          geometry: { kind: 'polygon', rings: [square(700, 400, 200)] },
          fill: '#0a84ff',
          extrudeHeight: 400,
        },
        {
          id: 'ellipse',
          geometry: {
            kind: 'ellipse',
            center: offset(-700, -400, 5),
            semiMajor: 300,
            semiMinor: 160,
            rotation: 0.5,
          },
          fill: [1, 0.84, 0.04, 0.7],
        },
        {
          id: 'rectangle',
          geometry: {
            kind: 'rectangle',
            rect: {
              west: offset(-250, 0).lon,
              south: offset(0, -650).lat,
              east: offset(250, 0).lon,
              north: offset(0, -150).lat,
            },
            height: 5,
          },
          fill: '#bf5af2',
        },
        {
          id: 'box',
          geometry: {
            kind: 'box',
            center: offset(700, -400, 150),
            dimensions: { x: 300, y: 300, z: 300 },
          },
          fill: '#ff9f0a',
        },
        {
          id: 'outline',
          geometry: { kind: 'polygon', rings: [square(0, -1000, 200)] },
          outline: '#ffffff',
          outlineOnly: true,
        },
      ]);
      return disposeAll(set);
    },
    views: [
      { name: 'top', view: over(5000) },
      { name: 'tilted', view: over(2500, -0.5, 0.3, offset(0, -3600)) },
    ],
  },
  {
    id: 'models',
    family: 'models',
    capability: 'models',
    needs: ['model'],
    async build(r, ctx) {
      await bare(r);
      r.globe.sky.set({ lighting: true });
      // No wait on `ready` here: a model that never loads would hang the
      // run, and `whenSettled` before each view waits for loading models.
      const set = r.draw.models({ id: 'ref:models' });
      set.set([
        {
          id: 'plane',
          pos: offset(0, 0, 300),
          url: ctx.assets.model,
          orientation: { heading: 0.6, pitch: 0, roll: 0 },
          scale: 4,
          minPixelSize: 64,
        },
      ]);
      return disposeAll(set);
    },
    views: [{ name: 'oblique', view: over(330, -0.2, 0, offset(0, -140)) }],
  },
  {
    id: 'quads',
    family: 'quads',
    capability: 'quads',
    async build(r, ctx) {
      await bare(r);
      const set = r.draw.quads({ id: 'ref:quads' });
      set.set([
        {
          id: 'card',
          center: offset(0, 0, 200),
          orientation: { x: 0, y: 0, z: 0, w: 1 },
          size: [400, 250],
          source: { image: ICONS.square },
          outline: { color: '#ffffff', widthPx: 2 },
        },
      ]);
      return disposeAll(set);
    },
    views: [{ name: 'oblique', view: over(1500, -0.5, 0, offset(0, -1600)) }],
  },
  {
    id: 'meshes',
    family: 'meshes',
    capability: 'meshes',
    async build(r, ctx) {
      await bare(r);
      const set = r.draw.meshes({ id: 'ref:meshes' });
      // A square pyramid, 400 m across and 300 m tall.
      const positions = new Float32Array([
        -200, -200, 0, 200, -200, 0, 200, 200, 0, -200, 200, 0, 0, 0, 300,
      ]);
      const indices = new Uint16Array([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]);
      set.set([
        {
          id: 'pyramid',
          origin: ctx.toEcef(offset(0, 0)),
          positions,
          indices,
          color: '#ff9f0a',
          flat: true,
        },
      ]);
      return disposeAll(set);
    },
    views: [{ name: 'oblique', view: over(1200, -0.5, 0, offset(0, -1400)) }],
  },
  {
    id: 'fields',
    family: 'fields',
    capability: 'fields',
    async build(r) {
      await bare(r);
      const width = 32;
      const height = 16;
      const values = new Float32Array(width * height).map(
        (_, i) => (i % width) / width,
      );
      const field = r.draw.field({
        kind: 'scalarRaster',
        id: 'ref:scalar',
        values,
        width,
        height,
        rectangle: { west: -100, south: 28, east: -95, north: 32 },
        ramp: [
          { value: 0, color: '#0a84ff' },
          { value: 0.5, color: '#34c759' },
          { value: 1, color: '#ff3b30' },
        ],
        alpha: 0.8,
      });
      return () => field.dispose();
    },
    views: [
      {
        name: 'regional',
        view: over(900000, -Math.PI / 2, 0, { lon: -97.5, lat: 30 }),
      },
    ],
  },
  {
    id: 'agents',
    family: 'agents',
    capability: 'agents',
    async build(r, ctx) {
      await bare(r);
      const set = r.draw.agents({ id: 'ref:agents' });
      set.set([
        {
          id: 'road',
          positions: [ctx.toEcef(offset(-800, 0)), ctx.toEcef(offset(800, 0))],
          count: 20,
          speedMps: 0,
          color: '#ffd60a',
          pixelSize: 6,
        },
      ]);
      return disposeAll(set);
    },
    views: [{ name: 'top', view: over(2500) }],
  },
  {
    id: 'city',
    family: 'city',
    capability: null,
    async build(r, ctx) {
      await bare(r);
      const shapes = r.draw.shapes({ id: 'ref:city:blocks' });
      const blocks = [];
      for (let i = 0; i < 5; i++)
        for (let j = 0; j < 5; j++) {
          const e = (i - 2) * 220;
          const n = (j - 2) * 220;
          blocks.push({
            id: `b${i}${j}`,
            geometry: {
              kind: 'polygon',
              rings: [
                [
                  offset(e - 80, n - 80),
                  offset(e + 80, n - 80),
                  offset(e + 80, n + 80),
                  offset(e - 80, n + 80),
                ],
              ],
            },
            fill: [0.55, 0.6, 0.7, 1],
            extrudeHeight: 40 + ((i * 7 + j * 13) % 9) * 25,
          });
        }
      shapes.set(blocks);
      const roads = r.draw.lines({ id: 'ref:city:roads' });
      const road = (id, a, b) => ({
        id,
        positions: [ctx.toEcef(a), ctx.toEcef(b)],
        widthPx: 3,
        mode: '3d',
        style: { kind: 'solid', color: '#ffd60a' },
      });
      roads.set([
        ...[-330, -110, 110, 330].map((n, k) =>
          road(`ew${k}`, offset(-600, n, 2), offset(600, n, 2)),
        ),
        ...[-330, -110, 110, 330].map((e, k) =>
          road(`ns${k}`, offset(e, -600, 2), offset(e, 600, 2)),
        ),
      ]);
      const vehicles = r.draw.icons({ id: 'ref:city:vehicles' });
      vehicles.set(
        Array.from({ length: 12 }, (_, k) => ({
          id: `v${k}`,
          pos: ctx.toEcef(offset(-500 + k * 90, -110, 5)),
          image: ICONS.arrow,
          size: [20, 20],
          color: '#ff3b30',
          rotationMode: 'course',
          course: 90,
        })),
      );
      const sensors = r.draw.points({ id: 'ref:city:sensors' });
      sensors.set(
        Array.from({ length: 10 }, (_, k) => ({
          id: `s${k}`,
          pos: ctx.toEcef(offset(110, -550 + k * 110, 5)),
          pixelSize: 8,
          color: '#34c759',
          outlineColor: '#000000',
          outlineWidth: 1,
        })),
      );
      return disposeAll(shapes, roads, vehicles, sensors);
    },
    views: [
      { name: 'orbit', view: over(15000000) },
      { name: 'city', view: over(1800, -0.6, 0.4, offset(-1200, -2600)) },
      { name: 'street', view: over(60, -0.08, 0, offset(-150, -700)) },
    ],
  },
]);

/**
 * The calibration path: the city scene seen from orbit down to the street,
 * the poses a quality calibration (and the performance budget) samples.
 */
export const CALIBRATION_PATH = Object.freeze({
  scene: 'city',
  poses: Object.freeze([
    over(15000000),
    over(1500000),
    over(60000, -1.2),
    over(6000, -0.8, 0.3, offset(-800, -3000)),
    over(1200, -0.5, 0.5, offset(-600, -1200)),
    over(250, -0.25, 0.2, offset(-250, -800)),
    over(60, -0.08, 0, offset(-150, -700)),
  ]),
});

/** Whether a renderer and context can draw a scene; the reason when not. */
export function sceneSupport(scene, renderer, ctx = {}) {
  if (scene.capability && !renderer.capabilities.has(scene.capability))
    return `no ${scene.capability}`;
  for (const need of scene.needs ?? [])
    if (!ctx.assets?.[need]) return `no ${need} asset`;
  return null;
}
