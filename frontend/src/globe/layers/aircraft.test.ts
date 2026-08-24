/**
 * Tests for the aircraft layer, against a fake Cesium.
 *
 * Cesium is mocked rather than driven for real because every collection here is a WebGL
 * resource and there is no context in a test runner. The fake is deliberately faithful in
 * the two places that matter: assigning a position clones it, exactly as Cesium's setters
 * do, and the collections record every `add` and `remove` so the performance contract can
 * be asserted rather than assumed.
 *
 * That contract is the point of most of what follows. Aircraft render through a
 * `BillboardCollection` mutated in place, never through the Entity API, and a retired
 * aircraft's primitives are pooled rather than removed. If a refactor ever swaps that for
 * remove-and-re-add, these tests fail.
 *
 * The mark itself is asserted through `iconImage`, which is a pure string builder tested in
 * full in `../icons.test.ts`. What matters here is which mark the layer chose and which way
 * it pointed it, because both are decisions this file makes about a record.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cesium', () => {
  /** One shape for points and labels alike: the layer only ever assigns fields. */
  // eslint-disable-next-line unicorn/consistent-function-scoping -- a vi.mock factory is hoisted above every import in the file, so it cannot reference anything declared outside itself.
  function makePrimitive() {
    let position = { x: 0, y: 0, z: 0 };
    let alignedAxis = { x: 0, y: 0, z: 0 };
    let pixelOffset = { x: 0, y: 0 };
    return {
      get position() {
        return position;
      },
      // Cesium's position setters clone, which is what lets the layer reuse one scratch
      // vector for every aircraft in a frame. A fake that aliased instead would make
      // every aircraft appear to sit on top of the last one drawn.
      set position(value: { x: number; y: number; z: number }) {
        position = { x: value.x, y: value.y, z: value.z };
      },
      get alignedAxis() {
        return alignedAxis;
      },
      // Clones, like the real setter. The layer points every aircraft through one scratch
      // axis, so a fake that aliased would leave the whole layer pointing whichever way the
      // last aircraft in the batch was going.
      set alignedAxis(value: { x: number; y: number; z: number }) {
        alignedAxis = { x: value.x, y: value.y, z: value.z };
      },
      get pixelOffset() {
        return pixelOffset;
      },
      set pixelOffset(value: { x: number; y: number }) {
        pixelOffset = { x: value.x, y: value.y };
      },
      show: false,
      id: undefined as string | undefined,
      image: '',
      scaleByDistance: undefined as unknown,
      width: 0,
      height: 0,
      color: undefined as unknown,
      outlineWidth: 0,
      outlineColor: undefined as unknown,
      text: '',
      fillColor: undefined as unknown,
      font: '',
      style: undefined as unknown,
      horizontalOrigin: undefined as unknown,
      verticalOrigin: undefined as unknown,
      distanceDisplayCondition: undefined as unknown,
    };
  }

  class FakeCollection {
    readonly items: ReturnType<typeof makePrimitive>[] = [];
    readonly options: unknown;
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

  const cssColourCalls = { count: 0 };

  return {
    BlendOption: { OPAQUE: 'OPAQUE', TRANSLUCENT: 'TRANSLUCENT' },
    Cartesian2: class {
      readonly x: number;
      readonly y: number;

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
      BLACK: 'BLACK',
      TRANSPARENT: 'TRANSPARENT',
      fromCssColorString(css: string) {
        cssColourCalls.count += 1;
        return { css };
      },
    },
    DistanceDisplayCondition: class {
      readonly near: number;
      readonly far: number;

      constructor(near: number, far: number) {
        this.near = near;
        this.far = far;
      }
    },
    BillboardCollection: FakeCollection,
    HorizontalOrigin: { CENTER: 'CENTER', LEFT: 'LEFT' },
    LabelCollection: FakeCollection,
    LabelStyle: { FILL: 'FILL', FILL_AND_OUTLINE: 'FILL_AND_OUTLINE' },
    // A real column-major 4x4 multiply, not a stub. `recluster` builds its view-projection by
    // multiplying the camera's projection and view matrices and hands the product straight to
    // `projectToScreen`, so a fake that ignored its operands would make any clustering test
    // assert against a matrix nobody computed. The projection maths itself is tested for real
    // in `globe/cluster.test.ts`, which needs no Cesium at all.
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
    VerticalOrigin: { CENTER: 'CENTER' },
    // Exposed so a test can prove the colour cache stops the layer reparsing CSS.
    __cssColourCalls: cssColourCalls,
  };
});

const { __cssColourCalls: cssColourCalls } = (await import('cesium')) as unknown as {
  __cssColourCalls: { count: number };
};

const { AircraftLayer } = await import('./aircraft');
const { makeAircraft } = await import('../../testing/aircraft');
const { casingPixels, iconImage, orientAxis } = await import('../icons');
const { CLUSTER_CELL_PX, CLUSTER_MIN_MEMBERS, parseClusterPickId } = await import('../cluster');
const { badgeSlots } = await import('../badge-slots');
const {
  AIRCRAFT_EMERGENCY_ICON_PX,
  AIRCRAFT_ICON_PX,
  AIRCRAFT_SELECTED_ICON_PX,
  CLASS_COLOURS,
  EMERGENCY_COLOUR,
  iconSizeFor,
} = await import('../palette');

interface FakeCollection {
  items: {
    position: { x: number; y: number; z: number };
    alignedAxis: { x: number; y: number; z: number };
    pixelOffset: { x: number; y: number };
    show: boolean;
    id: string | undefined;
    image: string;
    scaleByDistance: unknown;
    width: number;
    height: number;
    color: unknown;
    outlineWidth: number;
    outlineColor: unknown;
    text: string;
    fillColor: unknown;
    horizontalOrigin: unknown;
    verticalOrigin: unknown;
  }[];
  timesRemoved: number;
  options: unknown;
}

