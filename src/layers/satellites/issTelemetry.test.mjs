import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import * as Cesium from 'cesium';
import {
  ISS_ALPHA_JOINTS,
  ISS_BETA_JOINTS,
  ISS_DISH_JOINTS,
  ISS_RADIATOR_JOINTS,
  createIssArticulation,
} from './issArticulation.js';
import {
  issTelemetryLatestEpoch,
  ISS_TELEMETRY_ALPHA,
  ISS_TELEMETRY_BETA,
  ISS_TELEMETRY_FRESH_MS,
  ISS_TELEMETRY_GAMMA,
  ISS_TELEMETRY_POLL_MS,
  ISS_TELEMETRY_URL,
  createIssTelemetryFeed,
  issTelemetryDishDirection,
  issTelemetryPose,
} from './issTelemetry.js';

// The joint driver asks Cesium for the Earth's orientation, which loads data
// over the network; without it Cesium's own fallback is used, as in the app
// before that data arrives.
const realIcrf = Cesium.Transforms.computeIcrfToFixedMatrix;
before(() => {
  Cesium.Transforms.computeIcrfToFixedMatrix = () => undefined;
});
after(() => {
  Cesium.Transforms.computeIcrfToFixedMatrix = realIcrf;
});

const DEG = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angleDeg = (a, b) =>
  Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) / DEG;

/**
 * Two moments recorded from the feed on 13 November 2026, eleven minutes
 * apart. `sun` and `relayDirection` are on the model's axes (port, zenith,
 * forward), worked out from the station's own position and attitude in the
 * same feed; the relay is the TDRS satellite the dish was aimed at.
 */
const RECORDED = [
  {
    items: {
      S0000004: [306.2512, 0],
      S0000003: [53.7878, 0],
      P4000007: [161.5045, 0],
      P4000008: [198.4406, 0],
      P6000008: [202.9449, 0],
      P6000007: [161.0541, 0],
      S4000007: [18.7427, 0],
      S4000008: [341.3068, 0],
      S6000008: [341.7682, 0],
      S6000007: [18.8361, 0],
      S0000002: [15.1868, 0],
      S0000001: [24.8383, 0],
      Z1000014: [-8.4924, 0],
      Z1000015: [-31.6077, 0],
    },
    sun: [0.45411, 0.5286, -0.7172],
    relayDirection: [-0.5264, 0.84041, 0.12893],
  },
  {
    items: {
      S0000004: [262.0807, 0],
      S0000003: [97.9968, 0],
      P4000007: [161.8451, 0],
      P4000008: [198.2867, 0],
      P6000008: [202.8131, 0],
      P6000007: [161.4166, 0],
      S4000007: [18.6932, 0],
      S4000008: [341.7902, 0],
      S6000008: [341.6089, 0],
      S6000007: [18.4076, 0],
      S0000002: [15.1923, 0],
      S0000001: [24.8383, 0],
      Z1000014: [39.5837, 0],
      Z1000015: [-30.1135, 0],
    },
    sun: [0.45807, -0.12024, -0.88075],
    relayDirection: [-0.50436, 0.66714, -0.54822],
  },
];

/**
 * An array's cell-side normal on the model's axes: ±X at rest, turned about
 * the mast (Z) by beta, then about the truss (X) by alpha.
 */
function cellNormal(face, alpha, beta) {
  const x = face * Math.cos(beta);
  const y = face * Math.sin(beta);
  return [x, Math.cos(alpha) * y, Math.sin(alpha) * y];
}

test('the joint lists line up with the model joints they drive', () => {
  assert.equal(ISS_TELEMETRY_ALPHA.length, ISS_ALPHA_JOINTS.length);
  assert.equal(ISS_TELEMETRY_BETA.length, ISS_BETA_JOINTS.length);
  assert.equal(ISS_TELEMETRY_GAMMA.length, ISS_RADIATOR_JOINTS.length);
  const items = [
    ...ISS_TELEMETRY_ALPHA,
    ...ISS_TELEMETRY_BETA,
    ...ISS_TELEMETRY_GAMMA,
  ].map(({ item }) => item);
  assert.equal(new Set(items).size, items.length, 'no item drives two joints');
});

