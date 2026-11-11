import {
  cartesian3,
  cartographic,
  like,
  MAGENTA,
  show,
  ensure,
  near,
  unit,
} from './helpers.mjs';
import { createSurfacePoints } from '../../surfacePlacement.js';

export function spriteChecks(
  engine,
  { settle, until, nadirView, centre, readRegion, makeCanvas },
) {
  return [
    [
      'movers.createSet: three sprites draw at their projections, hide, recolour and go',
      async () => {
        await nadirView(1e6);
        const atlasCanvas = makeCanvas
          ? makeCanvas(16, 16)
          : { width: 16, height: 16 };
        if (makeCanvas) {
          const context = atlasCanvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, 16, 16);
        }
        const places = [
          [20, 10],
          [21.5, 10],
          [20, 11.5],
        ].map(([lon, lat]) => cartesian3.fromDegrees(lon, lat, 1000));
        const set = engine.movers.createSet({
          id: 'contract-sprites',
          kind: 'sprite',
          capacity: 3,
          order: 100,
          depthTest: 'always',
          sprite: {
            atlas: { canvas: atlasCanvas, cells: { box: [0, 0, 1, 1] } },
            sizePx: 24,
          },
        });
        const MAGENTA = [1, 0, 1, 1];
        // Frames drawn in a window, with nothing asked of the engine.
        const framesIn = async (ms) => {
          let frames = 0;
          const remove = engine.frames.postRender.addEventListener(
            () => frames++,
          );
          await new Promise((resolve) => setTimeout(resolve, ms));
          remove();
          return frames;
        };
        const idleFrames = readRegion ? await framesIn(2000) : 0;
        try {
          places.forEach((position, index) =>
            set.set(index, { position, color: MAGENTA, cell: 'box' }),
          );
          set.setCount(3);
          set.commit();
          ensure(set.count() === 3, `count ${set.count()}`);
          ensure(
            typeof set.ready() === 'boolean' &&
              typeof set.ready(0) === 'boolean',
            'ready() and ready(index) answer booleans',
          );
          ensure(
            engine.movers
              .list()
              .some(
                ({ id, count }) => id === 'contract-sprites' && count === 3,
              ),
            'movers.list() does not show the set',
          );
          if (!readRegion) return;
          const screens = places.map((position) =>
            engine.projector.worldToWindow(position),
          );
          // Pixels close to a colour in a 64 px box around a point: their
          // count and centroid.
          // A colour as drawn: within 40 of the asked one on every channel
          // (both engines draw overlays after tone mapping, unlit).

          const find = (screen, colour) => {
            const half = 32;
            const x0 = Math.round(screen.x) - half;
            const y0 = Math.round(screen.y) - half;
            const data = readRegion(x0, y0, 2 * half, 2 * half);
            let count = 0;
            let sx = 0;
            let sy = 0;
            for (let y = 0; y < 2 * half; y++)
              for (let x = 0; x < 2 * half; x++) {
                const i = (y * 2 * half + x) * 4;
                if (like(colour, data, i)) {
                  count++;
                  sx += x0 + x + 0.5;
                  sy += y0 + y + 0.5;
                }
              }
            return count
              ? { count, x: sx / count, y: sy / count }
              : { count, x: NaN, y: NaN };
          };
          // The atlas and the upload may take a few frames.
          await until(
            () => find(screens[0], MAGENTA).count > 100,
            'the first sprite drawn',
          );
          screens.forEach((screen, index) => {
            const seen = find(screen, MAGENTA);
            ensure(
              seen.count > 300,
              `sprite ${index}: ${seen.count} magenta pixels, a 24 px square has 576`,
            );
            ensure(
              Math.hypot(seen.x - screen.x, seen.y - screen.y) <= 2,
              `sprite ${index} centred at ${seen.x.toFixed(1)}, ${seen.y.toFixed(1)}, projected ${screen.x.toFixed(1)}, ${screen.y.toFixed(1)}`,
            );
          });
          set.set(1, { show: false });
          set.set(0, { color: [0, 1, 0, 1] });
          set.commit();
          await until(
            () => find(screens[1], MAGENTA).count < 10,
            'the hidden sprite gone',
          );
          ensure(
            find(screens[0], [0, 1, 0, 1]).count > 300,
            'the recoloured sprite is not green',
          );
          ensure(
            find(screens[2], MAGENTA).count > 300,
            'an untouched sprite changed',
          );
          // Idle: once a commit has drawn, the set adds no frames (the
          // page may draw for its own reasons: the app's other layers).
          await settle(2);
          const framesAfter = await framesIn(2000);
          ensure(
            framesAfter <= idleFrames + 1,
            `${framesAfter} frames in 2 s after a commit, ${idleFrames} before the set`,
          );
          set.destroy();
          await until(
            () => find(screens[2], MAGENTA).count < 10,
            'the destroyed set gone',
          );
        } finally {
          set.destroy();
        }
        ensure(
          !engine.movers.list().some(({ id }) => id === 'contract-sprites'),
          'a destroyed set is still listed',
        );
      },
    ],
    [
      'movers.createSet: colours: mid-tone sprite, point and line colours draw as asked (within 3 per channel)',
      async () => {
        if (!readRegion || !makeCanvas) return;
        await nadirView(1e6);
        const at = (lon, lat, height = 20_000) =>
          cartesian3.fromDegrees(lon, lat, height);
        const GREY = [0.5, 0.5, 0.5, 1];
        const ORANGE = [1, 0.6, 0.2, 1];
        const atlasCanvas = makeCanvas(16, 16);
        const context = atlasCanvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, 16, 16);
        const sprites = engine.movers.createSet({
          id: 'contract-colour-sprites',
          kind: 'sprite',
          capacity: 2,
          order: 100,
          depthTest: 'always',
          sprite: {
            atlas: { canvas: atlasCanvas, cells: { box: [0, 0, 1, 1] } },
            sizePx: 32,
          },
        });
        const points = engine.movers.createSet({
          id: 'contract-colour-points',
          kind: 'point',
          capacity: 2,
          order: 100,
          depthTest: 'always',
          point: { sizePx: 32 },
        });
        const lines = [GREY, ORANGE].map((color, index) =>
          engine.lines.createLine({
            id: `contract-colour-line-${index}`,
            widthPx: 16,
            color,
          }),
        );
        // The centre 4×4 pixels' mean, as 0..255 per channel.
        const centre = (position) => {
          const screen = engine.projector.worldToWindow(position);
          const data = readRegion(
            Math.round(screen.x) - 2,
            Math.round(screen.y) - 2,
            4,
            4,
          );
          const sum = [0, 0, 0];
          for (let i = 0; i < data.length; i += 4)
            for (let k = 0; k < 3; k++) sum[k] += data[i + k];
          return sum.map((value) => value / (data.length / 4));
        };
        const cases = [
          ['sprite', GREY, at(19.5, 10.5)],
          ['sprite', ORANGE, at(20.5, 10.5)],
          ['point', GREY, at(19.5, 9.5)],
          ['point', ORANGE, at(20.5, 9.5)],
          ['line', GREY, at(19.5, 10)],
          ['line', ORANGE, at(20.5, 10)],
        ];
        try {
          sprites.set(0, { position: cases[0][2], color: GREY, cell: 'box' });
          sprites.set(1, { position: cases[1][2], color: ORANGE, cell: 'box' });
          sprites.setCount(2);
          sprites.commit();
          points.set(0, { position: cases[2][2], color: GREY });
          points.set(1, { position: cases[3][2], color: ORANGE });
          points.setCount(2);
          points.commit();
          // Short vertical lines through their sample points.
          lines[0].setPositions([at(19.5, 9.9), at(19.5, 10.1)]);
          lines[1].setPositions([at(20.5, 9.9), at(20.5, 10.1)]);
          const off = (seen, colour) =>
            Math.max(
              ...seen.map((value, k) => Math.abs(value - colour[k] * 255)),
            );
          await until(
            () => cases.every(([, colour, p]) => off(centre(p), colour) <= 3),
            'mid-tone colours within 3',
          );
        } catch (error) {
          const seen = cases
            .map(
              ([kind, colour, p]) =>
                `${kind} ${colour.slice(0, 3)} → ${centre(p)
                  .map((v) => v.toFixed(0))
                  .join('/')}`,
            )
            .join('; ');
          throw new ContractError(`${error.message}: ${seen}`);
        } finally {
          sprites.destroy();
          points.destroy();
          for (const line of lines) line.destroy();
        }
      },
    ],
  ];
}

