/**
 * Camera checks: the reference traces, then flight, hold, event, follow and
 * view rules the traces cannot show.
 */
import goldens from '../goldens/camera.json' with { type: 'json' };
import {
  AUSTIN,
  CAMERA_SCRIPTS,
  SCRIPT_VIEWPORT,
  usesInput,
} from '../cameraScripts.js';
import { contractDriver, runCameraScript } from '../cameraRunner.js';
import { deepEqual, equal, near, nearAngle, nearVec, ok } from '../expect.js';
import { eyeMoved } from '../../../geo/eyeMoves.js';
import {
  cross,
  eastNorthUp,
  framePoint,
  frameVector,
  normalize,
  scale,
} from '../../../geo/index.js';

const lonLatToEcef = (h) => h.toEcef;

function comparePose(actual, expected, tol, where) {
  nearVec(actual.position, expected.position, tol.metres, `${where} position`);
  nearVec(actual.direction, expected.direction, tol.unit, `${where} direction`);
  nearVec(actual.up, expected.up, tol.unit, `${where} up`);
  nearVec(actual.right, expected.right, tol.unit, `${where} right`);
  nearAngle(actual.heading, expected.heading, tol.radians, `${where} heading`);
  // Pitch is compared by its sine: straight up or down, the angle itself
  // turns a last-bit difference in direction into ~1e-8 rad.
  near(
    Math.sin(actual.pitch),
    Math.sin(expected.pitch),
    tol.radians,
    `${where} sin(pitch)`,
  );
  nearAngle(actual.roll, expected.roll, tol.radians, `${where} roll`);
  near(actual.height, expected.height, tol.metres, `${where} height`);
  equal(
    actual.frameIsIdentity,
    expected.frameIsIdentity,
    `${where} frameIsIdentity`,
  );
}

function compareRecord(actual, expected, tol, where, flightPaths) {
  equal(actual.kind, expected.kind, `${where} kind`);
  const a = actual.value;
  const e = expected.value;
  switch (expected.kind) {
    case 'pose':
      comparePose(a, e, tol, where);
      break;
    case 'project':
      e.forEach((s, i) => nearVec(a[i], s, tol.pixels, `${where} point ${i}`));
      break;
    case 'pickEllipsoid':
      e.forEach((p, i) => nearVec(a[i], p, tol.metres, `${where} pick ${i}`));
      break;
    case 'pickRay':
      e.forEach((r, i) => {
        nearVec(a[i].origin, r.origin, tol.metres, `${where} ray ${i} origin`);
        nearVec(
          a[i].direction,
          r.direction,
          tol.unit,
          `${where} ray ${i} direction`,
        );
      });
      break;
    case 'occluded':
      deepEqual(a, e, `${where} occluded`);
      break;
    case 'changed':
      e.forEach((c, i) =>
        near(
          a[i].count,
          c.count,
          tol.changedCount,
          `${where} changed at ${c.threshold}`,
        ),
      );
      break;
    case 'viewRectangle':
      equal(a === null, e === null, `${where} viewRectangle null`);
      if (e)
        for (const side of ['west', 'south', 'east', 'north'])
          near(
            a[side],
            e[side],
            (tol.radians * 180) / Math.PI,
            `${where} viewRectangle ${side}`,
          );
      break;
    case 'matrices': {
      // The view's last column is a translation in metres; the rest is unit.
      e.view.forEach((v, i) =>
        near(
          a.view[i],
          v,
          i >= 12 ? tol.metres : tol.unit,
          `${where} view[${i}]`,
        ),
      );
      // Depth terms come from the renderer's own near and far planes (the
      // contract fixes neither, and allows an infinite far plane).
      const n = a.near;
      const f = a.far;
      ok(Number.isFinite(n) && n > 0, `${where} near is a positive number`);
      ok(
        f === null || (Number.isFinite(f) && f > n),
        `${where} far is beyond near, or infinite`,
      );
      const depth =
        f === null
          ? { 10: -1, 14: -2 * n }
          : { 10: -(f + n) / (f - n), 14: (-2 * f * n) / (f - n) };
      e.projection.forEach((v, i) =>
        near(
          a.projection[i],
          depth[i] ?? v,
          tol.unit * Math.max(1, Math.abs(depth[i] ?? v)),
          `${where} projection[${i}]`,
        ),
      );
      break;
    }
    case 'flying':
      equal(a.flying, e.flying, `${where} flying`);
      if (flightPaths === 'trace') comparePose(a.pose, e.pose, tol, where);
      break;
    default:
      throw new Error(`unknown record ${expected.kind}`);
  }
}