test('recorded telemetry turns every array toward where the Sun was', () => {
  for (const { items, sun } of RECORDED) {
    const pose = issTelemetryPose(items);
    ISS_BETA_JOINTS.forEach(({ node, face }, i) => {
      const alpha = pose.alpha[node.startsWith('PORT') ? 0 : 1];
      const off = angleDeg(cellNormal(face, alpha, pose.beta[i]), sun);
      // The real arrays were held 5° to 9° off the Sun.
      assert.ok(off < 11, `${node} is ${off.toFixed(1)}° off the Sun`);
    });
  }
});

test('the other sign on any joint turns its arrays away from the Sun', () => {
  const { items, sun } = RECORDED[0];
  const pose = issTelemetryPose(items);
  ISS_BETA_JOINTS.forEach(({ node, face }, i) => {
    const alpha = pose.alpha[node.startsWith('PORT') ? 0 : 1];
    // Beta with the opposite sign about its 90° zero.
    const flipped = Math.PI - pose.beta[i];
    assert.ok(angleDeg(cellNormal(face, alpha, flipped), sun) > 35, node);
    // Alpha with the opposite sign.
    assert.ok(angleDeg(cellNormal(face, -alpha, pose.beta[i]), sun) > 35, node);
  });
});

test('the recorded dish angles point at the relay satellite', () => {
  for (const { items, relayDirection } of RECORDED) {
    const { dish } = issTelemetryPose(items);
    assert.ok(Math.abs(Math.hypot(...dish) - 1) < 1e-9);
    assert.ok(angleDeg(dish, relayDirection) < 0.5);
  }
  // At rest it looks at the zenith; cross-elevation leans to port,
  // elevation tips aft.
  assert.ok(angleDeg(issTelemetryDishDirection(0, 0), [0, 1, 0]) < 1e-6);
  assert.ok(issTelemetryDishDirection(0, 30)[0] > 0);
  assert.ok(issTelemetryDishDirection(30, 0)[2] < 0);
});

test('a snapshot missing a joint gives no pose; missing dish angles give no dish', () => {
  const { items } = RECORDED[0];
  assert.equal(issTelemetryPose(null), null);
  assert.equal(issTelemetryPose({}), null);
  for (const item of ['S0000004', 'P6000007', 'S0000001']) {
    const partial = { ...items };
    delete partial[item];
    assert.equal(issTelemetryPose(partial), null, item);
  }
  assert.equal(
    issTelemetryPose({ ...items, S0000003: ['x', 0] }),
    null,
    'a value that is not a number',
  );
  const noDish = { ...items };
  delete noDish.Z1000015;
  const pose = issTelemetryPose(noDish);
  assert.equal(pose.dish, null);
  assert.equal(pose.beta.length, 8);
});