export function moverChecks(engine, context) {
  const { until, nadirView, centre, readRegion, makeCanvas } = context;
  const { camera } = engine;
  return [
    ...surfaceMoverChecks(engine, context),
    ...tilesMoverChecks(engine, context),
    [
      'movers.createSet: depth tests, rotation, cells, scale, count, points and models',
      async () => {
        await nadirView(1e6);
        const at = (lon, lat, height = 20_000) =>
          cartesian3.fromDegrees(lon, lat, height);
        // Atlas: 'red' a red square; 'up' white in its top half only.
        const atlas = makeCanvas
          ? makeCanvas(32, 16)
          : { width: 32, height: 16 };
        if (makeCanvas) {
          const context = atlas.getContext('2d');
          context.fillStyle = '#ff0000';
          context.fillRect(0, 0, 16, 16);
          context.fillStyle = '#ffffff';
          context.fillRect(16, 0, 16, 8);
        }
        const cells = { red: [0, 0, 0.5, 1], up: [0.5, 0, 1, 1] };
        const sprites = (id, extra = {}) =>
          engine.movers.createSet({
            id,
            kind: 'sprite',
            capacity: 3,
            order: 100,
            depthTest: 'always',
            sprite: { atlas: { canvas: atlas, cells }, sizePx: 24 },
            ...extra,
          });
        const sets = [];
        const make = (set) => (sets.push(set), set);
        const RED = [1, 0, 0];
        const MAGENTA = [1, 0, 1];
        // Pixels near a colour (within 60 per channel) in a box, and how
        // many lie above / below the box's centre row.
        const look = (position, colour, half = 40) => {
          const screen = engine.projector.worldToWindow(position);
          const x0 = Math.round(screen.x) - half;
          const y0 = Math.round(screen.y) - half;
          const data = readRegion(x0, y0, 2 * half, 2 * half);
          let total = 0;
          let above = 0;
          for (let y = 0; y < 2 * half; y++)
            for (let x = 0; x < 2 * half; x++) {
              const i = (y * 2 * half + x) * 4;
              if (
                colour.every(
                  (channel, k) => Math.abs(data[i + k] - channel * 255) <= 60,
                )
              ) {
                total++;
                if (y < half) above++;
              }
            }
          return { total, above, below: total - above };
        };
        try {
          const a = at(19.5, 10);
          const base = make(sprites('contract-cells'));
          base.set(0, { position: a, cell: 'red' });
          base.set(1, { position: at(20.5, 10), cell: 'red' });
          base.set(2, { position: at(20.5, 11), cell: 'red' });
          base.setCount(3);
          base.commit();
          const far = make(
            sprites('contract-far', {
              sprite: {
                atlas: { canvas: atlas, cells },
                sizePx: 24,
                // The camera is 1000 km away: past `far`, half size.
                scaleByDistance: [1e3, 1, 1e5, 0.5],
              },
            }),
          );
          const b = at(19.5, 11);
          far.set(0, { position: b, cell: 'red' });
          far.setCount(1);
          far.commit();
          const deep = (lon) => at(lon, 9, -30_000);
          const depth = {
            normal: make(sprites('contract-normal', { depthTest: 'normal' })),
            always: make(sprites('contract-always', { depthTest: 'always' })),
            within: make(
              sprites('contract-within', {
                depthTest: { disableWithinM: 2e7 },
              }),
            ),
            near: make(
              sprites('contract-near', { depthTest: { disableWithinM: 10 } }),
            ),
          };
          Object.values(depth).forEach((set, index) => {
            set.set(0, { position: deep(19 + index * 0.7), cell: 'red' });
            set.setCount(1);
            set.commit();
          });
          const points = make(
            engine.movers.createSet({
              id: 'contract-points',
              kind: 'point',
              capacity: 1,
              depthTest: 'always',
              point: { sizePx: 20, outlinePx: 3 },
            }),
          );
          const p = at(20.5, 9.5);
          points.set(0, { position: p, color: [1, 0, 1, 1] });
          points.setCount(1);
          points.commit();
          if (!readRegion) {
            base.setCount(1);
            base.commit();
            ensure(base.count() === 1, 'setCount did not shrink the set');
            return;
          }
          await until(() => look(a, RED).total > 300, 'the red cell drawn');
          const unit = look(a, RED).total;
          ensure(
            look(at(20.5, 11), RED).total > 300,
            'the third sprite is not drawn',
          );
          // Scale by distance: a quarter of the area.
          const farArea = look(b, RED).total;
          ensure(
            farArea > unit * 0.12 && farArea < unit * 0.4,
            `scaleByDistance drew ${farArea} px against ${unit} at full size`,
          );
          // Scale 2: four times the area.
          base.set(0, { scale: 2 });
          base.commit();
          await until(
            () => look(a, RED).total > unit * 3,
            'the sprite drawn at scale 2',
          );
          ensure(
            look(a, RED).total < unit * 5,
            `scale 2 drew ${look(a, RED).total} px against ${unit}`,
          );
          // Cell switch: the 'up' cell is white in its top half (magenta
          // times the instance colour), then turned upside down.
          base.set(0, { scale: 1, cell: 'up', color: [1, 0, 1, 1] });
          base.commit();
          await until(() => look(a, MAGENTA).total > 100, 'the up cell drawn');
          const upright = look(a, MAGENTA);
          ensure(
            upright.above > 10 * Math.max(1, upright.below) &&
              look(a, RED).total < 10,
            `the up cell: ${JSON.stringify(upright)}, red ${look(a, RED).total}`,
          );
          base.set(0, { rotation: Math.PI });
          base.commit();
          await until(
            () => look(a, MAGENTA).below > 100,
            'the rotated cell drawn',
          );
          const turned = look(a, MAGENTA);
          ensure(
            turned.below > 10 * Math.max(1, turned.above),
            `rotation π: ${JSON.stringify(turned)}`,
          );
          // setCount shrinks: the others go.
          base.setCount(1);
          base.commit();
          await until(
            () => look(at(20.5, 11), RED).total < 10,
            'the shrunk set drawn',
          );
          ensure(look(a, MAGENTA).total > 100, 'instance 0 went with them');
          // Terrain depth is cleared before movers, including points below it.
          const drawn = (index) =>
            look(deep(19 + index * 0.7), RED).total > 100;
          await until(() => drawn(1), "the 'always' sprite drawn");
          ensure(drawn(2), 'disableWithinM past the camera is hidden');
          ensure(drawn(0), "a 'normal' sprite under terrain is hidden");
          ensure(drawn(3), 'disableWithinM 10 m under terrain is hidden');
          // Points: a magenta disc with a dark outline.
          await until(() => look(p, MAGENTA, 16).total > 80, 'the point drawn');
          const ring = look(p, [0, 0, 0], 16).total;
          ensure(ring > 20, `no dark outline around the point (${ring} px)`);
          // Models: an aircraft drawn in magenta (blended by replace), at
          // least 80 px; lit and graded on Navara, so magenta-leaning.
          const models = make(
            engine.movers.createSet({
              id: 'contract-models',
              kind: 'model',
              capacity: 1,
              model: {
                url: '/models/airplane.glb',
                minimumPixelSize: 80,
                colorBlend: { mode: 'replace', amount: 1 },
              },
            }),
          );
          const m = at(19.2, 9.6, 50_000);
          models.set(0, { position: m, color: [1, 0, 1, 1] });
          models.setCount(1);
          models.commit();
          const modelPixels = () => {
            const screen = engine.projector.worldToWindow(m);
            const data = readRegion(
              Math.round(screen.x) - 50,
              Math.round(screen.y) - 50,
              100,
              100,
            );
            let count = 0;
            for (let i = 0; i < data.length; i += 4)
              if (
                Math.min(data[i], data[i + 2]) - data[i + 1] > 40 &&
                data[i] > 60
              )
                count++;
            return count;
          };
          // ready() turns true once the glTF has loaded (the magenta point
          // and sprites above can already fill the region before then).
          await until(() => models.ready(), 'the model set ready()');
          ensure(
            models.ready(0) === true,
            'the drawn instance is not ready(0)',
          );
          await until(() => modelPixels() > 150, 'the model drawn');
        } finally {
          for (const set of sets) set.destroy();
        }
      },
    ],
  ];
}

