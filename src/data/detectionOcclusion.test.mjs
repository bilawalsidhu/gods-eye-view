import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DepthSnapshot,
  SURFACE_FIRST_ANSWER_MS,
  SURFACE_FORGET_MS,
  SURFACE_MAX_FRAME_STEP_MS,
  SURFACE_OCCLUSION_MIN_MARGIN_M,
  SURFACE_REAPPEAR_MS,
  SURFACE_RETEST_MS,
  SurfaceOcclusion,
  depthToViewDistance,
  projectContact,
  surfaceHidesContact,
  surfaceOcclusionMargin,
  unpackDepth,
} from './detectionOcclusion.js';
import {
  depthImage,
  packDepth,
  viewDistanceToDepth,
} from './fixtures/fakeDepthScene.mjs';

test('the margin is 3 m near the camera and 2% of the range beyond 150 m', () => {
  assert.equal(surfaceOcclusionMargin(10), SURFACE_OCCLUSION_MIN_MARGIN_M);
  assert.equal(surfaceOcclusionMargin(150), 3);
  assert.equal(surfaceOcclusionMargin(500), 10);
  assert.equal(surfaceOcclusionMargin(5000), 100);
  assert.equal(surfaceOcclusionMargin(0), 3);
  assert.equal(surfaceOcclusionMargin(Number.NaN), 3);
});

test('a surface hides a contact only when nearer by more than the margin', () => {
  // 500 m away: margin 10 m.
  assert.equal(surfaceHidesContact(500, 489), true, 'a facade 11 m in front');
  assert.equal(surfaceHidesContact(500, 491), false, 'its own road or dot');
  assert.equal(surfaceHidesContact(500, 500), false);
  assert.equal(surfaceHidesContact(500, 520), false, 'the ground behind it');
  // Close range keeps the 3 m floor.
  assert.equal(surfaceHidesContact(60, 56), true);
  assert.equal(surfaceHidesContact(60, 58), false);
});

test('nothing drawn, or no distance, never hides a contact', () => {
  assert.equal(surfaceHidesContact(500, undefined), false);
  assert.equal(surfaceHidesContact(500, Number.NaN), false);
  assert.equal(surfaceHidesContact(Number.NaN, 10), false);
});

test('packed depth unpacks most significant byte first', () => {
  assert.equal(unpackDepth([0, 0, 0, 0], 0), 0);
  assert.equal(unpackDepth([255, 0, 0, 0], 0), 1);
  assert.equal(unpackDepth([9, 9, 51, 0, 0, 0], 2), 0.2);
  for (const depth of [0.000123, 0.25, 0.5, 0.987654321]) {
    const round = unpackDepth(packDepth(depth), 0);
    assert.ok(Math.abs(round - depth) < 1e-9, `${depth} -> ${round}`);
  }
});

test('logarithmic depth decodes to metres in front of the camera', () => {
  const near = 0.1;
  const far = 10_000_000;
  // depth = log2(z - near + 1) / log2(far - near + 1)
  for (const z of [0.5, 12, 480, 25_000, 3_000_000]) {
    const depth = Math.log2(z - near + 1) / Math.log2(far - near + 1);
    const decoded = depthToViewDistance(depth, near, far, true);
    assert.ok(Math.abs(decoded - z) / z < 1e-9, `${z} -> ${decoded}`);
  }
});

test('standard perspective depth decodes to metres in front of the camera', () => {
  const near = 1;
  const far = 5000;
  // depth = far * (z - near) / (z * (far - near))
  for (const z of [1.5, 40, 900, 4999]) {
    const depth = (far * (z - near)) / (z * (far - near));
    const decoded = depthToViewDistance(depth, near, far, false);
    assert.ok(Math.abs(decoded - z) / z < 1e-9, `${z} -> ${decoded}`);
  }
  assert.ok(
    Math.abs(depthToViewDistance(0.5, 1, 5000, false) - 10000 / 5001) < 1e-9,
    'half depth sits just past twice the near plane',
  );
});

