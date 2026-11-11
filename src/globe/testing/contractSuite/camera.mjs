import {
  cartesian2,
  cartesian3,
  cartographic,
  ellipsoid,
  math,
  matrix4,
  WGS84,
  ensure,
  near,
  angleBetween,
  isCartesian3,
  localAxes,
  inRange,
  unit,
  along,
} from './helpers.mjs';
import { enuOffset } from '../../follow.js';

export function poseChecks(engine, { settle, until, nadirView }) {
  const { camera } = engine;
  return [
    [
      'camera.setFovy: changes projection and rays without moving the camera',
      async () => {
        const saved = camera.pose();
        const size = engine.host.size();
        const pixel = { x: size.width * 0.65, y: size.height * 0.5 };
        const ray = camera.pickRay(pixel);
        const point = cartesian3.add(
          ray.origin,
          cartesian3.multiplyByScalar(ray.direction, 1000, cartesian3.create()),
          cartesian3.create(),
        );
        const before = engine.projector.worldToWindow(point);
        try {
          camera.setFovy(saved.fovy / 128);
          await settle();
          near(
            camera.pose().fovy,
            saved.fovy / 128,
            1e-10,
            'vertical field of view',
          );
          near(
            cartesian3.distance(camera.pose().position, saved.position),
            0,
            0.01,
            'position unchanged',
          );
          const after = engine.projector.worldToWindow(point);
          ensure(after.x > before.x, 'narrowing the field magnifies the image');
          const narrower = camera.pickRay(pixel);
          ensure(
            cartesian3.distance(narrower.direction, ray.direction) > 1e-3,
            'pick ray follows the lens',
          );
          for (const invalid of [0, -1, Math.PI, NaN, Infinity]) {
            let rejected = false;
            try {
              camera.setFovy(invalid);
            } catch {
              rejected = true;
            }
            ensure(rejected, 'invalid field of view is rejected');
          }
          near(
            camera.pose().fovy,
            saved.fovy / 128,
            1e-10,
            'invalid input keeps the lens',
          );
        } finally {
          camera.setFovy(saved.fovy);
        }
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
      'camera.livePosition: the pose position and height, without a pose',
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
      'camera.changed: changed, moveStart and moveEnd follow a move',
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
  ];
}

export function flightChecks(engine, { settle, until, nadirView, centre }) {
  const { camera } = engine;
  return [
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
      'camera.completeFlight: lands a running flight at once and calls complete',
      async () => {
        await nadirView();
        camera.completeFlight();
        const outcome = [];
        const destination = cartesian3.fromDegrees(100, 0, 5e6);
        camera.flyTo({
          destination,
          orientation: { heading: 0.5, pitch: -0.8, roll: 0 },
          duration: 5,
          complete: () => outcome.push('complete'),
          cancel: () => outcome.push('cancel'),
        });
        await settle(2);
        camera.completeFlight();
        ensure(
          outcome.join() === 'complete',
          `completeFlight returned with [${outcome}] instead of [complete]`,
        );
        ensure(!camera.flightActive(), 'the flight is still active');
        const pose = camera.pose();
        near(
          cartesian3.distance(pose.position, destination),
          0,
          0.01,
          'position error (m)',
        );
        near(angleBetween(pose.heading, 0.5), 0, 1e-6, 'heading error');
        near(pose.pitch, -0.8, 1e-6, 'pitch');
        await settle(3);
        ensure(outcome.join() === 'complete', `flight ended with ${outcome}`);
      },
    ],
    [
      'camera.setView: cancels an active flight and retains its destination',
      async () => {
        await nadirView();
        const outcome = [];
        camera.flyTo({
          destination: cartesian3.fromDegrees(100, 0, 5e6),
          duration: 5,
          complete: () => outcome.push('complete'),
          cancel: () => outcome.push('cancel'),
        });
        await settle(2);
        const destination = cartesian3.fromDegrees(20, 10, 200000);
        camera.setView({ destination });
        await settle(3);
        ensure(outcome.join() === 'cancel', `flight ended with ${outcome}`);
        ensure(!camera.flightActive(), 'setView left the flight active');
        near(
          cartesian3.distance(camera.pose().position, destination),
          0,
          0.01,
          'setView position error (m)',
        );
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
  ];
}

export function swingChecks(engine, { settle, until }) {
  const { camera } = engine;
  return [
    [
      'camera.follow: swings to an ENU offset and cancels on handoff',
      async () => {
        const target = cartesian3.fromDegrees(10, 30, 5000);
        const goal = { x: 0, y: 4800, z: 3300 };
        const handle = camera.follow({
          position: () => target,
          viewFrom: { x: 0, y: -4800, z: 3300 },
          swingTo: goal,
        });
        try {
          await until(
            () =>
              cartesian3.distance(
                enuOffset(target, camera.pose().position),
                goal,
              ) < 5,
            'the shared follow offset',
          );
          ensure(camera.following() === handle, 'swing replaced the follow');
          handle.retarget({ swingTo: { x: 0, y: -4800, z: 3300 } });
          handle.retarget({ swingTo: null });
          await settle(3);
          near(
            cartesian3.distance(
              enuOffset(target, camera.pose().position),
              goal,
            ),
            0,
            5,
            'cancelled swing moved the camera',
          );
          camera.setView({
            destination: cartesian3.fromDegrees(10, 30, 50000),
          });
          await settle(3);
          ensure(
            camera.following() === null,
            'camera handoff retained the swing',
          );
        } finally {
          handle.stop();
        }
      },
    ],
  ];
}

export function cameraChecks(engine, { settle, until, nadirView, centre }) {
  const { camera } = engine;
  return [
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
      'camera.zoomIn: zoomIn and zoomOut move along the view direction',
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
      'camera.setView: missing angles default to heading 0, pitch −π/2, roll 0',
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
      'camera.flyTo: a rectangle destination fills the view',
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
}

export function aspectChecks(engine, { nadirView }) {
  const { camera } = engine;
  return [
    [
      'camera.pose: aspectRatio is the view width over its height',
      async () => {
        await nadirView();
        const { width, height } = engine.host.size();
        // Cesium's frustum uses the drawing buffer, rounded to device pixels.
        near(camera.pose().aspectRatio, width / height, 0.01, 'aspectRatio');
      },
    ],
  ];
}

export function followChecks(
  engine,
  { settle, until, nadirView, centre, pointer },
) {
  const { camera } = engine;
  return [
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
          // A layer's own handle as `native`: echoed, whatever the engine.
          const followed = { id: 'contract-followed' };
          const handle = camera.follow({
            native: followed,
            position: () => at(step),
            viewFrom: { x: 0, y: -1000, z: 400 },
          });
          ensure(
            camera.following() === handle,
            'following() is not the handle',
          );
          ensure(handle.native === followed, 'the handle lost its native');
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
}

export function cameraBehaviourChecks(
  engine,
  { settle, until, nadirView, centre, pointer },
) {
  const { camera } = engine;
  const checks = [
    ...['heading', 'roll'].map((angle) => [
      `camera.changed: a pure ${angle} change raises the event`,
      async () => {
        await nadirView();
        const previous = camera.percentageChanged;
        camera.percentageChanged = 0.001;
        const position = camera.pose().position;
        let changes = 0;
        const remove = camera.changed.addEventListener(() => changes++);
        try {
          camera.setView({
            destination: position,
            orientation: { heading: 0, pitch: -1, roll: 0 },
          });
          await settle(3);
          changes = 0;
          camera.setView({
            destination: position,
            orientation: { heading: 0, pitch: -1, roll: 0, [angle]: 0.8 },
          });
          await until(() => changes > 0, `${angle} changed`);
          near(
            cartesian3.distance(camera.pose().position, position),
            0,
            0.01,
            'rotation moved the camera',
          );
        } finally {
          remove();
          camera.percentageChanged = previous;
        }
      },
    ]),
    [
      'camera.following: set, retarget and stop retain identity and announce changes',
      async () => {
        await nadirView();
        const first = cartesian3.fromDegrees(20, 10, 1000);
        const second = cartesian3.fromDegrees(20.01, 10, 1000);
        const changes = [];
        const remove = camera.followChanged.addEventListener((value) =>
          changes.push(value),
        );
        let handle;
        try {
          const label = { id: 'contract-follow', position: () => first };
          handle = camera.follow({
            position: () => first,
            viewFrom: { x: 0, y: -1000, z: 500 },
            label,
          });
          ensure(
            camera.following() === handle,
            'following did not return the handle',
          );
          ensure(
            changes.length === 1 && changes[0] === handle,
            'followChanged missed the start',
          );
          ensure(handle.label?.id === label.id, 'follow label lost');
          handle.retarget({ position: () => second });
          await settle(3);
          ensure(camera.following() === handle, 'retarget replaced the handle');
          near(
            cartesian3.distance(handle.target(), second),
            0,
            0.01,
            'retarget position',
          );
          ensure(
            changes.length === 2 && changes[1] === handle,
            'followChanged missed the retarget',
          );
          handle.stop();
          ensure(camera.following() === null, 'following did not clear');
          ensure(
            changes.length === 3 && changes[2] === null,
            'followChanged missed the stop',
          );
          handle.stop();
          ensure(changes.length === 3, 'stop announced twice');
        } finally {
          handle?.stop();
          camera.release();
          remove();
        }
      },
    ],
  ];
  if (pointer?.drag)
    checks.push([
      'camera.flyTo: a pointer gesture during a flight does not cut it',
      async () => {
        await nadirView();
        let complete = 0;
        let cancel = 0;
        const destination = cartesian3.fromDegrees(21, 11, 5e5);
        const { x, y } = centre();
        try {
          camera.flyTo({
            destination,
            duration: 2,
            complete: () => complete++,
            cancel: () => cancel++,
          });
          await settle(2);
          ensure(camera.flightActive(), 'flight ended before the gesture');
          await pointer.drag(x, y, x + 80, y + 40);
          ensure(cancel === 0, 'pointer cancelled the flight');
          await until(() => complete > 0, 'flight completion');
          ensure(complete === 1 && cancel === 0, 'flight callbacks');
          near(
            cartesian3.distance(camera.pose().position, destination),
            0,
            1,
            'flight destination',
          );
        } finally {
          camera.cancelFlight();
        }
      },
    ]);
  return checks;
}
