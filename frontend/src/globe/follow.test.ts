/**
 * Tests for follow mode, against a fake Cesium camera and a fake canvas.
 *
 * Cesium is mocked because a real camera needs a WebGL context, and the canvas is faked
 * because the runner has no DOM. Both fakes are faithful in the places that decide the
 * behaviour: `Cartesian3.fromDegrees` passes degrees straight through so a test can assert
 * on the longitude and latitude that reached the camera, `Cartesian3.distance` is a real
 * distance so the captured range can be asserted, and the canvas fires listeners so a drag
 * is exercised through the events the browser will actually deliver.
 *
 * The two things these prove are the two things that make the mode usable: the camera
 * follows a moving aircraft between server fixes, and the user's own input takes it back
 * immediately. What a fake cannot prove is that Cesium's own camera controller does the
 * right thing once the reference frame is handed back, or how the gesture feels. That needs
 * a real browser and belongs to the Playwright suite in phase 9.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Selection } from '../state/store';
import type { Aircraft, Vessel } from '../types/entities';

vi.mock('cesium', () => {
  class FakeCartesian3 {
    x = 0;
    y = 0;
    z = 0;

    // Not a projection. Degrees go through untouched so a test can read them back; turning
    // them into ECEF metres is Cesium's job and testing it here would test the fake.
    static fromDegrees(lon: number, lat: number, height?: number): FakeCartesian3 {
      const target = new FakeCartesian3();
      target.x = lon;
      target.y = lat;
      target.z = height ?? 0;
      return target;
    }

    static distance(
      left: { x: number; y: number; z: number },
      right: { x: number; y: number; z: number },
    ): number {
      return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
    }
  }

  class FakeHeadingPitchRange {
    readonly heading: number;
    readonly pitch: number;
    readonly range: number;

    constructor(heading: number, pitch: number, range: number) {
      this.heading = heading;
      this.pitch = pitch;
      this.range = range;
    }
  }

  return {
    Cartesian3: FakeCartesian3,
    HeadingPitchRange: FakeHeadingPitchRange,
    Matrix4: { IDENTITY: 'IDENTITY' },
  };
});

const {
  DRAG_THRESHOLD_PX,
  FOLLOW_HINT,
  FOLLOW_KEY,
  FollowMode,
  MINIMUM_RANGE_M,
  followFix,
  installFollowKey,
} = await import('./follow');
const { makeAircraft } = await import('../testing/aircraft');
const { makeVessel } = await import('../testing/vessel');

interface Vector {
  x: number;
  y: number;
  z: number;
}

/** Only the fields the mode reads off an event, so a test writes only what it means. */
interface FakePointerEvent {
  clientX: number;
  clientY: number;
  buttons: number;
}

class FakeCanvas {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(handler);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  /** Deliver what the browser would deliver. */
  fire(type: string, event: Partial<FakePointerEvent> = {}): void {
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) {
      handler({ clientX: 0, clientY: 0, buttons: 0, ...event });
    }
  }
}

/** Where the camera sits when a test does not care. */
const ORIGIN: Vector = { x: 0, y: 0, z: 0 };

interface Aimed {
  target: Vector;
  offset: { heading: number; pitch: number; range: number };
}

/** A mode wired to a fake camera, plus handles on everything it did to it. */
function build(cameraAt: Vector = ORIGIN) {
  const canvas = new FakeCanvas();
  const aimed: Aimed[] = [];
  const released: unknown[] = [];
  const camera = {
    heading: 1.25,
    pitch: -0.75,
    positionWC: cameraAt,
    lookAt(target: Vector, offset: Aimed['offset']): void {
      aimed.push({ target, offset });
    },
    lookAtTransform(transform: unknown): void {
      released.push(transform);
    },
  };
  const follow = new FollowMode({ camera, scene: { canvas } } as unknown as ConstructorParameters<
    typeof FollowMode
  >[0]);
  return { follow, canvas, camera, aimed, released };
}

/** A selected aircraft over the equator, flying due east at 200 m/s. */
function selectedAircraft(overrides: Partial<Aircraft> = {}, receivedAtMs = 1000): Selection {
  const aircraft = makeAircraft({
    icao24: 'abc123',
    point: { lon: 0, lat: 0, altitude_m: 1000 },
    track_deg: 90,
    ground_speed_mps: 200,
    ...overrides,
  });
  return {
    kind: 'aircraft',
    id: aircraft.icao24,
    aircraft: { aircraft, layer: 'aircraft', receivedAtMs },
  };
}