/** @param {import('../index.js').ConformanceHarness} h */
async function fresh(h) {
  return h.create({ viewport: SCRIPT_VIEWPORT });
}

export function cameraChecks() {
  const traceChecks = CAMERA_SCRIPTS.map((script) => ({
    id: `camera.trace.${script.name}`,
    port: 'camera',
    title: `reference trace: ${script.name}`,
    async run(h) {
      const expected = goldens.scripts[script.name];
      ok(expected, `no reference trace for ${script.name}`);
      const input = usesInput(script);
      if (input && h.cameraInput && !h.pointer)
        throw new Error('a harness with cameraInput needs pointer');
      if (input && !h.cameraInput)
        return { skip: 'the harness has no camera that answers pointer input' };
      const r = await fresh(h);
      try {
        if (script.capability && !r.capabilities.has(script.capability))
          return { skip: `no ${script.capability}` };
        const run = await runCameraScript(
          contractDriver(r, {
            frame: () => h.frame(r),
            toEcef: lonLatToEcef(h),
            ...(input
              ? {
                  pointer: (type, x, y, extra) =>
                    h.pointer(r, type, x, y, extra),
                }
              : {}),
          }),
          script,
        );
        equal(run.records.length, expected.records.length, 'record count');
        run.records.forEach((record, i) =>
          compareRecord(
            record,
            expected.records[i],
            h.tolerance,
            `${script.name} step ${expected.records[i].step}`,
            h.flightPaths,
          ),
        );
        equal(run.flights.length, expected.flights.length, 'flight count');
        run.flights.forEach((f, i) => {
          equal(f.outcome, expected.flights[i].outcome, `flight ${i} outcome`);
          near(f.frames, expected.flights[i].frames, 1, `flight ${i} frames`);
        });
      } finally {
        r.destroy();
      }
    },
  }));

  return [
    ...traceChecks,
    {
      id: 'camera.flight.callbacks',
      port: 'camera',
      title: 'flight callbacks run synchronously; a new flight cancels the old',
      async run(h) {
        const r = await fresh(h);
        const events = [];
        const first = r.camera.flyTo(
          { lon: 0, lat: 0, height: 1e6 },
          {
            durationS: 1,
            onCancel: () => events.push('cancel1'),
            onComplete: () => events.push('done1'),
          },
        );
        ok(r.camera.flying, 'flying after flyTo');
        r.camera.flyTo(
          { lon: 1, lat: 1, height: 1e6 },
          { durationS: 0.5, onComplete: () => events.push('done2') },
        );
        deepEqual(
          events,
          ['cancel1'],
          'the first flight was cancelled inside the second flyTo',
        );
        equal(await first.done, 'cancelled', 'first outcome');
        for (let i = 0; i < 40 && r.camera.flying; i++) await h.frame(r);
        deepEqual(events, ['cancel1', 'done2'], 'the second completed');
        ok(!r.camera.flying, 'not flying after completion');
        const third = r.camera.flyTo(
          { lon: 2, lat: 2, height: 1e6 },
          { durationS: 1, onCancel: () => events.push('cancel3') },
        );
        r.camera.cancelFlight();
        equal(
          events.at(-1),
          'cancel3',
          'cancelFlight runs onCancel inside the call',
        );
        equal(await third.done, 'cancelled', 'third outcome');
        r.destroy();
      },
    },
    {
      id: 'camera.controls.holds',
      port: 'camera',
      title:
        'camera input holds are counted; a flight ending gives back only its own',
      async run(h) {
        const r = await fresh(h);
        ok(r.camera.controls.enabled, 'enabled at start');
        const release = r.input.suspendCameraControls('drag');
        ok(!r.camera.controls.enabled, 'a hold disables input');
        r.camera.flyTo({ lon: 0, lat: 0, height: 1e6 }, { durationS: 0.1 });
        // By the clock, not a frame count: a page's frames come at the
        // display's rate, so 20 of them can pass inside the 100 ms flight.
        const flownAt = h.now(r);
        for (
          let i = 0;
          i < 600 && r.camera.flying && h.now(r) - flownAt < 1000;
          i++
        )
          await h.frame(r);
        ok(!r.camera.flying, 'the flight ended');
        ok(!r.camera.controls.enabled, 'the drag hold survives the flight end');
        const second = r.camera.controls.suspend('cockpit');
        release();
        release();
        ok(!r.camera.controls.enabled, 'one hold still out');
        second();
        ok(r.camera.controls.enabled, 'enabled with no holds out');
        const [min, max] = r.camera.controls.pitchRange;
        ok(
          -Math.PI / 2 <= min && min <= max && max <= Math.PI / 2,
          'pitchRange is an ordered range of pitches',
        );
        r.camera.controls.pitchRange = [-1.2, -0.1];
        deepEqual(
          [...r.camera.controls.pitchRange],
          [-1.2, -0.1],
          'pitchRange is settable',
        );
        const { coast } = r.camera.controls;
        for (const key of ['drag', 'zoom'])
          ok(
            Number.isFinite(coast[key]) && coast[key] >= 0,
            `coast.${key} is seconds`,
          );
        r.camera.controls.coast = { drag: 0.25, zoom: 0 };
        // Within rounding: an engine may keep it as a decay coefficient.
        near(
          r.camera.controls.coast.drag,
          0.25,
          1e-9,
          'coast.drag is settable',
        );
        near(
          r.camera.controls.coast.zoom,
          0,
          1e-9,
          'a coast of 0 stops at once',
        );
        r.destroy();
      },
    },
    {
      id: 'camera.controls.settings',
      port: 'camera',
      title: 'camera control settings read back as they were set',
      async run(h) {
        const r = await fresh(h);
        const c = r.camera.controls;
        for (const key of ['enableTilt', 'enableRotate', 'enableZoom']) {
          equal(typeof c[key], 'boolean', `${key} is a boolean`);
          c[key] = false;
          equal(c[key], false, `${key} turns off`);
          c[key] = true;
          equal(c[key], true, `${key} turns back on`);
        }
        ok(
          0 <= c.minDistance && c.minDistance <= c.maxDistance,
          'the zoom distances are an ordered range',
        );
        c.minDistance = 25;
        c.maxDistance = 3e7;
        equal(c.minDistance, 25, 'minDistance is settable');
        equal(c.maxDistance, 3e7, 'maxDistance is settable');
        ok(c.zoomFactor > 0, 'zoomFactor is positive');
        c.zoomFactor = 12;
        equal(c.zoomFactor, 12, 'zoomFactor is settable');
        ok(
          ['none', 'terrain', 'tiles', 'both'].includes(c.collision),
          'collision is a known setting',
        );
        for (const setting of ['none', 'terrain', 'tiles', 'both']) {
          c.collision = setting;
          equal(c.collision, setting, `collision ${setting} reads back`);
        }
        const inputs = ['wheel', 'pinch', 'rightDrag', 'ctrlWheel'];
        ok(
          c.zoomInputs.every((name) => inputs.includes(name)),
          'zoomInputs are known bindings',
        );
        c.zoomInputs = ['wheel', 'ctrlWheel'];
        deepEqual(
          [...c.zoomInputs].sort(),
          ['ctrlWheel', 'wheel'],
          'zoomInputs are settable',
        );
        if (r.capabilities.has('keepEarthFramed')) {
          equal(c.keepEarthFramed, false, 'keepEarthFramed is off at first');
          c.keepEarthFramed = true;
          equal(c.keepEarthFramed, true, 'keepEarthFramed is settable');
          c.keepEarthFramed = false;
          equal(c.keepEarthFramed, false, 'keepEarthFramed turns off');
        }
        r.destroy();
      },
    },
    {
      id: 'camera.onCommand',
      port: 'camera',
      title: 'every camera command is announced before it runs',
      async run(h) {
        const r = await fresh(h);
        const seen = [];
        const off = r.camera.onCommand((c) => seen.push(c.kind));
        const target = h.toEcef({ lon: 0, lat: 0, height: 0 });
        r.camera.setView({ destination: { lon: 0, lat: 0, height: 1000 } });
        r.camera.lookAt(target, { heading: 0, pitch: -0.5, range: 1000 });
        r.camera.release();
        r.camera.flyTo({ lon: 1, lat: 1, height: 1000 }, { durationS: 1 });
        r.camera.cancelFlight();
        r.camera.flyToBounds({ center: target, radius: 10 }, { durationS: 1 });
        r.camera.cancelFlight();
        r.camera.follow({
          key: 'k',
          position: () => target,
          frame: 'enu',
          viewFrom: { x: 0, y: -100, z: 100 },
        });
        off();
        r.camera.follow(null);
        deepEqual(
          seen,
          [
            'setView',
            'lookAt',
            'release',
            'flyTo',
            'cancelFlight',
            'flyToBounds',
            'cancelFlight',
            'follow',
          ],
          'commands',
        );
        r.destroy();
      },
    },
    {
      id: 'camera.moveEnd',
      port: 'camera',
      title: 'moveStart on movement; moveEnd 500 ms after the last change',
      async run(h) {
        const r = await fresh(h);
        const events = [];
        r.camera.on('moveStart', () => events.push(['start', h.now(r)]));
        r.camera.on('moveEnd', () => events.push(['end', h.now(r)]));
        await h.frame(r);
        const movingAt = h.now(r);
        r.camera.setView(eyeMoved(r.camera.pose(), 'forward', 1000));
        await h.frame(r);
        equal(events[0]?.[0], 'start', 'moveStart after the move');
        const movedAt = h.now(r);
        // By the clock, not a frame count: a page's frames come at the
        // display's rate.
        // The event comes on the first frame past 500 ms, so the slack is
        // two of the longest frames seen, never less than two at 60 Hz.
        let longestFrame = 1000 / 60;
        for (let i = 0; i < 600 && h.now(r) - movedAt < 750; i++) {
          const before = h.now(r);
          await h.frame(r);
          longestFrame = Math.max(longestFrame, h.now(r) - before);
        }
        const end = events.find(([kind]) => kind === 'end');
        ok(end, 'moveEnd fired');
        ok(
          end[1] - movingAt >= 500 - 1e-6,
          `moveEnd waited 500 ms (${end[1] - movingAt})`,
        );
        ok(
          end[1] - movedAt < 500 + 2 * longestFrame + 1e-6,
          `moveEnd came within two frames of 500 ms (${end[1] - movedAt})`,
        );
        r.destroy();
      },
    },
    {
      id: 'camera.changed.order',
      port: 'camera',
      title:
        '`changed` is measured before preUpdate; a move made in preUpdate is reported on the next frame',
      async run(h) {
        const r = await fresh(h);
        try {
          const at = (height) => ({
            destination: { ...AUSTIN, height },
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          r.camera.setView(at(2000));
          const seen = [];
          let move = null;
          r.camera.on('changed', () => seen.push('changed'));
          r.frame.on('preUpdate', () => {
            seen.push('preUpdate');
            if (move) r.camera.setView(move);
            move = null;
          });
          // The first measure is the listener's starting point.
          await h.frame(r);
          await h.frame(r);
          seen.length = 0;
          r.camera.setView(at(8000));
          await h.frame(r);
          deepEqual(
            seen,
            ['changed', 'preUpdate'],
            'a move made before the frame is reported before preUpdate',
          );
          seen.length = 0;
          move = at(2000);
          await h.frame(r);
          deepEqual(
            seen,
            ['preUpdate'],
            'a move made in preUpdate is not reported in its own frame',
          );
          seen.length = 0;
          await h.frame(r);
          deepEqual(
            seen,
            ['changed', 'preUpdate'],
            'it is reported as the next frame starts',
          );
        } finally {
          r.destroy();
        }
      },
    },
    {
      id: 'camera.follow',
      port: 'camera',
      title: 'a follow keeps the eye at its offset from a moving target',
      async run(h) {
        const r = await fresh(h);
        const changes = [];
        r.camera.on('followChanged', () =>
          changes.push(r.camera.followed?.key ?? null),
        );
        const base = h.toEcef({ lon: -97.74, lat: 30.27, height: 1000 });
        const start = r.frame.time();
        const target = {
          key: 'test:mover',
          position: (t) => ({
            x: base.x + (t - start) * 0.2,
            y: base.y,
            z: base.z,
          }),
          frame: 'enu',
          viewFrom: { x: 0, y: -800, z: 400 },
        };
        r.camera.follow(target);
        equal(r.camera.followed, target, 'followed');
        await h.frame(r);
        ok(r.camera.followFramed, 'framed after a frame');
        const range0 = dist(
          r.camera.pose().position,
          target.position(r.frame.time()),
        );
        near(range0, Math.hypot(800, 400), 1, 'starting range');
        for (let i = 0; i < 30; i++) {
          r.frame.setTime(r.frame.time() + 1000);
          await h.frame(r);
          near(
            dist(r.camera.pose().position, target.position(r.frame.time())),
            range0,
            1e-3 * range0,
            `range at frame ${i}`,
          );
        }
        r.camera.follow(null);
        equal(r.camera.followed, null, 'cleared');
        ok(r.camera.pose().frameIsIdentity, 'back in the world frame');
        deepEqual(changes, ['test:mover', null], 'followChanged');
        r.destroy();
      },
    },
    {
      id: 'camera.follow.transition',
      port: 'camera',
      title:
        'a follow with transitionS moves the eye from where it stood to viewFrom; a viewFrom along its own view keeps view and range',
      async run(h) {
        const r = await fresh(h);
        const target = h.toEcef({ lon: -97.74, lat: 30.27, height: 1000 });
        const enu = eastNorthUp(target);
        // The eye 1.8 km off the target, looking a little beside it.
        const local = { x: 400, y: -1500, z: 900 };
        const range = Math.hypot(local.x, local.y, local.z);
        const look = normalize({
          x: -local.x + 150,
          y: -local.y,
          z: -local.z - 120,
        });
        const right = normalize(cross(look, { x: 0, y: 0, z: 1 }));
        const lookUp = normalize(cross(right, look));
        const eye = framePoint(enu, local);
        const direction = normalize(frameVector(enu, look));
        r.camera.setView({
          destination: eye,
          orientation: { direction, up: normalize(frameVector(enu, lookUp)) },
        });
        await h.frame(r);
        const viewFrom = scale(look, -range);
        r.camera.follow({
          key: 'test:transition',
          position: () => target,
          frame: 'enu',
          viewFrom,
          transitionS: 1,
        });
        const startedAt = h.now(r);
        await h.frame(r);
        ok(!r.camera.followFramed, 'not framed on the first frame');
        nearVec(
          r.camera.pose().position,
          eye,
          1e-3,
          'the eye starts where it stood',
        );
        let midway = false;
        for (let i = 0; i < 600 && !r.camera.followFramed; i++) {
          const pose = r.camera.pose();
          near(dist(pose.position, target), range, 1e-6 * range, `range ${i}`);
          nearVec(pose.direction, direction, 1e-6, `view ${i}`);
          if (dist(pose.position, eye) > 1) midway = true;
          await h.frame(r);
        }
        ok(midway, 'the eye moved before it arrived');
        ok(r.camera.followFramed, 'framed on arrival');
        ok(h.now(r) - startedAt >= 1000 - 1e-6, 'arrived after transitionS');
        const pose = r.camera.pose();
        nearVec(
          pose.position,
          framePoint(enu, viewFrom),
          1e-3,
          'the eye at viewFrom',
        );
        nearVec(pose.direction, direction, 1e-6, 'the same view');
        r.camera.follow(null);
        r.destroy();
      },
    },
    {
      id: 'camera.follow.autodetect',
      port: 'camera',
      title:
        'an autodetect follow keeps its range: north-up on a still target, a frame standing up on a fast one',
      async run(h) {
        const r = await fresh(h);
        if (!r.capabilities.has('followAutodetect')) {
          r.destroy();
          return { skip: 'no followAutodetect' };
        }
        const viewFrom = { x: 0, y: -800, z: 400 };
        const range = Math.hypot(viewFrom.x, viewFrom.y, viewFrom.z);
        const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
        const unit = (v) => {
          const n = Math.hypot(v.x, v.y, v.z);
          return { x: v.x / n, y: v.y / n, z: v.z / n };
        };
        // The frame's axes and origin, where the renderer reads it back.
        const frame = () => {
          if (!r.capabilities.has('followFrame')) return null;
          const m = r.camera.followFrame();
          return {
            x: { x: m[0], y: m[1], z: m[2] },
            z: { x: m[8], y: m[9], z: m[10] },
            origin: { x: m[12], y: m[13], z: m[14] },
          };
        };

        const still = h.toEcef({ lon: -97.74, lat: 30.27, height: 1000 });
        r.camera.follow({
          key: 'test:still',
          position: () => still,
          frame: 'autodetect',
          viewFrom,
        });
        for (let i = 0; i < 3; i++) await h.frame(r);
        ok(r.camera.followFramed, 'framed');
        near(dist(r.camera.pose().position, still), range, 1, 'still range');
        const enu = frame();
        if (enu) {
          nearVec(enu.origin, still, 1e-3, 'still: the frame on the target');
          const lon = (-97.74 * Math.PI) / 180;
          const east = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
          ok(dot(enu.x, east) > 0.999, 'still: x is east');
          ok(dot(enu.z, unit(still)) > 0.99, 'still: z is up');
        }
        r.camera.follow(null);
        await h.frame(r);

        // A satellite's speed, eastward 400 km up over the equator.
        const radius = 6378137 + 400000;
        const speed = 7670;
        const start = r.frame.time();
        const orbiting = (t) => {
          const a = ((t - start) / 1000) * (speed / radius);
          return { x: radius * Math.cos(a), y: radius * Math.sin(a), z: 0 };
        };
        r.camera.follow({
          key: 'test:orbit',
          position: orbiting,
          frame: 'autodetect',
          viewFrom,
        });
        for (let i = 0; i < 3; i++) await h.frame(r);
        ok(r.camera.followFramed, 'framed');
        const range0 = dist(r.camera.pose().position, orbiting(r.frame.time()));
        near(range0, range, 1, 'orbit: starting range');
        for (let i = 0; i < 10; i++) {
          r.frame.setTime(r.frame.time() + 1000);
          await h.frame(r);
          const at = orbiting(r.frame.time());
          near(
            dist(r.camera.pose().position, at),
            range0,
            1e-3 * range0,
            `orbit: range at frame ${i}`,
          );
          const f = frame();
          if (f) {
            nearVec(f.origin, at, 1e-3, `orbit: the frame on the target ${i}`);
            ok(dot(f.z, unit(at)) > 0.99, `orbit: z is up ${i}`);
          }
        }
        r.camera.follow(null);
        r.destroy();
      },
    },
    {
      id: 'camera.followFrame',
      port: 'camera',
      title:
        'the eye’s frame reads back: the world, a lookAt target’s east-north-up, a follow’s with the offset in it',
      async run(h) {
        const r = await fresh(h);
        if (!r.capabilities.has('followFrame')) {
          r.destroy();
          return { skip: 'no followFrame' };
        }
        const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const frameOf = () => {
          const m = r.camera.followFrame();
          equal(m.length, 16, 'a 4×4 matrix');
          return {
            m,
            x: { x: m[0], y: m[1], z: m[2] },
            y: { x: m[4], y: m[5], z: m[6] },
            z: { x: m[8], y: m[9], z: m[10] },
            origin: { x: m[12], y: m[13], z: m[14] },
          };
        };
        // The eye's position in a frame, from its world position.
        const inFrame = (f, p) => {
          const d = {
            x: p.x - f.origin.x,
            y: p.y - f.origin.y,
            z: p.z - f.origin.z,
          };
          const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
          return { x: dot(f.x, d), y: dot(f.y, d), z: dot(f.z, d) };
        };
        const world = frameOf();
        IDENTITY.forEach((v, i) => near(world.m[i], v, 1e-12, `world [${i}]`));

        const target = h.toEcef({ lon: -97.74, lat: 30.27, height: 1000 });
        r.camera.lookAt(target, {
          heading: 0,
          pitch: -Math.PI / 2,
          range: 900,
        });
        const looked = frameOf();
        nearVec(looked.origin, target, 1e-6, 'lookAt origin');
        // Straight down from 900 m: the eye is 900 m up the frame's z.
        nearVec(
          inFrame(looked, r.camera.pose().position),
          { x: 0, y: 0, z: 900 },
          1e-6,
          'lookAt eye',
        );
        const up = Math.hypot(target.x, target.y, target.z);
        ok(
          (looked.z.x * target.x +
            looked.z.y * target.y +
            looked.z.z * target.z) /
            up >
            0.99,
          'its z is up',
        );
        r.camera.release();

        const start = r.frame.time();
        const mover = {
          key: 'test:frame',
          position: (t) => ({
            x: target.x + (t - start) * 0.2,
            y: target.y,
            z: target.z,
          }),
          frame: 'enu',
          viewFrom: { x: 0, y: -800, z: 400 },
        };
        r.camera.follow(mover);
        await h.frame(r);
        r.frame.setTime(start + 5000);
        await h.frame(r);
        const followed = frameOf();
        nearVec(
          followed.origin,
          mover.position(r.frame.time()),
          1e-3,
          'the follow frame stands on the target',
        );
        nearVec(
          inFrame(followed, r.camera.pose().position),
          r.camera.followOffset.get(),
          1e-3,
          'followOffset is the eye in it',
        );
        // setView places a world pose and keeps the follow's frame.
        const placed = {
          x: followed.origin.x + 300,
          y: followed.origin.y - 200,
          z: followed.origin.z + 500,
        };
        r.camera.setView({
          destination: placed,
          orientation: { heading: 0.3, pitch: -0.5, roll: 0 },
        });
        frameOf().m.forEach((v, i) =>
          near(v, followed.m[i], 1e-6, `setView keeps the frame [${i}]`),
        );
        nearVec(r.camera.pose().position, placed, 1e-6, 'setView places it');
        r.camera.follow(null);
        const after = frameOf();
        IDENTITY.forEach((v, i) =>
          near(after.m[i], v, 1e-12, `world again [${i}]`),
        );
        r.destroy();
      },
    },
    {
      id: 'camera.rect',
      port: 'camera',
      title:
        'a rectangle destination looks straight down and keeps the whole rectangle in view',
      async run(h) {
        const r = await fresh(h);
        const rect = { west: -98, south: 30, east: -97.5, north: 30.4 };
        r.camera.setView({ destination: { rect } });
        await h.frame(r);
        const pose = r.camera.pose();
        near(pose.pitch, -Math.PI / 2, 1e-3, 'pitch');
        for (const [lon, lat] of [
          [rect.west, rect.north],
          [rect.east, rect.north],
          [rect.west, rect.south],
          [rect.east, rect.south],
        ]) {
          const s = r.query.project(h.toEcef({ lon, lat, height: 0 }));
          ok(
            s &&
              s.x >= -1 &&
              s.x <= SCRIPT_VIEWPORT.width + 1 &&
              s.y >= -1 &&
              s.y <= SCRIPT_VIEWPORT.height + 1,
            `corner ${lon},${lat} in view (${JSON.stringify(s)})`,
          );
        }
        r.destroy();
      },
    },
    {
      id: 'camera.viewRectangle',
      port: 'camera',
      title:
        'viewRectangle holds the ground in view, is the whole globe from afar, null facing away',
      async run(h) {
        const r = await fresh(h);
        const at = async (height, pitch = -Math.PI / 2) => {
          r.camera.setView({
            destination: { ...AUSTIN, height },
            orientation: { heading: 0, pitch, roll: 0 },
          });
          await h.frame(r);
          return r.camera.viewRectangle();
        };
        const down = await at(5000);
        ok(
          down &&
            down.west < -97.74 &&
            down.east > -97.74 &&
            down.south < 30.27 &&
            down.north > 30.27 &&
            down.east - down.west < 0.2,
          `straight down holds the centre (${JSON.stringify(down)})`,
        );
        const tilted = await at(2000, -0.3);
        ok(tilted && tilted.north > 30.3, 'tilted: cut at the horizon');
        deepEqual(
          await at(15000000),
          { west: -180, south: -90, east: 180, north: 90 },
          'from afar: the whole globe',
        );
        equal(await at(15000000, Math.PI / 2), null, 'facing away: null');
        r.destroy();
      },
    },
    {
      id: 'camera.followItem',
      port: 'camera',
      title: 'following a drawn item tracks where the renderer draws it',
      async run(h) {
        const r = await fresh(h);
        if (!r.capabilities.has('motionSegments')) {
          r.destroy();
          return { skip: 'no motionSegments' };
        }
        const t0 = r.frame.time();
        const from = h.toEcef({ lon: -97.74, lat: 30.27, height: 1000 });
        const to = h.toEcef({ lon: -97.7, lat: 30.27, height: 1000 });
        const set = r.draw.icons({
          id: 'conf:follow',
          motionClock: { kind: 'scene' },
        });
        set.set([
          {
            id: 'm',
            pos: from,
            image: 'data:,',
            size: [16, 16],
            motion: { kind: 'lerp', from, to, t0, t1: t0 + 60000 },
          },
        ]);
        r.camera.follow({
          key: 'conf:follow:m',
          // Deliberately stale: the drawn item is the answer.
          position: () => from,
          item: { set: 'conf:follow', id: 'm' },
          frame: 'enu',
          viewFrom: { x: 0, y: -500, z: 300 },
        });
        await h.frame(r);
        const range0 = dist(r.camera.pose().position, from);
        r.frame.setTime(t0 + 30000);
        await h.frame(r);
        const mid = {
          x: (from.x + to.x) / 2,
          y: (from.y + to.y) / 2,
          z: (from.z + to.z) / 2,
        };
        near(
          dist(r.camera.pose().position, mid),
          range0,
          1,
          'the eye keeps its range from the drawn position',
        );
        set.dispose();
        r.destroy();
      },
    },
    {
      id: 'camera.setView.exact',
      port: 'camera',
      title:
        'a view given as direction and up is placed exactly: a thousand small turns straight down add up to one',
      async run(h) {
        const r = await fresh(h);
        r.camera.setView({
          destination: { lon: -97.74, lat: 30.27, height: 5000 },
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        await h.frame(r);
        const start = r.camera.pose();
        // Turn about the eye's own up, as a step turn left does.
        const turn = (v, axis, angle) => {
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          const k = axis;
          const d = k.x * v.x + k.y * v.y + k.z * v.z;
          return {
            x: v.x * c + (k.y * v.z - k.z * v.y) * s + k.x * d * (1 - c),
            y: v.y * c + (k.z * v.x - k.x * v.z) * s + k.y * d * (1 - c),
            z: v.z * c + (k.x * v.y - k.y * v.x) * s + k.z * d * (1 - c),
          };
        };
        const step = 1e-5;
        for (let i = 0; i < 1000; i++) {
          const { position, direction, up } = r.camera.pose();
          r.camera.setView({
            destination: position,
            orientation: { direction: turn(direction, up, step), up },
          });
        }
        await h.frame(r);
        const end = r.camera.pose();
        const want = turn(start.direction, start.up, 1000 * step);
        for (const axis of ['x', 'y', 'z'])
          near(end.direction[axis], want[axis], 1e-6, `direction.${axis}`);
        for (const axis of ['x', 'y', 'z'])
          near(
            end.position[axis],
            start.position[axis],
            1e-3,
            `position.${axis}`,
          );
        r.destroy();
      },
    },
    {
      id: 'camera.fov',
      port: 'camera',
      title: 'setFov sets the vertical field of view; null gives it back',
      async run(h) {
        const r = await fresh(h);
        const own = r.camera.pose().fovy;
        r.camera.setFov({ vertical: 0.5 });
        near(r.camera.pose().fovy, 0.5, 1e-12, 'fovy');
        near(
          r.camera.pose().aspectRatio,
          SCRIPT_VIEWPORT.width / SCRIPT_VIEWPORT.height,
          1e-9,
          'aspect',
        );
        r.camera.setFov(null);
        near(r.camera.pose().fovy, own, 1e-9, 'the renderer’s own again');
        r.destroy();
      },
    },
  ];
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