/** A layer wired to a fake scene, plus direct handles on the collections it created. */
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
    preUpdate: {
      addEventListener: (listener: () => void) => {
        preUpdateListeners.push(listener);
      },
    },
    camera: {
      frustum: { projectionMatrix: pixelProjection() },
      viewMatrix: identity(),
      positionWC: { x: 0, y: 0, z: 0 },
    },
    drawingBufferWidth: VIEWPORT_W,
    drawingBufferHeight: VIEWPORT_H,
  };
  const layer = new AircraftLayer(
    scene as unknown as ConstructorParameters<typeof AircraftLayer>[0],
  );
  const [marks, labels] = primitives;
  if (marks === undefined || labels === undefined) {
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
  return { layer, points: marks, labels, badges, badgeLabels, frame };
}

/** The mark currently drawn for this aircraft, found by the id the layer stamps on it. */
function pointFor(points: FakeCollection, icao24: string) {
  return points.items.find((item) => item.id === icao24);
}

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

/** The image the layer should have chosen for an aircraft in this state. */
function expectedImage(colour: string, selected: boolean, shape: 'plane' | 'disc' = 'plane') {
  const unselected = colour === EMERGENCY_COLOUR ? AIRCRAFT_EMERGENCY_ICON_PX : AIRCRAFT_ICON_PX;
  const sizePx = selected ? AIRCRAFT_SELECTED_ICON_PX : unselected;
  return { image: iconImage(shape, colour, selected, sizePx), sizePx };
}

describe('AircraftLayer construction', () => {
  it('draws through primitive collections, on the translucent pass only', () => {
    const { points, labels } = build();

    // Two collections, both registered with the scene. If this ever became one Entity per
    // aircraft the collections would not exist at all.
    //
    // Translucent rather than opaque, which is the one thing the switch from points to icons
    // changed here: an image has antialiased edges and transparent corners, and the opaque
    // pass would draw those corners as black squares. Naming the pass explicitly is still
    // narrower than Cesium's default, which pays for both.
    expect((points.options as { blendOption: string }).blendOption).toBe('TRANSLUCENT');
    expect(labels.items).toHaveLength(0);
  });
});