function selectedVessel(overrides: Partial<Vessel> = {}, receivedAtMs = 1000): Selection {
  const vessel = makeVessel({ point: { lon: 5, lat: 10, altitude_m: null }, ...overrides });
  return { kind: 'vessel', id: vessel.mmsi, vessel: { vessel, receivedAtMs } };
}

describe('followFix', () => {
  it('reads an aircraft track, groundspeed and altitude', () => {
    const fix = followFix(selectedAircraft({ point: { lon: 3, lat: 4, altitude_m: 9000 } }, 5000));

    expect(fix).toEqual({
      lon: 3,
      lat: 4,
      altitudeM: 9000,
      bearingDeg: 90,
      speedMps: 200,
      anchorMs: 5000,
    });
  });

  it('holds an aircraft on the ground still, whatever speed the feed reports', () => {
    const fix = followFix(selectedAircraft({ on_ground: true }));

    // Matching the aircraft layer: a taxiing groundspeed extrapolated along a track drives
    // the camera off the airfield.
    expect(fix.speedMps).toBe(0);
  });

  it('reads a vessel course over ground, and puts it at sea level', () => {
    const fix = followFix(
      selectedVessel({ course_over_ground_deg: 187.4, speed_over_ground_mps: 8.2 }),
    );

    // Course over ground, not true heading: heading is where the bow points and a ship crabs.
    expect(fix).toEqual({
      lon: 5,
      lat: 10,
      altitudeM: 0,
      bearingDeg: 187.4,
      speedMps: 8.2,
      anchorMs: 1000,
    });
  });

  it('puts an aircraft with no reported altitude on the ellipsoid', () => {
    const fix = followFix(selectedAircraft({ point: { lon: 1, lat: 2, altitude_m: null } }));

    expect(fix.altitudeM).toBe(0);
  });

  it('reports a vessel with no course or speed as absent, not stopped at zero', () => {
    // Digitraffic sends 360.0 for an unavailable course and 102.3 for an unavailable speed,
    // and the adapter maps both to null. Treating either as a real number would drive the
    // camera off along a heading nobody reported.
    const fix = followFix(
      selectedVessel({ course_over_ground_deg: null, speed_over_ground_mps: null }),
    );

    expect(fix.bearingDeg).toBeNull();
    expect(fix.speedMps).toBeNull();
  });

  it('reports an absent bearing and speed as absent rather than as zero', () => {
    const fix = followFix(selectedAircraft({ track_deg: null, ground_speed_mps: null }));

    expect(fix.bearingDeg).toBeNull();
    expect(fix.speedMps).toBeNull();
  });
});

describe('FollowMode.start', () => {
  it('locks onto the selection at the distance and angles the camera already had', () => {
    const { follow, camera, aimed } = build();

    follow.start(selectedAircraft(), 1000);

    expect(follow.following).toBe('abc123');
    expect(aimed).toHaveLength(1);
    expect(aimed[0]?.target).toEqual({ x: 0, y: 0, z: 1000 });
    // Engaging locks onto what you are looking at. It does not fly you anywhere.
    expect(aimed[0]?.offset).toEqual({
      heading: camera.heading,
      pitch: camera.pitch,
      range: 1000,
    });
  });

  it('never puts the camera closer than the minimum range', () => {
    const { follow, aimed } = build({ x: 0, y: 0, z: 950 });

    follow.start(selectedAircraft(), 1000);

    // Fifty metres away from an airliner is inside it.
    expect(aimed[0]?.offset.range).toBe(MINIMUM_RANGE_M);
  });

  it('does nothing when there is nothing selected', () => {
    const { follow, aimed } = build();

    follow.start(null, 1000);

    expect(follow.following).toBeNull();
    expect(aimed).toHaveLength(0);
  });

  it('hands the camera back to the world before locking onto something else', () => {
    const { follow, released, aimed } = build();
    follow.start(selectedAircraft(), 1000);

    follow.start(selectedVessel(), 1000);

    // Heading and pitch are read relative to the frame the camera is in, so the old frame
    // has to go first or the second lock inherits the first one's angles.
    expect(released).toStrictEqual(['IDENTITY']);
    expect(follow.following).toBe('230123450');
    expect(aimed.at(-1)?.target).toEqual({ x: 5, y: 10, z: 0 });
  });
});

