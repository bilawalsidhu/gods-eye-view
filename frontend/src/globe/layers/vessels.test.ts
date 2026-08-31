/**
 * Tests for the vessel layer, against a fake Cesium.
 *
 * Cesium is mocked rather than driven for real because every collection here is a WebGL
 * resource and there is no context in a test runner. The fake is faithful in the one place
 * that matters: assigning a position clones it, exactly as Cesium's setters do, so a layer
 * that reused one scratch vector wrongly would show every ship stacked on the last one
 * drawn. The collections also record every `remove`, which is how the performance contract
 * gets asserted rather than assumed.
 *
 * The fake is a copy of the one in `aircraft.test.ts` rather than a shared helper: a
 * `vi.mock` factory is hoisted above every import in its file, and two copies of test
 * scaffolding is cheaper than the indirection needed to share it. Worth extracting when a
 * third layer wants it.
 *
 * The mark is asserted through `iconImage`, which is a pure string builder tested in full in
 * `../icons.test.ts`. What this file is for is the choice the layer makes about a record: a
 * hull when the feed gave a course and a square when it did not, and which way round it
 * pointed the hull.
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
      // Cesium's position setters clone. A fake that aliased instead would make every
      // vessel appear to sit on top of the last one drawn.
      set position(value: { x: number; y: number; z: number }) {
        position = { x: value.x, y: value.y, z: value.z };
      },
      get alignedAxis() {
        return alignedAxis;
      },
      // Clones, like the real setter. The layer points every hull through one scratch axis,
      // so a fake that aliased would leave the whole fleet on the last ship's course.
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

const {
  VesselLayer,
  UNDER_WAY_COLOUR,
  STOPPED_COLOUR,
  VESSEL_ICON_PX,
  SELECTED_VESSEL_ICON_PX,
  MAX_DEAD_RECKON_SECONDS,
  VESSEL_CLUSTER_KEY,
  VESSEL_CLUSTER_MIN,
} = await import('./vessels');
const { parseClusterPickId } = await import('../cluster');
const { makeVessel } = await import('../../testing/vessel');
const { clusterBadgeImage, iconImage, orientAxis } = await import('../icons');
const { CLUSTER_FILL, clusterBadgePx } = await import('../palette');

interface FakeCollection {
  show?: boolean;
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
    horizontalOrigin: unknown;
    verticalOrigin: unknown;
  }[];
  timesRemoved: number;
  options: unknown;
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

/** The image the layer should have chosen for a vessel in this state. */
function expectedImage(colour: string, selected: boolean, shape: 'ship' | 'block' = 'ship') {
  const sizePx = selected ? SELECTED_VESSEL_ICON_PX : VESSEL_ICON_PX;
  return iconImage(shape, colour, selected, sizePx);
}

/** A layer wired to a fake scene, plus direct handles on the collections it created. */
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
  const layer = new VesselLayer(scene as unknown as ConstructorParameters<typeof VesselLayer>[0]);
  const [points, labels] = primitives;
  if (points === undefined || labels === undefined) {
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
  return { layer, points, labels, badges, badgeLabels, frame };
}

/** The mark currently drawn for this vessel, found by the MMSI the layer stamps on it. */
function pointFor(points: FakeCollection, mmsi: string) {
  return points.items.find((item) => item.id === mmsi);
}

function labelFor(labels: FakeCollection, mmsi: string) {
  return labels.items.find((item) => item.id === mmsi);
}

/** A vessel that is stopped, which is what most of a port is. */
function moored(mmsi: string) {
  return makeVessel({
    mmsi,
    speed_over_ground_mps: 0,
    course_over_ground_deg: null,
    navigational_status: 'moored',
  });
}