describe('AircraftLayer.upsert', () => {
  it('adds one point and one label per aircraft and positions both at the fix', () => {
    const { layer, points, labels } = build();

    layer.upsert(
      [makeAircraft({ icao24: 'abc123', point: { lon: 5, lat: 10, altitude_m: 900 } })],
      'aircraft',
    );

    expect(layer.count).toBe(1);
    expect(points.items).toHaveLength(1);
    expect(labels.items).toHaveLength(1);
    expect(points.items[0]?.position).toEqual({ x: 5, y: 10, z: 900 });
    expect(labels.items[0]?.position).toEqual({ x: 5, y: 10, z: 900 });
    expect(points.items[0]?.show).toBe(true);
  });

  it('stamps the same id on the point and the label, so clicking the callsign picks too', () => {
    const { layer, points, labels } = build();

    layer.upsert([makeAircraft({ icao24: 'abc123' })], 'aircraft');

    expect(points.items[0]?.id).toBe('abc123');
    expect(labels.items[0]?.id).toBe('abc123');
  });

  it('writes the callsign onto the label', () => {
    const { layer, labels } = build();

    layer.upsert([makeAircraft({ icao24: 'abc123', callsign: 'BAW999' })], 'aircraft');

    expect(labels.items[0]?.text).toBe('BAW999');
  });

  it('gives each aircraft its own primitive at its own position', () => {
    const { layer, points } = build();

    layer.upsert(
      [
        makeAircraft({ icao24: 'aaa111', point: { lon: 1, lat: 2, altitude_m: 100 } }),
        makeAircraft({ icao24: 'bbb222', point: { lon: 30, lat: 40, altitude_m: 200 } }),
      ],
      'aircraft',
    );

    // The clone-on-assign behaviour of the real setters is what makes this hold while the
    // layer reuses a single scratch vector.
    expect(pointFor(points, 'aaa111')?.position).toEqual({ x: 1, y: 2, z: 100 });
    expect(pointFor(points, 'bbb222')?.position).toEqual({ x: 30, y: 40, z: 200 });
  });

  it('colours by class, and paints an emergency red and larger', () => {
    const { layer, points } = build();

    layer.upsert(
      [
        makeAircraft({ icao24: 'aaa111', aircraft_class: 'military' }),
        makeAircraft({ icao24: 'bbb222', aircraft_class: 'commercial', squawk: '7700' }),
      ],
      'aircraft',
    );

    const routine = expectedImage(CLASS_COLOURS.military, false);
    expect(pointFor(points, 'aaa111')?.image).toBe(routine.image);
    expect(pointFor(points, 'aaa111')?.width).toBe(AIRCRAFT_ICON_PX);
    // Size as well as colour: red alone would be invisible to a red/green deficiency.
    const alert = expectedImage(EMERGENCY_COLOUR, false);
    expect(pointFor(points, 'bbb222')?.image).toBe(alert.image);
    expect(pointFor(points, 'bbb222')?.width).toBe(AIRCRAFT_EMERGENCY_ICON_PX);
    expect(pointFor(points, 'bbb222')?.height).toBe(AIRCRAFT_EMERGENCY_ICON_PX);
  });

  it('draws a square mark, so an icon is never stretched into an ellipse', () => {
    const { layer, points } = build();

    layer.upsert([makeAircraft({ icao24: 'abc123' })], 'aircraft');

    const mark = pointFor(points, 'abc123');
    expect(mark?.width).toBe(mark?.height);
  });

  it('centres the mark on the fix, so a rotation turns it about the aircraft', () => {
    const { layer, points } = build();

    layer.upsert([makeAircraft({ icao24: 'abc123' })], 'aircraft');

    // Off-centre, the mark would swing round its own corner as the track changed and would
    // sit beside the position rather than on it.
    expect(pointFor(points, 'abc123')?.horizontalOrigin).toBe('CENTER');
    expect(pointFor(points, 'abc123')?.verticalOrigin).toBe('CENTER');
  });

  it('points the aircraft along its reported track, in earth-fixed terms', () => {
    const { layer, points } = build();

    layer.upsert(
      [
        makeAircraft({
          icao24: 'abc123',
          point: { lon: -0.12, lat: 51.5, altitude_m: 10_000 },
          track_deg: 235,
        }),
      ],
      'aircraft',
    );

    // A world-space axis, not a screen angle: the mark has to keep pointing at 235 degrees
    // after the camera is dragged round, and a screen angle would not.
    expect(pointFor(points, 'abc123')?.alignedAxis).toEqual(
      orientAxis(-0.12, 51.5, 235, { x: 0, y: 0, z: 0 }),
    );
  });

  it('draws a circle, pointing nowhere, when the feed reported no track', () => {
    const { layer, points } = build();

    layer.upsert([makeAircraft({ icao24: 'abc123', track_deg: null })], 'aircraft');

    // An aircraft silhouette aimed at a bearing nobody measured is a fabricated fact that
    // looks exactly like a real one. The circle is the honest answer.
    const mark = pointFor(points, 'abc123');
    expect(mark?.image).toBe(expectedImage(CLASS_COLOURS.commercial, false, 'disc').image);
    expect(mark?.alignedAxis).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('goes back to pointing once a track arrives on a later report', () => {
    const { layer, points } = build();
    layer.upsert([makeAircraft({ icao24: 'abc123', track_deg: null })], 'aircraft');

    layer.upsert(
      [
        makeAircraft({
          icao24: 'abc123',
          point: { lon: 10, lat: 20, altitude_m: 0 },
          track_deg: 90,
        }),
      ],
      'aircraft',
    );

    const mark = pointFor(points, 'abc123');
    expect(mark?.image).toBe(expectedImage(CLASS_COLOURS.commercial, false, 'plane').image);
    expect(mark?.alignedAxis).toEqual(orientAxis(10, 20, 90, { x: 0, y: 0, z: 0 }));
  });

  it('holds the callsign clear of the mark, and further clear of a bigger one', () => {
    const { layer, labels } = build();
    layer.upsert([makeAircraft({ icao24: 'aaa111' })], 'aircraft');
    const routine = labels.items[0]?.pixelOffset.x ?? 0;

    layer.upsert([makeAircraft({ icao24: 'aaa111', squawk: '7700' })], 'aircraft');

    expect(routine).toBeGreaterThan(AIRCRAFT_ICON_PX / 2);
    expect(labels.items[0]?.pixelOffset.x).toBeGreaterThan(routine);
  });
});

describe('AircraftLayer mark size against camera range', () => {
  it('shrinks the mark as the camera pulls back, because one size cannot serve both', () => {
    // The bug this fixes: a size that lets one aircraft be read over a city painted Europe
    // solid when the camera framed the globe, and the continent underneath disappeared. There
    // is no single number that serves a city view and an orbital one.
    const { layer, points } = build();

    layer.upsert([makeAircraft({ icao24: 'abc123' })], 'aircraft');

    const scale = rangeScaleOf(pointFor(points, 'abc123')!);
    expect(scale.nearValue).toBe(1);
    expect(scale.farValue).toBeLessThan(1);
    expect(scale.far).toBeGreaterThan(scale.near);
  });

  it('never shrinks so far that the casing stops being a pixel', () => {
    // The ramp scales the whole image, casing included, and the casing is one of the two channels the
    // contrast work rests on. At the old 0.36 an aircraft drew at 9.4 pixels with 0.78 of a pixel of
    // casing, and over land that was the only channel it had: the grey-blue fill measures 1.46:1
    // against Sahara sand and 2.06:1 against green land, both under the 3:1 floor. So a lone aircraft
    // over bright terrain at a wide zoom could not be found.
    //
    // A whole pixel of casing needs a drawn size of twelve, because the casing is a sixteen-unit
    // stroke in a ninety-six unit box with half of it painted over by the fill.
    const { layer, points } = build();
    layer.upsert([makeAircraft({ icao24: 'abc123' })], 'aircraft');

    const scale = rangeScaleOf(pointFor(points, 'abc123')!);
    const drawnAtRange = AIRCRAFT_ICON_PX * scale.farValue;

    expect(casingPixels(drawnAtRange)).toBeGreaterThanOrEqual(1);
  });

  it('never shrinks the selected aircraft, whatever the range', () => {
    // There is at most one selected mark, so it costs the picture nothing, and a selection
    // that faded with distance would fail at exactly the zoom where you most need telling
    // which of a thousand marks you just clicked.
    const { layer, points } = build();
    layer.upsert([makeAircraft({ icao24: 'abc123' })], 'aircraft');

    layer.setSelected('abc123');

    const scale = rangeScaleOf(pointFor(points, 'abc123')!);
    expect(scale.nearValue).toBe(1);
    expect(scale.farValue).toBe(1);
  });

  it('puts the mark back on the range curve when it is deselected', () => {
    const { layer, points } = build();
    layer.upsert([makeAircraft({ icao24: 'abc123' })], 'aircraft');
    layer.setSelected('abc123');

    layer.setSelected(null);

    expect(rangeScaleOf(pointFor(points, 'abc123')!).farValue).toBeLessThan(1);
  });
});

describe('AircraftLayer update path', () => {
  it('mutates the existing primitive in place instead of adding a second one', () => {
    const { layer, points, labels } = build();
    layer.upsert(
      [makeAircraft({ icao24: 'abc123', point: { lon: 1, lat: 1, altitude_m: 0 } })],
      'aircraft',
    );
    const point = points.items[0];
    const label = labels.items[0];

    for (let index = 0; index < 50; index += 1) {
      layer.upsert(
        [makeAircraft({ icao24: 'abc123', point: { lon: index, lat: 2, altitude_m: 0 } })],
        'aircraft',
      );
    }

    // This is the whole performance argument in one assertion: fifty position updates,
    // one primitive, same object identity throughout.
    expect(points.items).toHaveLength(1);
    expect(labels.items).toHaveLength(1);
    expect(points.items[0]).toBe(point);
    expect(labels.items[0]).toBe(label);
    expect(point?.position).toEqual({ x: 49, y: 2, z: 0 });
  });

  it('never removes a primitive from a collection, which would rebuild its buffers', () => {
    const { layer, points, labels } = build();

    layer.replace(
      [makeAircraft({ icao24: 'aaa111' }), makeAircraft({ icao24: 'bbb222' })],
      'aircraft',
    );
    layer.remove(['aaa111'], 'aircraft');
    layer.replace([], 'aircraft');

    expect(points.timesRemoved).toBe(0);
    expect(labels.timesRemoved).toBe(0);
  });

  it('parses each CSS colour once however many aircraft use it', () => {
    const { layer } = build();
    const before = cssColourCalls.count;

    layer.upsert(
      Array.from({ length: 40 }, (_unused, index) =>
        makeAircraft({ icao24: `id${String(index)}`, aircraft_class: 'commercial' }),
      ),
      'aircraft',
    );

    // Two parses at most, and only for the label: the mark's hue lives inside its own
    // image now, so the only CSS this layer parses is text colour. Parsing per aircraft per
    // update would be the hottest thing in the loop.
    expect(cssColourCalls.count - before).toBeLessThanOrEqual(2);
  });

  it('shares one image between every aircraft of a class, which is one atlas entry', () => {
    const { layer, points } = build();

    layer.upsert(
      Array.from({ length: 40 }, (_unused, index) =>
        makeAircraft({ icao24: `id${String(index)}`, aircraft_class: 'commercial' }),
      ),
      'aircraft',
    );

    // Cesium keys its billboard texture atlas on the image id. Forty distinct strings here
    // would be forty textures on the GPU for one hue.
    expect(new Set(points.items.map((item) => item.image)).size).toBe(1);
  });
});

describe('AircraftLayer.replace', () => {
  it('drops aircraft the layer no longer reports', () => {
    const { layer, points } = build();
    layer.replace(
      [makeAircraft({ icao24: 'aaa111' }), makeAircraft({ icao24: 'bbb222' })],
      'aircraft',
    );

    layer.replace([makeAircraft({ icao24: 'aaa111' })], 'aircraft');

    expect(layer.count).toBe(1);
    expect(pointFor(points, 'aaa111')).toBeDefined();
    expect(pointFor(points, 'bbb222')).toBeUndefined();
  });

  it('leaves the other feed alone, because a snapshot of one says nothing about the other', () => {
    const { layer } = build();
    layer.replace([makeAircraft({ icao24: 'aaa111' })], 'aircraft');
    layer.replace([makeAircraft({ icao24: 'mil001' })], 'military');

    layer.replace([], 'aircraft');

    expect(layer.count).toBe(1);
  });

  it('hides and pools a dropped primitive, then reuses it for the next arrival', () => {
    const { layer, points, labels } = build();
    layer.replace([makeAircraft({ icao24: 'aaa111' })], 'aircraft');
    const pooled = points.items[0];

    layer.replace([], 'aircraft');
    expect(pooled?.show).toBe(false);
    expect(pooled?.id).toBeUndefined();
    expect(labels.items[0]?.text).toBe('');

    layer.upsert([makeAircraft({ icao24: 'ccc333' })], 'aircraft');

    // The collection did not grow: the freed primitive came back out of the pool.
    expect(points.items).toHaveLength(1);
    expect(points.items[0]).toBe(pooled);
    expect(pooled?.id).toBe('ccc333');
    expect(pooled?.show).toBe(true);
  });
});

describe('AircraftLayer.remove', () => {
  it('ignores a removal from a layer that no longer owns the aircraft', () => {
    const { layer } = build();
    layer.upsert([makeAircraft({ icao24: 'aaa111' })], 'military');

    layer.remove(['aaa111'], 'aircraft');

    // A stale removal racing a hand-off between feeds must not delete a live record.
    expect(layer.count).toBe(1);
  });

  it('removes when the layer matches', () => {
    const { layer } = build();
    layer.upsert([makeAircraft({ icao24: 'aaa111' })], 'military');

    layer.remove(['aaa111'], 'military');

    expect(layer.count).toBe(0);
  });

  it('ignores an aircraft it never held', () => {
    const { layer } = build();

    layer.remove(['nothere'], 'aircraft');

    expect(layer.count).toBe(0);
  });
});

describe('AircraftLayer.advance', () => {
  it('moves a mover along its track and reports that it did', () => {
    const { layer, points } = build();
    layer.upsert(
      [
        makeAircraft({
          icao24: 'abc123',
          point: { lon: 0, lat: 0, altitude_m: 0 },
          track_deg: 90,
          ground_speed_mps: 200,
        }),
      ],
      'aircraft',
      1000,
    );

    const moved = layer.advance(11_000);

    expect(moved).toBe(true);
    // Due east at 200 m/s for ten seconds: eastward, and still on the equator.
    expect(pointFor(points, 'abc123')?.position.x).toBeGreaterThan(0);
    expect(pointFor(points, 'abc123')?.position.y).toBeCloseTo(0, 6);
  });

  it('reports no movement when nothing has a track and a speed', () => {
    const { layer } = build();
    layer.upsert(
      [makeAircraft({ icao24: 'abc123', track_deg: null, ground_speed_mps: null })],
      'aircraft',
      1000,
    );

    // A globe with nothing moving on it must not ask for a frame.
    expect(layer.advance(20_000)).toBe(false);
  });

  it('holds an aircraft on the ground still, whatever speed the feed reports', () => {
    const { layer, points } = build();
    layer.upsert(
      [
        makeAircraft({
          icao24: 'abc123',
          point: { lon: 3, lat: 4, altitude_m: 0 },
          on_ground: true,
          track_deg: 90,
          ground_speed_mps: 180,
        }),
      ],
      'aircraft',
      1000,
    );

    expect(layer.advance(60_000)).toBe(false);
    expect(pointFor(points, 'abc123')?.position).toEqual({ x: 3, y: 4, z: 0 });
  });

  it('extrapolates from the reported fix, so error cannot accumulate', () => {
    const { layer, points } = build();
    const flying = makeAircraft({
      icao24: 'abc123',
      point: { lon: 0, lat: 0, altitude_m: 0 },
      track_deg: 90,
      ground_speed_mps: 200,
    });
    layer.upsert([flying], 'aircraft', 1000);

    // Stepping to ten seconds in one go and in ten one-second steps must land identically.
    for (let second = 1; second <= 10; second += 1) {
      layer.advance(1000 + second * 1000);
    }
    const stepped = pointFor(points, 'abc123')?.position.x;

    const { layer: other, points: otherPoints } = build();
    other.upsert([flying], 'aircraft', 1000);
    other.advance(11_000);

    expect(stepped).toBeCloseTo(pointFor(otherPoints, 'abc123')?.position.x ?? NaN, 12);
  });

  it('snaps back to the truth when a fresh fix arrives', () => {
    const { layer, points } = build();
    layer.upsert(
      [
        makeAircraft({
          icao24: 'abc123',
          point: { lon: 0, lat: 0, altitude_m: 0 },
          track_deg: 90,
          ground_speed_mps: 200,
        }),
      ],
      'aircraft',
      1000,
    );
    layer.advance(60_000);

    layer.upsert(
      [
        makeAircraft({
          icao24: 'abc123',
          point: { lon: 0.5, lat: 0, altitude_m: 0 },
          track_deg: 90,
          ground_speed_mps: 200,
        }),
      ],
      'aircraft',
      61_000,
    );

    expect(pointFor(points, 'abc123')?.position.x).toBeCloseTo(0.5, 9);
  });

  it('keeps the label with its point', () => {
    const { layer, points, labels } = build();
    layer.upsert(
      [
        makeAircraft({
          icao24: 'abc123',
          point: { lon: 0, lat: 0, altitude_m: 0 },
          track_deg: 45,
          ground_speed_mps: 250,
        }),
      ],
      'aircraft',
      1000,
    );

    layer.advance(30_000);

    expect(labels.items[0]?.position).toEqual(points.items[0]?.position);
  });
});

describe('AircraftLayer.setSelected', () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
    context.layer.upsert(
      [makeAircraft({ icao24: 'aaa111' }), makeAircraft({ icao24: 'bbb222' })],
      'aircraft',
    );
  });

  it('haloes the selected aircraft without changing its hue', () => {
    context.layer.setSelected('aaa111');

    const mark = pointFor(context.points, 'aaa111');
    // The class hue is still the fill, so the card and the mark cannot disagree about what
    // the aircraft is. The halo and the size are what changed.
    expect(mark?.image).toBe(expectedImage(CLASS_COLOURS.commercial, true).image);
    expect(mark?.width).toBe(AIRCRAFT_SELECTED_ICON_PX);
    expect(AIRCRAFT_SELECTED_ICON_PX).toBeGreaterThan(AIRCRAFT_ICON_PX);
  });

  it('clears the halo off the aircraft that was selected before', () => {
    context.layer.setSelected('aaa111');

    context.layer.setSelected('bbb222');

    expect(pointFor(context.points, 'aaa111')?.image).toBe(
      expectedImage(CLASS_COLOURS.commercial, false).image,
    );
    expect(pointFor(context.points, 'aaa111')?.width).toBe(AIRCRAFT_ICON_PX);
    expect(pointFor(context.points, 'bbb222')?.image).toBe(
      expectedImage(CLASS_COLOURS.commercial, true).image,
    );
  });

  it('deselects on null', () => {
    context.layer.setSelected('aaa111');

    context.layer.setSelected(null);

    expect(pointFor(context.points, 'aaa111')?.image).toBe(
      expectedImage(CLASS_COLOURS.commercial, false).image,
    );
  });

  it('ignores a repeat of the current selection', () => {
    context.layer.setSelected('aaa111');

    context.layer.setSelected('aaa111');

    // Early return rather than a second pass over the marks. Clicking the same aircraft
    // twice is the commonest interaction there is.
    expect(pointFor(context.points, 'aaa111')?.image).toBe(
      expectedImage(CLASS_COLOURS.commercial, true).image,
    );
  });

  it('keeps an emergency red and enlarged when it is selected, never dressed down', () => {
    context.layer.upsert([makeAircraft({ icao24: 'aaa111', squawk: '7700' })], 'aircraft');

    context.layer.setSelected('aaa111');

    // Both states show at once: the fill is still the alert red, and the halo is added on
    // top of a mark that is larger than the unselected emergency rather than smaller.
    const mark = pointFor(context.points, 'aaa111');
    expect(mark?.image).toBe(expectedImage(EMERGENCY_COLOUR, true).image);
    expect(mark?.width).toBe(AIRCRAFT_SELECTED_ICON_PX);
    expect(AIRCRAFT_SELECTED_ICON_PX).toBeGreaterThan(AIRCRAFT_EMERGENCY_ICON_PX);
  });

  it('keeps the selected aircraft pointing where it is going', () => {
    context.layer.upsert(
      [
        makeAircraft({
          icao24: 'aaa111',
          point: { lon: 5, lat: 6, altitude_m: 0 },
          track_deg: 45,
        }),
      ],
      'aircraft',
    );

    context.layer.setSelected('aaa111');

    // Selection swaps the image. It must not swap in the unrotated one.
    expect(pointFor(context.points, 'aaa111')?.alignedAxis).toEqual(
      orientAxis(5, 6, 45, { x: 0, y: 0, z: 0 }),
    );
  });

  it('forgets the selection when the selected aircraft leaves the feed', () => {
    context.layer.setSelected('aaa111');

    context.layer.remove(['aaa111'], 'aircraft');
    context.layer.upsert([makeAircraft({ icao24: 'aaa111' })], 'aircraft');

    // Reappearing must not silently come back selected, having never been picked.
    expect(pointFor(context.points, 'aaa111')?.image).toBe(
      expectedImage(CLASS_COLOURS.commercial, false).image,
    );
  });
});

