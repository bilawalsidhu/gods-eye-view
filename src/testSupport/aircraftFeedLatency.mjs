/**
 * The feed-latency checks both aircraft layers run (`flights` and `military`
 * `feedLatency.test.mjs`): a slow feed played through the layer frame by
 * frame, and where its contacts and the tracked trail were drawn judged
 * against where they really were.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceToPath,
  frameSteps,
  placementError,
  runAircraftFeedSim,
  slowFeedPolls,
  truePath,
} from './aircraftFeedSim.mjs';

const SEC = 1000;
const T0 = Date.UTC(2026, 10, 13, 18, 0);
const CONTACTS = 24;
const SPEED_MPS = 130;

/** The sharpest turn (degrees) at any vertex of `line`, steps under 1 m skipped. */
function sharpestTurnDeg(line) {
  let worst = 0;
  for (let i = 1; i < line.length - 1; i++) {
    const a = line[i - 1];
    const b = line[i];
    const c = line[i + 1];
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const lu = Math.hypot(u.x, u.y, u.z);
    const lv = Math.hypot(v.x, v.y, v.z);
    if (lu < 1 || lv < 1) continue;
    const cos = Math.min(1, (u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv));
    worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
  }
  return worst;
}

function run(
  layer,
  pollOptions = {},
  { drop = [], reportedSpeedMps, frameMs } = {},
) {
  const polls = slowFeedPolls({
    startMs: T0,
    count: 30,
    contacts: CONTACTS,
    ...pollOptions,
  }).filter((_, k) => !drop.includes(k));
  return runAircraftFeedSim({
    layer,
    startMs: T0,
    polls,
    untilMs: polls.at(-1).receiptMs + 10 * SEC,
    // From the seventh poll: the delay has settled and the trail has begun.
    measureFromMs: polls[6].receiptMs,
    contacts: CONTACTS,
    reportedSpeedMps,
    ...(frameMs ? { frameMs } : {}),
  });
}

/** Every drawn step of the fleet contact and the tracked one is smooth. */
function assertSmoothMotion(sim) {
  for (const key of ['fleet', 'tracked']) {
    const steps = frameSteps(sim, sim.frames, key, SPEED_MPS);
    assert.equal(steps.jumps, 0, `${key}: ${JSON.stringify(steps)}`);
    assert.equal(steps.stalls, 0, `${key}: ${JSON.stringify(steps)}`);
  }
}

/** The tracked trail is the true path, smooth, and the icon is drawn on it. */
function assertTrail(sim, maxOffPathM) {
  const line = [...sim.body().flat(), ...sim.head()];
  assert.ok(line.length > 30, `${line.length} trail points`);
  const lastMs = sim.frames.at(-1).displayMs;
  const path = truePath(sim, 0, lastMs - 30 * 60 * SEC, lastMs);
  for (const p of sim.body().flat()) {
    const off = distanceToPath(p, path);
    assert.ok(off < maxOffPathM, `trail ${off.toFixed(0)} m off the true path`);
  }
  const turn = sharpestTurnDeg(line);
  assert.ok(turn < 3, `trail turns ${turn.toFixed(1)}° at one vertex`);
  for (const f of sim.frames.slice(-150)) {
    const off = distanceToPath(f.tracked, line);
    assert.ok(off < 3, `tracked icon ${off.toFixed(1)} m off its trail`);
  }
}

