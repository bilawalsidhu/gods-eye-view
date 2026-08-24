/**
 * Tests for the satellite layer, against a fake Cesium.
 *
 * Same approach as `aircraft.test.ts` and for the same reason: every collection here is a
 * WebGL resource and there is no context in a test runner. The fake is faithful where it
 * matters, which is that assigning a position clones it and that the collections record every
 * `add` and `remove`.
 *
 * Most of what follows is the render contract rather than the drawing. Satellites go through
 * a `BillboardCollection` mutated in place, a retired satellite's primitive is pooled
 * rather than removed, and exactly one polyline exists no matter how many satellites are on
 * the globe. A refactor to the Entity API, or to a trail per object, fails here.
 *
 * This is the densest layer in the app, so the mark has its own contract on top of that: one
 * image string for the whole catalogue and a second for the selection, which is what keeps
 * the texture atlas at two entries however many objects are being drawn.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('cesium', () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- a vi.mock factory is hoisted above every import in the file, so it cannot reference anything declared outside itself.
  function makePrimitive() {
    let position = { x: 0, y: 0, z: 0 };
    return {
      get position() {
        return position;
      },
      // Cesium's position setter clones, which is what lets the layer reuse one scratch
      // vector for a whole tick. A fake that aliased instead would stack every satellite on
      // top of the last one drawn.
      set position(value: { x: number; y: number; z: number }) {
        position = { x: value.x, y: value.y, z: value.z };
      },
      show: false,
      id: undefined as string | undefined,
      image: '',
      scaleByDistance: undefined as unknown,
      height: 0,
      horizontalOrigin: undefined as unknown,
      verticalOrigin: undefined as unknown,
      // `width` is shared: a billboard's pixel width and a polyline's line width.
      width: 0,
      // Label fields, for the cluster badge counts.
      text: '',
      font: '',
      style: undefined as unknown,
      fillColor: undefined as unknown,
      // Polyline fields.
      positions: [] as { x: number; y: number; z: number }[],
      material: undefined as unknown,
    };
  }

  class FakeCollection {
    readonly items: ReturnType<typeof makePrimitive>[] = [];
    readonly options: unknown;
    show = true;
    timesRemoved = 0;

    constructor(options?: unknown) {
      this.options = options;
    }

    add(template?: Record<string, unknown>): ReturnType<typeof makePrimitive> {
      const primitive = makePrimitive();
      Object.assign(primitive, template ?? {});
      this.items.push(primitive);
      return primitive;
    }

    remove(): boolean {
      this.timesRemoved += 1;
      return true;
    }

    removeAll(): void {
      this.timesRemoved += 1;
    }
  }

  return {
    BlendOption: { OPAQUE: 'OPAQUE', TRANSLUCENT: 'TRANSLUCENT' },
    Cartesian2: class {
      x: number;
      y: number;

      constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
      }
    },
    Cartesian3: class FakeCartesian3 {
      x = 0;
      y = 0;
      z = 0;

      static readonly ZERO = new FakeCartesian3();

      // Not a real projection. Degrees go straight through so a test can assert on the
      // longitude and latitude that reached Cesium.
      static fromDegrees(
        lon: number,
        lat: number,
        height?: number,
        _ellipsoid?: unknown,
        result?: FakeCartesian3,
      ): FakeCartesian3 {
        const target = result ?? new FakeCartesian3();
        target.x = lon;
        target.y = lat;
        target.z = height ?? 0;
        return target;
      }
    },
    Color: {
      TRANSPARENT: 'TRANSPARENT',
      fromCssColorString(css: string) {
        return { css, withAlpha: (alpha: number) => ({ css, alpha }) };
      },
    },
    Material: {
      fromType(type: string, uniforms: unknown) {
        return { type, uniforms };
      },
    },
    // A real column-major 4x4 multiply, not a stub. `recluster` builds its view-projection by
    // multiplying the camera's projection and view matrices and hands the product straight to
    // `projectToScreen`, so a fake that ignored its operands would make any clustering test
    // assert against a matrix nobody computed. The projection maths itself is tested for real
    // in `globe/cluster.test.ts`, which needs no Cesium at all.
    LabelCollection: FakeCollection,
    LabelStyle: { FILL: 'FILL', FILL_AND_OUTLINE: 'FILL_AND_OUTLINE' },
    Matrix4: class FakeMatrix4 {
      readonly length = 16;
      [index: number]: number;

      constructor() {
        for (let index = 0; index < 16; index += 1) {
          this[index] = 0;
        }
      }

      static multiply(
        left: ArrayLike<number>,
        right: ArrayLike<number>,
        result: Record<number, number>,
      ): Record<number, number> {
        for (let column = 0; column < 4; column += 1) {
          for (let row = 0; row < 4; row += 1) {
            let sum = 0;
            for (let k = 0; k < 4; k += 1) {
              sum += (left[k * 4 + row] ?? 0) * (right[column * 4 + k] ?? 0);
            }
            result[column * 4 + row] = sum;
          }
        }
        return result;
      }
    },
    // The inverse of this file's `Cartesian3.fromDegrees` fake, which puts degrees straight
    // through into x and y. The layer converts what comes back into degrees, so treating x and
    // y as degrees here and returning radians round-trips: a test asserts on the longitude and
    // latitude it fed in. Doing the real ECEF conversion would be testing Cesium.
    Cartographic: class FakeCartographic {
      longitude = 0;
      latitude = 0;
      height = 0;

      static fromCartesian(
        cartesian: { x: number; y: number; z: number },
        _ellipsoid: unknown,
        result?: FakeCartographic,
      ): FakeCartographic {
        const target = result ?? new FakeCartographic();
        target.longitude = (cartesian.x * Math.PI) / 180;
        target.latitude = (cartesian.y * Math.PI) / 180;
        return target;
      }
    },
    NearFarScalar: class {
      readonly near: number;
      readonly nearValue: number;
      readonly far: number;
      readonly farValue: number;

      constructor(near: number, nearValue: number, far: number, farValue: number) {
        this.near = near;
        this.nearValue = nearValue;
        this.far = far;
        this.farValue = farValue;
      }
    },
    BillboardCollection: FakeCollection,
    HorizontalOrigin: { CENTER: 'CENTER' },
    PolylineCollection: FakeCollection,
    VerticalOrigin: { CENTER: 'CENTER' },
  };
});

const {
  ORBIT_TRAIL_WIDTH,
  SATELLITE_COLOUR,
  SATELLITE_ICON_PX,
  SATELLITE_PICK_PREFIX,
  SATELLITE_SELECTED_ICON_PX,
  SatelliteLayer,
  noradFromPickId,
  SATELLITE_CLUSTER_KEY,
  SATELLITE_CLUSTER_MIN,
} = await import('./satellites');
const { parseClusterPickId } = await import('../cluster');
const { CLUSTER_FILL, clusterBadgePx } = await import('../palette');
const { clusterBadgeImage, iconImage } = await import('../icons');

const PLAIN_MARK = iconImage('diamond', SATELLITE_COLOUR, false, SATELLITE_ICON_PX);
const SELECTED_MARK = iconImage('diamond', SATELLITE_COLOUR, true, SATELLITE_SELECTED_ICON_PX);

interface FakeRangeScale {
  near: number;
  nearValue: number;
  far: number;
  farValue: number;
}

/** The range-scaling attribute Cesium evaluates in its vertex shader. */
function rangeScaleOf(item: { scaleByDistance: unknown }): FakeRangeScale {
  return item.scaleByDistance as FakeRangeScale;
}