export function surfaceMoverChecks(
  engine,
  { settle, until, nadirView, readRegion },
) {
  return [
    [
      'movers.createSet: sampled surface points ignore terrain and retain horizon occlusion',
      async () => {
        await nadirView(10000);
        const groups = ['normal', 'always'].map((depthTest) => {
          const set = engine.movers.createSet({
            id: `contract-surface-point-${depthTest}`,
            kind: 'point',
            capacity: 1,
            depthTest,
            point: { sizePx: 24, outlinePx: 2 },
          });
          const point = {
            cartographic: cartographic.fromDegrees(20, 10),
            position: cartesian3.fromDegrees(20, 10),
          };
          set.set(0, { position: point.position, color: [1, 0, 1, 1] });
          set.setCount(1);
          set.commit();
          return { set, points: [point] };
        });
        const placement = createSurfacePoints(engine, {
          groups: () => groups,
          prefer: 'terrain',
          request: () => engine.render.request(),
        });
        const select = (selected) => {
          groups.forEach(({ set }, index) => {
            set.setCount(index === selected ? 1 : 0);
            set.commit();
          });
        };
        const pixels = (position) => {
          const screen = engine.projector.worldToWindow(position);
          ensure(screen, 'surface point has no projection');
          const data = readRegion(
            Math.round(screen.x) - 24,
            Math.round(screen.y) - 24,
            48,
            48,
          );
          let count = 0;
          for (let i = 0; i < data.length; i += 4)
            if (like([1, 0, 1], data, i)) count++;
          return count;
        };
        try {
          await until(() => {
            placement.place({ all: true });
            return groups.every(({ points }) =>
              Number.isFinite(points[0].surfaceHeight),
            );
          }, 'surface points placed');
          if (!readRegion) return;
          const point = groups[0].points[0];
          // Compare the same pixel footprint, with only the depth mode changed.
          select(1);
          await settle();
          await until(
            () => pixels(point.position) > 200,
            'surface control drawn',
          );
          const control = pixels(point.position);
          select(0);
          await settle();
          await until(
            () => pixels(point.position) >= control * 0.8,
            'normal point visible on its supporting surface',
          );
          // The same near-side point stays visible below the terrain as well.
          placement.destroy();
          const buried = cartesian3.fromDegrees(
            20,
            10,
            point.surfaceHeight - 1000,
          );
          for (const { set } of groups) {
            set.set(0, { position: buried });
            set.commit();
          }
          select(1);
          await settle();
          await until(() => pixels(buried) > 200, 'buried control drawn');
          select(0);
          await settle();
          await until(
            () => pixels(buried) >= control * 0.8,
            'normal point visible below terrain',
          );
          // Moving a previously visible point to the far side must hide it.
          const farSide = cartesian3.fromDegrees(-160, -10);
          groups[0].set.set(0, { position: farSide });
          groups[0].set.commit();
          await settle();
          ensure(
            pixels(farSide) < 10,
            'normal point behind the horizon is visible',
          );
        } finally {
          placement.destroy();
          for (const { set } of groups) set.destroy();
        }
      },
    ],
  ];
}