describe('FollowMode.tick', () => {
  it('tracks a moving aircraft between server fixes', () => {
    const { follow, aimed } = build();
    follow.start(selectedAircraft(), 1000);

    const moved = follow.tick(11_000);

    // Due east at 200 m/s for ten seconds. This is the whole point of the mode: the
    // aircraft's own reported fix, extrapolated, not a position read off a primitive.
    expect(moved).toBe(true);
    expect(aimed.at(-1)?.target.x).toBeGreaterThan(0);
    expect(aimed.at(-1)?.target.y).toBeCloseTo(0, 6);
    expect(aimed.at(-1)?.target.z).toBe(1000);
  });

  it('asks for no frame when the followed entity is not going anywhere', () => {
    const { follow, aimed } = build();
    follow.start(selectedAircraft({ track_deg: null, ground_speed_mps: null }), 1000);

    // Already centred, so re-aiming every animation frame would render the globe
    // continuously for nothing.
    expect(follow.tick(60_000)).toBe(false);
    expect(aimed).toHaveLength(1);
  });

  it('does nothing at all when nothing is followed', () => {
    const { follow, aimed } = build();

    expect(follow.tick(1000)).toBe(false);
    expect(aimed).toHaveLength(0);
  });
});

describe('FollowMode.refresh', () => {
  it('re-anchors on a fresh fix, so extrapolation cannot accumulate', () => {
    const { follow, aimed } = build();
    follow.start(selectedAircraft(), 1000);
    follow.tick(60_000);

    follow.refresh(
      selectedAircraft({ point: { lon: 1, lat: 0, altitude_m: 1000 } }, 61_000),
      61_000,
    );

    expect(aimed.at(-1)?.target.x).toBeCloseTo(1, 9);
  });

  it('disengages when the user selects something else', () => {
    const { follow, released } = build();
    follow.start(selectedAircraft(), 1000);

    follow.refresh(selectedVessel(), 2000);

    expect(follow.following).toBeNull();
    expect(released).toStrictEqual(['IDENTITY']);
  });

  it('disengages when the followed entity drops off its feed', () => {
    const { follow, released } = build();
    follow.start(selectedAircraft(), 1000);

    follow.refresh(null, 2000);

    // Leaving the camera locked to the last place we saw it is the frozen-but-looks-live
    // view this app exists to avoid.
    expect(follow.following).toBeNull();
    expect(released).toStrictEqual(['IDENTITY']);
  });

  it('ignores a selection change while nothing is followed', () => {
    const { follow, aimed } = build();

    follow.refresh(selectedAircraft(), 2000);

    expect(follow.following).toBeNull();
    expect(aimed).toHaveLength(0);
  });
});

describe('FollowMode and manual camera input', () => {
  it('disengages on a drag and hands the camera back to the world', () => {
    const { follow, canvas, released } = build();
    follow.start(selectedAircraft(), 1000);

    canvas.fire('pointerdown', { clientX: 100, clientY: 100, buttons: 1 });
    canvas.fire('pointermove', { clientX: 100 + DRAG_THRESHOLD_PX, clientY: 100, buttons: 1 });

    // A camera that fights the user is worse than no follow mode.
    expect(follow.following).toBeNull();
    // And the reference frame goes with it, or the next drag orbits a point the aircraft
    // left minutes ago and the globe looks stuck.
    expect(released).toStrictEqual(['IDENTITY']);
    expect(follow.tick(20_000)).toBe(false);
  });

  it('survives a click, because clicking is how an aircraft gets selected', () => {
    const { follow, canvas } = build();
    follow.start(selectedAircraft(), 1000);

    canvas.fire('pointerdown', { clientX: 100, clientY: 100, buttons: 1 });
    canvas.fire('pointermove', { clientX: 101, clientY: 100, buttons: 1 });
    canvas.fire('pointerup', { clientX: 101, clientY: 100, buttons: 0 });

    // One pixel of jitter on the way to a click is not a camera gesture.
    expect(follow.following).toBe('abc123');
  });

  it('survives the pointer moving with no button held', () => {
    const { follow, canvas } = build();
    follow.start(selectedAircraft(), 1000);

    canvas.fire('pointerdown', { clientX: 0, clientY: 0, buttons: 1 });
    canvas.fire('pointerup', { clientX: 0, clientY: 0, buttons: 0 });
    canvas.fire('pointermove', { clientX: 900, clientY: 900, buttons: 0 });

    expect(follow.following).toBe('abc123');
  });

  it('disengages on a zoom', () => {
    const { follow, canvas } = build();
    follow.start(selectedAircraft(), 1000);

    canvas.fire('wheel');

    expect(follow.following).toBeNull();
  });

  it('stops listening once destroyed', () => {
    const { follow, canvas } = build();
    follow.start(selectedAircraft(), 1000);

    follow.destroy();
    canvas.fire('pointerdown', { clientX: 0, clientY: 0, buttons: 1 });
    canvas.fire('pointermove', { clientX: 500, clientY: 500, buttons: 1 });

    expect(follow.following).toBeNull();
  });
});