describe('VesselLayer badge identity', () => {
  it('draws a group as one hull in the colour it draws its own marks in', () => {
    // A group is a merged asset now rather than a counted hexagon, so this asserts the icon and
    // its hue together. The colour is the same constant the rail is handed for its legend row, so
    // the globe and the key cannot drift apart.
    const { layer, badges, frame } = build();
    layer.replace(crowd(VESSEL_CLUSTER_MIN, 300, 300));

    frame();

    const drawn = badges.items.find((item) => item.show)?.image;
    expect(drawn).toBe(iconImage('ship', UNDER_WAY_COLOUR, false, VESSEL_ICON_PX));
    // Not a hexagon of any colour, which is the thing that was asked to go.
    expect(drawn).not.toBe(
      clusterBadgeImage(clusterBadgePx(VESSEL_CLUSTER_MIN), CLUSTER_FILL, UNDER_WAY_COLOUR),
    );
  });

  it('draws a merged hull at one vessel size however many it stands for', () => {
    // "Do not scale the asset icon size when merging, keep at the current size". The old badge
    // grew with the count, from 30 pixels to 48, so this asserts the two group sizes are the same
    // number and that the number is the size a lone ship draws at.
    const { layer, badges, frame } = build();

    layer.replace(crowd(VESSEL_CLUSTER_MIN, 300, 300));
    frame();
    const small = badges.items.find((item) => item.show);
    const smallWidth = small?.width;

    layer.replace(crowd(VESSEL_CLUSTER_MIN * 20, 300, 300));
    frame();
    const large = badges.items.find((item) => item.show);

    expect(smallWidth).toBe(VESSEL_ICON_PX);
    expect(large?.width).toBe(VESSEL_ICON_PX);
    expect(large?.height).toBe(VESSEL_ICON_PX);
  });

  it('turns a merged hull to the members mean course, round the wrap', () => {
    // Courses of 350 and 10 are twenty degrees apart and their arithmetic mean is 180, which
    // would point the merged hull back down the track its members are sailing. The circular mean
    // of that pair is due north, worked out here rather than read off the clusterer: the sines
    // cancel, the cosines are both positive, so the answer is 0.
    //
    // This also catches the heading never reaching the clusterer at all. `offer` takes the course
    // as its last argument and a layer that forgets to pass it draws the no-course square every
    // time, which looks entirely deliberate on screen.
    const { layer, badges, frame } = build();
    // An even number of members, so the two courses are eight apiece and the answer really is due
    // north. An odd split would put the true circular mean somewhere between the two and the
    // expectation would have to be computed the way the clusterer computes it, which is no test
    // at all.
    layer.replace(
      crowd(VESSEL_CLUSTER_MIN + 1, 300, 300).map((vessel, index) => ({
        ...vessel,
        course_over_ground_deg: index % 2 === 0 ? 350 : 10,
      })),
    );

    frame();

    const drawn = badges.items.find((item) => item.show);
    expect(drawn?.image).toBe(iconImage('ship', UNDER_WAY_COLOUR, false, VESSEL_ICON_PX));
    // The fake `Cartesian3.fromDegrees` puts longitude in x and latitude in y, so the drawn
    // position reads back as degrees and the expected axis can be built at the very place the
    // merged hull was drawn. Compared to a tolerance because the sines of 350 and 10 cancel to
    // about 1e-16 rather than to nothing, so the recovered bearing is a hair off zero.
    const at = drawn?.position ?? { x: 0, y: 0, z: 0 };
    const axis = drawn?.alignedAxis ?? { x: 0, y: 0, z: 0 };
    const north = orientAxis(at.x, at.y, 0, { x: 0, y: 0, z: 0 });
    const backwards = orientAxis(at.x, at.y, 180, { x: 0, y: 0, z: 0 });
    expect(axis.x).toBeCloseTo(north.x, 9);
    expect(axis.y).toBeCloseTo(north.y, 9);
    expect(axis.z).toBeCloseTo(north.z, 9);
    // 180 is what an arithmetic average of 350 and 10 gives, and it is the whole reason the
    // clusterer accumulates sine and cosine instead.
    expect(axis.z).not.toBeCloseTo(backwards.z, 3);
  });

  it('draws a courseless group as the square, pointing nowhere', () => {
    // The feed omits course on a great many records, and a hull aimed north would be a bearing
    // nobody reported. A single courseless vessel already draws the cut-cornered square; a group
    // of them draws the same thing.
    //
    // Grey rather than cyan, and that is `isUnderWay`'s doing rather than this file's: it requires
    // a course as well as a speed, so a ship with no course is never under way in this layer and
    // the shape and the hue move together.
    const { layer, badges, frame } = build();
    layer.replace(
      crowd(VESSEL_CLUSTER_MIN, 300, 300).map((vessel) => ({
        ...vessel,
        course_over_ground_deg: null,
      })),
    );

    frame();

    const drawn = badges.items.find((item) => item.show);
    expect(drawn?.image).toBe(iconImage('block', STOPPED_COLOUR, false, VESSEL_ICON_PX));
    expect(drawn?.alignedAxis).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('keeps the under-way cyan on a group that swallowed one moving ship', () => {
    // Cyan and grey are this layer's only state channel. A port at a wide zoom is one cell and is
    // mostly moored, so a merge that took its colour from the majority would hide the one ship
    // leaving. Same rule as the aircraft layer keeping red on a group holding an emergency.
    const { layer, badges, frame } = build();
    const berth = crowd(VESSEL_CLUSTER_MIN, 300, 300).map((vessel) => moored(vessel.mmsi));
    // `makeVessel`'s own defaults are a ship under way with a course, so this one leaves.
    berth[0] = makeVessel({ mmsi: '230000000' });
    layer.replace(berth);

    frame();

    const drawn = badges.items.find((item) => item.show)?.image;
    expect(drawn).toBe(iconImage('ship', UNDER_WAY_COLOUR, false, VESSEL_ICON_PX));
    expect(drawn).not.toBe(iconImage('ship', STOPPED_COLOUR, false, VESSEL_ICON_PX));
  });

  it('draws a wholly moored group in the stopped grey', () => {
    // The other half of the rule. A berth is not traffic, and drawing every merged icon in the
    // under-way cyan would put moving-ship colour on every harbour on the coast.
    const { layer, badges, frame } = build();
    layer.replace(crowd(VESSEL_CLUSTER_MIN, 300, 300).map((vessel) => moored(vessel.mmsi)));

    frame();

    // Moored, so no course either: the same record that stops a ship also drops its course.
    expect(badges.items.find((item) => item.show)?.image).toBe(
      iconImage('block', STOPPED_COLOUR, false, VESSEL_ICON_PX),
    );
  });
});

describe('VesselLayer construction', () => {
  it('draws through primitive collections, on the translucent pass only', () => {
    const { points, labels } = build();

    // Two collections, both registered with the scene. One Cesium Entity per vessel would
    // mean these did not exist at all.
    //
    // Translucent because an image has antialiased edges and transparent corners, which the
    // opaque pass would draw as black squares. Named explicitly all the same, because
    // Cesium's default pays for both passes.
    expect((points.options as { blendOption: string }).blendOption).toBe('TRANSLUCENT');
    expect(labels.items).toHaveLength(0);
  });
});

describe('VesselLayer.upsert', () => {
  it('adds one point and one label per vessel and puts both at the fix, at sea level', () => {
    const { layer, points, labels } = build();

    layer.upsert([makeVessel({ mmsi: '230123450', point: { lon: 5, lat: 10, altitude_m: null } })]);

    expect(layer.count).toBe(1);
    expect(points.items).toHaveLength(1);
    expect(labels.items).toHaveLength(1);
    // Height zero: AIS carries no altitude, so nothing here invents one.
    expect(points.items[0]?.position).toEqual({ x: 5, y: 10, z: 0 });
    expect(labels.items[0]?.position).toEqual({ x: 5, y: 10, z: 0 });
    expect(points.items[0]?.show).toBe(true);
  });

  it('stamps the same MMSI on the point and the label, so clicking the name picks too', () => {
    const { layer, points, labels } = build();

    layer.upsert([makeVessel({ mmsi: '230123450' })]);

    expect(points.items[0]?.id).toBe('230123450');
    expect(labels.items[0]?.id).toBe('230123450');
  });

  it('labels with the name, then the call sign, then the MMSI', () => {
    const { layer, labels } = build();

    layer.upsert([
      makeVessel({ mmsi: '230000001', name: 'FINNMAID' }),
      makeVessel({ mmsi: '230000002', name: null, call_sign: 'OJPQ' }),
      makeVessel({ mmsi: '230000003', name: null, call_sign: null }),
    ]);

    expect(labelFor(labels, '230000001')?.text).toBe('FINNMAID');
    expect(labelFor(labels, '230000002')?.text).toBe('OJPQ');
    expect(labelFor(labels, '230000003')?.text).toBe('230000003');
  });

  it('gives each vessel its own primitive at its own position', () => {
    const { layer, points } = build();

    layer.upsert([
      makeVessel({ mmsi: '230000001', point: { lon: 1, lat: 2, altitude_m: null } }),
      makeVessel({ mmsi: '230000002', point: { lon: 30, lat: 40, altitude_m: null } }),
    ]);

    expect(pointFor(points, '230000001')?.position).toEqual({ x: 1, y: 2, z: 0 });
    expect(pointFor(points, '230000002')?.position).toEqual({ x: 30, y: 40, z: 0 });
  });

  it('draws a position with no static data at all', () => {
    const { layer, points, labels } = build();

    // The thinnest record the contract allows, and a common one: 108 of 1,058 live
    // positions had no metadata record to join to, so no name, no speed and no course.
    layer.upsert([
      {
        kind: 'vessel',
        mmsi: '230000009',
        point: { lon: 21, lat: 59 },
        observed_at: '2026-08-19T12:00:00Z',
        position_age_s: 4,
        source: 'digitraffic',
        providers: ['digitraffic'],
      },
    ]);

    expect(layer.count).toBe(1);
    expect(pointFor(points, '230000009')?.position).toEqual({ x: 21, y: 59, z: 0 });
    // No name to show, so the MMSI is the label, and it is not shown because a vessel with
    // no reported speed is not under way.
    expect(labelFor(labels, '230000009')?.text).toBe('230000009');
    expect(labelFor(labels, '230000009')?.show).toBe(false);
    expect(layer.advance(999_999)).toBe(false);
  });

  it('keeps one record per MMSI when two providers report the same ship', () => {
    const { layer, points } = build();

    // The union merges on MMSI server side, but double counting is the named bug class in
    // ADR 010 and the layer must not reintroduce it: two records, one ship, one pin.
    layer.upsert([
      makeVessel({ mmsi: '230123450', source: 'digitraffic' }),
      makeVessel({ mmsi: '230123450', source: 'aishub' }),
    ]);

    expect(layer.count).toBe(1);
    expect(points.items).toHaveLength(1);
  });
});

describe('VesselLayer port density', () => {
  it('labels a vessel under way and leaves a moored one unlabelled', () => {
    const { layer, labels } = build();

    layer.upsert([makeVessel({ mmsi: '230000001' }), moored('230000002')]);

    // The whole port decision in one assertion. A berth is mostly moored ships and their
    // stacked names would hide the traffic moving through it.
    expect(labelFor(labels, '230000001')?.show).toBe(true);
    expect(labelFor(labels, '230000002')?.show).toBe(false);
  });

  it('still draws the moored vessel, because nothing is hidden here', () => {
    const { layer, points } = build();

    layer.upsert([moored('230000002')]);

    expect(pointFor(points, '230000002')?.show).toBe(true);
    expect(layer.count).toBe(1);
  });

  it('shows the name of a moored vessel once it is selected', () => {
    const { layer, labels } = build();
    layer.upsert([moored('230000002')]);

    layer.setSelected('230000002');

    // The escape hatch: click a berthed ship and you get its name.
    expect(labelFor(labels, '230000002')?.show).toBe(true);
  });

  it('drops the label again when the vessel is deselected', () => {
    const { layer, labels } = build();
    layer.upsert([moored('230000002')]);
    layer.setSelected('230000002');

    layer.setSelected(null);

    expect(labelFor(labels, '230000002')?.show).toBe(false);
  });

  it('colours a vessel under way apart from a stopped one', () => {
    const { layer, points } = build();

    layer.upsert([makeVessel({ mmsi: '230000001' }), moored('230000002')]);

    expect(pointFor(points, '230000001')?.image).toBe(expectedImage(UNDER_WAY_COLOUR, false));
    expect(pointFor(points, '230000002')?.image).toBe(
      expectedImage(STOPPED_COLOUR, false, 'block'),
    );
  });

  it('draws vessels smaller than aircraft, so a full berth keeps its structure', () => {
    const { layer, points } = build();

    layer.upsert([makeVessel({ mmsi: '230123450' })]);

    expect(pointFor(points, '230123450')?.width).toBe(VESSEL_ICON_PX);
    expect(pointFor(points, '230123450')?.height).toBe(VESSEL_ICON_PX);
  });

  it('shares one image across a berth in the same state, which is one atlas entry', () => {
    const { layer, points } = build();

    layer.upsert(
      Array.from({ length: 40 }, (_unused, index) =>
        moored(`2300000${String(index).padStart(2, '0')}`),
      ),
    );

    // Cesium keys its billboard texture atlas on the image id, so forty distinct strings
    // here would be forty textures on the GPU for one state.
    expect(new Set(points.items.map((item) => item.image)).size).toBe(1);
  });
});

describe('VesselLayer orientation', () => {
  it('points the hull along the course over ground, in earth-fixed terms', () => {
    const { layer, points } = build();

    layer.upsert([
      makeVessel({
        mmsi: '230000001',
        point: { lon: 24.95, lat: 60.16, altitude_m: null },
        course_over_ground_deg: 187.4,
      }),
    ]);

    // A world-space axis, not a screen angle: the hull has to keep pointing at 187 degrees
    // once the camera is dragged round.
    expect(pointFor(points, '230000001')?.alignedAxis).toEqual(
      orientAxis(24.95, 60.16, 187.4, { x: 0, y: 0, z: 0 }),
    );
  });

  it('draws a square, pointing nowhere, when the feed reported no course', () => {
    const { layer, points } = build();

    layer.upsert([moored('230000002')]);

    // The AIS not-available course is 360 and the adapter maps it to null, so a missing
    // course is a missing measurement rather than a bearing of zero. Pointing a bow north on
    // the strength of it would invent a heading for about one ship in twenty.
    const mark = pointFor(points, '230000002');
    expect(mark?.image).toBe(expectedImage(STOPPED_COLOUR, false, 'block'));
    expect(mark?.alignedAxis).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('ignores the true heading, which is not where the ship is going', () => {
    const { layer, points } = build();

    layer.upsert([
      makeVessel({
        mmsi: '230000003',
        speed_over_ground_mps: 0,
        course_over_ground_deg: null,
        true_heading_deg: 190,
        navigational_status: 'moored',
      }),
    ]);

    // A heading is where the bow looks; the layer extrapolates on course over ground and
    // draws what it extrapolates on. A moored ship with a heading still gets the square.
    expect(pointFor(points, '230000003')?.image).toBe(
      expectedImage(STOPPED_COLOUR, false, 'block'),
    );
  });

  it('centres the mark on the fix, so a rotation turns it about the ship', () => {
    const { layer, points } = build();

    layer.upsert([makeVessel({ mmsi: '230000001' })]);

    expect(pointFor(points, '230000001')?.horizontalOrigin).toBe('CENTER');
    expect(pointFor(points, '230000001')?.verticalOrigin).toBe('CENTER');
  });
});

describe('VesselLayer mark size against camera range', () => {
  it('shrinks the mark as the camera pulls back', () => {
    // This layer holds the most records in the app and they sit in one part of the world, so
    // from a whole-globe view they are a single dense patch. The shrink is what stops that
    // patch becoming an inkblot over Northern Europe.
    const { layer, points } = build();

    layer.upsert([makeVessel({ mmsi: '230123450' })]);

    const scale = rangeScaleOf(pointFor(points, '230123450')!);
    expect(scale.nearValue).toBe(1);
    expect(scale.farValue).toBeLessThan(1);
    expect(scale.far).toBeGreaterThan(scale.near);
  });

  it('never shrinks the selected vessel, whatever the range', () => {
    const { layer, points } = build();
    layer.upsert([makeVessel({ mmsi: '230123450' })]);

    layer.setSelected('230123450');

    const scale = rangeScaleOf(pointFor(points, '230123450')!);
    expect(scale.farValue).toBe(1);
  });
});

describe('VesselLayer update path', () => {
  it('mutates the existing primitive in place instead of adding a second one', () => {
    const { layer, points, labels } = build();
    layer.upsert([makeVessel({ mmsi: '230123450', point: { lon: 1, lat: 1, altitude_m: null } })]);
    const point = points.items[0];
    const label = labels.items[0];

    for (let index = 0; index < 50; index += 1) {
      layer.upsert([
        makeVessel({ mmsi: '230123450', point: { lon: index, lat: 2, altitude_m: null } }),
      ]);
    }

    // The whole performance argument in one assertion: fifty updates, one primitive, same
    // object identity throughout.
    expect(points.items).toHaveLength(1);
    expect(labels.items).toHaveLength(1);
    expect(points.items[0]).toBe(point);
    expect(labels.items[0]).toBe(label);
    expect(point?.position).toEqual({ x: 49, y: 2, z: 0 });
  });

  it('never removes a primitive from a collection, which would rebuild its buffers', () => {
    const { layer, points, labels } = build();

    layer.replace([makeVessel({ mmsi: '230000001' }), makeVessel({ mmsi: '230000002' })]);
    layer.remove(['230000001']);
    layer.replace([]);

    expect(points.timesRemoved).toBe(0);
    expect(labels.timesRemoved).toBe(0);
  });

  it('parses each CSS colour once however many vessels use it', () => {
    const { layer } = build();
    const before = cssColourCalls.count;

    layer.upsert(
      Array.from({ length: 40 }, (_unused, index) =>
        makeVessel({ mmsi: `2300000${String(index).padStart(2, '0')}` }),
      ),
    );

    // One parse at most now: the mark's hue lives inside its own image, so the only CSS
    // this layer parses is the label text colour.
    expect(cssColourCalls.count - before).toBeLessThanOrEqual(2);
  });
});

describe('VesselLayer.replace', () => {
  it('drops vessels the feed no longer reports', () => {
    const { layer, points } = build();
    layer.replace([makeVessel({ mmsi: '230000001' }), makeVessel({ mmsi: '230000002' })]);

    layer.replace([makeVessel({ mmsi: '230000001' })]);

    expect(layer.count).toBe(1);
    expect(pointFor(points, '230000001')).toBeDefined();
    expect(pointFor(points, '230000002')).toBeUndefined();
  });

  it('hides and pools a dropped primitive, then reuses it for the next arrival', () => {
    const { layer, points, labels } = build();
    layer.replace([makeVessel({ mmsi: '230000001' })]);
    const pooled = points.items[0];

    layer.replace([]);
    expect(pooled?.show).toBe(false);
    expect(pooled?.id).toBeUndefined();
    expect(labels.items[0]?.text).toBe('');

    layer.upsert([makeVessel({ mmsi: '230000003' })]);

    // The collection did not grow: the freed primitive came back out of the pool.
    expect(points.items).toHaveLength(1);
    expect(points.items[0]).toBe(pooled);
    expect(pooled?.id).toBe('230000003');
    expect(pooled?.show).toBe(true);
  });
});

describe('VesselLayer.remove', () => {
  it('removes a vessel it holds', () => {
    const { layer } = build();
    layer.upsert([makeVessel({ mmsi: '230000001' })]);

    layer.remove(['230000001']);

    expect(layer.count).toBe(0);
  });

  it('ignores a vessel it never held', () => {
    const { layer } = build();

    layer.remove(['230999999']);

    expect(layer.count).toBe(0);
  });

  it('clears the selection when the selected vessel is removed', () => {
    const { layer, labels } = build();
    layer.upsert([moored('230000002')]);
    layer.setSelected('230000002');

    layer.remove(['230000002']);
    layer.upsert([moored('230000002')]);

    // The pooled primitive came back for the same MMSI, and it must not arrive still
    // wearing the old selection.
    expect(labelFor(labels, '230000002')?.show).toBe(false);
  });
});

describe('VesselLayer.advance', () => {
  it('moves along the course over ground, not along the heading', () => {
    const { layer, points } = build();
    layer.upsert(
      [
        makeVessel({
          mmsi: '230123450',
          point: { lon: 0, lat: 0, altitude_m: null },
          course_over_ground_deg: 90,
          // Bow pointing due north while the track runs due east, which is what a vessel
          // in a tideway actually does. Reckoning along this would sail her up the coast.
          true_heading_deg: 0,
          speed_over_ground_mps: 10,
        }),
      ],
      1000,
    );

    const moved = layer.advance(61_000);

    expect(moved).toBe(true);
    expect(pointFor(points, '230123450')?.position.x).toBeGreaterThan(0);
    expect(pointFor(points, '230123450')?.position.y).toBeCloseTo(0, 6);
  });

  it('holds a moored vessel still and reports no movement', () => {
    const { layer, points } = build();
    layer.upsert([moored('230000002')], 1000);

    // A globe with nothing moving on it must not ask for a frame.
    expect(layer.advance(61_000)).toBe(false);
    expect(pointFor(points, '230000002')?.position).toEqual({ x: 24.95, y: 60.16, z: 0 });
  });

  it('holds a vessel still when the feed gave a speed but no course', () => {
    const { layer } = build();
    layer.upsert(
      [makeVessel({ mmsi: '230123450', course_over_ground_deg: null, speed_over_ground_mps: 8 })],
      1000,
    );

    expect(layer.advance(61_000)).toBe(false);
  });

  it('extrapolates from the reported fix, so error cannot accumulate', () => {
    const { layer, points } = build();
    const sailing = makeVessel({
      mmsi: '230123450',
      point: { lon: 0, lat: 0, altitude_m: null },
      course_over_ground_deg: 90,
      speed_over_ground_mps: 10,
    });
    layer.upsert([sailing], 1000);

    // Stepping to sixty seconds in one go and in sixty one-second steps must land
    // identically.
    for (let second = 1; second <= 60; second += 1) {
      layer.advance(1000 + second * 1000);
    }
    const stepped = pointFor(points, '230123450')?.position.x;

    const { layer: other, points: otherPoints } = build();
    other.upsert([sailing], 1000);
    other.advance(61_000);

    expect(stepped).toBeCloseTo(pointFor(otherPoints, '230123450')?.position.x ?? NaN, 12);
  });

  it('snaps back to the truth when a fresh fix arrives', () => {
    const { layer, points } = build();
    const sailing = makeVessel({
      mmsi: '230123450',
      point: { lon: 0, lat: 0, altitude_m: null },
      course_over_ground_deg: 90,
      speed_over_ground_mps: 10,
    });
    layer.upsert([sailing], 1000);
    layer.advance(61_000);

    layer.upsert(
      [{ ...sailing, point: { lon: 0.5, lat: 0, altitude_m: null } }],
      // A minute later, which is the union's cadence.
      61_000,
    );

    expect(pointFor(points, '230123450')?.position.x).toBeCloseTo(0.5, 9);
  });

  it('stops extrapolating past the cap and goes quiet', () => {
    const { layer, points } = build();
    layer.upsert(
      [
        makeVessel({
          mmsi: '230123450',
          point: { lon: 0, lat: 0, altitude_m: null },
          course_over_ground_deg: 90,
          speed_over_ground_mps: 10,
        }),
      ],
      1000,
    );

    const atCap = layer.advance(1000 + MAX_DEAD_RECKON_SECONDS * 1000);
    const held = pointFor(points, '230123450')?.position.x;
    const pastCap = layer.advance(1000 + 6 * 60 * 60 * 1000);

    expect(atCap).toBe(true);
    // Six hours on, the ship has not sailed 200 km along a course nobody reported, and the
    // render loop is no longer being woken to redraw it.
    expect(pastCap).toBe(false);
    expect(pointFor(points, '230123450')?.position.x).toBe(held);
  });

  it('keeps the label with its point', () => {
    const { layer, points, labels } = build();
    layer.upsert(
      [
        makeVessel({
          mmsi: '230123450',
          point: { lon: 0, lat: 0, altitude_m: null },
          course_over_ground_deg: 45,
          speed_over_ground_mps: 10,
        }),
      ],
      1000,
    );

    layer.advance(31_000);

    expect(labels.items[0]?.position).toEqual(points.items[0]?.position);
  });
});

describe('VesselLayer.setSelected', () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
    context.layer.upsert([makeVessel({ mmsi: '230000001' }), makeVessel({ mmsi: '230000002' })]);
  });

  it('haloes the selected vessel without changing its hue', () => {
    context.layer.setSelected('230000001');

    const mark = pointFor(context.points, '230000001');
    // Still the under-way cyan, so the mark and the card cannot disagree about the ship's
    // state. The halo and the size are what changed.
    expect(mark?.image).toBe(expectedImage(UNDER_WAY_COLOUR, true));
    expect(mark?.width).toBe(SELECTED_VESSEL_ICON_PX);
    expect(SELECTED_VESSEL_ICON_PX).toBeGreaterThan(VESSEL_ICON_PX);
  });

  it('clears the halo off the vessel that was selected before', () => {
    context.layer.setSelected('230000001');

    context.layer.setSelected('230000002');

    expect(pointFor(context.points, '230000001')?.image).toBe(
      expectedImage(UNDER_WAY_COLOUR, false),
    );
    expect(pointFor(context.points, '230000001')?.width).toBe(VESSEL_ICON_PX);
    expect(pointFor(context.points, '230000002')?.image).toBe(
      expectedImage(UNDER_WAY_COLOUR, true),
    );
  });

  it('deselects on null', () => {
    context.layer.setSelected('230000001');

    context.layer.setSelected(null);

    expect(pointFor(context.points, '230000001')?.image).toBe(
      expectedImage(UNDER_WAY_COLOUR, false),
    );
  });

  it('ignores a repeat of the current selection', () => {
    context.layer.setSelected('230000001');

    context.layer.setSelected('230000001');

    expect(pointFor(context.points, '230000001')?.image).toBe(
      expectedImage(UNDER_WAY_COLOUR, true),
    );
  });

  it('survives selecting a vessel the layer does not hold', () => {
    context.layer.setSelected('230999999');

    expect(pointFor(context.points, '230000001')?.image).toBe(
      expectedImage(UNDER_WAY_COLOUR, false),
    );
  });

  it('keeps the selection halo across a position update', () => {
    context.layer.setSelected('230000001');

    context.layer.upsert([makeVessel({ mmsi: '230000001' })]);

    // The halo is reapplied on upsert rather than being lost until the next click.
    expect(pointFor(context.points, '230000001')?.image).toBe(
      expectedImage(UNDER_WAY_COLOUR, true),
    );
    expect(pointFor(context.points, '230000001')?.width).toBe(SELECTED_VESSEL_ICON_PX);
  });

  it('keeps the selected ship pointing along its course', () => {
    context.layer.setSelected('230000001');

    // Selection swaps the image. It must not swap in the unrotated one.
    expect(pointFor(context.points, '230000001')?.alignedAxis).toEqual(
      orientAxis(24.95, 60.16, 187.4, { x: 0, y: 0, z: 0 }),
    );
  });
});

/**
 * The socket path, which is what the running app actually calls.
 *
 * `upsert` and `replace` above are driven directly by the tests; nothing in the app calls
 * them. What the app hands this layer is a frame off the socket, and before phase 2's review
 * that frame was going to the aircraft layer instead.
 */
describe('VesselLayer.apply', () => {
  it('takes the snapshot first, then the removal, then the upsert', () => {
    const { layer, points } = build();

    layer.apply(
      {
        snapshots: new Map([
          ['vessels', [makeVessel({ mmsi: '230000001' }), makeVessel({ mmsi: '230000002' })]],
        ]),
        removals: new Map([['230000002', 'vessels']]),
        upserts: new Map([
          ['230000003', { entity: makeVessel({ mmsi: '230000003' }), layer: 'vessels' }],
        ]),
      },
      1000,
    );

    expect(layer.count).toBe(2);
    expect(pointFor(points, '230000001')).toBeDefined();
    expect(pointFor(points, '230000002')).toBeUndefined();
    expect(pointFor(points, '230000003')).toBeDefined();
  });

  it('lets an upsert batched with a removal of the same ship win', () => {
    const { layer } = build();
    layer.upsert([makeVessel({ mmsi: '230000001' })]);

    layer.apply({
      snapshots: new Map(),
      removals: new Map([['230000001', 'vessels']]),
      upserts: new Map([
        ['230000001', { entity: makeVessel({ mmsi: '230000001' }), layer: 'vessels' }],
      ]),
    });

    expect(layer.count).toBe(1);
  });

  it('empties the layer on an empty snapshot, which is what a reconnect delivers', () => {
    const { layer } = build();
    layer.upsert([makeVessel({ mmsi: '230000001' })]);

    layer.apply({
      snapshots: new Map([['vessels', []]]),
      removals: new Map(),
      upserts: new Map(),
    });

    expect(layer.count).toBe(0);
  });
});

describe('VesselLayer.setVisible', () => {
  it('hides both collections without dropping a single record', () => {
    const { layer, points, labels } = build();
    layer.upsert([makeVessel({ mmsi: '230000001' })]);

    layer.setVisible(false);

    expect(points.show).toBe(false);
    expect(labels.show).toBe(false);
    // Hidden, never dropped: switching the layer back on has to draw the picture the store
    // has kept rather than waiting a minute for the next poll.
    expect(layer.count).toBe(1);

    layer.setVisible(true);
    expect(points.show).toBe(true);
    expect(labels.show).toBe(true);
  });

  it('stops advancing a hidden layer, which is where its per-frame cost is', () => {
    const { layer } = build();
    layer.upsert(
      [
        makeVessel({
          mmsi: '230000001',
          speed_over_ground_mps: 8,
          course_over_ground_deg: 90,
        }),
      ],
      1000,
    );

    expect(layer.advance(2000)).toBe(true);

    layer.setVisible(false);
    expect(layer.advance(3000)).toBe(false);
  });
});

describe('VesselLayer.countInView', () => {
  it('counts only the ships the camera can see', () => {
    const { layer } = build();
    layer.upsert([
      makeVessel({ mmsi: '230000001', point: { lon: 24.9, lat: 60.2, altitude_m: null } }),
      makeVessel({ mmsi: '230000002', point: { lon: 25.1, lat: 60.4, altitude_m: null } }),
      makeVessel({ mmsi: '235000003', point: { lon: -0.5, lat: 51.4, altitude_m: null } }),
    ]);

    // This layer is why the count exists. Its only keyless provider covers Finnish waters,
    // so it is legitimately live with hundreds of ships and legitimately empty everywhere
    // else, and a row reading "685" over the Atlantic reads as a broken renderer.
    expect(layer.countInView({ west: 17, south: 57, east: 32, north: 66 })).toBe(2);
    expect(layer.countInView({ west: -10, south: 45, east: 5, north: 55 })).toBe(1);
  });

  it('counts none when the camera is somewhere the provider does not cover', () => {
    const { layer } = build();
    layer.upsert([
      makeVessel({ mmsi: '230000001', point: { lon: 24.9, lat: 60.2, altitude_m: null } }),
    ]);

    expect(layer.countInView({ west: -60, south: -40, east: -30, north: -10 })).toBe(0);
  });
});

/**
 * `count` vessels all landing inside a single grid cell.
 *
 * Ten across and one apart down, so any count used here stays inside a single grid cell.
 */
function crowd(count: number, originX = 100, originY = 100) {
  return Array.from({ length: count }, (_unused, index) =>
    makeVessel({
      mmsi: `23000${String(index).padStart(4, '0')}`,
      point: {
        lon: originX + (index % 10),
        lat: originY + Math.floor(index / 10),
        altitude_m: null,
      },
    }),
  );
}

/** Vessels that land on the given pixels. */
function at(pixels: readonly (readonly [number, number])[]) {
  return pixels.map(([x, y], index) =>
    makeVessel({
      mmsi: `2300000${String(index).padStart(2, '0')}`,
      point: { lon: x, lat: y, altitude_m: null },
    }),
  );
}

describe('VesselLayer clustering', () => {
  it('replaces a crowded cell with one vessel and no count', () => {
    // Alexander Fanthome asked on 2026-08-24 to drop the hexagons and merge a group into one asset
    // icon. So the count is deliberately gone from the globe: this asserts its absence, because a
    // stray label is the thing that would quietly bring the clutter back.
    const { layer, points, badges, badgeLabels, frame } = build();
    layer.upsert(crowd(VESSEL_CLUSTER_MIN));

    frame();

    expect(layer.count).toBe(VESSEL_CLUSTER_MIN);
    expect(points.items.filter((item) => item.show)).toHaveLength(0);
    expect(badges.items.filter((item) => item.show)).toHaveLength(1);
    expect(badgeLabels.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('draws the merged vessel at the members mean position, on the surface', () => {
    // The mean of positions on a sphere sits inside it, so a merged icon drawn on the raw mean
    // would be swallowed by the depth buffer. The clusterer pushes it back out to the members'
    // mean distance from the centre, and this asserts the drawn point is that far out rather than
    // nearer in. The fake `Cartesian3` puts longitude in x and latitude in y, so the members'
    // distances are computed the same way here as they are there, from independently written
    // arithmetic over the fixture's own coordinates.
    const { layer, badges, frame } = build();
    const members = crowd(VESSEL_CLUSTER_MIN);
    layer.upsert(members);

    frame();

    const drawn = badges.items.find((item) => item.show);
    if (drawn?.position === undefined) throw new Error('expected a merged vessel');
    const meanRadius =
      members.reduce((total, vessel) => total + Math.hypot(vessel.point.lon, vessel.point.lat), 0) /
      members.length;
    expect(Math.hypot(drawn.position.x, drawn.position.y, drawn.position.z)).toBeCloseTo(
      meanRadius,
      6,
    );
  });

  it('takes the name off a grouped ship even while it is under way', () => {
    // The port rule draws a name for a ship with way on. Grouping outranks it: a ship inside a
    // badge shows nothing of its own, or the badge would sit in a pile of its members' names.
    const { layer, labels, frame } = build();
    layer.upsert(crowd(VESSEL_CLUSTER_MIN));
    expect(labels.items.filter((item) => item.show)).toHaveLength(VESSEL_CLUSTER_MIN);

    frame();

    expect(labels.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('keeps a grouped ship hidden when a fresh position arrives for it', () => {
    // An upsert repaints the mark, and repainting must not undo the grouping until the camera
    // has had a chance to say the cell is no longer crowded.
    const { layer, points, frame } = build();
    layer.upsert(crowd(VESSEL_CLUSTER_MIN));
    frame();

    layer.upsert(crowd(1));

    expect(points.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('publishes a count that adds up', () => {
    const { layer, frame } = build();
    layer.upsert([
      ...crowd(VESSEL_CLUSTER_MIN),
      ...at([
        [900, 500],
        [905, 505],
      ]).map((vessel, index) =>
        makeVessel({ ...vessel, mmsi: `23099${String(index).padStart(4, '0')}` }),
      ),
    ]);

    frame();

    const state = layer.clusterState;
    expect(state).toMatchObject({
      onScreen: VESSEL_CLUSTER_MIN + 2,
      individuals: 2,
      groups: 1,
      inGroups: VESSEL_CLUSTER_MIN,
    });
    expect(state.individuals + state.inGroups).toBe(state.onScreen);
  });

  it('hides its badges with the rail switch', () => {
    const { layer, badges, badgeLabels, frame } = build();
    layer.upsert(crowd(VESSEL_CLUSTER_MIN));
    frame();

    layer.setVisible(false);

    expect(badges.show).toBe(false);
    expect(badgeLabels.show).toBe(false);
    expect(layer.count).toBe(VESSEL_CLUSTER_MIN);
  });

  it('pools its badges rather than removing them', () => {
    const { layer, badges, badgeLabels, frame } = build();
    layer.upsert(crowd(VESSEL_CLUSTER_MIN));
    frame();
    layer.replace([]);

    frame();

    expect(badges.timesRemoved).toBe(0);
    expect(badgeLabels.timesRemoved).toBe(0);
  });

  it('sends a picked badge to a camera position rather than to a card', () => {
    const { layer, badges, frame } = build();
    layer.upsert(crowd(VESSEL_CLUSTER_MIN));
    frame();
    const pickId = badges.items.find((item) => item.show)?.id ?? null;

    const target = layer.clusterFlyTo(pickId);

    expect(parseClusterPickId(pickId)?.layerKey).toBe(VESSEL_CLUSTER_KEY);
    expect(target?.count).toBe(VESSEL_CLUSTER_MIN);
    // Somewhere among its own members: `crowd` lays them out across twenty units from 100.
    expect(target?.lon).toBeGreaterThanOrEqual(100);
    expect(target?.lon).toBeLessThanOrEqual(110);
  });

  it('refuses another layer badge, so one click belongs to one layer', () => {
    const { layer } = build();

    expect(layer.clusterFlyTo('cluster:aircraft:0')).toBeNull();
    expect(layer.clusterFlyTo('satellite:25544')).toBeNull();
  });
});