export function tilesMoverChecks(
  engine,
  { settle, until, readRegion, fixtures },
) {
  const tile = fixtures?.tiles;
  if (!tile?.position) return [];
  return [
    [
      'movers.createSet: normal points behind a tiles mesh are hidden',
      async () => {
        engine.camera.lookAt(tile.position, {
          heading: 0,
          pitch: -Math.PI / 2,
          range: 1000,
        });
        const place = cartographic.fromCartesian(tile.position);
        const position = cartesian3.fromRadians(
          place.longitude,
          place.latitude,
          place.height - 20,
        );
        const sets = ['normal', 'always'].map((depthTest) => {
          const set = engine.movers.createSet({
            id: `contract-tile-point-${depthTest}`,
            kind: 'point',
            capacity: 1,
            depthTest,
            point: { sizePx: 24 },
          });
          set.set(0, { position, color: [1, 0, 1, 1] });
          return set;
        });
        const select = (index) => {
          sets.forEach((set, i) => {
            set.setCount(i === index ? 1 : 0);
            set.commit();
          });
        };
        const pixels = () => {
          const screen = engine.projector.worldToWindow(position);
          ensure(screen, 'tile point has no projection');
          const data = readRegion(
            Math.round(screen.x) - 24,
            Math.round(screen.y) - 24,
            48,
            48,
          );
          let count = 0;
          for (let i = 0; i < data.length; i += 4)
            if (like([1, 0, 1], data, i)) count++;
          return count;
        };
        try {
          await until(() => {
            const sample = engine.surface.sampleHeightDetailed(place);
            return (
              sample?.source === 'tiles' &&
              Math.abs(sample.height - place.height) < 2
            );
          }, 'tile occluder loaded');
          if (!readRegion) return;
          select(1);
          await settle();
          await until(() => pixels() > 200, 'tile control drawn');
          select(0);
          await settle();
          ensure(pixels() < 10, 'normal point behind a tiles mesh is visible');
        } finally {
          for (const set of sets) set.destroy();
          engine.camera.release();
        }
      },
    ],
  ];
}

