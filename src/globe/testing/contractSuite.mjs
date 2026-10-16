// Behavioural checks every GlobeEngine must pass. The suite is engine-agnostic
// and imports nothing from Node, so it runs in Node against the fake engine and
// in a headless browser against the Cesium and Navara engines:
//
//   const checks = createContractSuite(engine, { waitFrames });
//   for (const { name, run } of checks) await run();
//
// `waitFrames(count)` resolves after the engine has rendered `count` frames.
// Checks request renders themselves, so engines in request-render mode work.
// Each check sets the view it needs; checks may leave the camera anywhere.

import * as geo from '../../geo/index.js';
import { INPUT_TYPES, MODIFIERS, assertGlobeEngine } from '../contract.js';

const { cartesian2, cartesian3, cartographic, ellipsoid, math, matrix4 } = geo;
const WGS84 = ellipsoid.WGS84;

class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractError';
  }
}

function ensure(condition, message) {
  if (!condition) throw new ContractError(message);
}

function near(actual, expected, tolerance, label) {
  ensure(
    typeof actual === 'number' && Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance} of ${expected}`,
  );
}

// Smallest difference between two angles, in radians.
const angleBetween = (a, b) => Math.abs(math.negativePiToPi(a - b));

const isCartesian3 = (value) =>
  value != null &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.y) &&
  Number.isFinite(value.z);

// The local east/north/up axes at a position.
function localAxes(position) {
  const frame = geo.transforms.eastNorthUpToFixedFrame(position, WGS84);
  return {
    frame,
    east: cartesian3.create(frame[0], frame[1], frame[2]),
    north: cartesian3.create(frame[4], frame[5], frame[6]),
    up: cartesian3.create(frame[8], frame[9], frame[10]),
  };
}

const inRange = (value, low, high, label) =>
  ensure(
    typeof value === 'number' && value >= low && value < high,
    `${label} ${value} is outside [${low}, ${high})`,
  );

const unit = (vector) => cartesian3.normalize(vector, cartesian3.create());
const along = (origin, direction, distance) =>
  cartesian3.add(
    origin,
    cartesian3.multiplyByScalar(direction, distance, cartesian3.create()),
    cartesian3.create(),
  );

/**
 * @param {import('../contract.js').GlobeEngine} engine
 * @param {{ waitFrames: (count: number) => Promise<void>, maxWaitFrames?: number,
 *   mapSources?: { imagery: object[], photoreal: object },
 *   readRegion?: (x: number, y: number, width: number, height: number) => Uint8ClampedArray,
 *   makeCanvas?: (width: number, height: number) => object,
 *   pointer?: { click: (x: number, y: number) => Promise<void>, move: (x: number, y: number) => Promise<void> } }} options
 *   `mapSources` (two imagery sources and a photoreal one the engine can
 *   show) adds the maps checks; they leave photoreal tiles hidden.
 *   `readRegion` (RGBA bytes of the last drawn frame in a CSS-pixel box) and
 *   `makeCanvas` (a 2D canvas) add the pixel checks of drawn objects.
 *   `pointer` (a real left click and pointer move at a canvas position)
 *   adds the pick checks.
 * @returns {{ name: string, run: () => Promise<void> }[]}
 */
export function createContractSuite(
  engine,
  {
    waitFrames,
    maxWaitFrames = 240,
    mapSources = null,
    readRegion = null,
    makeCanvas = null,
    pointer = null,
  },
) {
  if (typeof waitFrames !== 'function')
    throw new TypeError('createContractSuite needs a waitFrames(count) helper');
  const { camera } = engine;

  const settle = async (count = 2) => {
    for (let index = 0; index < count; index++) {
      engine.render.request();
      await waitFrames(1);
    }
  };
  const until = async (predicate, label) => {
    for (let frame = 0; frame < maxWaitFrames; frame++) {
      if (predicate()) return;
      await settle(1);
    }
    ensure(
      predicate(),
      `${label} did not happen within ${maxWaitFrames} frames`,
    );
  };

  // A view 1000 km above (20°E, 10°N) looking straight down, heading north.
  const nadirView = async (height = 1e6) => {
    camera.setView({
      destination: cartesian3.fromDegrees(20, 10, height),
      orientation: { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 },
    });
    await settle();
  };
  const centre = () => {
    const { width, height } = engine.host.size();
    return cartesian2.create(width / 2, height / 2);
  };

  const checks = [
    [
      'shape: the engine has every contract capability',
      async () => {
        assertGlobeEngine(engine);
      },
    ],
    [
      'host.size: a positive CSS size',
      async () => {
        const { width, height } = engine.host.size();
        ensure(
          width > 0 && height > 0,
          `size ${width}x${height} is not positive`,
        );
      },
    ],
    [
      'camera.setView: heading, pitch and roll round-trip through pose',
      async () => {
        const destination = cartesian3.fromDegrees(-70, 45, 25000);
        const orientation = { heading: 1.2, pitch: -0.6, roll: 0.05 };
        camera.setView({ destination, orientation });
        await settle();
        const pose = camera.pose();
        near(
          cartesian3.distance(pose.position, destination),
          0,
          0.01,
          'position error (m)',
        );
        near(
          angleBetween(pose.heading, orientation.heading),
          0,
          1e-6,
          'heading error',
        );
        near(pose.pitch, orientation.pitch, 1e-6, 'pitch');
        near(angleBetween(pose.roll, orientation.roll), 0, 1e-6, 'roll error');
      },
    ],
    [
      'camera.setView: direction and up orientation',
      async () => {
        const destination = cartesian3.fromDegrees(5, 50, 3e5);
        const direction = unit(
          cartesian3.negate(destination, cartesian3.create()),
        );
        const north = cartesian3.cross(
          cartesian3.cross(direction, cartesian3.UNIT_Z, cartesian3.create()),
          direction,
          cartesian3.create(),
        );
        const up = unit(north);
        camera.setView({ destination, orientation: { direction, up } });
        await settle();
        const pose = camera.pose();
        near(
          cartesian3.dot(pose.direction, direction),
          1,
          1e-9,
          'direction·expected',
        );
        near(cartesian3.dot(pose.up, up), 1, 1e-9, 'up·expected');
      },
    ],
    [
      'camera.livePosition and camera.height: the pose position and height, without a pose',
      async () => {
        camera.setView({
          destination: cartesian3.fromDegrees(-3.7, 40.4, 12000),
          orientation: { heading: 0.4, pitch: -0.5, roll: 0 },
        });
        await settle();
        const live = camera.livePosition;
        ensure(isCartesian3(live), 'livePosition is a Cartesian3');
        near(
          cartesian3.distance(live, camera.pose().position),
          0,
          1e-6,
          'livePosition vs pose().position',
        );
        near(
          camera.height(),
          camera.pose().cartographic.height,
          0.01,
          'height()',
        );
        const destination = cartesian3.fromDegrees(2.35, 48.85, 30000);
        camera.setView({ destination });
        await settle();
        ensure(
          camera.livePosition === live,
          'livePosition is the same engine-owned object on every read',
        );
        near(
          cartesian3.distance(camera.livePosition, destination),
          0,
          1e-3,
          'livePosition follows the camera',
        );
      },
    ],
    [
      'camera.pose: cartographic, frame vectors and fovy are consistent',
      async () => {
        camera.setView({
          destination: cartesian3.fromDegrees(139.7, 35.6, 8000),
          orientation: { heading: 4, pitch: -0.3, roll: 0 },
        });
        await settle();
        const pose = camera.pose();
        const expected = cartographic.fromCartesian(pose.position, WGS84);
        near(
          pose.cartographic.longitude,
          expected.longitude,
          1e-9,
          'longitude',
        );
        near(pose.cartographic.latitude, expected.latitude, 1e-9, 'latitude');
        near(pose.cartographic.height, expected.height, 0.01, 'height');
        for (const [name, vector] of [
          ['direction', pose.direction],
          ['up', pose.up],
          ['right', pose.right],
        ])
          near(cartesian3.magnitude(vector), 1, 1e-6, `|${name}|`);
        near(cartesian3.dot(pose.direction, pose.up), 0, 1e-6, 'direction·up');
        const right = cartesian3.cross(
          pose.direction,
          pose.up,
          cartesian3.create(),
        );
        near(
          cartesian3.dot(right, pose.right),
          1,
          1e-6,
          'right = direction × up',
        );
        ensure(
          pose.fovy > 0 && pose.fovy < Math.PI,
          `fovy ${pose.fovy} out of range`,
        );
      },
    ],
    [
      'camera.percentageChanged: readable and writable',
      async () => {
        const previous = camera.percentageChanged;
        try {
          camera.percentageChanged = 0.125;
          near(camera.percentageChanged, 0.125, 0, 'percentageChanged');
        } finally {
          camera.percentageChanged = previous;
        }
      },
    ],
    [
      'camera events: changed, moveStart and moveEnd follow a move',
      async () => {
        // moveStart marks a move from rest: let the nadir move end first
        // (Cesium raises moveEnd only after cameraEventWaitTime, 500 ms).
        let rested = 0;
        const removeRest = camera.moveEnd.addEventListener(() => rested++);
        try {
          // A pose no other check uses, so this always is a move.
          await nadirView(1.5e6);
          await until(() => rested > 0, 'moveEnd after the resting move');
        } finally {
          removeRest();
        }
        const previous = camera.percentageChanged;
        const seen = { changed: 0, moveStart: 0, moveEnd: 0 };
        const removers = Object.keys(seen).map((name) =>
          camera[name].addEventListener(() => seen[name]++),
        );
        try {
          camera.percentageChanged = 0.01;
          camera.setView({
            destination: cartesian3.fromDegrees(60, -30, 2e6),
            orientation: { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 },
          });
          await until(() => seen.moveEnd > 0, 'moveEnd');
          ensure(seen.moveStart > 0, 'moveStart did not fire');
          ensure(seen.changed > 0, 'changed did not fire');
        } finally {
          for (const remove of removers) remove();
          camera.percentageChanged = previous;
        }
      },
    ],
    [
      'events: removed listeners are not called',
      async () => {
        await nadirView();
        let viaHandle = 0;
        let viaRemove = 0;
        const remove = camera.moveStart.addEventListener(() => viaHandle++);
        const listener = () => viaRemove++;
        engine.frames.postRender.addEventListener(listener);
        remove();
        ensure(
          engine.frames.postRender.removeEventListener(listener) === true,
          'removeEventListener did not report removal',
        );
        await nadirView(3e6);
        await settle(3);
        ensure(
          viaHandle === 0 && viaRemove === 0,
          'a removed listener was called',
        );
      },
    ],
    [
      'frames: preUpdate, preRender and postRender fire in order with timestamps',
      async () => {
        const order = [];
        const removers = ['preUpdate', 'preRender', 'postRender'].map((name) =>
          engine.frames[name].addEventListener((time) =>
            order.push([name, time]),
          ),
        );
        try {
          await until(
            () => order.some(([name]) => name === 'postRender'),
            'postRender',
          );
        } finally {
          for (const remove of removers) remove();
        }
        const firstPost = order.findIndex(([name]) => name === 'postRender');
        const frame = order.slice(0, firstPost + 1);
        const index = (name) => frame.map(([entry]) => entry).lastIndexOf(name);
        ensure(index('preRender') >= 0, 'preRender did not precede postRender');
        ensure(index('preUpdate') >= 0, 'preUpdate did not precede postRender');
        ensure(
          index('preUpdate') < index('preRender'),
          'preUpdate ran after preRender',
        );
        for (const [name, time] of order)
          ensure(
            Number.isFinite(time),
            `${name} timestamp ${time} is not a number`,
          );
      },
    ],
    [
      'clock: one frame time per frame, latched before preUpdate, never decreasing',
      async () => {
        const records = [];
        const read = (name, value) =>
          records.push({
            name,
            value,
            frame: engine.clock.frameTime(),
            now: engine.clock.now(),
          });
        const removers = [
          engine.clock.ticked.addEventListener((time) => read('ticked', time)),
          ...['preUpdate', 'preRender', 'postRender'].map((name) =>
            engine.frames[name].addEventListener(() => read(name)),
          ),
        ];
        try {
          await until(
            () =>
              records.filter(({ name }) => name === 'postRender').length >= 3,
            'three drawn frames',
          );
        } finally {
          for (const remove of removers) remove();
        }
        ensure(
          Number.isFinite(engine.clock.now()) &&
            Number.isFinite(engine.clock.frameTime()),
          'clock.now or clock.frameTime is not a number',
        );
        // From the first tick on: every frame event belongs to the frame the
        // last tick opened, and reads that tick's frame time.
        const start = records.findIndex(({ name }) => name === 'ticked');
        ensure(start >= 0, 'clock.ticked never fired');
        let tick = null;
        let ticksSincePreUpdate = 0;
        let previousFrame = -Infinity;
        for (const record of records.slice(start)) {
          ensure(
            record.frame <= record.now,
            `${record.name}: frameTime ${record.frame} is after now ${record.now}`,
          );
          if (record.name === 'ticked') {
            ensure(
              record.value === record.frame,
              `ticked passed ${record.value}, frameTime read ${record.frame}`,
            );
            ensure(
              record.frame >= previousFrame,
              `frame time went back from ${previousFrame} to ${record.frame}`,
            );
            previousFrame = record.frame;
            tick = record;
            ticksSincePreUpdate++;
            continue;
          }
          ensure(
            record.frame === tick.frame,
            `${record.name} read frame time ${record.frame}, its frame's is ${tick.frame}`,
          );
          if (record.name === 'preUpdate') {
            ensure(
              ticksSincePreUpdate >= 1,
              'preUpdate ran without a tick before it',
            );
            ticksSincePreUpdate = 0;
          }
        }
      },
    ],
    [
      'movers: three sprites draw at their projections, hide, recolour and go',
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
          const view = set.positionsView();
          ensure(
            view.length === 9 && view[3] === places[1].x,
            'positionsView does not hold the positions',
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
          const like = (colour, data, i) =>
            colour.every(
              (channel, k) =>
                k > 2 || Math.abs(data[i + k] - channel * 255) <= 40,
            );
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
      'colours: mid-tone sprite, point and line colours draw as asked (within 3 per channel)',
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
    [
      'lines: a line draws between its projections, turns with its model matrix and dims where hidden',
      async () => {
        await nadirView(1e6);
        // 20 km up: above any ground the scene draws.
        const at = (lon, lat, height = 20_000) =>
          cartesian3.fromDegrees(lon, lat, height);
        const line = engine.lines.createLine({
          id: 'contract-line',
          widthPx: 8,
          color: [1, 0, 1, 1],
        });
        const hidden = engine.lines.createLine({
          id: 'contract-line-hidden',
          widthPx: 10,
          color: [1, 0, 1, 1],
          depthFailAlpha: 0.6,
        });
        try {
          line.setPositions([at(19, 9), at(20, 9), at(21, 9)]);
          ensure(
            engine.lines
              .list()
              .some(({ id, points }) => id === 'contract-line' && points === 3),
            'lines.list() does not show the line',
          );
          if (!readRegion) return;
          // Magenta-leaning pixels (red and blue over green; a dimmed copy
          // over a light map stays above 30) near a point.
          // The strongest magenta lean near a point (for dimmer-than).
          const strength = (position) => {
            const screen = engine.projector.worldToWindow(position);
            const data = readRegion(
              Math.round(screen.x) - 6,
              Math.round(screen.y) - 6,
              12,
              12,
            );
            let best = -255;
            for (let i = 0; i < data.length; i += 4)
              best = Math.max(
                best,
                Math.min(data[i], data[i + 2]) - data[i + 1],
              );
            return best;
          };
          const magentaAt = (position) => {
            const screen = engine.projector.worldToWindow(position);
            if (!screen) return 0;
            const data = readRegion(
              Math.round(screen.x) - 6,
              Math.round(screen.y) - 6,
              12,
              12,
            );
            let count = 0;
            for (let i = 0; i < data.length; i += 4)
              if (
                Math.min(data[i], data[i + 2]) - data[i + 1] > 30 &&
                data[i] > 120
              )
                count++;
            return count;
          };
          await until(
            () => magentaAt(at(19.5, 9)) > 10 && magentaAt(at(20.5, 9)) > 10,
            'the line drawn along both segments',
          );
          ensure(magentaAt(at(19.5, 10.5)) === 0, 'line pixels off the line');
          // Turned 1° about the Earth's axis: the line moves 1° east.
          const turn = (radians) => {
            const c = Math.cos(radians);
            const s = Math.sin(radians);
            return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
          };
          line.setModelMatrix(turn(math.toRadians(1)));
          await until(
            () => magentaAt(at(21.5, 9)) > 10 && magentaAt(at(19.25, 9)) === 0,
            'the turned line drawn 1° east',
          );
          const shownStrength = strength(at(20.5, 9));
          line.show(false);
          await until(() => magentaAt(at(20.5, 9)) === 0, 'the line hidden');
          // 30 km under the ground: only the depth-fail copy shows, dimmed.
          const deep = (lon) => at(lon, 11, -30_000);
          hidden.setPositions([deep(19), deep(21)]);
          await until(
            () => magentaAt(deep(20)) > 10,
            'the hidden line drawn by its depth-fail copy',
          );
          const hiddenStrength = strength(deep(20));
          ensure(
            hiddenStrength < shownStrength,
            `the depth-fail copy (${hiddenStrength}) is not dimmer than the line (${shownStrength})`,
          );
          hidden.destroy();
          await until(
            () => magentaAt(deep(20)) === 0,
            'the destroyed line gone',
          );
        } finally {
          line.destroy();
          hidden.destroy();
        }
        ensure(
          !engine.lines.list().some(({ id }) => id.startsWith('contract-line')),
          'a destroyed line is still listed',
        );
      },
    ],
    [
      'input: picks on click and move payloads, drill, lines',
      async () => {
        await nadirView(1e6);
        const at = (lon, lat, height = 20_000) =>
          cartesian3.fromDegrees(lon, lat, height);
        const atlasCanvas = makeCanvas
          ? makeCanvas(16, 16)
          : { width: 16, height: 16 };
        if (makeCanvas) {
          const context = atlasCanvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, 16, 16);
        }
        const set = engine.movers.createSet({
          id: 'contract-picks',
          kind: 'sprite',
          capacity: 3,
          order: 100,
          depthTest: 'always',
          pickable: true,
          sprite: {
            atlas: { canvas: atlasCanvas, cells: { box: [0, 0, 1, 1] } },
            sizePx: 24,
          },
        });
        const quiet = engine.movers.createSet({
          id: 'contract-quiet',
          kind: 'sprite',
          capacity: 1,
          order: 100,
          depthTest: 'always',
          sprite: {
            atlas: { canvas: atlasCanvas, cells: { box: [0, 0, 1, 1] } },
            sizePx: 24,
          },
        });
        const line = engine.lines.createLine({
          id: 'contract-pick-line',
          widthPx: 8,
          color: [1, 1, 0, 1],
          pickId: 'line-1',
        });
        const clicks = [];
        const moves = [];
        const removers = [
          engine.input.on('click', (event) => clicks.push(event), {
            pick: true,
            drill: 8,
          }),
          engine.input.on('move', (event) => moves.push(event), {
            pick: true,
          }),
        ];
        try {
          const a = at(20, 10);
          const b = at(21, 10.5);
          set.set(0, { position: a, pickId: 'a', color: [1, 0, 1, 1] });
          set.set(1, { position: b, pickId: 'b', color: [1, 0, 1, 1] });
          set.set(2, { position: b, pickId: 'c', color: [1, 0, 1, 1] });
          set.setCount(3);
          set.commit();
          line.setPositions([at(19, 9), at(21, 9)]);
          const unpickable = at(19.5, 11);
          quiet.set(0, { position: unpickable, pickId: 'quiet' });
          quiet.setCount(1);
          quiet.commit();
          await settle(4);
          if (!pointer) return;
          const screen = (position) => engine.projector.worldToWindow(position);
          const clickAt = async (position) => {
            const before = clicks.length;
            const { x, y } = screen(position);
            await pointer.click(x, y);
            await until(() => clicks.length > before, 'a click payload');
            return clicks[clicks.length - 1];
          };
          const onA = await clickAt(a);
          ensure(
            onA.picked?.id === 'a' && onA.picked?.owner === 'contract-picks',
            `a click on sprite a picked ${JSON.stringify(onA.picked?.id)} of ${onA.picked?.owner}`,
          );
          ensure(onA.picked.instance === 0, `instance ${onA.picked.instance}`);
          const empty = await clickAt(at(18, 12));
          ensure(
            empty.picked === undefined || empty.picked.id === undefined,
            `a click on the map picked ${JSON.stringify(empty.picked?.id)}`,
          );
          const onB = await clickAt(b);
          const drilled = (onB.drilled ?? []).map(({ id }) => id);
          ensure(
            drilled.includes('b') && drilled.includes('c'),
            `two sprites in one place drilled ${JSON.stringify(drilled)}`,
          );
          const onQuiet = await clickAt(unpickable);
          ensure(
            onQuiet.picked?.owner !== 'contract-quiet' &&
              !(onQuiet.drilled ?? []).some(
                ({ owner }) => owner === 'contract-quiet',
              ),
            `a pickable: false sprite was picked (${JSON.stringify(onQuiet.picked?.id)})`,
          );
          const onLine = await clickAt(at(20, 9));
          ensure(
            onLine.picked?.id === 'line-1',
            `a click on the line picked ${JSON.stringify(onLine.picked?.id)}`,
          );
          const target = screen(a);
          const movesBefore = moves.length;
          await pointer.move(target.x + 1, target.y);
          await until(
            () => moves.length > movesBefore && moves.at(-1).picked?.id === 'a',
            'a hover payload over sprite a',
          );
        } finally {
          for (const remove of removers) remove();
          set.destroy();
          quiet.destroy();
          line.destroy();
        }
      },
    ],
    [
      'lines: pixel dashes are regular, in CSS pixels',
      async () => {
        if (!readRegion) return;
        await nadirView(1e6);
        const line = engine.lines.createLine({
          id: 'contract-dashes',
          widthPx: 6,
          color: [1, 0, 1, 1],
          dash: { lengthPx: 16, gapPx: 16 },
        });
        try {
          const a = cartesian3.fromDegrees(19, 9, 20_000);
          const b = cartesian3.fromDegrees(21, 9, 20_000);
          line.setPositions([a, b]);
          const sa = engine.projector.worldToWindow(a);
          const sb = engine.projector.worldToWindow(b);
          // On/off runs (CSS px) along the middle of the line.
          const runs = () => {
            const left = Math.round(Math.min(sa.x, sb.x)) + 4;
            const width = Math.round(Math.abs(sb.x - sa.x)) - 8;
            const y = Math.round((sa.y + sb.y) / 2);
            const data = readRegion(left, y, width, 1);
            const on = [];
            const off = [];
            let current = null;
            let length = 0;
            for (let x = 0; x < width; x++) {
              const i = x * 4;
              const lit =
                Math.min(data[i], data[i + 2]) - data[i + 1] > 60 &&
                data[i] > 150;
              if (lit === current) length++;
              else {
                if (current !== null) (current ? on : off).push(length);
                current = lit;
                length = 1;
              }
            }
            // The first and last runs are cut by the window.
            return { on: on.slice(1), off: off.slice(1) };
          };
          const median = (values) =>
            [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
          await until(() => runs().on.length >= 3, 'dashes drawn');
          const { on, off } = runs();
          const spread = (values) => Math.max(...values) - Math.min(...values);
          // What each engine draws for 16/16, for the harness to compare
          // across device pixel ratios (Cesium's PolylineDash is the
          // reference; Navara's must not change with the ratio).
          globalThis.__qaDashes = {
            dash: median(on),
            gap: median(off),
            period: median(on) + median(off),
          };
          ensure(
            on.length >= 3 && spread(on) <= 2 && spread(off) <= 2,
            `irregular dashes: runs ${JSON.stringify(on)} / ${JSON.stringify(off)}`,
          );
          if (engine.kind === 'navara')
            ensure(
              Math.abs(median(on) - 16) <= 2 && Math.abs(median(off) - 16) <= 2,
              `dash ${median(on)} px, gap ${median(off)} px (16/16 asked)`,
            );
        } finally {
          line.destroy();
        }
      },
    ],
    [
      'movers: depth tests, rotation, cells, scale, count, points and models',
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
          // Depth: under the ground only 'always' and a disableWithinM
          // reaching past the camera draw.
          const drawn = (index) =>
            look(deep(19 + index * 0.7), RED).total > 100;
          await until(() => drawn(1), "the 'always' sprite drawn");
          ensure(drawn(2), 'disableWithinM past the camera is hidden');
          // Cesium's billboards under the app's photoreal tiles (globe
          // hidden) are not occluded by them, measured; Navara's overlay
          // tests the scene depth. Occlusion is checked on Navara only.
          if (engine.kind === 'navara') {
            ensure(!drawn(0), "a 'normal' sprite under the ground is drawn");
            ensure(!drawn(3), 'disableWithinM 10 m under the ground is drawn');
          }
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
          await until(() => modelPixels() > 150, 'the model drawn');
        } finally {
          for (const set of sets) set.destroy();
        }
      },
    ],
    [
      'render: continuous mode toggles',
      async () => {
        const previous = engine.render.isContinuous();
        try {
          engine.render.setContinuous(true);
          ensure(
            engine.render.isContinuous() === true,
            'continuous not enabled',
          );
          engine.render.setContinuous(false);
          ensure(
            engine.render.isContinuous() === false,
            'continuous not disabled',
          );
        } finally {
          engine.render.setContinuous(previous);
        }
      },
    ],
    [
      'render.setSharpen: merges partial updates, rejects bad values, draws',
      async () => {
        const previous = engine.render.sharpen();
        const same = (expected, label) => {
          const actual = engine.render.sharpen();
          ensure(
            actual.enabled === expected.enabled &&
              actual.amount === expected.amount,
            `${label}: ${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`,
          );
        };
        ensure(
          typeof previous.enabled === 'boolean' &&
            Number.isFinite(previous.amount),
          `sharpen() ${JSON.stringify(previous)} is not { enabled, amount }`,
        );
        try {
          engine.render.setSharpen({ enabled: true, amount: 1.7 });
          same({ enabled: true, amount: 1.7 }, 'after enabling');
          engine.render.sharpen().amount = 0;
          same({ enabled: true, amount: 1.7 }, 'sharpen() is a copy');
          // A frame with the sharpening on draws without errors.
          await settle(2);
          engine.render.setSharpen({ amount: 0.5 });
          same({ enabled: true, amount: 0.5 }, 'after an amount alone');
          engine.render.setSharpen({ enabled: false });
          same({ enabled: false, amount: 0.5 }, 'after disabling');
          for (const bad of [
            { enabled: 'yes' },
            { amount: -0.1 },
            { amount: Number.NaN },
            { amount: '1' },
          ]) {
            let error = null;
            try {
              engine.render.setSharpen(bad);
            } catch (caught) {
              error = caught;
            }
            ensure(
              error instanceof TypeError,
              `setSharpen(${JSON.stringify(bad)}) did not throw a TypeError`,
            );
          }
          same({ enabled: false, amount: 0.5 }, 'after rejected values');
          await settle(1);
        } finally {
          engine.render.setSharpen(previous);
          await settle(1);
        }
      },
    ],
    [
      'camera.flyTo: duration 0 lands and completes before flyTo returns',
      async () => {
        await nadirView();
        const destination = cartesian3.fromDegrees(-3.7, 40.4, 50000);
        const outcome = [];
        camera.flyTo({
          destination,
          orientation: { heading: 0.5, pitch: -0.8, roll: 0 },
          duration: 0,
          complete: () => outcome.push('complete'),
          cancel: () => outcome.push('cancel'),
        });
        ensure(
          outcome.join() === 'complete',
          `flyTo returned with [${outcome}] instead of [complete]`,
        );
        ensure(!camera.flightActive(), 'a duration-0 flight is still active');
        const pose = camera.pose();
        near(
          cartesian3.distance(pose.position, destination),
          0,
          0.01,
          'position error (m)',
        );
        near(angleBetween(pose.heading, 0.5), 0, 1e-6, 'heading error');
        near(pose.pitch, -0.8, 1e-6, 'pitch');
      },
    ],
    [
      'camera.flyTo: cancelFlight calls cancel and never complete',
      async () => {
        await nadirView();
        const outcome = [];
        camera.flyTo({
          destination: cartesian3.fromDegrees(100, 0, 5e6),
          duration: 5,
          easing: 'linear',
          complete: () => outcome.push('complete'),
          cancel: () => outcome.push('cancel'),
        });
        await settle(2);
        camera.cancelFlight();
        await until(() => outcome.length > 0, 'flight cancellation');
        await settle(3);
        ensure(outcome.join() === 'cancel', `flight ended with ${outcome}`);
      },
    ],
    [
      'camera.flyTo: a newer flight cancels the previous one',
      async () => {
        await nadirView();
        const outcome = [];
        camera.flyTo({
          destination: cartesian3.fromDegrees(100, 0, 5e6),
          duration: 5,
          complete: () => outcome.push('first complete'),
          cancel: () => outcome.push('first cancel'),
        });
        await settle(1);
        camera.flyTo({
          destination: cartesian3.fromDegrees(20, 10, 2e6),
          duration: 0,
          complete: () => outcome.push('second complete'),
        });
        await until(() => outcome.includes('second complete'), 'second flight');
        ensure(
          outcome.join() === 'first cancel,second complete',
          `flights ended with ${outcome}`,
        );
      },
    ],
    [
      'camera.flyToSphere: ends at the range, looking at the centre',
      async () => {
        await nadirView();
        const center = cartesian3.fromDegrees(2.35, 48.85, 100);
        let done = false;
        camera.flyToSphere(
          { center, radius: 500 },
          {
            heading: 0.3,
            pitch: -0.5,
            range: 5000,
            duration: 0,
            complete: () => (done = true),
          },
        );
        await until(() => done, 'sphere flight completion');
        const pose = camera.pose();
        near(cartesian3.distance(pose.position, center), 5000, 5, 'range (m)');
        const toCenter = unit(
          cartesian3.subtract(center, pose.position, cartesian3.create()),
        );
        near(
          cartesian3.dot(toCenter, pose.direction),
          1,
          1e-6,
          'direction·toCentre',
        );
      },
    ],
    [
      'camera.lookAt: holds the range toward the target until release',
      async () => {
        await nadirView();
        const target = cartesian3.fromDegrees(-0.12, 51.5, 0);
        camera.lookAt(target, { heading: 0.4, pitch: -0.7, range: 2000 });
        await settle();
        const pose = camera.pose();
        near(cartesian3.distance(pose.position, target), 2000, 1, 'range (m)');
        const toTarget = unit(
          cartesian3.subtract(target, pose.position, cartesian3.create()),
        );
        near(
          cartesian3.dot(toTarget, pose.direction),
          1,
          1e-6,
          'direction·toTarget',
        );
        camera.release();
        await settle();
        near(
          cartesian3.distance(camera.pose().position, pose.position),
          0,
          0.01,
          'release moved the camera (m)',
        );
      },
    ],
    [
      'projector.worldToWindow: a point ahead projects to the canvas centre',
      async () => {
        await nadirView();
        const pose = camera.pose();
        const window = engine.projector.worldToWindow(
          along(pose.position, pose.direction, 1000),
        );
        ensure(window, 'a point ahead did not project');
        const expected = centre();
        near(window.x, expected.x, 1, 'x (px)');
        near(window.y, expected.y, 1, 'y (px)');
      },
    ],
    [
      'projector.worldToWindow: a point behind the camera is undefined',
      async () => {
        await nadirView();
        const pose = camera.pose();
        const behind = along(pose.position, pose.direction, -1000);
        ensure(
          engine.projector.worldToWindow(behind) === undefined,
          'a point behind the camera projected',
        );
      },
    ],
    [
      'projector.worldToWindow: up on screen is camera up, and result is filled',
      async () => {
        await nadirView();
        const pose = camera.pose();
        const ahead = along(pose.position, pose.direction, 1000);
        const result = cartesian2.create();
        const upper = engine.projector.worldToWindow(
          along(ahead, pose.up, 100),
          result,
        );
        ensure(
          upper === result,
          'worldToWindow did not return its result argument',
        );
        const lefter = engine.projector.worldToWindow(
          along(ahead, pose.right, -100),
        );
        const expected = centre();
        ensure(
          upper.y < expected.y,
          `camera up projected below the centre (${upper.y})`,
        );
        ensure(
          lefter.x < expected.x,
          `camera left projected right of the centre (${lefter.x})`,
        );
      },
    ],
    [
      'camera.pickRay: the centre ray starts at the camera along its direction',
      async () => {
        await nadirView();
        const pose = camera.pose();
        const pickRay = camera.pickRay(centre());
        ensure(isCartesian3(pickRay?.origin), 'pickRay has no origin');
        near(
          cartesian3.distance(pickRay.origin, pose.position),
          0,
          1,
          'origin error (m)',
        );
        near(
          cartesian3.dot(unit(pickRay.direction), pose.direction),
          1,
          1e-6,
          'direction·pose',
        );
      },
    ],
    [
      'camera.pickEllipsoid: the nadir hits the surface and the sky misses',
      async () => {
        await nadirView();
        const hit = camera.pickEllipsoid(centre());
        ensure(isCartesian3(hit), 'the nadir missed the ellipsoid');
        const point = cartographic.fromCartesian(hit, WGS84);
        near(point.height, 0, 1, 'surface height (m)');
        // Off the surface, Cesium's local up is the scaled-surface normal,
        // which misses the geodetic nadir by about 0.0015° at 1000 km.
        near(math.toDegrees(point.longitude), 20, 0.01, 'longitude (deg)');
        near(math.toDegrees(point.latitude), 10, 0.01, 'latitude (deg)');
        camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 1e6),
          orientation: { heading: 0, pitch: 0.6, roll: 0 },
        });
        await settle();
        ensure(
          camera.pickEllipsoid(centre()) === undefined,
          'the sky hit the ellipsoid',
        );
      },
    ],
    [
      'projector.worldToWindow: round-trips camera.pickEllipsoid',
      async () => {
        await nadirView();
        const { width, height } = engine.host.size();
        const screen = cartesian2.create(width / 4, height / 3);
        const hit = camera.pickEllipsoid(screen);
        ensure(isCartesian3(hit), 'the screen point missed the ellipsoid');
        const back = engine.projector.worldToWindow(hit);
        ensure(back, 'the picked point did not project');
        near(back.x, screen.x, 1, 'x (px)');
        near(back.y, screen.y, 1, 'y (px)');
      },
    ],
    [
      'camera.viewRectangle: contains the nadir point',
      async () => {
        await nadirView();
        const rectangle = camera.viewRectangle();
        ensure(rectangle, 'no view rectangle looking straight down');
        const lon = math.toRadians(20);
        const lat = math.toRadians(10);
        ensure(
          rectangle.west < lon && lon < rectangle.east,
          `longitude outside ${rectangle.west}..${rectangle.east}`,
        );
        ensure(
          rectangle.south < lat && lat < rectangle.north,
          `latitude outside ${rectangle.south}..${rectangle.north}`,
        );
      },
    ],
    [
      'picker: pick, drillPick and pickPosition return contract shapes',
      async () => {
        await nadirView();
        const screen = cartesian2.create(1, 1);
        const picked = engine.picker.pick(screen);
        ensure(
          picked === undefined || 'id' in picked,
          'pick returned no id field',
        );
        const drilled = engine.picker.drillPick(screen, 3);
        ensure(Array.isArray(drilled), 'drillPick did not return an array');
        ensure(drilled.length <= 3, 'drillPick ignored its limit');
        ensure(
          typeof engine.picker.pickPositionSupported === 'boolean',
          'pickPositionSupported is not boolean',
        );
        const position = engine.picker.pickPosition(centre());
        ensure(
          position === undefined || isCartesian3(position),
          'pickPosition is not a Cartesian3',
        );
      },
    ],
    [
      'surface.sampleHeightDetailed: source, tile size, lod and mover-set exclusion',
      async () => {
        const place = cartographic.fromDegrees(20, 10, 0);
        const shape = (detail, label) => {
          if (detail === undefined) return;
          ensure(Number.isFinite(detail.height), `${label}: height`);
          ensure(
            detail.source === 'tiles' || detail.source === 'terrain',
            `${label}: source ${detail.source}`,
          );
          ensure(
            detail.tileSizeM === undefined ||
              (detail.source === 'tiles' && detail.tileSizeM > 0),
            `${label}: tileSizeM ${detail.tileSizeM}`,
          );
        };
        const visible = engine.surface.sampleHeightDetailed(place);
        shape(visible, 'visible');
        shape(
          engine.surface.sampleHeightDetailed(place, { lod: 'finest' }),
          'finest',
        );
        if (visible?.source === 'tiles')
          near(
            engine.surface.sampleHeight(place),
            visible.height,
            1e-6,
            'sampleHeight and the detailed tiles answer',
          );
        let rejected = null;
        try {
          engine.surface.sampleHeightDetailed(place, { lod: 'best' });
        } catch (error) {
          rejected = error;
        }
        ensure(rejected instanceof TypeError, 'an unknown lod was accepted');
        // A mover set in exclude: the sample works and the set stays.
        const set = engine.movers.createSet({
          id: 'contract-surface-exclude',
          kind: 'point',
          capacity: 1,
          point: { sizePx: 8 },
        });
        try {
          set.set(0, { position: cartesian3.fromDegrees(20, 10, 50) });
          set.setCount(1);
          set.commit();
          shape(
            engine.surface.sampleHeightDetailed(place, { exclude: [set] }),
            'excluding a set',
          );
          ensure(set.id === 'contract-surface-exclude', 'the set has no id');
          ensure(
            engine.movers
              .list()
              .some(({ id }) => id === 'contract-surface-exclude'),
            'the excluded set is gone',
          );
        } finally {
          set.destroy();
        }
      },
    ],
    [
      'surface: flags, tilesLoaded, sampleHeight, terrainHeight and clampToHeight shapes',
      async () => {
        for (const flag of ['terrainHeightSupported', 'clampToHeightSupported'])
          ensure(
            typeof engine.surface[flag] === 'boolean',
            `${flag} is not boolean`,
          );
        const place = cartographic.fromDegrees(20, 10, 0);
        if (engine.surface.terrainHeightSupported) {
          const terrain = engine.surface.terrainHeight(place);
          ensure(
            terrain === undefined || Number.isFinite(terrain),
            `terrainHeight returned ${terrain}`,
          );
        }
        if (engine.surface.clampToHeightSupported) {
          const clamped = engine.surface.clampToHeight(
            cartesian3.fromDegrees(20, 10, 5000),
          );
          ensure(
            clamped === undefined || isCartesian3(clamped),
            'clampToHeight is not a Cartesian3',
          );
        }
        ensure(
          typeof engine.surface.supported === 'boolean',
          'supported is not boolean',
        );
        ensure(
          typeof engine.surface.tilesLoaded() === 'boolean',
          'tilesLoaded is not boolean',
        );
        if (!engine.surface.supported) return;
        const value = engine.surface.sampleHeight(
          cartographic.fromDegrees(20, 10, 0),
        );
        ensure(
          value === undefined || Number.isFinite(value),
          `sampleHeight returned ${value}`,
        );
      },
    ],
    [
      'input: every type subscribes and unsubscribes; camera inputs toggle',
      async () => {
        for (const type of INPUT_TYPES) {
          for (const modifier of [undefined, ...MODIFIERS]) {
            const off = engine.input.on(type, () => {}, { modifier });
            ensure(
              typeof off === 'function',
              `input.on('${type}', ${modifier}) returned no remover`,
            );
            off();
            off();
          }
        }
        engine.input.setCameraInputs(false);
        engine.input.setCameraInputs(true);
      },
    ],
    [
      'credits.addStatic: returns an idempotent remover',
      async () => {
        const remove = engine.credits.addStatic('Contract check', {
          onScreen: false,
        });
        ensure(typeof remove === 'function', 'addStatic returned no remover');
        remove();
        remove();
      },
    ],
    [
      'maps.setPhotorealTiles(null): photoreal is inactive',
      async () => {
        engine.maps.setPhotorealTiles(null);
        ensure(
          engine.maps.photorealActive() === false,
          'photoreal still active',
        );
      },
    ],
    [
      'events: adding a listener twice registers it once',
      async () => {
        let once = 0;
        let twice = 0;
        const reference = () => once++;
        const listener = () => twice++;
        const removers = [
          engine.frames.postRender.addEventListener(reference),
          engine.frames.postRender.addEventListener(listener),
          engine.frames.postRender.addEventListener(listener),
        ];
        try {
          await until(() => once >= 2, 'postRender');
        } finally {
          for (const remove of removers) remove();
        }
        ensure(
          twice === once,
          `a listener added twice fired ${twice} times in ${once} frames`,
        );
        removers[1]();
        removers[2]();
        await settle(2);
        ensure(twice === once, 'a removed listener still fired');
      },
    ],
    [
      'events: removal during dispatch skips the listener; re-adding keeps it',
      async () => {
        const event = engine.frames.postRender;
        const seen = [];
        const victim = () => seen.push('victim');
        const survivor = () => seen.push('survivor');
        let dispatches = 0;
        const remover = () => {
          dispatches++;
          if (dispatches !== 1) return;
          event.removeEventListener(victim);
          event.removeEventListener(survivor);
          event.addEventListener(survivor);
        };
        event.addEventListener(remover);
        event.addEventListener(victim);
        event.addEventListener(survivor);
        try {
          await until(() => dispatches >= 3, 'three postRender dispatches');
        } finally {
          for (const listener of [remover, victim, survivor])
            event.removeEventListener(listener);
        }
        ensure(
          !seen.includes('victim'),
          'a listener removed during dispatch ran',
        );
        ensure(
          seen.includes('survivor'),
          'a listener removed and re-added during dispatch was lost',
        );
      },
    ],
    [
      'camera.pose: angle ranges follow Cesium',
      async () => {
        const destination = cartesian3.fromDegrees(30, 20, 20000);
        camera.setView({
          destination,
          orientation: { heading: -0.5, pitch: -0.4, roll: -0.2 },
        });
        await settle();
        let pose = camera.pose();
        inRange(pose.heading, 0, math.TWO_PI, 'heading');
        inRange(pose.roll, 0, math.TWO_PI, 'roll');
        near(pose.heading, math.TWO_PI - 0.5, 1e-6, 'heading of −0.5');
        near(pose.roll, math.TWO_PI - 0.2, 1e-6, 'roll of −0.2');
        ensure(
          pose.pitch >= -math.PI_OVER_TWO && pose.pitch <= math.PI_OVER_TWO,
          `pitch ${pose.pitch} outside [−π/2, π/2]`,
        );
        camera.setView({
          destination,
          orientation: { heading: 0.7, pitch: -math.PI_OVER_TWO, roll: 0.3 },
        });
        await settle();
        pose = camera.pose();
        near(pose.roll, 0, 0, 'roll looking straight down');
        inRange(pose.heading, 0, math.TWO_PI, 'heading looking straight down');
      },
    ],
    [
      'camera.setView: heading π/2 at pitch 0 looks east',
      async () => {
        const destination = cartesian3.fromDegrees(-120, 35, 3000);
        camera.setView({
          destination,
          orientation: { heading: math.PI_OVER_TWO, pitch: 0, roll: 0 },
        });
        await settle();
        const pose = camera.pose();
        const axes = localAxes(pose.position);
        near(
          cartesian3.dot(pose.direction, axes.east),
          1,
          1e-6,
          'direction·east',
        );
        near(cartesian3.dot(pose.up, axes.up), 1, 1e-6, 'up·localUp');
      },
    ],
    [
      'camera.setView: pitch −π/2 looks down the local up',
      async () => {
        const destination = cartesian3.fromDegrees(-120, 35, 3000);
        camera.setView({
          destination,
          orientation: { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 },
        });
        await settle();
        const pose = camera.pose();
        const axes = localAxes(pose.position);
        near(cartesian3.dot(pose.direction, axes.up), -1, 1e-6, 'direction·up');
        near(
          cartesian3.dot(pose.up, axes.north),
          1,
          1e-6,
          'up·north at heading 0',
        );
      },
    ],
    [
      'camera.setView: positive roll tilts up toward the camera right',
      async () => {
        const destination = cartesian3.fromDegrees(10, 45, 3000);
        camera.setView({
          destination,
          orientation: { heading: 0.4, pitch: -0.2, roll: 0 },
        });
        await settle();
        const level = camera.pose();
        camera.setView({
          destination,
          orientation: { heading: 0.4, pitch: -0.2, roll: 0.3 },
        });
        await settle();
        const rolled = camera.pose();
        near(
          cartesian3.dot(rolled.up, level.right),
          Math.sin(0.3),
          1e-6,
          'up·levelRight',
        );
        near(
          cartesian3.dot(rolled.direction, level.direction),
          1,
          1e-9,
          'roll changed the direction',
        );
      },
    ],
    [
      'camera.flightActive: true during a flight, false after it ends',
      async () => {
        await nadirView();
        ensure(!camera.flightActive(), 'a flight is active before flyTo');
        camera.flyTo({
          destination: cartesian3.fromDegrees(100, 0, 5e6),
          duration: 5,
        });
        ensure(camera.flightActive(), 'no flight is active after flyTo');
        camera.cancelFlight();
        ensure(
          !camera.flightActive(),
          'the flight is active after cancelFlight',
        );
      },
    ],
    [
      'camera.flyToSphere: Cesium default heading, pitch and range',
      async () => {
        await nadirView();
        const center = cartesian3.fromDegrees(2.35, 48.85, 100);
        const radius = 1000;
        let done = false;
        camera.flyToSphere(
          { center, radius },
          { duration: 0, complete: () => (done = true) },
        );
        ensure(
          done,
          'a duration-0 sphere flight did not complete synchronously',
        );
        const pose = camera.pose();
        const { width, height } = engine.host.size();
        const tanPhi = Math.tan(pose.fovy / 2);
        const tanTheta = (width / height) * tanPhi;
        const range = Math.max(radius / tanTheta, radius / tanPhi);
        near(
          cartesian3.distance(pose.position, center),
          range,
          range * 1e-6,
          'range (m)',
        );
        const axes = localAxes(center);
        const toCamera = unit(
          cartesian3.subtract(pose.position, center, cartesian3.create()),
        );
        near(
          cartesian3.dot(toCamera, axes.up),
          Math.sin(Math.PI / 4),
          1e-6,
          'pitch −π/4',
        );
        near(
          cartesian3.dot(toCamera, axes.east),
          0,
          1e-6,
          'heading 0 (east offset)',
        );
        ensure(
          cartesian3.dot(toCamera, axes.north) < 0,
          'camera is not south of the centre',
        );
        camera.flyToSphere({ center, radius: 0 }, { duration: 0 });
        near(
          cartesian3.distance(camera.pose().position, center),
          100,
          1e-3,
          'minimum range (m)',
        );
        const identity = camera.transform();
        for (let index = 0; index < 16; index++)
          near(
            identity[index],
            matrix4.IDENTITY[index],
            0,
            `transform[${index}]`,
          );
      },
    ],
    [
      'camera.lookAtTransform: heading/pitch/range and Cartesian offsets, transform and release',
      async () => {
        await nadirView();
        const target = cartesian3.fromDegrees(-0.12, 51.5, 0);
        const { frame, up } = localAxes(target);
        camera.lookAtTransform(frame, {
          heading: 0.4,
          pitch: -0.7,
          range: 2000,
        });
        await settle();
        let pose = camera.pose();
        near(
          cartesian3.distance(pose.position, target),
          2000,
          1e-3,
          'range (m)',
        );
        const aim = () =>
          cartesian3.dot(
            unit(
              cartesian3.subtract(
                target,
                camera.pose().position,
                cartesian3.create(),
              ),
            ),
            camera.pose().direction,
          );
        near(aim(), 1, 1e-9, 'direction·toTarget');
        const held = camera.transform();
        for (let index = 0; index < 16; index++)
          near(held[index], frame[index], 1e-6, `transform[${index}]`);
        camera.lookAtTransform(frame, cartesian3.create(0, -1000, 1000));
        await settle();
        pose = camera.pose();
        near(
          cartesian3.distance(pose.position, target),
          Math.SQRT2 * 1000,
          1e-3,
          'Cartesian offset range (m)',
        );
        near(aim(), 1, 1e-9, 'Cartesian offset direction·toTarget');
        ensure(
          cartesian3.dot(pose.up, up) > 0,
          'up does not follow the frame +Z',
        );
        camera.release();
        await settle();
        near(
          cartesian3.distance(camera.pose().position, pose.position),
          0,
          0.01,
          'release moved the camera (m)',
        );
        const released = camera.transform();
        for (let index = 0; index < 16; index++)
          near(
            released[index],
            matrix4.IDENTITY[index],
            0,
            `released transform[${index}]`,
          );
      },
    ],
    [
      'camera.zoomIn and zoomOut move along the view direction',
      async () => {
        camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 50000),
          orientation: { heading: 0.3, pitch: -0.9, roll: 0 },
        });
        await settle();
        const start = camera.pose();
        camera.zoomIn(2000);
        await settle();
        const zoomed = camera.pose().position;
        const moved = cartesian3.subtract(
          zoomed,
          start.position,
          cartesian3.create(),
        );
        near(
          cartesian3.dot(moved, start.direction),
          2000,
          1e-3,
          'zoomIn distance (m)',
        );
        near(
          cartesian3.magnitude(moved),
          2000,
          1e-3,
          'zoomIn stays on the view axis',
        );
        camera.zoomOut(500);
        await settle();
        near(
          cartesian3.distance(camera.pose().position, start.position),
          1500,
          1e-3,
          'zoomOut distance (m)',
        );
      },
    ],
    [
      'camera.viewRectangle: wraps west > east across the antimeridian',
      async () => {
        camera.setView({
          destination: cartesian3.fromDegrees(180, 0, 1e6),
          orientation: { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 },
        });
        await settle();
        const rectangle = camera.viewRectangle();
        ensure(rectangle, 'no view rectangle over the antimeridian');
        ensure(
          rectangle.west > rectangle.east,
          `west ${rectangle.west} is not east of east ${rectangle.east}`,
        );
        ensure(
          rectangle.west > 0 && rectangle.east < 0,
          'the rectangle does not cross ±180°',
        );
        ensure(
          rectangle.south < 0 && rectangle.north > 0,
          'the rectangle misses the equator',
        );
      },
    ],
    [
      'camera.setView and flyTo: missing angles default to heading 0, pitch −π/2, roll 0',
      async () => {
        const destination = cartesian3.fromDegrees(40, 30, 20000);
        const expectDefaults = (label) => {
          const pose = camera.pose();
          near(pose.pitch, -math.PI_OVER_TWO, 1e-6, `${label} pitch`);
          near(angleBetween(pose.heading, 0), 0, 1e-6, `${label} heading`);
          near(pose.roll, 0, 1e-6, `${label} roll`);
        };
        const tilted = { heading: 1, pitch: -0.3, roll: 0.2 };
        camera.setView({ destination, orientation: tilted });
        camera.setView({ destination });
        await settle();
        expectDefaults('setView without orientation');
        camera.setView({ destination, orientation: tilted });
        camera.setView({ destination, orientation: {} });
        expectDefaults('setView with empty orientation');
        camera.setView({ destination, orientation: tilted });
        camera.flyTo({ destination, duration: 0 });
        expectDefaults('flyTo without orientation');
        camera.setView({ destination, orientation: tilted });
        camera.setView({ destination, orientation: { heading: 1 } });
        const partial = camera.pose();
        near(angleBetween(partial.heading, 1), 0, 1e-6, 'partial heading');
        near(partial.pitch, -math.PI_OVER_TWO, 1e-6, 'partial pitch default');
      },
    ],
    [
      'camera.viewRectangle: a horizontal view is bounded by the horizon',
      async () => {
        camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 100000),
          orientation: { heading: 0, pitch: 0, roll: 0 },
        });
        await settle();
        const rectangle = camera.viewRectangle();
        ensure(rectangle, 'no view rectangle looking at the horizon');
        for (const side of ['west', 'south', 'east', 'north'])
          ensure(Number.isFinite(rectangle[side]), `${side} is not finite`);
        // Looking north, Cesium's rectangle is built from the canvas corners
        // that hit the globe (the bottom ones) and horizon points for the
        // rest; it need not contain the camera's own position.
        const { width, height } = engine.host.size();
        for (const x of [0, width]) {
          const ground = camera.pickEllipsoid(cartesian2.create(x, height));
          ensure(
            isCartesian3(ground),
            `the bottom corner at x=${x} missed the globe`,
          );
          const seen = cartographic.fromCartesian(ground, WGS84);
          ensure(
            rectangle.west <= seen.longitude + 1e-9 &&
              seen.longitude - 1e-9 <= rectangle.east &&
              rectangle.south <= seen.latitude + 1e-9 &&
              seen.latitude - 1e-9 <= rectangle.north,
            `the visible corner at x=${x} lies outside the rectangle`,
          );
        }
        const lon = math.toRadians(20);
        ensure(
          rectangle.west < lon && lon < rectangle.east,
          `camera longitude outside ${rectangle.west}..${rectangle.east}`,
        );
        ensure(
          rectangle.east - rectangle.west < math.toRadians(30) &&
            rectangle.north - rectangle.south < math.toRadians(30),
          'the rectangle is not bounded by the horizon',
        );
      },
    ],
    [
      'camera.viewRectangle: undefined when looking away from the Earth',
      async () => {
        camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 1e6),
          orientation: { heading: 0, pitch: math.PI_OVER_TWO, roll: 0 },
        });
        await settle();
        const rectangle = camera.viewRectangle();
        ensure(
          rectangle === undefined,
          `looking away from the Earth gave ${JSON.stringify(rectangle)}`,
        );
      },
    ],
    [
      'camera.viewRectangle: spans all longitudes over a pole',
      async () => {
        camera.setView({
          destination: cartesian3.fromDegrees(0, 89, 1e6),
          orientation: { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 },
        });
        await settle();
        const rectangle = camera.viewRectangle();
        ensure(rectangle, 'no view rectangle over the pole');
        near(rectangle.west, -Math.PI, 1e-9, 'west');
        near(rectangle.east, Math.PI, 1e-9, 'east');
        near(rectangle.north, math.PI_OVER_TWO, 1e-9, 'north');
        ensure(
          rectangle.south > 0,
          `south ${rectangle.south} crosses the equator`,
        );
      },
    ],
    [
      'projector.viewProjection: agrees with worldToWindow',
      async () => {
        camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 30000),
          orientation: { heading: 0.6, pitch: -0.5, roll: 0.1 },
        });
        await settle();
        const { width, height } = engine.host.size();
        const result = new Array(16).fill(0);
        const matrix = engine.projector.viewProjection(result);
        ensure(
          matrix === result,
          'viewProjection did not fill its result argument',
        );
        ensure(
          matrix.length === 16 && matrix.every(Number.isFinite),
          'not 16 finite numbers',
        );
        let compared = 0;
        for (const [x, y] of [
          [width / 2, height / 2],
          [width / 5, height / 4],
          [width * 0.9, height * 0.8],
        ]) {
          const point = camera.pickEllipsoid(cartesian2.create(x, y));
          if (!point) continue;
          const window = engine.projector.worldToWindow(point);
          ensure(window, 'a picked point did not project');
          const clip = [0, 1, 2, 3].map(
            (row) =>
              matrix[row] * point.x +
              matrix[4 + row] * point.y +
              matrix[8 + row] * point.z +
              matrix[12 + row],
          );
          ensure(clip[3] > 0, 'a visible point has clip.w <= 0');
          near(((clip[0] / clip[3] + 1) / 2) * width, window.x, 0.5, 'x (px)');
          near(((1 - clip[1] / clip[3]) / 2) * height, window.y, 0.5, 'y (px)');
          compared++;
        }
        ensure(compared >= 2, 'too few screen points hit the globe');
      },
    ],
    [
      'camera.flyTo: endTransform IDENTITY releases a lookAt lock when it lands',
      async () => {
        const target = cartesian3.fromDegrees(-0.12, 51.5, 0);
        const destination = cartesian3.fromDegrees(-0.12, 51.4, 20000);
        const locked = () => {
          camera.lookAt(target, { heading: 0, pitch: -0.7, range: 2000 });
          ensure(
            camera
              .transform()
              .some((value, index) => value !== matrix4.IDENTITY[index]),
            'lookAt did not lock the camera',
          );
        };
        const released = (label) => {
          const transform = camera.transform();
          for (let index = 0; index < 16; index++)
            near(
              transform[index],
              matrix4.IDENTITY[index],
              0,
              `${label} transform[${index}]`,
            );
          near(
            cartesian3.distance(camera.pose().position, destination),
            0,
            0.01,
            `${label} position error (m)`,
          );
        };
        locked();
        camera.flyTo({
          destination,
          duration: 0,
          endTransform: matrix4.IDENTITY,
        });
        released('duration 0');
        locked();
        let done = false;
        camera.flyTo({
          destination,
          duration: 0.25,
          endTransform: matrix4.IDENTITY,
          complete: () => (done = true),
        });
        await until(() => done, 'the timed flight');
        released('timed');
      },
    ],
    [
      'camera.flyTo and setView: a rectangle destination fills the view',
      async () => {
        const rectangle = {
          west: math.toRadians(2.2),
          south: math.toRadians(48.8),
          east: math.toRadians(2.5),
          north: math.toRadians(48.9),
        };
        const { width, height } = engine.host.size();
        const expectFit = (label) => {
          const pose = camera.pose();
          near(pose.pitch, -math.PI_OVER_TWO, 1e-6, `${label} pitch`);
          const middle = engine.projector.worldToWindow(
            cartesian3.fromRadians(math.toRadians(2.35), math.toRadians(48.85)),
          );
          ensure(middle, `${label}: the rectangle centre did not project`);
          near(middle.x, width / 2, width * 0.05, `${label} centre x (px)`);
          near(middle.y, height / 2, height * 0.05, `${label} centre y (px)`);
          for (const [lon, lat] of [
            [rectangle.west, rectangle.south],
            [rectangle.west, rectangle.north],
            [rectangle.east, rectangle.south],
            [rectangle.east, rectangle.north],
          ]) {
            const corner = engine.projector.worldToWindow(
              cartesian3.fromRadians(lon, lat),
            );
            ensure(
              corner &&
                corner.x >= -1 &&
                corner.x <= width + 1 &&
                corner.y >= -1 &&
                corner.y <= height + 1,
              `${label}: a corner is off screen (${corner?.x}, ${corner?.y})`,
            );
          }
        };
        await nadirView();
        camera.flyTo({ destination: rectangle, duration: 0 });
        await settle();
        expectFit('flyTo');
        await nadirView();
        camera.setView({ destination: rectangle });
        await settle();
        expectFit('setView');
      },
    ],
    [
      'projector.horizonVisible: the nadir is visible and the far side hidden',
      async () => {
        await nadirView();
        ensure(
          engine.projector.horizonVisible(cartesian3.fromDegrees(20, 10, 0)),
          'the nadir is hidden',
        );
        ensure(
          !engine.projector.horizonVisible(
            cartesian3.fromDegrees(-160, -10, 0),
          ),
          'the antipode is visible',
        );
        ensure(
          engine.projector.horizonVisible(cartesian3.fromDegrees(-70, 10, 2e7)),
          'a high point beside the limb is hidden',
        );
      },
    ],
    [
      'isDestroyed: false while the engine lives',
      async () => {
        ensure(engine.isDestroyed() === false, 'a live engine is destroyed');
      },
    ],
    [
      'camera.pose: aspectRatio is the view width over its height',
      async () => {
        await nadirView();
        const { width, height } = engine.host.size();
        // Cesium's frustum uses the drawing buffer, rounded to device pixels.
        near(camera.pose().aspectRatio, width / height, 0.01, 'aspectRatio');
      },
    ],
    [
      'picker.pickGlobe: the nadir hits the globe and the sky misses',
      async () => {
        await nadirView();
        const hit = engine.picker.pickGlobe(centre());
        ensure(isCartesian3(hit), 'the nadir missed the globe');
        const point = cartographic.fromCartesian(hit, WGS84);
        // Terrain, when shown, stays within Earth's relief of the ellipsoid.
        near(point.height, 0, 9000, 'globe height (m)');
        near(math.toDegrees(point.longitude), 20, 0.05, 'longitude (deg)');
        near(math.toDegrees(point.latitude), 10, 0.05, 'latitude (deg)');
        camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 1e6),
          orientation: { heading: 0, pitch: 0.6, roll: 0 },
        });
        await settle();
        ensure(
          engine.picker.pickGlobe(centre()) === undefined,
          'the sky hit the globe',
        );
      },
    ],
    [
      'picker.pickPosition and projector.worldToWindow round-trip within 1.5 px',
      async () => {
        if (!engine.picker.pickPositionSupported) return;
        // Straight down and tilted; screen points with no surface are skipped.
        // Over New York, low enough for map detail.
        const views = [
          { height: 20000, heading: 0, pitch: -math.PI_OVER_TWO },
          { height: 5000, heading: 0.7, pitch: -1.0 },
        ];
        let hits = 0;
        const misses = [];
        for (const { height: viewHeight, heading, pitch } of views) {
          camera.setView({
            destination: cartesian3.fromDegrees(-73.78, 40.64, viewHeight),
            orientation: { heading, pitch, roll: 0 },
          });
          // Picks read the depth of the last drawn frame: draw this view.
          await settle(3);
          const { width, height } = engine.host.size();
          const screens = [
            [0.5, 0.5],
            [0.3, 0.4],
            [0.7, 0.6],
            [0.5, 0.75],
          ].map(([x, y]) =>
            cartesian2.create(Math.round(width * x), Math.round(height * y)),
          );
          // The depth a pick reads needs drawn frames.
          await until(
            () => engine.picker.pickPosition(screens[0]) !== undefined,
            'a surface under the centre for pickPosition',
          );
          for (const screen of screens) {
            const position = engine.picker.pickPosition(screen);
            if (position === undefined) continue;
            const back = engine.projector.worldToWindow(position);
            const error = back
              ? Math.hypot(back.x - screen.x, back.y - screen.y)
              : Infinity;
            hits += 1;
            if (!(error <= 1.5))
              misses.push(
                `(${screen.x}, ${screen.y}) → ${back ? `(${back.x.toFixed(2)}, ${back.y.toFixed(2)})` : 'undefined'}`,
              );
          }
        }
        ensure(hits > 0, 'pickPosition hit no surface');
        ensure(
          misses.length === 0,
          `round-trip off by more than 1.5 px: ${misses.join('; ')}`,
        );
      },
    ],
    [
      'maps.setTerrain: keyless terrain resolves; an unknown kind rejects',
      async () => {
        await engine.maps.setTerrain({ id: 'keyless', kind: 'keyless' });
        let rejected = null;
        try {
          await engine.maps.setTerrain({
            id: 'no-such-terrain',
            kind: 'no-such-terrain',
          });
        } catch (error) {
          rejected = error;
        }
        ensure(rejected !== null, 'an unknown terrain kind resolved');
        // The keyless terrain still applies after the rejection.
        await engine.maps.setTerrain({ id: 'keyless', kind: 'keyless' });
      },
    ],
    [
      'camera.commanded: fires for each camera command, never for reads',
      async () => {
        await nadirView();
        let raised = 0;
        const remove = camera.commanded.addEventListener(() => raised++);
        const target = cartesian3.fromDegrees(20, 10, 0);
        const commands = [
          [
            'setView',
            () =>
              camera.setView({
                destination: cartesian3.fromDegrees(20, 10, 2e6),
              }),
          ],
          [
            'flyTo',
            () =>
              camera.flyTo({
                destination: cartesian3.fromDegrees(21, 10, 2e6),
                duration: 0,
              }),
          ],
          [
            'flyToSphere',
            () =>
              camera.flyToSphere(
                { center: target, radius: 100 },
                { duration: 0 },
              ),
          ],
          [
            'lookAt',
            () => camera.lookAt(target, { heading: 0, pitch: -1, range: 5e3 }),
          ],
          ['cancelFlight', () => camera.cancelFlight()],
        ];
        try {
          camera.pose();
          camera.height();
          camera.viewRectangle();
          camera.pickEllipsoid(centre());
          ensure(raised === 0, `reads raised camera.commanded ${raised}x`);
          for (const [name, command] of commands) {
            const before = raised;
            command();
            ensure(raised > before, `${name} did not raise camera.commanded`);
          }
          camera.release();
        } finally {
          remove();
        }
        const count = raised;
        camera.setView({ destination: cartesian3.fromDegrees(20, 10, 1e6) });
        ensure(raised === count, 'a removed listener was called');
      },
    ],
    [
      'camera.follow: holds a moving target centred, keeps the minimum range, ends on stop or a command',
      async () => {
        // An aircraft at 3 km over JFK flying east at 250 m/s, one step per
        // drawn frame (the step after postRender: every stage of the next
        // frame sees the same position, and the check reads the drawn one).
        const start = cartographic.fromDegrees(-73.78, 40.64, 3000);
        const stepRad = 250 / 60 / (6378137 * Math.cos(start.latitude));
        let step = 0;
        let drawn = 0;
        const at = (index) =>
          cartesian3.fromRadians(
            start.longitude + index * stepRad,
            start.latitude,
            start.height,
          );
        const removeStep = engine.frames.postRender.addEventListener(() => {
          drawn = step;
          step++;
        });
        const changes = [];
        const removeChanged = camera.followChanged.addEventListener((handle) =>
          changes.push(handle),
        );
        const offCentre = () => {
          const screen = engine.projector.worldToWindow(at(drawn));
          if (!screen) return Infinity;
          const middle = centre();
          return Math.hypot(screen.x - middle.x, screen.y - middle.y);
        };
        const range = () =>
          cartesian3.distance(camera.pose().position, at(drawn));
        try {
          camera.setView({
            destination: cartesian3.fromDegrees(-73.8, 40.6, 8000),
            orientation: { heading: 0, pitch: -0.6, roll: 0 },
          });
          await settle();
          const handle = camera.follow({
            position: () => at(step),
            viewFrom: { x: 0, y: -1000, z: 400 },
          });
          ensure(
            camera.following() === handle,
            'following() is not the handle',
          );
          ensure(
            changes.at(-1) === handle,
            'followChanged did not report the handle',
          );
          await until(() => offCentre() <= 3, 'the follow centring its target');
          near(range(), Math.hypot(1000, 400), 5, 'follow range at viewFrom');
          // target(): where the followed target is now.
          ensure(
            cartesian3.distance(handle.target(), at(step)) < 1,
            'following().target() is not the target',
          );
          // 2 s of motion (at least 120 frames), centred within 3 px.
          const began = performance.now();
          const firstStep = step;
          let worst = 0;
          for (
            let frames = 0;
            frames < 600 && (frames < 120 || performance.now() - began < 2000);
            frames++
          ) {
            await settle(1);
            worst = Math.max(worst, offCentre());
          }
          ensure(
            worst <= 3,
            `the target drifted ${worst.toFixed(2)} px off centre`,
          );
          ensure(step - firstStep >= 120, 'the target did not move');
          if (pointer?.drag && pointer?.wheel) {
            // A left drag orbits the target: same range (±5 %), centred.
            const { width, height } = engine.host.size();
            const before = range();
            await pointer.drag(
              width / 2,
              height / 2,
              width / 2 + 200,
              height / 2 + 60,
            );
            await settle(4);
            ensure(camera.following() === handle, 'a drag ended the follow');
            ensure(
              Math.abs(range() - before) <= 0.05 * before,
              `a drag changed the range ${before.toFixed(0)} → ${range().toFixed(0)} m`,
            );
            ensure(offCentre() <= 3, 'the target left the centre after a drag');
            // A 240 px drag right turns the heading clockwise as Cesium's
            // tracked camera: 1.77 × 240 / width × 360° (±15 %).
            // Cesium's gesture inertia carries a turn on for a while: the
            // heading is read once it has been still for 5 frames.
            const headingAtRest = async () => {
              let last = camera.pose().heading;
              let still = 0;
              await until(() => {
                const now = camera.pose().heading;
                still =
                  Math.abs(math.negativePiToPi(now - last)) < 1e-4
                    ? still + 1
                    : 0;
                last = now;
                return still >= 5;
              }, 'the heading at rest');
              return last;
            };
            const headingBefore = await headingAtRest();
            await pointer.drag(
              width / 2 - 120,
              height / 2,
              width / 2 + 120,
              height / 2,
            );
            const headingAfter = await headingAtRest();
            const turned =
              (math.negativePiToPi(headingAfter - headingBefore) * 180) /
              Math.PI;
            const expected = (1.77 * 240 * 360) / width;
            // Clockwise, at Cesium's rate (the harness holds the pointer
            // still before releasing it: no inertia).
            ensure(
              Math.abs(turned - expected) <= 0.15 * expected,
              `a 240 px drag right turned the heading ${turned.toFixed(1)}°, Cesium turns ${expected.toFixed(1)}°`,
            );
            ensure(offCentre() <= 3, 'the target left the centre after a turn');
            // A right drag down closes in (Cesium zoom3D), above the floor.
            if (pointer.dragRight) {
              const far = range();
              await pointer.dragRight(
                width / 2,
                height / 2 - 100,
                width / 2,
                height / 2 + 100,
              );
              await headingAtRest();
              ensure(
                range() < 0.8 * far && range() >= 149,
                `a right drag down moved the range ${far.toFixed(0)} → ${range().toFixed(0)} m`,
              );
              ensure(
                offCentre() <= 3,
                'the target left the centre after a dolly',
              );
            }
            // The wheel zooms toward the target down to the floor, never below.
            let lowest = Infinity;
            for (let notch = 0; notch < 40; notch++) {
              await pointer.wheel(width / 2, height / 2, -100);
              await settle(2);
              lowest = Math.min(lowest, range());
            }
            await settle(4);
            lowest = Math.min(lowest, range());
            ensure(lowest >= 149, `the wheel reached ${lowest.toFixed(1)} m`);
            ensure(
              range() <= 150 * 1.05,
              `40 wheel notches stopped at ${range().toFixed(1)} m, not the 150 m floor`,
            );
            ensure(
              offCentre() <= 3,
              'the target left the centre after the wheel',
            );
            ensure(camera.following() === handle, 'the wheel ended the follow');
          }
          // A zoom through the target stops at the minimum range.
          camera.zoomIn(5000);
          await settle(4);
          ensure(camera.following() === handle, 'zoomIn ended the follow');
          ensure(range() >= 149, `zoomIn reached ${range().toFixed(1)} m`);
          ensure(offCentre() <= 3, 'the target left the centre after zoomIn');
          // stop() frees the camera: the target moves on without it.
          handle.stop();
          ensure(camera.following() === null, 'following() after stop');
          ensure(changes.at(-1) === null, 'followChanged did not report null');
          camera.release();
          // Gesture inertia (Cesium) may carry the camera a few frames:
          // wait for it to rest, then the target moves on without it.
          let last = camera.pose().position;
          let stillFrames = 0;
          await until(() => {
            const now = camera.pose().position;
            stillFrames =
              cartesian3.distance(now, last) < 1e-3 ? stillFrames + 1 : 0;
            last = now;
            return stillFrames >= 5;
          }, 'the camera at rest after stop');
          const free = camera.pose().position;
          await settle(10);
          ensure(
            cartesian3.distance(camera.pose().position, free) < 1e-3,
            `the camera still moves after stop (${cartesian3
              .distance(camera.pose().position, free)
              .toFixed(2)} m in 10 frames; following ${Boolean(
              camera.following(),
            )})`,
          );
          // A command that takes the camera ends the follow.
          camera.follow({
            position: () => at(step),
            viewFrom: { x: 0, y: -1000, z: 400 },
          });
          await settle(4);
          camera.setView({
            destination: cartesian3.fromDegrees(20, 10, 1e6),
            orientation: { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 },
          });
          ensure(camera.following() === null, 'setView did not end the follow');
          ensure(changes.at(-1) === null, 'followChanged missed the command');
          await settle();
          near(camera.height(), 1e6, 1, 'height after the command');
        } finally {
          camera.following()?.stop();
          camera.release();
          removeChanged();
          removeStep();
        }
      },
    ],
  ];
  if (mapSources?.photoreal && mapSources.imagery?.length >= 2)
    checks.push(...mapChecks(engine.maps, mapSources));
  return checks.map(([name, run]) => ({ name, run }));
}