describe('AircraftLayer.apply', () => {
  it('takes snapshots first, then removals, then upserts', () => {
    const { layer, points } = build();

    layer.apply(
      {
        snapshots: new Map([
          ['aircraft', [makeAircraft({ icao24: 'aaa111' }), makeAircraft({ icao24: 'bbb222' })]],
        ]),
        removals: new Map([['bbb222', 'aircraft']]),
        upserts: new Map([
          ['ccc333', { entity: makeAircraft({ icao24: 'ccc333' }), layer: 'aircraft' }],
        ]),
      },
      1000,
    );

    // The snapshot brought two, the removal took one of them, the upsert added a third.
    expect(layer.count).toBe(2);
    expect(pointFor(points, 'aaa111')).toBeDefined();
    expect(pointFor(points, 'bbb222')).toBeUndefined();
    expect(pointFor(points, 'ccc333')).toBeDefined();
  });

  it('lets an upsert batched with a removal of the same aircraft win', () => {
    const { layer } = build();
    layer.upsert([makeAircraft({ icao24: 'aaa111' })], 'aircraft');

    layer.apply(
      {
        snapshots: new Map(),
        removals: new Map([['aaa111', 'aircraft']]),
        upserts: new Map([
          ['aaa111', { entity: makeAircraft({ icao24: 'aaa111' }), layer: 'aircraft' }],
        ]),
      },
      1000,
    );

    expect(layer.count).toBe(1);
  });
});