/** Register the feed-latency tests for one aircraft layer. */
export function feedLatencyTests(layer, floorSec) {
  test(`${layer}: a feed 90 s late every 30 s is drawn about two minutes behind, every contact between real reports, with no jump or stall`, () => {
    const sim = run(layer);
    assertSmoothMotion(sim);
    for (const f of sim.frames) {
      const delaySec = (f.nowMs - f.displayMs) / SEC;
      assert.ok(delaySec > 120 && delaySec < 140, `${delaySec} s`);
    }
    // Placed between reports: within tens of metres of where it really was,
    // not kilometres of dead reckoning.
    assert.ok(placementError(sim, sim.frames, 'fleet', 1) < 100);
    assert.ok(placementError(sim, sim.frames, 'tracked', 0) < 100);
    assertTrail(sim, 60);
  });

  test(`${layer}: reports that give a speed of 0 still draw the tracked aircraft along its path, with no jump or stall`, () => {
    // The drawn motion is minutes behind the newest report, whose speed may
    // be stale or 0: a jump is judged by the path, not by that speed.
    // At 10 fps a frame moves 13 m, more than a speed of 0 allows.
    const sim = run(layer, {}, { reportedSpeedMps: 0, frameMs: 100 });
    assertSmoothMotion(sim);
    assert.ok(placementError(sim, sim.frames, 'tracked', 0) < 100);
  });

  test(`${layer}: a fresh fallback feed for four polls and reports that do not move on: no jump, no stall, no kink`, () => {
    const sim = run(layer, {
      fallback: [12, 13, 14, 15],
      repeats: [
        [0, 20],
        [1, 20],
        [0, 21],
      ],
    });
    assertSmoothMotion(sim);
    // The switch to the fresh feed leaves two minutes between two reports,
    // the second turn starting 20 s before the later one. Two reports and
    // their tracks cannot say when the turn began: the curve joining them
    // spreads it over the gap, up to about 550 m off the true path.
    assertTrail(sim, 600);
  });

  test(`${layer}: a two-minute outage on a straight leg: contacts coast on at their speed and carry on along their reports`, () => {
    // Polls 9 to 12 never come: the newest reports are from the straight leg
    // after the first turn, and the display passes them a minute in.
    const sim = run(layer, {}, { drop: [9, 10, 11, 12] });
    assertSmoothMotion(sim);
    // Coasting holds its height while the plane descends 1.5 m/s: under two
    // minutes of it.
    assert.ok(placementError(sim, sim.frames, 'fleet', 1) < 200);
    assertTrail(sim, 60);
  });

  test(`${layer}: an outage through a turn no report showed: off by more than 5 km it jumps once onto its reports, as a break; nothing else jumps`, () => {
    // Polls 14 to 17 never come; the second turn starts after the newest
    // report, so the coast flies straight on while the plane turns.
    const sim = run(layer, {}, { drop: [14, 15, 16, 17] });
    for (const key of ['fleet', 'tracked']) {
      const steps = frameSteps(sim, sim.frames, key, SPEED_MPS);
      assert.ok(steps.jumps <= 1, `${key}: ${JSON.stringify(steps)}`);
      assert.ok(
        steps.worstRatio < 1.5 || steps.worstJumpM > 5_000,
        `${key}: a jump under 5 km: ${JSON.stringify(steps)}`,
      );
      assert.equal(steps.stalls, 0, `${key}: ${JSON.stringify(steps)}`);
    }
    assertTrail(sim, 1_500);
  });

  test(`${layer}: a fresh feed is drawn a poll and a few seconds behind, never under the ${floorSec} s floor`, () => {
    const count = 30;
    const intervalSec = floorSec >= 30 ? 30 : 15;
    const sim = run(layer, {
      count,
      fallback: Array.from({ length: count }, (_, k) => k),
      intervalSec,
    });
    // The wait for the next report: a poll interval, plus reports up to 3 s
    // old, plus the 5 s margin.
    for (const f of sim.frames) {
      const delayMs = f.nowMs - f.displayMs;
      assert.ok(delayMs >= floorSec * SEC);
      assert.ok(delayMs <= (intervalSec + 3 + 5 + 1) * SEC, `${delayMs}`);
    }
    assertSmoothMotion(sim);
  });

  test(`${layer}: following the world clock, contacts draw at the world's time and deliveries leave the delay alone`, () => {
    const polls = slowFeedPolls({ startMs: T0, count: 4, contacts: 2 });
    const sim = runAircraftFeedSim({
      layer,
      startMs: T0,
      polls,
      untilMs: polls.at(-1).receiptMs + SEC,
      contacts: 2,
      followsClock: true,
    });
    assert.equal(sim.flightState._displayDelay.currentMs, floorSec * SEC);
    assert.equal(sim.flightState._displayDelay.lagCount, 0);
    for (const f of sim.frames) assert.equal(f.displayMs, f.nowMs);
  });
}