// The maps switch order, observed through maps.current().
function mapChecks(maps, { imagery: [first, second], photoreal }) {
  const shows = (baseImagery, tiles, label) => {
    const current = maps.current();
    ensure(
      current.baseImagery === baseImagery,
      `${label}: base imagery is not the expected source`,
    );
    ensure(
      current.photoreal === tiles,
      `${label}: photoreal tiles are not the expected source`,
    );
    ensure(
      maps.photorealActive() === (tiles !== null),
      `${label}: photorealActive is ${maps.photorealActive()}`,
    );
  };
  return [
    [
      'maps: setPhotorealTiles(null) brings back the last base imagery',
      async () => {
        await maps.setBaseImagery(first);
        shows(first, null, 'after setBaseImagery');
        await maps.setPhotorealTiles(photoreal);
        shows(null, photoreal, 'tiles replace the base imagery');
        await maps.setPhotorealTiles(null);
        shows(first, null, 'null');
      },
    ],
    [
      'maps: the last imagery or photoreal call decides what shows',
      async () => {
        await maps.setBaseImagery(first);
        await Promise.all([
          maps.setBaseImagery(second),
          maps.setPhotorealTiles(photoreal),
        ]);
        shows(null, photoreal, 'tiles last');
        await maps.setPhotorealTiles(null);
        const restored = maps.current().baseImagery;
        // The second source was superseded before or after it showed.
        ensure(
          restored === first || restored === second,
          'null: the last base imagery shown is not back',
        );
        await Promise.all([
          maps.setPhotorealTiles(photoreal),
          maps.setBaseImagery(second),
        ]);
        ensure(
          maps.current().baseImagery === second,
          'imagery last: the second source is not on the globe',
        );
        await maps.setPhotorealTiles(null);
        shows(second, null, 'null after imagery');
      },
    ],
    [
      'maps.releasePhotorealTiles: a released source no longer shows or counts',
      async () => {
        await maps.setPhotorealTiles(photoreal);
        await maps.setPhotorealTiles(null);
        maps.releasePhotorealTiles(photoreal);
        maps.releasePhotorealTiles(photoreal);
        ensure(!maps.photorealActive(), 'photorealActive after release');
        ensure(maps.current().photoreal === null, 'current after release');
      },
    ],
  ];
}

/** Runs every check in order; never throws for a failing check. */
export async function runContractSuite(engine, options) {
  const results = [];
  for (const { name, run } of createContractSuite(engine, options)) {
    try {
      await run();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({
        name,
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return results;
}