interface FakeCollection {
  items: {
    position: { x: number; y: number; z: number };
    show: boolean;
    id: string | undefined;
    image: string;
    scaleByDistance: unknown;
    width: number;
    height: number;
    horizontalOrigin: unknown;
    verticalOrigin: unknown;
    text: string;
    positions: { x: number; y: number; z: number }[];
    material: unknown;
  }[];
  show: boolean;
  timesRemoved: number;
  options: unknown;
}

/**
 * A view-projection that maps a fake position's x and y straight to canvas pixels.
 *
 * `Cartesian3.fromDegrees` is faked to put degrees through into x and y, so a record placed at
 * longitude 100 and latitude 120 lands on pixel (100, 120) and a test can say which movers share
 * a cell by writing coordinates. Column-major, like the real thing.
 */
const VIEWPORT_W = 1600;
const VIEWPORT_H = 1000;

function pixelProjection(): number[] {
  const m = Array.from({ length: 16 }, () => 0);
  m[0] = 2 / VIEWPORT_W;
  m[12] = -1;
  // Negative because device coordinates run y up and a canvas runs y down.
  m[5] = -2 / VIEWPORT_H;
  m[13] = 1;
  m[15] = 1;
  return m;
}

function identity(): number[] {
  const m = Array.from({ length: 16 }, () => 0);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function build() {
  const primitives: FakeCollection[] = [];
  const preUpdateListeners: (() => void)[] = [];
  const scene = {
    primitives: {
      add: (collection: FakeCollection) => {
        primitives.push(collection);
      },
    },
    // The layer clusters on `preUpdate` rather than running a frame loop of its own, so the
    // fake scene has to offer the event or construction throws. Listeners are collected rather
    // than dropped so a test can drive a clustering pass deliberately; nothing here ever fires
    // a frame by itself, which is why the existing tests are untouched by clustering.
    preUpdate: {
      addEventListener: (listener: () => void) => {
        preUpdateListeners.push(listener);
      },
    },
    // The camera sits at the earth's centre so the occlusion test passes for everything: these
    // tests are about which movers share a cell, and the horizon maths has its own tests in
    // `globe/cluster.test.ts` where it can be checked against real radii.
    camera: {
      frustum: { projectionMatrix: pixelProjection() },
      viewMatrix: identity(),
      positionWC: { x: 0, y: 0, z: 0 },
    },
    drawingBufferWidth: VIEWPORT_W,
    drawingBufferHeight: VIEWPORT_H,
  };
  const layer = new SatelliteLayer(
    scene as unknown as ConstructorParameters<typeof SatelliteLayer>[0],
  );
  const [points, trails] = primitives;
  if (points === undefined || trails === undefined) {
    throw new Error('the layer did not add both collections to the scene');
  }
  const badges = primitives[2];
  const badgeLabels = primitives[3];
  if (badges === undefined || badgeLabels === undefined) {
    throw new Error('the layer did not add its cluster collections to the scene');
  }
  /** Drive one clustering pass, the way a rendered frame would. */
  const frame = (): void => {
    for (const listener of preUpdateListeners) {
      listener();
    }
  };
  return { layer, points, trails, badges, badgeLabels, frame };
}

/** One tick's worth of positions in the flat form the worker sends. */
function tick(entries: readonly { id: number; lon: number; lat: number; altitudeM: number }[]) {
  const ids = new Int32Array(entries.map((entry) => entry.id));
  const lonLatAlt = new Float64Array(entries.flatMap((e) => [e.lon, e.lat, e.altitudeM]));
  return [ids, lonLatAlt] as const;
}

const ISS = { id: 25_544, lon: -112.37793, lat: 39.1026, altitudeM: 418_987 };
const HST = { id: 20_580, lon: 12.5, lat: -8.25, altitudeM: 537_000 };

function pointFor(points: FakeCollection, noradCatId: number) {
  return points.items.find((item) => item.id === `${SATELLITE_PICK_PREFIX}${noradCatId}`);
}

describe('SatelliteLayer construction', () => {
  it('draws through primitive collections, on the translucent pass only', () => {
    const { points, trails } = build();

    // Translucent because an image has antialiased edges and transparent corners, which the
    // opaque pass would draw as black squares. Named explicitly all the same, because
    // Cesium's default pays for both passes.
    expect((points.options as { blendOption: string }).blendOption).toBe('TRANSLUCENT');
    // One polyline, created once, before any satellite exists. It is the selection's orbit
    // trail and there is never a second one.
    expect(trails.items).toHaveLength(1);
    expect(trails.items[0]?.show).toBe(false);
    expect(trails.items[0]?.width).toBe(ORBIT_TRAIL_WIDTH);
  });

  it('starts empty', () => {
    const { layer } = build();

    expect(layer.count).toBe(0);
  });
});

describe('drawing a tick', () => {
  it('puts each satellite where the worker said, at its own altitude', () => {
    const { layer, points } = build();

    layer.apply(...tick([ISS, HST]));

    expect(layer.count).toBe(2);
    // The fake passes degrees straight through, so this is the longitude, latitude and
    // height that reached Cesium.
    expect(pointFor(points, ISS.id)?.position).toEqual({
      x: ISS.lon,
      y: ISS.lat,
      z: ISS.altitudeM,
    });
    expect(pointFor(points, HST.id)?.position).toEqual({
      x: HST.lon,
      y: HST.lat,
      z: HST.altitudeM,
    });
  });

  it('draws one mark for the layer, square, centred and at the unselected size', () => {
    const { layer, points } = build();

    layer.apply(...tick([ISS]));

    const mark = pointFor(points, ISS.id);
    expect(mark?.image).toBe(PLAIN_MARK);
    expect(mark?.width).toBe(SATELLITE_ICON_PX);
    expect(mark?.height).toBe(SATELLITE_ICON_PX);
    // Centred on the position rather than hanging off a corner of it, which at this size is
    // the difference between a satellite on its orbit and one beside it.
    expect(mark?.horizontalOrigin).toBe('CENTER');
    expect(mark?.verticalOrigin).toBe('CENTER');
  });

  it('shares one image across the whole catalogue, which is one atlas entry', () => {
    // The tightest budget in the app: about 700 objects on a normal run and the whole active
    // catalogue as the target. Cesium keys its billboard texture atlas on the image id, so a
    // per-object string here would be ten thousand textures on the GPU.
    const { layer, points } = build();

    layer.apply(
      ...tick(
        Array.from({ length: 500 }, (_unused, index) => ({
          id: 90_000 + index,
          lon: index % 180,
          lat: index % 80,
          altitudeM: 500_000,
        })),
      ),
    );

    expect(points.items).toHaveLength(500);
    expect(new Set(points.items.map((item) => item.image)).size).toBe(1);
  });

  it('mutates positions in place across ticks and never grows the collection', () => {
    // The performance contract, and the reason this layer exists in this shape. A thousand
    // satellites re-propagated every frame must not add or remove a single primitive.
    const { layer, points } = build();

    layer.apply(...tick([ISS, HST]));
    const created = points.items.length;
    for (let frame = 0; frame < 30; frame += 1) {
      layer.apply(...tick([{ ...ISS, lon: ISS.lon + frame }, HST]));
    }

    expect(points.items.length).toBe(created);
    expect(points.timesRemoved).toBe(0);
    expect(pointFor(points, ISS.id)?.position.x).toBeCloseTo(ISS.lon + 29, 5);
  });

  it('takes a satellite off the globe when the worker stops reporting it', () => {
    // Which is the whole of the cheap decay guard: a satellite SGP4 refused, or one whose
    // elements went stale, is simply absent from the tick.
    const { layer, points } = build();
    layer.apply(...tick([ISS, HST]));

    layer.apply(...tick([HST]));

    expect(layer.count).toBe(1);
    expect(pointFor(points, ISS.id)).toBeUndefined();
    // Hidden and pooled, not removed: removing forces Cesium to rebuild its vertex buffers.
    expect(points.timesRemoved).toBe(0);
    expect(points.items.filter((item) => !item.show)).toHaveLength(1);
  });

  it('reuses a pooled primitive rather than allocating a new one', () => {
    const { layer, points } = build();
    layer.apply(...tick([ISS, HST]));
    const created = points.items.length;

    layer.apply(...tick([HST]));
    layer.apply(...tick([HST, { ...ISS, id: 33_591 }]));

    expect(points.items.length).toBe(created);
    expect(layer.count).toBe(2);
  });

  it('is empty when the worker draws nothing, without touching the collection', () => {
    const { layer, points } = build();
    layer.apply(...tick([ISS]));

    layer.apply(new Int32Array(0), new Float64Array(0));

    expect(layer.count).toBe(0);
    expect(points.timesRemoved).toBe(0);
  });
});

describe('giving the globe back', () => {
  it('draws the smallest mark in the app, because it draws the most objects', () => {
    // The ordering that matters, and the one an earlier version had backwards. About 700
    // satellites spread right around the globe rather than gathered over where people live,
    // so a whole-globe view holds every one of them at once and this is the only layer that
    // can hide the planet. Aircraft are 26 and vessels 22, both in their own layer files.
    expect(SATELLITE_ICON_PX).toBeLessThan(22);
    // Eighteen is the casing floor rather than a round number: below it the black edge drops
    // under a pixel and the mark stops holding its shape against bright cloud.
    expect(SATELLITE_ICON_PX).toBe(18);
  });

  it('shrinks hardest of the three layers as the camera pulls back', () => {
    const { layer, points } = build();

    layer.apply(...tick([ISS]));

    // Aircraft fall to 0.42 of their size and vessels to 0.4; this layer has to go further,
    // because at a whole-globe view every object in it is on screen at once.
    const scale = rangeScaleOf(pointFor(points, ISS.id)!);
    expect(scale.nearValue).toBe(1);
    expect(scale.farValue).toBeLessThan(0.4);
    expect(scale.far).toBeGreaterThan(scale.near);
  });

  it('reserves full size for a satellite nearly overhead, not for one seen from orbit', () => {
    // A satellite is hundreds of kilometres up and is never close to the camera the way an
    // aircraft is, so the near figure has to be in the hundreds of kilometres or nothing in
    // the layer would ever reach full size.
    const { layer, points } = build();
    layer.apply(...tick([ISS]));

    expect(rangeScaleOf(pointFor(points, ISS.id)!).near).toBeGreaterThanOrEqual(400_000);
  });

  it('never shrinks the selected satellite, whatever the range', () => {
    const { layer, points } = build();
    layer.apply(...tick([ISS]));

    layer.setSelected(ISS.id);

    expect(rangeScaleOf(pointFor(points, ISS.id)!).farValue).toBe(1);
  });
});

describe('selection', () => {
  it('haloes and enlarges the selected satellite and nothing else', () => {
    const { layer, points } = build();
    layer.apply(...tick([ISS, HST]));

    layer.setSelected(ISS.id);

    expect(pointFor(points, ISS.id)?.image).toBe(SELECTED_MARK);
    expect(pointFor(points, ISS.id)?.width).toBe(SATELLITE_SELECTED_ICON_PX);
    expect(SATELLITE_SELECTED_ICON_PX).toBeGreaterThan(SATELLITE_ICON_PX);
    expect(pointFor(points, HST.id)?.image).toBe(PLAIN_MARK);
  });

  it('clears the previous halo when the selection moves, and on deselection', () => {
    const { layer, points } = build();
    layer.apply(...tick([ISS, HST]));

    layer.setSelected(ISS.id);
    layer.setSelected(HST.id);

    expect(pointFor(points, ISS.id)?.image).toBe(PLAIN_MARK);
    expect(pointFor(points, HST.id)?.image).toBe(SELECTED_MARK);

    layer.setSelected(null);
    expect(pointFor(points, HST.id)?.image).toBe(PLAIN_MARK);
  });

  it('does nothing when the same satellite is selected twice', () => {
    const { layer, points } = build();
    layer.apply(...tick([ISS]));

    layer.setSelected(ISS.id);
    layer.setSelected(ISS.id);

    expect(pointFor(points, ISS.id)?.image).toBe(SELECTED_MARK);
  });

  it('selects a satellite that has not been drawn yet, and haloes it when it arrives', () => {
    const { layer, points } = build();

    layer.setSelected(ISS.id);
    layer.apply(...tick([ISS]));

    expect(pointFor(points, ISS.id)?.image).toBe(SELECTED_MARK);
  });

  it('deselects and hides the trail when the selected satellite leaves the tick', () => {
    const { layer, points, trails } = build();
    layer.apply(...tick([ISS]));
    layer.setSelected(ISS.id);
    layer.setOrbit(ISS.id, new Float64Array([0, 0, 400_000, 1, 1, 400_000]));
    expect(trails.items[0]?.show).toBe(true);

    layer.apply(...tick([HST]));

    expect(trails.items[0]?.show).toBe(false);
    expect(pointFor(points, ISS.id)).toBeUndefined();
  });

  it('stamps a prefixed id so a click routes to this layer and not to an aircraft', () => {
    const { layer, points } = build();

    layer.apply(...tick([ISS]));

    const id = points.items[0]?.id;
    expect(id).toBe('satellite:25544');
    expect(noradFromPickId(id ?? null)).toBe(ISS.id);
    // An ICAO 24-bit address is six hex characters and would otherwise parse as a number.
    expect(noradFromPickId('4ca7b5')).toBeNull();
    expect(noradFromPickId(null)).toBeNull();
    expect(noradFromPickId('satellite:not-a-number')).toBeNull();
  });

  it('refuses a malformed id rather than resolving it to catalogue number zero', () => {
    // The trap the `> 0` guard exists for, and it was untested until now. `Number('')` is 0 and
    // `Number.isSafeInteger(0)` is true, so a bare prefix used to come back as catalogue number 0
    // and read as a lookup that quietly found nothing rather than as "that was not a satellite".
    // Catalogue numbers start at 1, so nothing at or below zero is a real one.
    expect(noradFromPickId('satellite:')).toBeNull();
    expect(noradFromPickId('satellite:0')).toBeNull();
    expect(noradFromPickId('satellite:-1')).toBeNull();
    expect(noradFromPickId('satellite:2.5')).toBeNull();
    // The smallest real catalogue number still resolves, so the guard cannot be over-tightened
    // into rejecting Sputnik.
    expect(noradFromPickId('satellite:1')).toBe(1);
  });
});

describe('the orbit trail', () => {
  const orbit = new Float64Array([0, 0, 400_000, 10, 5, 401_000, 20, 10, 402_000]);

  it('draws the trail for the selection through the one polyline it already has', () => {
    const { layer, trails } = build();
    layer.apply(...tick([ISS]));
    layer.setSelected(ISS.id);

    layer.setOrbit(ISS.id, orbit);

    expect(trails.items).toHaveLength(1);
    expect(trails.timesRemoved).toBe(0);
    expect(trails.items[0]?.show).toBe(true);
    expect(trails.items[0]?.positions).toHaveLength(3);
    expect(trails.items[0]?.positions[1]).toEqual({ x: 10, y: 5, z: 401_000 });
  });

  it('ignores a trail for anything other than the current selection', () => {
    // The reply may have crossed a click. Drawing it would put a trail under a point nobody
    // selected.
    const { layer, trails } = build();
    layer.apply(...tick([ISS, HST]));
    layer.setSelected(ISS.id);

    layer.setOrbit(HST.id, orbit);

    expect(trails.items[0]?.show).toBe(false);
  });

  it('clears the trail on deselection and when the worker has no orbit to give', () => {
    const { layer, trails } = build();
    layer.apply(...tick([ISS]));
    layer.setSelected(ISS.id);
    layer.setOrbit(ISS.id, orbit);

    layer.setOrbit(null, null);
    expect(trails.items[0]?.show).toBe(false);

    layer.setOrbit(ISS.id, orbit);
    expect(trails.items[0]?.show).toBe(true);
    layer.setOrbit(ISS.id, null);
    expect(trails.items[0]?.show).toBe(false);
  });

  it('will not draw a trail of one point', () => {
    const { layer, trails } = build();
    layer.apply(...tick([ISS]));
    layer.setSelected(ISS.id);

    layer.setOrbit(ISS.id, new Float64Array([0, 0, 400_000]));

    expect(trails.items[0]?.show).toBe(false);
  });
});

describe('the rail switch', () => {
  it('hides both collections with one flag rather than dropping the data', () => {
    // Switching a layer off must not unsubscribe it: the count in the rail stays true and
    // switching it back on is immediate.
    const { layer, points, trails } = build();
    layer.apply(...tick([ISS, HST]));

    layer.setVisible(false);

    expect(points.show).toBe(false);
    expect(trails.show).toBe(false);
    expect(layer.count).toBe(2);

    layer.setVisible(true);
    expect(points.show).toBe(true);
    expect(trails.show).toBe(true);
  });
});

describe('the per-tick cost', () => {
  it('redraws a thousand satellites well inside a frame', () => {
    // The tightest budget in the app. A tick is a full replacement of every position, and it
    // runs on the render thread, so this is the loop that decides whether the globe stutters.
    //
    // The bound is 40 ms, not 16.7, and that is deliberate, for the reason spelled out in
    // `../satellites/orbit.test.ts`: `pnpm test` runs under v8 coverage instrumentation,
    // which inflates a loop like this by roughly eight times. A 16.7 ms assertion passes on
    // an idle machine and fails on a loaded one, which is a flake rather than a regression
    // guard. 40 ms still catches anything worse than about 5 ms of real work. Run vitest
    // without --coverage for the true figure.
    const { layer, points } = build();
    const frame = tick(
      Array.from({ length: 1000 }, (_unused, index) => ({
        id: 90_000 + index,
        lon: (index % 360) - 180,
        lat: (index % 160) - 80,
        altitudeM: 500_000,
      })),
    );
    // One warm-up tick, so the measurement is not paying for the pool filling up. That is
    // also what makes this the steady state: every primitive already exists.
    layer.apply(...frame);

    const started = performance.now();
    layer.apply(...frame);
    const elapsedMs = performance.now() - started;

    expect(points.items).toHaveLength(1000);
    expect(elapsedMs).toBeLessThan(40);
  });
});

/** `count` satellites all landing inside a single grid cell. */
function crowded(count: number, originX = 100, originY = 100) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: 90_000 + index,
    lon: originX + (index % 10),
    lat: originY + Math.floor(index / 10),
    altitudeM: 500_000,
  }));
}