describe('FollowMode.toggle', () => {
  it('turns itself off on the entity it is already following', () => {
    const { follow } = build();
    follow.start(selectedAircraft(), 1000);

    follow.toggle(selectedAircraft(), 2000);

    expect(follow.following).toBeNull();
  });

  it('switches to a different entity rather than turning off', () => {
    const { follow } = build();
    follow.start(selectedAircraft(), 1000);

    follow.toggle(selectedVessel(), 2000);

    expect(follow.following).toBe('230123450');
  });
});

/** Enough of a document for the key binding, which is one listener. */
function keyTarget() {
  const handlers = new Set<(event: unknown) => void>();
  return {
    handlers,
    target: {
      addEventListener(_type: string, handler: (event: unknown) => void): void {
        handlers.add(handler);
      },
      removeEventListener(_type: string, handler: (event: unknown) => void): void {
        handlers.delete(handler);
      },
    } as unknown as Document,
    press(event: Partial<KeyboardEvent> & { key: string }): void {
      for (const handler of handlers) {
        handler(event);
      }
    },
  };
}

describe('installFollowKey', () => {
  it('toggles follow mode on the current selection', () => {
    const { follow } = build();
    const keys = keyTarget();
    installFollowKey(follow, () => selectedAircraft(), keys.target);

    keys.press({ key: FOLLOW_KEY });
    expect(follow.following).toBe('abc123');

    keys.press({ key: FOLLOW_KEY.toUpperCase() });
    expect(follow.following).toBeNull();
  });

  it('leaves the browser its own shortcuts', () => {
    const { follow } = build();
    const keys = keyTarget();
    installFollowKey(follow, () => selectedAircraft(), keys.target);

    keys.press({ key: FOLLOW_KEY, ctrlKey: true });
    keys.press({ key: FOLLOW_KEY, metaKey: true });
    keys.press({ key: FOLLOW_KEY, altKey: true });

    // Ctrl+F and Cmd+F are find. Taking either is a worse trade than the shortcut is worth.
    expect(follow.following).toBeNull();
  });

  it('ignores the key while the user is typing', () => {
    const { follow } = build();
    const keys = keyTarget();
    installFollowKey(follow, () => selectedAircraft(), keys.target);

    keys.press({ key: FOLLOW_KEY, target: { tagName: 'INPUT' } as unknown as EventTarget });
    keys.press({
      key: FOLLOW_KEY,
      target: { isContentEditable: true } as unknown as EventTarget,
    });

    // Otherwise the search box engages follow mode on every "f" in "Frankfurt".
    expect(follow.following).toBeNull();
  });

  it('ignores every other key', () => {
    const { follow } = build();
    const keys = keyTarget();
    installFollowKey(follow, () => selectedAircraft(), keys.target);

    keys.press({ key: 'k' });

    expect(follow.following).toBeNull();
  });

  it('unbinds', () => {
    const { follow } = build();
    const keys = keyTarget();
    const remove = installFollowKey(follow, () => selectedAircraft(), keys.target);

    remove();
    keys.press({ key: FOLLOW_KEY });

    expect(follow.following).toBeNull();
  });
});

describe('FOLLOW_HINT', () => {
  it('names the key that is actually bound', () => {
    // Both cards render this, because nothing on screen used to say the mode existed. It is
    // built from FOLLOW_KEY rather than typed out beside it: a hint naming the wrong key is
    // worse than no hint.
    expect(FOLLOW_HINT).toContain(FOLLOW_KEY.toUpperCase());
    expect(FOLLOW_HINT).toBe('Press F to follow. Drag the globe to let go.');
  });
});
