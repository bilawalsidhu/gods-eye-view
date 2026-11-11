// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../../../geo/index.js';
import { createFakeGroundHarness } from '../../../testSupport/groundDisplayEngines.mjs';

import { createAwarenessDisplay, RING_HALO_ID, RING_ID } from './display.js';

const HARNESSES = [createFakeGroundHarness];

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`the display reads whether the engine's camera inputs are on (${name})`, (t) => {
    const h = makeHarness();
    const display = createAwarenessDisplay(h.engine);
    t.after(() => {
      display.destroy();
      h.engine.destroy();
    });
    assert.equal(display.cameraInputsEnabled(), true);
    // The cockpit holds the camera through a suspension.
    const resume = h.engine.input.suspendCameraInputs();
    assert.equal(display.cameraInputsEnabled(), false);
    resume();
    assert.equal(display.cameraInputsEnabled(), true);
    h.engine.input.suspendCameraInputs();
    assert.equal(display.cameraInputsEnabled(), false);
  });

  test(`the display reads the engine's camera, frames and followed contact (${name})`, (t) => {
    const h = makeHarness();
    const display = createAwarenessDisplay(h.engine);
    t.after(() => {
      display.destroy();
      h.engine.destroy();
    });
    h.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(3, 20, 800_000),
      orientation: { heading: 0.5, pitch: -1, roll: 0 },
    });
    assert.equal(display.container, h.engine.host.container);
    assert.equal(display.canvas, h.engine.host.canvas);
    assert.ok(Math.abs(display.camera.heading - 0.5) < 1e-9);
    assert.ok(
      geo.cartesian3.distance(
        display.camera.positionWC,
        geo.cartesian3.fromDegrees(3, 20, 800_000),
      ) < 1e-3,
    );
    assert.ok(Math.abs(display.cameraHeight() - 800_000) < 1e-3);

    const contact = { gevTrackedId: 'flights:abc' };
    h.engine.camera.follow({
      native: contact,
      position: () => geo.cartesian3.fromDegrees(3, 20, 9000),
      viewFrom: geo.cartesian3.create(0, -2000, 1000),
    });
    assert.equal(display.trackedEntity?.gevTrackedId, 'flights:abc');
    h.engine.camera.following()?.stop();

    let frames = 0,
      ends = 0;
    const offFrame = display.onFrame(() => frames++);
    const offEnd = display.onFrameEnd(() => ends++);
    h.engine.fake.frame();
    assert.deepEqual([frames, ends], [1, 1]);
    offFrame();
    offEnd();

    const flights = [];
    h.engine.camera.flyToSphere = (sphere, options) =>
      flights.push({ sphere, options });
    const contactAt = geo.cartesian3.fromDegrees(3, 20, 0);
    display.frameContact(contactAt, 3000, 1.4);
    assert.deepEqual(flights, [
      {
        sphere: { center: contactAt, radius: 3000 },
        options: { duration: 1.4 },
      },
    ]);
  });

  test(`the ring is a 3 px core over a 4 px halo with a ground pulse field (${name})`, (t) => {
    const h = makeHarness();
    const display = createAwarenessDisplay(h.engine);
    t.after(() => {
      display.destroy();
      h.engine.destroy();
    });
    const center = geo.cartesian3.fromDegrees(3, 27, 0);
    const rim = display.createRim(center);
    const disc = display.createPulses(center);

    assert.equal(h.engine.fake.line(RING_ID).options.widthPx, 3);
    assert.equal(h.engine.fake.line(RING_HALO_ID).options.widthPx, 4);
    assert.ok(disc);
    disc.draw({ radii: [0.5], alphas: [0.4], level: 1 });
    const field = h.engine.fake.groundPulse('gev-awareness-pulses');
    assert.deepEqual(field.radii, [0.5, 0, 0, 0]);
    assert.deepEqual(field.alphas, [0.4, 0, 0, 0]);
    disc.destroy();
    assert.equal(h.engine.fake.groundPulse('gev-awareness-pulses'), undefined);

    rim.setAlpha(0.4);
    const alpha = h.engine.fake.line(RING_ID).color[3];
    assert.ok(Math.abs(alpha - 0.95 * 0.4) < 1e-9);
    rim.destroy();
    assert.equal(
      h.engine.lines.list().filter(({ id }) => id.startsWith(RING_ID)).length,
      0,
    );
  });
}