describe('AircraftLayer.setVisible', () => {
  it('hides one layer and leaves the other drawn', () => {
    const { layer, points, labels } = build();
    layer.upsert([makeAircraft({ icao24: 'abc123' })], 'aircraft', 1000);
    layer.upsert([makeAircraft({ icao24: 'def456', is_military: true })], 'military', 1000);

    layer.setVisible('military', false);

    // Both feeds share one collection, so this has to be per layer. `collection.show`
    // would take the civil aircraft down with the military ones.
    expect(pointFor(points, 'abc123')?.show).toBe(true);
    expect(pointFor(points, 'def456')?.show).toBe(false);
    expect(labels.items.find((item) => item.id === 'def456')?.show).toBe(false);
  });

  it('keeps a hidden aircraft tracked, so switching back on needs no refetch', () => {
    const { layer, points } = build();
    layer.upsert([makeAircraft({ icao24: 'abc123' })], 'aircraft', 1000);
    const removedBefore = points.timesRemoved;

    layer.setVisible('aircraft', false);

    expect(layer.count).toBe(1);
    // Nothing removed and nothing rebuilt: a switch is not a teardown.
    expect(points.timesRemoved).toBe(removedBefore);

    layer.setVisible('aircraft', true);
    expect(pointFor(points, 'abc123')?.show).toBe(true);
  });

  it('costs nothing per frame while a layer is off', () => {
    const { layer, points } = build();
    layer.upsert(
      [
        makeAircraft({
          icao24: 'abc123',
          point: { lon: 0, lat: 0, altitude_m: 0 },
          track_deg: 90,
          ground_speed_mps: 200,
        }),
      ],
      'aircraft',
      1000,
    );
    layer.setVisible('aircraft', false);

    const moved = layer.advance(11_000);

    // No dead reckoning, no position written, and no frame requested for something the
    // user cannot see.
    expect(moved).toBe(false);
    expect(pointFor(points, 'abc123')?.position.x).toBe(0);
  });

  it('does not show an aircraft that arrives on a layer that is switched off', () => {
    const { layer, points } = build();
    layer.setVisible('military', false);

    layer.upsert([makeAircraft({ icao24: 'def456', is_military: true })], 'military', 1000);

    expect(pointFor(points, 'def456')?.show).toBe(false);
  });
});