describe('SatelliteLayer badge identity', () => {
  it('rims its badge in the cyan it draws its own diamonds in', () => {
    // Before this, all five layers rendered an identical grey hexagon, so a badge reading "6k" could
    // have been six thousand of anything with several layers in the frame at once. The rim takes the
    // colour this layer already uses for its marks, which is the same constant the rail is handed for
    // its legend row, so the globe and the key cannot drift apart.
    const { layer, badges, frame } = build();
    layer.apply(...tick(crowded(SATELLITE_CLUSTER_MIN)));

    frame();

    const size = clusterBadgePx(SATELLITE_CLUSTER_MIN);
    const drawn = badges.items.find((item) => item.show)?.image;
    expect(drawn).toBe(clusterBadgeImage(size, CLUSTER_FILL, SATELLITE_COLOUR));
    // Not the old shared grey, which is the regression this guards.
    expect(drawn).not.toBe(clusterBadgeImage(size, CLUSTER_FILL));
  });
});

describe('SatelliteLayer clustering', () => {
  it('leaves a spread-out shell alone, which is the common case', () => {
    // Seven hundred objects spread right around the globe are rarely three to a cell, so the
    // shell stays a shell. Nothing was tuned to get that: density decides.
    const { layer, points, badges, frame } = build();
    layer.apply(
      ...tick(
        Array.from({ length: 20 }, (_unused, index) => ({
          id: 90_000 + index,
          lon: 60 * index,
          lat: 40 * index,
          altitudeM: 500_000,
        })),
      ),
    );

    frame();

    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
    expect(points.items.filter((item) => item.show).length).toBeGreaterThan(0);
  });

  it('leaves a pile of ten alone, where the other two layers would have grouped it', () => {
    // The bar here is thirty, not the default ten, and this is what that buys: a modest pile of
    // satellites stays a pile of satellites, because seven-pixel diamonds already let the globe
    // through and a badge does not.
    const { layer, points, badges, frame } = build();
    layer.apply(...tick(crowded(10)));

    frame();

    expect(points.items.filter((item) => item.show)).toHaveLength(10);
    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('groups a pile nobody could have read anyway, and says how many', () => {
    const { layer, points, badges, badgeLabels, frame } = build();
    layer.apply(...tick(crowded(SATELLITE_CLUSTER_MIN)));

    frame();

    expect(points.items.filter((item) => item.show)).toHaveLength(0);
    expect(badges.items.filter((item) => item.show)).toHaveLength(1);
    expect(badgeLabels.items.find((item) => item.show)?.text).toBe(String(SATELLITE_CLUSTER_MIN));
  });

  it('publishes a count that adds up', () => {
    const { layer, frame } = build();
    layer.apply(
      ...tick([
        ...crowded(SATELLITE_CLUSTER_MIN),
        { id: 99_999, lon: 900, lat: 500, altitudeM: 400_000 },
      ]),
    );

    frame();

    const state = layer.clusterState;
    expect(state).toMatchObject({
      onScreen: SATELLITE_CLUSTER_MIN + 1,
      individuals: 1,
      groups: 1,
      inGroups: SATELLITE_CLUSTER_MIN,
    });
    expect(state.individuals + state.inGroups).toBe(state.onScreen);
  });

  it('hides its badges with the rail switch', () => {
    const { layer, badges, badgeLabels, frame } = build();
    layer.apply(...tick(crowded(SATELLITE_CLUSTER_MIN)));
    frame();

    layer.setVisible(false);

    expect(badges.show).toBe(false);
    expect(badgeLabels.show).toBe(false);
  });

  it('pools its badges rather than removing them', () => {
    const { layer, badges, frame } = build();
    layer.apply(...tick(crowded(SATELLITE_CLUSTER_MIN)));
    frame();
    layer.apply(new Int32Array(0), new Float64Array(0));

    frame();

    expect(badges.timesRemoved).toBe(0);
    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('sends a picked badge to a camera position rather than to a card', () => {
    const { layer, badges, frame } = build();
    layer.apply(...tick(crowded(SATELLITE_CLUSTER_MIN)));
    frame();
    const pickId = badges.items.find((item) => item.show)?.id ?? null;

    const target = layer.clusterFlyTo(pickId);

    expect(parseClusterPickId(pickId)?.layerKey).toBe(SATELLITE_CLUSTER_KEY);
    expect(target?.count).toBe(SATELLITE_CLUSTER_MIN);
  });

  it('refuses another layer badge and its own bare satellite ids', () => {
    const { layer } = build();

    expect(layer.clusterFlyTo('cluster:vessels:0')).toBeNull();
    expect(layer.clusterFlyTo(`${SATELLITE_PICK_PREFIX}25544`)).toBeNull();
  });
});
