import assert from 'node:assert/strict';
import test from 'node:test';
import {Checklist,Diagnostics,FrameRate,REDRAW_INTERVAL,STATION_IDS,describeInputSource} from '../src/diagnostics.js';

test('a station stays passed once it has passed', () => {
  const list = new Checklist();
  assert.equal(list.complete('teleport'), true);
  assert.equal(list.complete('teleport'), false, 'a repeat is not a new pass');
  assert.ok(list.isComplete('teleport'));
  assert.equal(list.progress().done, 1);
  assert.ok(!list.pending().some((station) => station.id === 'teleport'));
});

test('an unknown station is a programming error, not a silent no-op', () => {
  assert.throws(() => new Checklist().complete('nope'), /Unknown station/);
});

test('the checklist covers the basics a headset session has to prove', () => {
  for (const id of ['desktop', 'controller-select', 'controller-grab', 'throw', 'teleport', 'teleport-rejected', 'snap-turn', 'hand-grab', 'hand-select', 'haptics', 'mr-placement']) {
    assert.ok(STATION_IDS.includes(id), `missing station ${id}`);
  }
  assert.equal(new Set(STATION_IDS).size, STATION_IDS.length, 'station ids are unique');
});

test('input sources are labelled by what they actually are', () => {
  assert.deepEqual(describeInputSource(null), { connected: false, label: 'not connected' });
  const controller = describeInputSource({ handedness: 'left', targetRayMode: 'tracked-pointer', gamepad: { hapticActuators: [{}] } });
  assert.equal(controller.kind, 'tracked-pointer');
  assert.equal(controller.haptics, true);
  assert.equal(controller.label, 'left · tracked-pointer · gamepad · haptics');
  // A joint-tracked hand reports targetRayMode too; hand presence has to win or every Quest hand
  // would read as a controller.
  assert.equal(describeInputSource({ handedness: 'right', targetRayMode: 'tracked-pointer', hand: {} }).kind, 'hand');
  assert.equal(describeInputSource({ handedness: 'none', targetRayMode: 'transient-pointer' }).kind, 'transient-pointer');
  assert.equal(describeInputSource({ targetRayMode: 'gaze' }).label, 'none · gaze');
  const noHaptics = describeInputSource({ handedness: 'left', targetRayMode: 'tracked-pointer', gamepad: { hapticActuators: [] } });
  assert.equal(noHaptics.haptics, false);
  assert.ok(!noHaptics.label.includes('haptics'));
});

test('frame rate averages over a window and survives a single sample', () => {
  const frames = new FrameRate(4);
  assert.equal(frames.fps, 0);
  frames.push(0);
  assert.equal(frames.fps, 0, 'one timestamp cannot imply a rate');
  for (let i = 1; i <= 6; i++) frames.push(i / 90);
  assert.ok(Math.abs(frames.fps - 90) < 1, `expected ~90 fps, got ${frames.fps}`);
  assert.ok(Math.abs(frames.frameMs - 1000 / 90) < 0.5);
});

test('redraws are throttled off the per-frame path', () => {
  const diagnostics = new Diagnostics();
  assert.equal(diagnostics.shouldRedraw(0), true);
  assert.equal(diagnostics.shouldRedraw(REDRAW_INTERVAL / 2), false);
  assert.equal(diagnostics.shouldRedraw(REDRAW_INTERVAL + 0.001), true);
  // 72 fps for one second must not mean 72 canvas rasterisations.
  let draws = 0;
  const bench = new Diagnostics();
  for (let frame = 0; frame <= 72; frame++) if (bench.shouldRedraw(frame / 72)) draws++;
  assert.ok(draws <= 1 / REDRAW_INTERVAL + 1, `expected at most ~${1 / REDRAW_INTERVAL} draws, got ${draws}`);
});

test('reported lines reflect session state, hand tracking and progress', () => {
  const diagnostics = new Diagnostics();
  const value = (label) => diagnostics.lines().find(([name]) => name === label)?.[1];
  assert.equal(value('Session'), 'desktop');
  assert.equal(value('Reference space'), '—');
  assert.equal(value('Hands'), 'not tracked');

  diagnostics.setSession({ mode: 'immersive-ar', referenceSpace: 'local-floor', hitTest: 'ready' });
  diagnostics.setInputs([{ handedness: 'left', targetRayMode: 'tracked-pointer', gamepad: {} }]);
  diagnostics.setHands([{ distance: 0.0215, pinching: true }, null]);
  assert.equal(value('Session'), 'immersive-ar');
  assert.equal(value('Reference space'), 'local-floor');
  assert.equal(value('Hit test'), 'ready');
  assert.match(value('Inputs'), /left · tracked-pointer · gamepad/);
  assert.match(value('Hands'), /22mm pinch/);

  diagnostics.complete('teleport', 'teleport');
  assert.equal(value('Checked'), `1 / ${STATION_IDS.length}`);
  assert.equal(value('Last'), 'teleport ✓');
  diagnostics.complete('teleport', 'teleport');
  assert.equal(value('Checked'), `1 / ${STATION_IDS.length}`, 'a repeat does not double-count');
});

test('a fallback reference space is reported rather than hidden', () => {
  const diagnostics = new Diagnostics();
  diagnostics.setSession({ mode: 'immersive-vr', referenceSpace: 'local (1.6 m estimate)' });
  assert.match(diagnostics.lines().find(([name]) => name === 'Reference space')[1], /estimate/);
});