test('the ends of the depth range, and a bad range, mean nothing was drawn', () => {
  for (const log of [true, false]) {
    assert.ok(Number.isNaN(depthToViewDistance(0, 1, 100, log)));
    assert.ok(Number.isNaN(depthToViewDistance(1, 1, 100, log)));
    assert.ok(Number.isNaN(depthToViewDistance(Number.NaN, 1, 100, log)));
    assert.ok(Number.isNaN(depthToViewDistance(0.5, 0, 100, log)));
    assert.ok(Number.isNaN(depthToViewDistance(0.5, 100, 100, log)));
  }
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A point `distance` metres ahead, `side` of the way to the frame edge. */
const ahead = (distance, side = 0, up = 0) => ({
  x: side * distance,
  y: up * distance,
  z: -distance,
});

test('a contact projects to its place in the frame, from the bottom-left corner', () => {
  const out = { u: -1, v: -1, threshold: -1 };
  // 90 degree field of view: the frame edge is as far out as the point is ahead.
  assert.equal(projectContact(IDENTITY, 1, 1, ahead(500), out), true);
  assert.deepEqual([out.u, out.v], [0.5, 0.5]);
  assert.equal(
    projectContact(IDENTITY, 1, 1, ahead(500, -0.5, 0.5), out),
    true,
  );
  assert.deepEqual([out.u, out.v], [0.25, 0.75]);
  // A wider horizontal field of view pulls the same point towards the middle.
  assert.equal(
    projectContact(IDENTITY, 2, 1, ahead(500, -0.5, 0.5), out),
    true,
  );
  assert.deepEqual([out.u, out.v], [0.375, 0.75]);
});

test('the threshold is the margin rule restated as a view distance', () => {
  const out = { u: 0, v: 0, threshold: 0 };
  // Straight ahead, distance and view distance are the same thing.
  projectContact(IDENTITY, 1, 1, ahead(500), out);
  assert.ok(Math.abs(out.threshold - 490) < 1e-9, '500 m less 2%');
  projectContact(IDENTITY, 1, 1, ahead(60), out);
  assert.ok(Math.abs(out.threshold - 57) < 1e-9, '60 m less the 3 m floor');
  // Off axis the ray is longer than the view distance; the rule holds along
  // the ray, so a surface at view distance d sits d * range / viewDistance out.
  const corner = ahead(400, -0.9, 0.9);
  const range = Math.hypot(corner.x, corner.y, corner.z);
  projectContact(IDENTITY, 1, 1, corner, out);
  for (const surfaceView of [out.threshold - 0.01, out.threshold + 0.01]) {
    const alongRay = (surfaceView * range) / 400;
    assert.equal(
      surfaceHidesContact(range, alongRay),
      surfaceView < out.threshold,
    );
  }
  assert.ok(Math.abs(out.threshold - 400 * 0.98) < 1e-9);
});

test('behind the camera or outside the frame there is nothing to test', () => {
  const out = { u: 7, v: 7, threshold: 7 };
  assert.equal(
    projectContact(IDENTITY, 1, 1, { x: 0, y: 0, z: 500 }, out),
    false,
  );
  assert.equal(
    projectContact(IDENTITY, 1, 1, { x: 0, y: 0, z: 0 }, out),
    false,
  );
  assert.equal(projectContact(IDENTITY, 1, 1, ahead(500, -1.2), out), false);
  assert.equal(projectContact(IDENTITY, 1, 1, ahead(500, 0, 1.01), out), false);
  assert.equal(
    projectContact(IDENTITY, 1, 1, ahead(500, 1), out),
    false,
    'u = 1',
  );
  assert.deepEqual(out, { u: 7, v: 7, threshold: 7 }, 'left untouched');
});

test('a contact is projected with the camera it is given', () => {
  // Camera 1000 m up the +Z axis looking down -Z: view = translate(0, 0, -1000).
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1000, 1];
  const out = { u: 0, v: 0, threshold: 0 };
  assert.equal(
    projectContact(view, 1, 1, { x: -250, y: 0, z: 500 }, out),
    true,
  );
  assert.equal(out.u, 0.25);
  assert.equal(projectContact(view, 1, 1, { x: 0, y: 0, z: 1500 }, out), false);
});

/**
 * A snapshot from a camera at the origin looking down -Z with a 90 degree
 * field of view. By default one depth range in which the left half of the
 * frame is a wall `wall` metres away and the right half is ground `ground`
 * metres away.
 */
function snapshotWithWall({
  wall = 400,
  ground = 500,
  logDepth = true,
  size = 8,
  frustums,
  images,
} = {}) {
  const ranges = frustums || [{ near: 1, far: 100_000 }];
  const layers = images || [
    depthImage(size, size, (column) =>
      viewDistanceToDepth(
        column < size / 2 ? wall : ground,
        ranges[0].near,
        ranges[0].far,
        logDepth,
      ),
    ),
  ];
  const bytes = new Uint8Array(size * size * 4 * layers.length);
  layers.forEach((image, i) => bytes.set(image.data, i * size * size * 4));
  return new DepthSnapshot({
    width: size,
    height: size,
    bytes,
    frustums: ranges,
    logDepth,
    view: IDENTITY,
    tanHalfFovX: 1,
    tanHalfFovY: 1,
  });
}

test('a contact behind a drawn wall is hidden; one on drawn ground, or in front of the wall, is not', () => {
  for (const logDepth of [true, false]) {
    const snapshot = snapshotWithWall({ logDepth });
    assert.equal(snapshot.hides(ahead(500, -0.5)), true);
    assert.equal(snapshot.hides(ahead(500, 0.5)), false);
    assert.equal(snapshot.hides(ahead(300, -0.5)), false);
    // 2% of 405 m is 8.1 m: 5 m behind the wall is still the wall's own face.
    assert.equal(snapshot.hides(ahead(405, -0.5)), false);
    assert.equal(snapshot.hides(ahead(412, -0.5)), true);
    assert.equal(snapshot.hides(ahead(500, -1.5)), null, 'outside the frame');
  }
});

test('rows are read bottom to top', () => {
  const size = 8;
  const image = depthImage(size, size, (_column, row) =>
    viewDistanceToDepth(row < size / 2 ? 400 : 500, 1, 100_000, true),
  );
  const snapshot = snapshotWithWall({ images: [image] });
  assert.equal(snapshot.hides(ahead(500, 0, -0.5)), true, 'below centre');
  assert.equal(snapshot.hides(ahead(500, 0, 0.5)), false, 'above centre');
});

test('the nearest depth range that drew something answers', () => {
  const size = 4;
  const frustums = [
    { near: 1, far: 1000 },
    { near: 999, far: 1_000_000 },
  ];
  // Near range: a wall 400 m away on the left, nothing on the right.
  const nearImage = depthImage(size, size, (column) =>
    column < 2 ? viewDistanceToDepth(400, 1, 1000, true) : 1,
  );
  // Far range: ground 20 km away everywhere.
  const farImage = depthImage(size, size, () =>
    viewDistanceToDepth(20_000, 999, 1_000_000, true),
  );
  const snapshot = snapshotWithWall({
    size,
    frustums,
    images: [nearImage, farImage],
  });
  assert.ok(Math.abs(snapshot.surfaceViewDistance(0, 0) - 400) < 0.01);
  assert.ok(Math.abs(snapshot.surfaceViewDistance(3, 0) - 20_000) < 1);
  assert.equal(snapshot.hides(ahead(15_000, -0.5)), true);
  assert.equal(snapshot.hides(ahead(15_000, 0.5)), false);
  assert.equal(snapshot.hides(ahead(30_000, 0.5)), true);
});

test('where nothing was drawn a contact is visible', () => {
  const size = 4;
  const snapshot = snapshotWithWall({
    size,
    images: [depthImage(size, size, () => 1)],
  });
  assert.ok(Number.isNaN(snapshot.surfaceViewDistance(1, 1)));
  assert.equal(snapshot.hides(ahead(500)), false);
});

/**
 * A probe that answers when told to. `hidden` decides each test's answer at
 * the time it is resolved.
 */
function manualProbe() {
  const inFlight = [];
  return {
    accepting: true,
    started: 0,
    inFlight,
    add(contact) {
      if (!this.accepting) return false;
      this.started++;
      contact.pending = true;
      inFlight.push(contact);
      return true;
    },
    /** Deliver every answer in flight. */
    answer(hidden, now) {
      for (const contact of inFlight.splice(0)) {
        contact.pending = false;
        contact.answered = true;
        if (hidden) contact.lastHiddenAt = now;
      }
    },
  };
}

const anywhere = { x: 0, y: 0, z: -500 };

test('a contact is drawn until an answer says it is hidden, then hidden at once', () => {
  const probe = manualProbe();
  const occlusion = new SurfaceOcclusion(probe);
  occlusion.beginFrame(1000);
  assert.equal(occlusion.isHidden('traffic', 'a', anywhere), false);
  assert.equal(probe.started, 1, 'a new contact is tested straight away');
  occlusion.beginFrame(1016);
  assert.equal(occlusion.isHidden('traffic', 'a', anywhere), false);
  assert.equal(probe.started, 1, 'one test in flight per contact');
  probe.answer(true, occlusion.now);
  occlusion.beginFrame(1032);
  assert.equal(occlusion.isHidden('traffic', 'a', anywhere), true);
  assert.equal(occlusion.testedCount, 1);
  assert.equal(occlusion.hiddenCount, 1);
  // The same source id on another layer is another contact.
  assert.equal(occlusion.isHidden('transit', 'a', anywhere), false);
});

test('with a working probe a new contact is held back until its first answer, and no longer than the limit', () => {
  const probe = manualProbe();
  probe.mode = 'async';
  const occlusion = new SurfaceOcclusion(probe);
  occlusion.beginFrame(0);
  // New to the view: tested at once, and not drawn while the answer is out.
  assert.equal(occlusion.isHidden('traffic', 'street', anywhere), true);
  assert.equal(occlusion.isHidden('traffic', 'roofed', anywhere), true);
  assert.equal(occlusion.isHidden('traffic', 'unanswered', anywhere), true);
  assert.equal(probe.started, 3);
  const [street, roofed] = probe.inFlight.splice(0, 2);
  street.pending = false;
  street.answered = true;
  roofed.pending = false;
  roofed.answered = true;
  roofed.lastHiddenAt = occlusion.now;
  occlusion.beginFrame(16);
  assert.equal(
    occlusion.isHidden('traffic', 'street', anywhere),
    false,
    'drawn from its first answer',
  );
  assert.equal(
    occlusion.isHidden('traffic', 'roofed', anywhere),
    true,
    'never drawn at all',
  );
  // The third answer never comes. It is drawn once the limit has passed.
  const firstSeen = occlusion.now - 16;
  const drawn = [];
  for (let wall = 32; wall < 1000; wall += 16) {
    occlusion.beginFrame(wall);
    drawn.push([
      occlusion.now - firstSeen,
      !occlusion.isHidden('traffic', 'unanswered', anywhere),
    ]);
  }
  for (const [age, shown] of drawn)
    assert.equal(shown, age >= SURFACE_FIRST_ANSWER_MS, `at ${age} ms`);

  // No working probe: a new contact is drawn at once, as before.
  for (const mode of ['off', 'sync', undefined]) {
    const idle = manualProbe();
    idle.mode = mode;
    const plain = new SurfaceOcclusion(idle);
    plain.beginFrame(0);
    assert.equal(plain.isHidden('traffic', 'a', anywhere), false, String(mode));
  }
});

test('a contact is retested at most every retest interval and at least every half of it', () => {
  const probe = manualProbe();
  const occlusion = new SurfaceOcclusion(probe);
  const starts = [];
  let before = 0;
  for (let now = 0; now <= 2000; now += 4) {
    probe.answer(false, now);
    occlusion.beginFrame(now);
    occlusion.isHidden('traffic', 'a', anywhere);
    if (probe.started !== before) {
      starts.push(now);
      before = probe.started;
    }
  }
  const gaps = starts.slice(1).map((at, i) => at - starts[i]);
  assert.ok(gaps.length >= 9);
  assert.ok(
    gaps.every((gap) => gap <= SURFACE_RETEST_MS),
    `${gaps}`,
  );
  assert.ok(
    gaps.every((gap) => gap >= SURFACE_RETEST_MS / 2),
    `${gaps}`,
  );
  assert.ok(new Set(gaps).size > 3, 'not all on the same beat');
});

test('contacts that appear together drift apart instead of all testing on the same frames', () => {
  const probe = manualProbe();
  const occlusion = new SurfaceOcclusion(probe);
  const perFrame = [];
  for (let frame = 0; frame < 240; frame++) {
    const now = frame * 16;
    probe.answer(false, now);
    occlusion.beginFrame(now);
    const before = probe.started;
    for (let id = 0; id < 600; id++)
      occlusion.isHidden('traffic', id, anywhere);
    perFrame.push(probe.started - before);
  }
  assert.equal(perFrame[0], 600, 'every new contact is tested at once');
  const settled = perFrame.slice(120);
  assert.ok(Math.max(...settled) < 200, `peak ${Math.max(...settled)}`);
  assert.ok(Math.min(...settled) > 0);
});

test('with more contacts than the probe takes per frame, the retests slow down and none is starved', () => {
  // A probe that takes 256 tests a frame, 2,400 contacts in view, 30 fps.
  const inFlight = [];
  let taken = 0;
  const probe = {
    maxPerFrame: 256,
    add(contact) {
      if (taken >= 256) return false;
      taken++;
      contact.pending = true;
      inFlight.push(contact);
      return true;
    },
  };
  const occlusion = new SurfaceOcclusion(probe);
  const tests = new Array(2400).fill(0);
  const lastStart = new Array(2400).fill(0);
  let longestGap = 0;
  for (let frame = 0; frame < 300; frame++) {
    const now = frame * 33;
    for (const contact of inFlight.splice(0)) contact.pending = false;
    taken = 0;
    occlusion.beginFrame(now);
    for (let id = 0; id < 2400; id++) {
      const before = taken;
      occlusion.isHidden('traffic', id, anywhere);
      if (taken !== before) {
        tests[id]++;
        if (frame > 60) longestGap = Math.max(longestGap, now - lastStart[id]);
        lastStart[id] = now;
      }
    }
  }
  assert.ok(
    Math.min(...tests) >= 8,
    `fewest tests for one contact: ${Math.min(...tests)}`,
  );
  assert.ok(occlusion.retestMs > SURFACE_RETEST_MS);
  assert.ok(longestGap <= occlusion.retestMs + 33, `longest gap ${longestGap}`);
  assert.ok(occlusion.reappearMs >= 3 * occlusion.retestMs);
  // A view the budget covers easily keeps the normal pace.
  const few = new SurfaceOcclusion(probe);
  for (let frame = 0; frame < 10; frame++) {
    taken = 0;
    few.beginFrame(frame * 16);
    for (let id = 0; id < 300; id++) few.isHidden('traffic', id, anywhere);
  }
  assert.equal(few.retestMs, SURFACE_RETEST_MS);
  assert.equal(few.reappearMs, SURFACE_REAPPEAR_MS);
});

test('a hidden contact comes back only after the reappear time without a hidden answer', () => {
  const probe = manualProbe();
  const occlusion = new SurfaceOcclusion(probe);
  occlusion.beginFrame(0);
  occlusion.isHidden('traffic', 'a', anywhere);
  const hiddenAt = occlusion.now;
  probe.answer(true, hiddenAt);
  // Visible answers from now on; the contact still waits out the time.
  let reappeared = null;
  for (let wall = 16; wall < 2000 && reappeared === null; wall += 16) {
    probe.answer(false, occlusion.now);
    occlusion.beginFrame(wall);
    if (!occlusion.isHidden('traffic', 'a', anywhere))
      reappeared = occlusion.now;
  }
  assert.ok(reappeared - hiddenAt >= SURFACE_REAPPEAR_MS);
  assert.ok(reappeared - hiddenAt < SURFACE_REAPPEAR_MS + 17);
});

test('a contact on an edge, answering either way in turn, stays hidden', () => {
  const probe = manualProbe();
  const occlusion = new SurfaceOcclusion(probe);
  const drawn = [];
  let answers = 0;
  for (let wall = 0; wall < 4000; wall += 16) {
    if (probe.inFlight.length > 0)
      probe.answer(answers++ % 2 === 0, occlusion.now);
    occlusion.beginFrame(wall);
    drawn.push(!occlusion.isHidden('traffic', 'a', anywhere));
  }
  // Drawn only until the first answer arrives.
  assert.equal(drawn.lastIndexOf(true), 0);
});

test('when the probe stops answering, hidden contacts are drawn again and stay drawn', () => {
  const probe = manualProbe();
  const occlusion = new SurfaceOcclusion(probe);
  occlusion.beginFrame(0);
  occlusion.isHidden('traffic', 'a', anywhere);
  const hiddenAt = occlusion.now;
  probe.answer(true, hiddenAt);
  // No depth any more: the probe takes no tests and answers nothing.
  probe.accepting = false;
  const drawn = [];
  for (let wall = 16; wall < 3000; wall += 16) {
    occlusion.beginFrame(wall);
    drawn.push([
      occlusion.now - hiddenAt,
      !occlusion.isHidden('traffic', 'a', anywhere),
    ]);
  }
  for (const [age, shown] of drawn)
    assert.equal(shown, age >= SURFACE_REAPPEAR_MS, `at ${age} ms`);
  // A probe that never accepted anything hides nothing.
  const dead = new SurfaceOcclusion({ add: () => false });
  dead.beginFrame(0);
  assert.equal(dead.isHidden('traffic', 'a', anywhere), false);
});

test('a change of pace does not bring back a hidden that has run out', () => {
  // 2,400 contacts with a 256-a-frame probe: the hide time is longer at 33 ms
  // frames than at 16 ms ones.
  const inFlight = [];
  let taken = 0;
  const probe = {
    maxPerFrame: 256,
    add(contact) {
      if (taken >= 256) return false;
      taken++;
      contact.pending = true;
      inFlight.push(contact);
      return true;
    },
  };
  const occlusion = new SurfaceOcclusion(probe);
  let wall = 0;
  const paint = (step) => {
    wall += step;
    for (const contact of inFlight.splice(0)) contact.pending = false;
    taken = 0;
    occlusion.beginFrame(wall);
    let watched = false;
    for (let id = 0; id < 2400; id++) {
      const hidden = occlusion.isHidden('traffic', id, anywhere);
      if (id === 0) watched = hidden;
    }
    return watched;
  };
  for (let i = 0; i < 30; i++) paint(16);
  // One hidden answer for contact 0, then visible answers only.
  occlusion.contacts.get('traffic').get(0).lastHiddenAt = occlusion.now;
  const states = [];
  for (let i = 0; i < 80; i++) states.push(paint(16));
  assert.equal(states[0], true);
  assert.equal(states.at(-1), false, 'ran out at the fast pace');
  // The frames slow down, which lengthens the hide time for new answers.
  const slow = [];
  for (let i = 0; i < 40; i++) slow.push(paint(33));
  assert.ok(occlusion.reappearMs > SURFACE_REAPPEAR_MS);
  assert.ok(
    slow.every((hidden) => hidden === false),
    'and stays out',
  );
});

test('a pause in painting does not run the hidden time out', () => {
  const probe = manualProbe();
  const occlusion = new SurfaceOcclusion(probe);
  occlusion.beginFrame(0);
  occlusion.isHidden('traffic', 'a', anywhere);
  probe.answer(true, occlusion.now);
  occlusion.beginFrame(16);
  assert.equal(occlusion.isHidden('traffic', 'a', anywhere), true);
  // Nothing is painted for a minute (a hidden tab, an idle scene). On the
  // first frame back the contact is still hidden: no answer could have come.
  const before = occlusion.now;
  occlusion.beginFrame(60_016);
  assert.equal(occlusion.now - before, SURFACE_MAX_FRAME_STEP_MS);
  assert.equal(occlusion.isHidden('traffic', 'a', anywhere), true);
  // A clock that jumps backwards moves nothing.
  occlusion.beginFrame(100);
  assert.equal(occlusion.now - before, SURFACE_MAX_FRAME_STEP_MS);
});

test('prune forgets contacts that are no longer drawn; clear forgets everything', () => {
  const probe = manualProbe();
  const occlusion = new SurfaceOcclusion(probe);
  let wall = 0;
  /** Paint frames for `ms` of painted time, drawing the given contacts. */
  const paint = (ms, ids) => {
    for (const end = occlusion.now + ms; occlusion.now < end;) {
      wall += 50;
      occlusion.beginFrame(wall);
      for (const id of ids) occlusion.isHidden('traffic', id, anywhere);
    }
  };
  paint(100, ['gone', 'here']);
  paint(SURFACE_FORGET_MS + 50, ['here']);
  occlusion.prune();
  assert.deepEqual([...occlusion.contacts.get('traffic').keys()], ['here']);
  paint(SURFACE_FORGET_MS + 50, []);
  occlusion.prune();
  assert.equal(occlusion.contacts.size, 0);

  occlusion.isHidden('traffic', 'again', anywhere);
  occlusion.clear();
  assert.equal(occlusion.contacts.size, 0);
  assert.equal(occlusion.testedCount, 0);
});