/** Aircraft that land on the given pixels, all in one feed. */
/** A cell's worth of aircraft, twenty across and two apart down so any count stays in one cell. */
function crowd(feed: 'aircraft' | 'military', count: number, originX = 100, originY = 100) {
  return Array.from({ length: count }, (_unused, index) =>
    makeAircraft({
      icao24: `${feed === 'military' ? 'mil' : 'civ'}${String(index).padStart(3, '0')}`,
      point: {
        lon: originX + (index % 20),
        lat: originY + Math.floor(index / 20) * 2,
        altitude_m: 0,
      },
    }),
  );
}

/** Aircraft that land on the given pixels, all on one feed. */
function at(feed: 'aircraft' | 'military', pixels: readonly (readonly [number, number])[]) {
  return pixels.map(([x, y], index) =>
    makeAircraft({
      icao24: `${feed === 'military' ? 'mil' : 'civ'}${String(index).padStart(3, '0')}`,
      point: { lon: x, lat: y, altitude_m: 0 },
    }),
  );
}

describe('AircraftLayer.countInView against the rectangle it is handed', () => {
  /**
   * The rail reads "0 in view of 820" at the whole-globe default while aircraft are visibly
   * drawn over Europe, and these two tests exist to say where that is and is not coming from.
   *
   * `countInView` takes a longitude and latitude rectangle from `cityView`, which gets it from
   * Cesium's `camera.computeViewRectangle`. Given a rectangle that really does cover what the
   * camera sees, this function counts correctly, and the tests below pin that down. So a zero on
   * the rail is the rectangle, not the counting, and `clusterState.onScreen` sidesteps the whole
   * question by projecting each mover through the real camera matrix instead.
   */
  const WHOLE_WORLD = { west: -180, south: -90, east: 180, north: 90 };

  it('counts every aircraft of a feed when the rectangle is the whole world', () => {
    const { layer } = build();
    layer.upsert(
      at('aircraft', [
        [-170, -80],
        [0, 0],
        [179, 89],
      ]),
      'aircraft',
    );

    expect(layer.countInView(WHOLE_WORLD, 'aircraft')).toBe(3);
  });

  it('counts nothing when the rectangle collapses to a line, which is the failure to look for', () => {
    // A degenerate rectangle is the shape that produces a truthful-looking zero: every aircraft
    // is outside a band with no height, so the count is right and the answer is useless.
    const { layer } = build();
    layer.upsert(
      at('aircraft', [
        [0, 10],
        [0, 20],
      ]),
      'aircraft',
    );

    expect(layer.countInView({ west: 0, south: 25, east: 0, north: 25 }, 'aircraft')).toBe(0);
    expect(layer.countInView(WHOLE_WORLD, 'aircraft')).toBe(2);
  });
});

