import test from 'node:test';
import assert from 'node:assert/strict';
import { aircraftPartState } from './modelPartDrivers.js';
import { partTableOf } from '../render/modelParts.js';
import {
  ROTOR_FPS,
  ROTOR_FRAMES,
  ROTOR_STILL_FRAME,
  rotorFrame,
  rotorPhase,
  rotorTurns,
} from './rotorFrames.js';
import { aircraftIcon } from './aircraftIcons.js';

const svg = (uri) =>
  Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8');

test('the helicopter has three rotor frames, each its own image', () => {
  assert.equal(ROTOR_FRAMES, 3);
  const frames = [0, 1, 2].map((frame) =>
    aircraftIcon('helicopter', 64, frame),
  );
  assert.equal(new Set(frames).size, 3);
  // Frames 30° apart on a four-blade rotor: the third steps back onto the
  // first, a seamless loop.
  assert.match(svg(frames[0]), /rotate\(15 0 -11\.2\)/);
  assert.match(svg(frames[1]), /rotate\(45 0 -11\.2\)/);
  assert.match(svg(frames[2]), /rotate\(75 0 -11\.2\)/);
  // No frame, or one out of range, is the still frame.
  assert.equal(aircraftIcon('helicopter', 64), frames[ROTOR_STILL_FRAME]);
  assert.equal(aircraftIcon('helicopter', 64, 7), frames[ROTOR_STILL_FRAME]);
  // Other kinds have one image whatever the frame.
  assert.equal(aircraftIcon('airliner', 64, 2), aircraftIcon('airliner', 64));
});

test('frames step at the rotor rate through every frame in order', () => {
  const id = 'abc123';
  const stepMs = 1000 / ROTOR_FPS;
  const start = 1_700_000_000_000;
  const seen = [];
  for (let i = 0; i < 9; i++) seen.push(rotorFrame(id, start + i * stepMs + 1));
  for (let i = 1; i < seen.length; i++)
    assert.equal(seen[i], (seen[i - 1] + 1) % ROTOR_FRAMES, seen.join(','));
  // Within one step it holds.
  const at = start + 5 * stepMs + 1;
  const held = rotorFrame(id, at);
  for (let ms = 0; ms < stepMs; ms += 10) {
    const frame = rotorFrame(id, at + ms);
    assert.ok(frame === held || frame === (held + 1) % ROTOR_FRAMES);
  }
});

test('each contact has its own phase, so a group does not change in step', () => {
  assert.equal(rotorPhase('abc123'), rotorPhase('abc123'));
  const ids = Array.from(
    { length: 24 },
    (_, i) => `a${i.toString(16).padStart(5, '0')}`,
  );
  const phases = ids.map(rotorPhase);
  for (const phase of phases) assert.ok(phase >= 0 && phase < 1);
  assert.ok(new Set(phases).size > 20, 'phases differ by contact');
  // At one instant the group shows every frame, not one.
  const at = 1_700_000_000_000;
  const frames = new Set(ids.map((id) => rotorFrame(id, at)));
  assert.equal(frames.size, ROTOR_FRAMES);
});

test('the rotor sprite turns exactly when the model’s rotor does: in the air, or taxiing', () => {
  const table = partTableOf({
    parts: [
      { name: 'body', kind: 'body' },
      { name: 'rotor_main', kind: 'spin', axis: [0, 1, 0] },
    ],
  });
  const stepMs = 1000 / ROTOR_FPS;
  for (const state of [
    { onGround: false },
    { onGround: true, speedMps: 0 },
    { onGround: true, speedMps: 1 },
    { onGround: true, speedMps: 3 },
    { onGround: true, speedMps: null },
  ]) {
    const modelSpins = aircraftPartState(table, state)?.spin?.rotor_main > 0;
    assert.equal(rotorTurns(state), modelSpins, JSON.stringify(state));
    const frames = new Set(
      [0, 1, 2, 3].map((i) =>
        rotorFrame('abc123', 1_700_000_000_000 + i * stepMs + 1, state),
      ),
    );
    assert.equal(frames.size, modelSpins ? ROTOR_FRAMES : 1);
  }
});

test('a helicopter on the ground holds the still frame', () => {
  const stepMs = 1000 / ROTOR_FPS;
  for (let i = 0; i < 6; i++)
    assert.equal(
      rotorFrame('abc123', 1_700_000_000_000 + i * stepMs, { onGround: true }),
      ROTOR_STILL_FRAME,
    );
  assert.equal(rotorFrame('abc123', Number.NaN), ROTOR_STILL_FRAME);
});