export function failedModelChecks(
  engine,
  { until, fixtures, nadirView, readRegion },
) {
  return [
    [
      'movers.createSet: failed model retries, recovers and stops after three attempts',
      async () => {
        await nadirView(1e6);
        const id = 'contract-failed-model';
        const url = '/models/airplane.glb?contract-retry';
        let failing = true;
        let attempts = 0;
        const fetch = globalThis.fetch;
        const open = globalThis.XMLHttpRequest?.prototype.open;
        // Route this model alone to the runner's missing asset while failing.
        // The next attempt uses the real GLB without replacing the mover set.
        const route = (value) => {
          if (!String(value).endsWith(url)) return value;
          attempts++;
          return failing ? '/__contract_missing_model.glb' : value;
        };
        if (fixtures?.failModel) fixtures.failModel(id, true);
        else {
          globalThis.fetch = (input, init) => {
            const value = route(input?.url ?? input);
            return fetch(value === (input?.url ?? input) ? input : value, init);
          };
          globalThis.XMLHttpRequest.prototype.open = function (
            method,
            value,
            ...args
          ) {
            return open.call(this, method, route(value), ...args);
          };
        }
        const set = engine.movers.createSet({
          id,
          kind: 'model',
          capacity: 2,
          retryAfterMs: 100,
          model: {
            url,
            minimumPixelSize: 80,
            colorBlend: { mode: 'replace', amount: 1 },
          },
        });
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const fail = (value) => {
          failing = value;
          fixtures?.failModel?.(id, value);
        };
        try {
          ensure(
            set.ready() && !set.failed(),
            'empty model set reports a load',
          );
          const position = cartesian3.fromDegrees(20, 10, 50_000);
          set.set(0, { position, color: [1, 0, 1, 1], pickId: 'first' });
          set.setCount(1);
          set.commit();
          await until(() => set.failed(0), 'failed model');
          ensure(
            set.failed() && !set.ready() && !set.ready(0),
            'failed model is ready',
          );
          ensure(
            !set.failed(1) && !set.ready(1),
            'inactive instance reports a load',
          );
          fail(false);
          await wait(120);
          await until(() => set.ready(0), 'model ready after engine retry');
          ensure(
            set.ready() && !set.failed(),
            'retry did not clear the failure',
          );
          if (readRegion) {
            const screen = engine.projector.worldToWindow(position);
            await until(() => {
              const data = readRegion(
                Math.round(screen.x) - 50,
                Math.round(screen.y) - 50,
                100,
                100,
              );
              let pixels = 0;
              for (let i = 0; i < data.length; i += 4)
                if (
                  Math.min(data[i], data[i + 2]) - data[i + 1] > 40 &&
                  data[i] > 60
                )
                  pixels++;
              return pixels > 150;
            }, 'retried model drawn');
          }
          // A new identity reloads even a previously healthy index.
          fail(true);
          attempts = 0;
          set.set(0, { pickId: 'second' });
          set.commit();
          await until(() => set.failed(0), 'replacement model failure');
          await wait(350);
          ensure(set.failed() && !set.ready(), 'permanent failure disappeared');
          if (!fixtures?.failModel)
            ensure(attempts === 3, `expected 3 attempts, got ${attempts}`);
          fail(false);
          await wait(150);
          ensure(set.failed(0) && !set.ready(0), 'exhausted model retried');
          set.set(0, { pickId: 'third' });
          ensure(
            !set.failed(0) && !set.failed(),
            'new identity inherited failure',
          );
          set.commit();
          await until(
            () => set.ready(0),
            'replacement after exhausted attempts',
          );
          ensure(!set.failed(), 'replacement inherited exhausted failure');
        } finally {
          fixtures?.failModel?.(id, false);
          if (!fixtures?.failModel) {
            globalThis.fetch = fetch;
            globalThis.XMLHttpRequest.prototype.open = open;
          }
          set.destroy();
        }
        ensure(
          !set.failed() && !set.ready(),
          'destroyed model reports ready or failed',
        );
      },
    ],
  ];
}

export function moverListChecks(engine) {
  return [
    [
      'movers.list: shown follows active instance visibility and count',
      async () => {
        const set = engine.movers.createSet({
          id: 'contract-movers-shown',
          kind: 'point',
          capacity: 2,
          point: { sizePx: 8 },
        });
        const shown = () =>
          engine.movers.list().find((row) => row.id === set.id)?.shown;
        try {
          ensure(shown() === false, 'empty set is shown');
          set.set(0, { position: cartesian3.fromDegrees(20, 10), show: false });
          set.setCount(1);
          set.commit();
          ensure(shown() === false, 'hidden set is shown');
          set.set(0, { show: true });
          set.commit();
          ensure(shown() === true, 'visible set is hidden');
          set.setCount(0);
          set.commit();
          ensure(shown() === false, 'zero count is shown');
        } finally {
          set.destroy();
        }
        ensure(
          !engine.movers.list().some((row) => row.id === set.id),
          'removed set remains listed',
        );
      },
    ],
  ];
}