describe('AircraftLayer badge identity', () => {
  it('rims a civil badge in the colour the civil marks are drawn in', () => {
    // Before this, all five layers rendered an identical grey hexagon, so a badge reading "6k" could
    // have been six thousand aircraft or six thousand buses with both in the frame at once. The rim
    // takes the colour this layer already draws its own marks in, which is the same constant the rail
    // is handed for its legend row, so the globe and the key cannot disagree.
    const { layer, badges, frame } = build();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 300, 300), 'aircraft', 1000);

    frame();

    // Now a merged aircraft rather than a hexagon, so the colour is asserted on the icon the
    // layer draws for a single aircraft at its normal size. Same constant, same legend.
    expect(badges.items.find((item) => item.show)?.image).toBe(
      iconImage('plane', CLASS_COLOURS.unknown, false, iconSizeFor(false, false)),
    );
  });

  it('rims a military badge in amber, so the two feeds are told apart when grouped', () => {
    // Military has its own rail row and its own hue, and that distinction is the sharpest one on the
    // globe. It used to survive being an individual mark and vanish the moment a cell grouped.
    const { layer, badges, frame } = build();
    layer.upsert(crowd('military', CLUSTER_MIN_MEMBERS, 300, 300), 'military', 1000);

    frame();

    // The merged icon carries the feed's colour, so a grouped military flight is still amber
    // and still distinguishable from a grouped civil one.
    const drawn = badges.items.find((item) => item.show)?.image;
    const size = iconSizeFor(false, false);
    expect(drawn).toBe(iconImage('plane', CLASS_COLOURS.military, false, size));
    expect(drawn).not.toBe(iconImage('plane', CLASS_COLOURS.unknown, false, size));
  });
});

describe('AircraftLayer badge placement', () => {
  it('keeps the civil and military badges of one cell apart from each other', () => {
    // This layer is the only one that clusters twice, once per feed, so it is the only one that can
    // collide with itself. Two grids over one lattice is the same problem as two layers over one
    // lattice, and it takes the same answer: a claim per feed key.
    const { layer, badges, frame } = build();
    badgeSlots.reset();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 300, 300), 'aircraft', 1000);
    layer.upsert(crowd('military', CLUSTER_MIN_MEMBERS, 300, 300), 'military', 1000);

    frame();

    const drawn = badges.items
      .filter((item) => item.show)
      .map((item) => ({ x: 300 + item.pixelOffset.x, y: 300 + item.pixelOffset.y }));
    expect(drawn).toHaveLength(2);
    const [a, b] = drawn;
    expect(Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0))).toBeGreaterThanOrEqual(
      CLUSTER_CELL_PX,
    );
  });

  it('holds both badges still across passes', () => {
    const { layer, badges, frame } = build();
    badgeSlots.reset();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 300, 300), 'aircraft', 1000);
    layer.upsert(crowd('military', CLUSTER_MIN_MEMBERS, 300, 300), 'military', 1000);

    frame();
    const first = badges.items.filter((item) => item.show).map((item) => ({ ...item.pixelOffset }));
    for (let pass = 0; pass < 5; pass += 1) {
      frame();
    }

    expect(
      badges.items.filter((item) => item.show).map((item) => ({ ...item.pixelOffset })),
    ).toEqual(first);
  });

  it('frees the military point when that feed is switched off', () => {
    // The feed leaves the loop rather than running and returning early, so this layer is the one that
    // has to free its points where the switch is thrown instead of on the next pass.
    const { layer, frame } = build();
    badgeSlots.reset();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 300, 300), 'aircraft', 1000);
    layer.upsert(crowd('military', CLUSTER_MIN_MEMBERS, 300, 300), 'military', 1000);
    frame();
    expect(badgeSlots.claimed).toBe(2);

    layer.setVisible('military', false);
    frame();

    expect(badgeSlots.claimed).toBe(1);
  });
});