/** A hand-moved clock with the timers set on it. */
function fakeTime() {
  const time = { ms: 1_000_000 };
  let timers = [];
  let nextId = 1;
  return {
    now: () => time.ms,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.push({ id, at: time.ms + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers = timers.filter((timer) => timer.id !== id);
    },
    /** Move the clock on, running timers as they fall due. */
    async advance(ms) {
      const end = time.ms + ms;
      for (;;) {
        // Let a finished request schedule its next timer first.
        await new Promise((resolve) => setImmediate(resolve));
        const due = timers
          .filter((timer) => timer.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        time.ms = Math.max(time.ms, due.at);
        due.fn();
      }
      time.ms = end;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** A fetch that answers from a queue of bodies (or throws for an Error). */
function fakeFetch(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    return { ok: true, json: async () => answer };
  };
  return { fetchImpl, calls };
}

const LIVE = { configured: true, status: 'live', items: RECORDED[0].items };

test('the feed asks only while the model is drawn, every five seconds', async () => {
  const time = fakeTime();
  const { fetchImpl, calls } = fakeFetch([LIVE]);
  const feed = createIssTelemetryFeed({ fetchImpl, ...time });
  await time.advance(60_000);
  assert.equal(calls.length, 0, 'nothing is asked before the model shows');

  feed.touch();
  await time.advance(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ISS_TELEMETRY_URL);
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(feed.configured(), true);
  assert.deepEqual(feed.pose(), issTelemetryPose(RECORDED[0].items));

  // Drawn for another 12 s: two more requests.
  for (let i = 0; i < 12; i++) {
    feed.touch();
    await time.advance(1000);
  }
  assert.equal(calls.length, 1 + Math.floor(12_000 / ISS_TELEMETRY_POLL_MS));

  // Not drawn any more: it stops by itself, and the pose goes stale.
  const drawn = calls.length;
  await time.advance(60_000);
  assert.ok(calls.length <= drawn + 2);
  assert.equal(feed.pose(), null);
  const settled = calls.length;
  await time.advance(60_000);
  assert.equal(calls.length, settled);
});

test('a relay that is switched off is asked once and never again', async () => {
  const time = fakeTime();
  const { fetchImpl, calls } = fakeFetch([{ configured: false }]);
  const feed = createIssTelemetryFeed({ fetchImpl, ...time });
  for (let i = 0; i < 30; i++) {
    feed.touch();
    await time.advance(1000);
  }
  assert.equal(calls.length, 1);
  assert.equal(feed.configured(), false);
  assert.equal(feed.pose(), null);
});

test('no signal, a failed request or an old answer all give no pose', async () => {
  const time = fakeTime();
  const { fetchImpl, calls } = fakeFetch([
    LIVE,
    { configured: true, status: 'no-signal', items: RECORDED[0].items },
    LIVE,
    new Error('offline'),
  ]);
  const feed = createIssTelemetryFeed({ fetchImpl, ...time });
  const drawFor = async (ms) => {
    for (let t = 0; t < ms; t += 1000) {
      feed.touch();
      await time.advance(1000);
    }
  };
  await drawFor(1000);
  assert.ok(feed.pose());
  await drawFor(ISS_TELEMETRY_POLL_MS);
  assert.equal(feed.pose(), null, 'no signal');
  await drawFor(ISS_TELEMETRY_POLL_MS);
  assert.ok(feed.pose(), 'signal back');
  // Requests now fail: the last pose is used until it is 20 s old, and the
  // feed asks less often.
  const failingFrom = calls.length;
  await drawFor(ISS_TELEMETRY_FRESH_MS - ISS_TELEMETRY_POLL_MS - 1000);
  assert.ok(feed.pose());
  await drawFor(ISS_TELEMETRY_POLL_MS + 2000);
  assert.equal(feed.pose(), null, 'too old');
  await drawFor(60_000);
  assert.ok(calls.length - failingFrom <= 4, 'failures are retried slowly');
});

test('destroy stops the feed, even with a request in flight', async () => {
  const time = fakeTime();
  let release;
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(url);
    return new Promise((resolve) => {
      release = () => resolve({ ok: true, json: async () => LIVE });
    });
  };
  const feed = createIssTelemetryFeed({ fetchImpl, ...time });
  feed.touch();
  await time.advance(0);
  assert.equal(calls.length, 1);
  feed.destroy();
  release();
  await time.advance(60_000);
  assert.equal(feed.pose(), null);
  assert.equal(calls.length, 1);
});

/**
 * A stand-in for the loaded model: named nodes that keep a copy of the
 * matrix written to them, as a Cesium node does.
 */
function fakeModel() {
  const nodes = new Map();
  return {
    ready: true,
    getNode(name) {
      if (!nodes.has(name)) {
        let copy = null;
        nodes.set(name, {
          name,
          get matrix() {
            return copy;
          },
          set matrix(value) {
            copy = Array.from(value);
          },
        });
      }
      return nodes.get(name);
    },
    matrixOf(name) {
      return nodes.get(name)?.matrix ?? null;
    },
  };
}

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const POSITION = { x: 6_800_000, y: 0, z: 0 };

test('with a telemetry pose the joints take its angles, each side its own', () => {
  const articulation = createIssArticulation();
  const model = fakeModel();
  const pose = issTelemetryPose(RECORDED[0].items);
  articulation.setTelemetry(() => pose);
  articulation.update(
    model,
    new Date(Date.UTC(2026, 10, 13, 11, 8)),
    POSITION,
    AXES,
    1000,
  );
  assert.equal(articulation.isLive(), true);

  // The alpha joints turn about X by the pose's angle: port and starboard differ.
  ISS_ALPHA_JOINTS.forEach(({ node }, i) => {
    const m = model.matrixOf(node);
    assert.ok(Math.abs(m[5] - Math.cos(pose.alpha[i])) < 1e-9, node);
    assert.ok(Math.abs(m[6] - Math.sin(pose.alpha[i])) < 1e-9, node);
  });
  assert.notDeepEqual(
    model.matrixOf(ISS_ALPHA_JOINTS[0].node),
    model.matrixOf(ISS_ALPHA_JOINTS[1].node),
  );
  ISS_BETA_JOINTS.forEach(({ node }, i) => {
    const m = model.matrixOf(node);
    assert.ok(Math.abs(m[0] - Math.cos(pose.beta[i])) < 1e-9, node);
    assert.ok(Math.abs(m[1] - Math.sin(pose.beta[i])) < 1e-9, node);
  });
  ISS_RADIATOR_JOINTS.forEach(({ node }, i) => {
    const m = model.matrixOf(node);
    assert.ok(Math.abs(m[0] - Math.cos(pose.gamma[i])) < 1e-9, node);
  });
  // The first dish takes the reported aim (its rest boresight, +Y, turned
  // onto it); the second is left where it was.
  const dish = model.matrixOf(ISS_DISH_JOINTS[0].node);
  assert.ok(angleDeg([dish[4], dish[5], dish[6]], pose.dish) < 1e-4);
  const second = model.matrixOf(ISS_DISH_JOINTS[1].node);
  assert.ok(angleDeg([second[4], second[5], second[6]], [0, 1, 0]) < 1e-4);
});

test('without a pose, or in Manual, the joints keep their computed rules', () => {
  const date = new Date(Date.UTC(2026, 10, 13, 11, 8));
  const computed = fakeModel();
  createIssArticulation().update(computed, date, POSITION, AXES, 1000);

  // Telemetry with nothing to say.
  const silent = createIssArticulation();
  silent.setTelemetry(() => null);
  const silentModel = fakeModel();
  silent.update(silentModel, date, POSITION, AXES, 1000);
  assert.equal(silent.isLive(), false);

  // Telemetry with a pose, but the command panel is on Manual.
  const manual = createIssArticulation();
  manual.setTelemetry(() => issTelemetryPose(RECORDED[0].items));
  manual.setTelemetryAllowed(false);
  const manualModel = fakeModel();
  manual.update(manualModel, date, POSITION, AXES, 1000);
  assert.equal(manual.isLive(), false);

  // A Sun chosen by hand is computed too.
  const forced = createIssArticulation();
  forced.setTelemetry(() => issTelemetryPose(RECORDED[0].items));
  forced.setOverride(() => ({ sun: [0, 1, 0], sunlit: true }));
  forced.update(fakeModel(), date, POSITION, AXES, 1000);
  assert.equal(forced.isLive(), false);

  for (const { node } of [
    ...ISS_ALPHA_JOINTS,
    ...ISS_BETA_JOINTS,
    ...ISS_RADIATOR_JOINTS,
  ]) {
    assert.deepEqual(silentModel.matrixOf(node), computed.matrixOf(node), node);
    assert.deepEqual(manualModel.matrixOf(node), computed.matrixOf(node), node);
  }

  // Back to Automatic: the pose is used again, gliding at the joint rate.
  manual.setTelemetryAllowed(true);
  manual.update(manualModel, date, POSITION, AXES, 1100);
  assert.equal(manual.isLive(), true);
});

test('a page that opens during a loss of signal learns when the feed last had data', async () => {
  const time = fakeTime();
  // The recording carries no times; date every item the same.
  const dated = Object.fromEntries(
    Object.entries(RECORDED[0].items).map(([key, [value]]) => [
      key,
      [value, 1_700_000_000_000],
    ]),
  );
  const noSignal = {
    configured: true,
    status: 'no-signal',
    items: dated,
  };
  const { fetchImpl } = fakeFetch([noSignal, noSignal]);
  const feed = createIssTelemetryFeed({ fetchImpl, ...time });
  feed.touch();
  await time.advance(1000);
  const status = feed.status();
  assert.equal(status.state, 'no-signal');
  assert.equal(status.poseAgeMs, null);
  const latest = issTelemetryLatestEpoch(dated);
  assert.ok(Number.isFinite(latest) && latest > 0);
  assert.equal(status.liveUntilMs, latest);
  feed.destroy();
});

test('the latest epoch is the newest dated item, and nothing without one', () => {
  assert.equal(
    issTelemetryLatestEpoch({ a: [1, 100], b: [2, 300], c: [3, 200] }),
    300,
  );
  assert.equal(issTelemetryLatestEpoch({ a: [1, 'x'], b: 5, c: [2, 0] }), null);
  assert.equal(issTelemetryLatestEpoch({}), null);
  assert.equal(issTelemetryLatestEpoch(null), null);
});
