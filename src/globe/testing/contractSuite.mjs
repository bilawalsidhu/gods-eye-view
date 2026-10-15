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
import { INPUT_TYPES, assertGlobeEngine } from '../contract.js';

const { cartesian2, cartesian3, cartographic, ellipsoid, math } = geo;
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

const unit = (vector) => cartesian3.normalize(vector, cartesian3.create());
const along = (origin, direction, distance) =>
  cartesian3.add(
    origin,
    cartesian3.multiplyByScalar(direction, distance, cartesian3.create()),
    cartesian3.create(),
  );

/**
 * @param {import('../contract.js').GlobeEngine} engine
 * @param {{ waitFrames: (count: number) => Promise<void>, maxWaitFrames?: number }} options
 * @returns {{ name: string, run: () => Promise<void> }[]}
 */
export function createContractSuite(
  engine,
  { waitFrames, maxWaitFrames = 240 },
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
        await nadirView();
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
      'camera.flyTo: duration 0 lands on the destination and completes',
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
        await until(() => outcome.length > 0, 'flight completion');
        ensure(outcome.join() === 'complete', `flight ended with ${outcome}`);
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
      'surface: supported, tilesLoaded and sampleHeight shapes',
      async () => {
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
          const off = engine.input.on(type, () => {});
          ensure(
            typeof off === 'function',
            `input.on('${type}') returned no remover`,
          );
          off();
          off();
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
  ];
  return checks.map(([name, run]) => ({ name, run }));
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