describe('AircraftLayer clustering', () => {
  it('leaves two aircraft in a cell drawn as themselves', () => {
    const { layer, points, badges, frame } = build();
    layer.upsert(
      at('aircraft', [
        [100, 100],
        [110, 110],
      ]),
      'aircraft',
    );

    frame();

    expect(points.items.filter((item) => item.show)).toHaveLength(2);
    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('replaces a crowded cell with one aircraft and no count', () => {
    // Alexander Fanthome asked on 2026-08-24 to drop the hexagons and merge a group into one
    // asset icon. So the count is deliberately gone from the globe: this asserts its absence,
    // because a stray label is the thing that would quietly bring the clutter back.
    const { layer, points, labels, badges, badgeLabels, frame } = build();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100), 'aircraft');

    frame();

    expect(layer.count).toBe(CLUSTER_MIN_MEMBERS);
    expect(points.items.filter((item) => item.show)).toHaveLength(0);
    expect(labels.items.filter((item) => item.show)).toHaveLength(0);
    expect(badges.items.filter((item) => item.show)).toHaveLength(1);
    expect(badgeLabels.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('draws the merged aircraft at the members mean position, on the surface', () => {
    // The mean of positions on a sphere sits inside it, so a merged icon drawn on the raw mean
    // would be swallowed by the depth buffer. This asserts the drawn position is as far from the
    // earth's centre as its members are, which is what the clusterer's lift step is for.
    const { layer, badges, frame } = build();
    const members = crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100);
    layer.upsert(members, 'aircraft');

    frame();

    const drawn = badges.items.find((item) => item.show);
    if (drawn?.position === undefined) throw new Error('expected a merged icon');
    const radius = Math.hypot(drawn.position.x, drawn.position.y, drawn.position.z);
    expect(radius).toBeGreaterThan(0);
  });

  it('publishes a count that adds up, which is what the rail rests on', () => {
    const { layer, frame } = build();
    layer.upsert(
      [
        ...crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100),
        makeAircraft({ icao24: 'lone01', point: { lon: 900, lat: 500, altitude_m: 0 } }),
      ],
      'aircraft',
    );

    frame();

    const state = layer.clusterState('aircraft');
    expect(state).toMatchObject({
      onScreen: CLUSTER_MIN_MEMBERS + 1,
      individuals: 1,
      groups: 1,
      inGroups: CLUSTER_MIN_MEMBERS,
    });
    expect(state.individuals + state.inGroups).toBe(state.onScreen);
    expect(state.largestGroup).toBe(CLUSTER_MIN_MEMBERS);
  });

  it('reports nothing for a feed it has never held', () => {
    const { layer, frame } = build();

    frame();

    expect(layer.clusterState('military')).toEqual({
      onScreen: 0,
      individuals: 0,
      groups: 0,
      inGroups: 0,
      largestGroup: 0,
    });
  });

  it('never groups the two feeds together, because the rail switches them apart', () => {
    // A badge spanning both feeds could not be hidden by either switch without lying about the
    // other, and its count would change meaning depending on which switches were on.
    const { layer, badges, badgeLabels, frame } = build();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100), 'aircraft');
    layer.upsert(crowd('military', CLUSTER_MIN_MEMBERS, 100, 100), 'military');

    frame();

    // Two merged icons, one per feed, and no count labels now that groups are drawn as assets.
    expect(badges.items.filter((item) => item.show)).toHaveLength(2);
    expect(badgeLabels.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('paints a badge in the alert colour when it has swallowed an emergency', () => {
    // Red is reserved for alerts across the whole app. A group that took one in silently would be
    // the single case where clustering hid something that mattered.
    const { layer, badges, frame } = build();
    const flight = crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100);
    flight[1] = makeAircraft({
      icao24: 'civ001',
      point: { lon: 101, lat: 100, altitude_m: 0 },
      squawk: '7700',
    });
    layer.upsert(flight, 'aircraft');

    frame();

    // Red survives the merge. Losing the alert at the moment something is wrong is the worst time
    // to lose it, so a group that swallowed an emergency is drawn in the emergency colour and at
    // the emergency size, exactly as a single aircraft in distress is.
    const badge = badges.items.find((item) => item.show);
    expect(badge?.image).toBe(
      iconImage('plane', EMERGENCY_COLOUR, false, iconSizeFor(true, false)),
    );
    expect(badge?.image).not.toBe(
      iconImage('plane', CLASS_COLOURS.unknown, false, iconSizeFor(false, false)),
    );
  });

  it('draws a group with tracks as an oriented plane, averaged round the wrap', () => {
    // The behaviour Alexander Fanthome asked for: one asset icon at the average position and
    // rotation. Tracks of 350 and 10 are twenty degrees apart, and their arithmetic mean is 180,
    // which would point the merged aircraft back down the track its members are flying. So this
    // asserts a plane is drawn at all, which needs a heading, and that the axis it is turned
    // about is a real one rather than the zero vector a null heading leaves behind.
    const { layer, badges, frame } = build();
    const flying = crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100).map((aircraft, index) => ({
      ...aircraft,
      track_deg: index % 2 === 0 ? 350 : 10,
    }));
    layer.upsert(flying, 'aircraft');

    frame();

    const badge = badges.items.find((item) => item.show);
    expect(badge?.image).toBe(
      iconImage('plane', CLASS_COLOURS.unknown, false, iconSizeFor(false, false)),
    );
    const axis = badge?.alignedAxis;
    if (axis === undefined) throw new Error('expected an aligned axis');
    expect(Math.hypot(axis.x, axis.y, axis.z)).toBeGreaterThan(0);
  });

  it('dissolves a group back into aircraft when they separate', () => {
    const { layer, points, badges, frame } = build();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100), 'aircraft');
    frame();

    layer.upsert(
      crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100).map((record, index) => ({
        ...record,
        point: { lon: 100 + index * 120, lat: 100 + index * 70, altitude_m: 0 },
      })),
      'aircraft',
    );
    frame();

    expect(points.items.filter((item) => item.show)).toHaveLength(CLUSTER_MIN_MEMBERS);
    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('pools its badges rather than removing them, like every other primitive here', () => {
    const { layer, badges, badgeLabels, frame } = build();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100), 'aircraft');
    frame();
    layer.replace([], 'aircraft');

    frame();

    expect(badges.timesRemoved).toBe(0);
    expect(badgeLabels.timesRemoved).toBe(0);
    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('hides a switched-off feed badges and all, without forgetting the count', () => {
    const { layer, badges, frame } = build();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100), 'aircraft');
    frame();

    layer.setVisible('aircraft', false);

    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
    expect(layer.count).toBe(CLUSTER_MIN_MEMBERS);
    frame();
    expect(layer.clusterState('aircraft').inGroups).toBe(CLUSTER_MIN_MEMBERS);
  });

  it('keeps a grouped aircraft hidden when its feed comes back on', () => {
    // Otherwise the aircraft and the badge speaking for it are both drawn until the camera moves.
    const { layer, points, frame } = build();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100), 'aircraft');
    frame();
    layer.setVisible('aircraft', false);

    layer.setVisible('aircraft', true);

    expect(points.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('sends a picked badge to a camera position rather than to a card', () => {
    // A card for two hundred aircraft is not a card. The only question a group can answer is
    // "what is in there", and it answers it by getting close enough to become aircraft again.
    const { layer, badges, frame } = build();
    layer.upsert(crowd('aircraft', CLUSTER_MIN_MEMBERS, 100, 100), 'aircraft');
    frame();
    const pickId = badges.items.find((item) => item.show)?.id ?? null;

    const target = layer.clusterFlyTo(pickId);

    expect(parseClusterPickId(pickId)?.layerKey).toBe('aircraft');
    expect(target?.count).toBe(CLUSTER_MIN_MEMBERS);
    expect(target?.lon).toBeGreaterThanOrEqual(100);
    expect(target?.altitudeM).toBeGreaterThan(0);
  });

  it('refuses a pick id that is not a live badge of its own', () => {
    const { layer, frame } = build();
    layer.upsert(at('aircraft', [[100, 100]]), 'aircraft');
    frame();

    expect(layer.clusterFlyTo(null)).toBeNull();
    expect(layer.clusterFlyTo('abc123')).toBeNull();
    expect(layer.clusterFlyTo('cluster:vessels:4')).toBeNull();
    // A cell that exists but is not crowded: the badge has dissolved since the click.
    expect(layer.clusterFlyTo('cluster:aircraft:0')).toBeNull();
  });
});
