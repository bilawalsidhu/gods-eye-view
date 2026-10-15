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
      'camera.position and camera.height: the pose position and height, without a pose',
      async () => {
        camera.setView({
          destination: cartesian3.fromDegrees(-3.7, 40.4, 12000),
          orientation: { heading: 0.4, pitch: -0.5, roll: 0 },
        });
        await settle();
        const pose = camera.pose();
        const result = cartesian3.create();
        const filled = camera.position(result);
        ensure(
          filled === result,
          'position(result) returns the result it filled',
        );
        near(
          cartesian3.distance(filled, pose.position),
          0,
          1e-6,
          'position(result) vs pose().position',
        );
        const fresh = camera.position();
        ensure(
          isCartesian3(fresh) && fresh !== filled,
          'position() returns a fresh Cartesian3',
        );
        near(
          cartesian3.distance(fresh, pose.position),
          0,
          1e-6,
          'position() vs pose().position',
        );
        near(camera.height(), pose.cartographic.height, 0.01, 'height()');
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
