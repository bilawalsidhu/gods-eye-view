/**
 * Tests for the transit layer, against a fake Cesium.
 *
 * The mock is the vessel layer's, copied because a `vi.mock` factory is hoisted above every import
 * in its own file and cannot be shared. Same trade the other three layer tests already made.
 *
 * What this file is mostly for is the four things this layer does differently from every other
 * mover layer, all of them forced by `src/tracker/contracts/transit.py`: the compound key, the
 * single silhouette, the absence of dead reckoning, and grouping tuned for the densest layer in
 * the app. Each of those is a decision a later tidy-up could undo without noticing.
 */

import { describe, expect, it, vi } from 'vitest';

import type { TransitVehicle } from '../../types/entities';

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
  SELECTED_TRANSIT_ICON_PX,
  TRANSIT_CLUSTER_KEY,
  TRANSIT_CLUSTER_MIN,
  TRANSIT_ICON_PX,
  TransitLayer,
  transitKey,
  transitLabel,
  transitShape,
} = await import('./transit');
const { clusterBadgeImage, iconImage, orientAxis } = await import('../icons');
const { CLUSTER_FILL, TRANSIT_COLOUR, clusterBadgePx } = await import('../palette');
const { parseClusterPickId } = await import('../cluster');
const { badgeSlots } = await import('../badge-slots');

/** A minimal valid vehicle, mirroring the contract's own required fields. */
function makeVehicle(overrides: Partial<TransitVehicle> = {}): TransitVehicle {
  return {
    kind: 'transit',
    feed_id: 'tfl-london',
    entity_id: 'VJ_1234',
    point: { lon: -0.12, lat: 51.5, altitude_m: null },
    observed_at: '2026-08-23T12:00:00Z',
    timestamp_basis: 'vehicle',
    position_age_s: 4,
    source: 'Transport for London',
    licence: 'ODbL 1.0',
    country: 'GB',
    vehicle_id: 'LTZ1234',
    vehicle_label: '38',
    route_id: '38',
    trip_id: 'VJ_1234_1',
    bearing: 187.4,
    speed_ms: 8.2,
    occupancy: null,
    ...overrides,
  };
}

/**
 * A vehicle with `bearing` absent rather than null.
 *
 * `delete` rather than `bearing: undefined`, because `exactOptionalPropertyTypes` is on and, more
 * to the point, because this is what `JSON.parse` of a payload that omits the field actually gives
 * you. Setting it to undefined would be testing a shape the wire never sends.
 */
function withoutBearing(): TransitVehicle {
  const vehicle = makeVehicle();
  delete (vehicle as { bearing?: number | null }).bearing;
  return vehicle;
}

const VIEWPORT_W = 1600;
const VIEWPORT_H = 1000;

/** Maps a fake position's x and y straight to canvas pixels. Column-major, like Cesium's own. */
function pixelProjection(): number[] {
  const m = Array.from({ length: 16 }, () => 0);
  m[0] = 2 / VIEWPORT_W;
  m[12] = -1;
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
    text: string;
    horizontalOrigin: unknown;
    verticalOrigin: unknown;
  }[];
  timesRemoved: number;
  options: unknown;
}

/** A layer wired to a fake scene, plus handles on the four collections it created. */
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
    // At the earth's centre, so the occlusion test passes for everything: these tests are about
    // which vehicles share a cell. The horizon maths has its own tests in `../cluster.test.ts`.
    camera: {
      frustum: { projectionMatrix: pixelProjection() },
      viewMatrix: identity(),
      positionWC: { x: 0, y: 0, z: 0 },
    },
    drawingBufferWidth: VIEWPORT_W,
    drawingBufferHeight: VIEWPORT_H,
  };
  const layer = new TransitLayer(scene as unknown as ConstructorParameters<typeof TransitLayer>[0]);
  const marks = primitives[0];
  const labels = primitives[1];
  const badges = primitives[2];
  const badgeLabels = primitives[3];
  if (
    marks === undefined ||
    labels === undefined ||
    badges === undefined ||
    badgeLabels === undefined
  ) {
    throw new Error('the layer did not add all four collections to the scene');
  }
  const frame = (): void => {
    for (const listener of preUpdateListeners) {
      listener();
    }
  };
  return { layer, marks, labels, badges, badgeLabels, frame };
}

function markFor(marks: FakeCollection, key: string) {
  return marks.items.find((item) => item.id === key);
}

/**
 * `count` vehicles that all land in the same grid cell.
 *
 * `prefix` matters: two calls with the same one produce the same entity ids, and since the key is
 * the feed and entity together the second call would overwrite the first rather than adding to it.
 * That is the compound key doing its job, and it caught a bug in this file's own first draft.
 */
function crowd(count: number, originX = 100, originY = 100, prefix = 'V'): TransitVehicle[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeVehicle({
      entity_id: `${prefix}${String(index).padStart(4, '0')}`,
      point: {
        lon: originX + (index % 10),
        lat: originY + Math.floor(index / 10),
        altitude_m: null,
      },
    }),
  );
}

describe('TransitLayer badge identity', () => {
  it('rims its badge in the colour it draws its own marks in', () => {
    // Before this, all five layers rendered an identical grey hexagon, so a badge reading "6k" could
    // have been six thousand of anything, with several layers in the frame at once. The rim takes the
    // colour this layer already uses for its marks, which is the same constant the rail is handed for
    // its legend row, so the globe and the key cannot drift apart.
    const { layer, badges, frame } = build();
    layer.replace(crowd(TRANSIT_CLUSTER_MIN, 300, 300));

    frame();

    const size = clusterBadgePx(TRANSIT_CLUSTER_MIN);
    const drawn = badges.items.find((item) => item.show)?.image;
    expect(drawn).toBe(clusterBadgeImage(size, CLUSTER_FILL, TRANSIT_COLOUR));
    // Not the old shared grey, which is the regression this guards.
    expect(drawn).not.toBe(clusterBadgeImage(size, CLUSTER_FILL));
  });
});

describe('transitKey', () => {
  it('keys on the feed and the entity together, never on the vehicle id', () => {
    // Measured across 247 feeds: 35.9% of id-carrying vehicles sat on an id another agency was
    // also using, and keying on `vehicle_id` would have collapsed 3,224 vehicles into others.
    const london = makeVehicle({ feed_id: 'tfl-london', entity_id: '557', vehicle_id: '557' });
    const madrid = makeVehicle({ feed_id: 'emt-madrid', entity_id: '557', vehicle_id: '557' });

    expect(transitKey(london)).not.toBe(transitKey(madrid));
  });

  it('keeps two vehicles apart in the layer when they share an id across feeds', () => {
    // The same collision as a drawing, which is what the key exists to stop: one bus swallowing
    // another with nothing erroring.
    const { layer, marks } = build();

    layer.upsert([
      makeVehicle({ feed_id: 'tfl-london', entity_id: '801', vehicle_id: '801' }),
      makeVehicle({ feed_id: 'ratp-paris', entity_id: '801', vehicle_id: '801' }),
    ]);

    expect(layer.count).toBe(2);
    expect(marks.items.filter((item) => item.show)).toHaveLength(2);
  });

  it('separates on a feed-local id that is not unique globally', () => {
    const { layer } = build();

    layer.upsert([
      makeVehicle({ feed_id: 'a', entity_id: '1' }),
      makeVehicle({ feed_id: 'b', entity_id: '1' }),
      makeVehicle({ feed_id: 'a', entity_id: '2' }),
    ]);

    expect(layer.count).toBe(3);
  });

  it('uses a separator neither half of the key can contain', () => {
    // Both halves are operator-supplied strings, so a colon or a dash could appear in either and
    // make two different pairs produce the same key.
    const left = transitKey({ feed_id: 'a:b', entity_id: 'c' });
    const right = transitKey({ feed_id: 'a', entity_id: 'b:c' });

    expect(left).not.toBe(right);
  });
});

describe('transitShape', () => {
  it('draws a vehicle body when the feed reported a bearing', () => {
    expect(transitShape({ bearing: 187.4 })).toBe('vehicle');
    // Zero is a real bearing, due north, and must not be read as absent.
    expect(transitShape({ bearing: 0 })).toBe('vehicle');
  });

  it('draws a square when it did not, rather than a body pointing north', () => {
    expect(transitShape({ bearing: null })).toBe('block');
  });

  it('treats a bearing missing from the payload the same as an explicit null', () => {
    // `bearing` carries a default on the contract, so the generated type is
    // `number | null | undefined` and a feed can omit the field rather than sending null. An
    // earlier version of this compared against null alone and drew a directional body for every
    // one of those, which is precisely the fabricated heading the square exists to avoid. The
    // generated type caught it the moment the placeholder came out.
    expect(transitShape(withoutBearing())).toBe('block');
  });

  it('has only one body shape, because the contract carries no mode', () => {
    // There is no `route_type`, no `vehicle_type` and no `mode` on `TransitVehicle`, and none is
    // derived in `sources/gtfsrt.py`. Two silhouettes would mean guessing which vehicles are
    // trains. If a mode ever lands, this is the test that should change.
    const shapes = new Set([
      transitShape({ bearing: 0 }),
      transitShape({ bearing: 90 }),
      transitShape({ bearing: 359.9 }),
    ]);

    expect(shapes).toEqual(new Set(['vehicle']));
  });
});

describe('transitLabel', () => {
  it('prefers the route, which is what a rider is looking for', () => {
    expect(transitLabel(makeVehicle({ route_id: '38', vehicle_label: 'X' }))).toBe('38');
  });

  it('falls back through the rider-facing label, then the fleet number, then the entity id', () => {
    expect(transitLabel(makeVehicle({ route_id: null }))).toBe('38');
    expect(transitLabel(makeVehicle({ route_id: null, vehicle_label: null }))).toBe('LTZ1234');
    expect(
      transitLabel(
        makeVehicle({ route_id: null, vehicle_label: null, vehicle_id: null, entity_id: 'E9' }),
      ),
    ).toBe('E9');
  });

  it('never returns an empty string, because the entity id is required by the contract', () => {
    const bare = makeVehicle({
      route_id: null,
      vehicle_label: null,
      vehicle_id: null,
      entity_id: 'x',
    });

    expect(transitLabel(bare).length).toBeGreaterThan(0);
  });
});

describe('TransitLayer construction', () => {
  it('draws through four primitive collections, all on the translucent pass', () => {
    const { marks, labels, badges, badgeLabels } = build();

    expect((marks.options as { blendOption: string }).blendOption).toBe('TRANSLUCENT');
    expect((badges.options as { blendOption: string }).blendOption).toBe('TRANSLUCENT');
    // The counts share the badges' pass, or Cesium draws them first and each badge paints over
    // its own number. See AGENTS.md.
    expect((badgeLabels.options as { blendOption: string }).blendOption).toBe('TRANSLUCENT');
    expect(labels.items).toHaveLength(0);
  });
});

describe('TransitLayer drawing', () => {
  it('points the body along the reported bearing, in earth-fixed terms', () => {
    const { layer, marks } = build();

    layer.upsert([
      makeVehicle({ point: { lon: -0.12, lat: 51.5, altitude_m: null }, bearing: 187.4 }),
    ]);

    const key = transitKey(makeVehicle());
    const expected = orientAxis(-0.12, 51.5, 187.4, { x: 0, y: 0, z: 0 });
    expect(markFor(marks, key)?.alignedAxis).toEqual(expected);
  });

  it('leaves a vehicle with no bearing unpointed as well as square', () => {
    // Two independent guards: the square has no nose, and a zero axis means Cesium turns nothing.
    const { layer, marks } = build();

    layer.upsert([withoutBearing()]);

    const mark = markFor(marks, transitKey(makeVehicle()));
    expect(mark?.image).toBe(iconImage('block', TRANSIT_COLOUR, false, TRANSIT_ICON_PX));
    expect(mark?.alignedAxis).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('draws one colour, because the feed reports a speed on two vehicles in five', () => {
    const { layer, marks } = build();

    layer.upsert([
      makeVehicle({ entity_id: 'moving', speed_ms: 12 }),
      makeVehicle({ entity_id: 'still', speed_ms: 0 }),
      makeVehicle({ entity_id: 'unknown', speed_ms: null }),
    ]);

    const images = new Set(marks.items.filter((item) => item.show).map((item) => item.image));
    expect(images.size).toBe(1);
  });

  it('shares one image across a fleet, which is one texture atlas entry', () => {
    const { layer, marks } = build();

    layer.upsert(crowd(40));

    expect(new Set(marks.items.map((item) => item.image)).size).toBe(1);
  });

  it('parses each CSS colour once however many vehicles use it', () => {
    const { layer } = build();
    const before = cssColourCalls.count;

    layer.upsert(crowd(40));

    // The mark's hue is inside its own image, so the only CSS parsed here is text colour.
    expect(cssColourCalls.count - before).toBeLessThanOrEqual(2);
  });

  it('labels only the selected vehicle', () => {
    // Ten to twenty thousand vehicles concentrated in cities turn any distance-based label rule
    // into a wall of text over the places a viewer is trying to read.
    const { layer, labels } = build();
    layer.upsert(crowd(6));
    expect(labels.items.filter((item) => item.show)).toHaveLength(0);

    layer.setSelected(transitKey({ feed_id: 'tfl-london', entity_id: 'V0003' }));

    expect(labels.items.filter((item) => item.show)).toHaveLength(1);
  });

  it('mutates the existing primitive in place instead of adding a second one', () => {
    const { layer, marks } = build();
    layer.upsert([makeVehicle({ point: { lon: 1, lat: 1, altitude_m: null } })]);
    const first = marks.items[0];

    for (let index = 0; index < 50; index += 1) {
      layer.upsert([makeVehicle({ point: { lon: index, lat: 2, altitude_m: null } })]);
    }

    expect(marks.items).toHaveLength(1);
    expect(marks.items[0]).toBe(first);
    expect(first?.position).toEqual({ x: 49, y: 2, z: 0 });
  });

  it('ignores a removal for a vehicle it never held', () => {
    // A stale removal must not throw and must not disturb what is drawn. The docstring on `remove`
    // promises this, so it is tested rather than assumed.
    const { layer, marks } = build();
    layer.upsert([makeVehicle()]);

    layer.remove(['some-other-feed\tsome-other-entity']);

    expect(layer.count).toBe(1);
    expect(marks.items.filter((item) => item.show)).toHaveLength(1);
  });

  it('never removes a primitive from a collection, which would rebuild its buffers', () => {
    const { layer, marks, labels } = build();

    layer.replace([makeVehicle({ entity_id: 'a' }), makeVehicle({ entity_id: 'b' })]);
    layer.remove([transitKey({ feed_id: 'tfl-london', entity_id: 'a' })]);
    layer.replace([]);

    expect(marks.timesRemoved).toBe(0);
    expect(labels.timesRemoved).toBe(0);
  });
});

describe('TransitLayer.advance', () => {
  it('never extrapolates, and says so, so the render loop costs nothing', () => {
    // A ship at sea keeps going in a straight line; a bus stops at every stop and turns at every
    // junction. At a fifteen-second feed cadence a vehicle reporting 8 m/s would be drawn 120
    // metres along its bearing, which for a road vehicle is the wrong street.
    const { layer } = build();
    layer.upsert([makeVehicle({ speed_ms: 12, bearing: 90 })]);

    expect(layer.advance()).toBe(false);
  });

  it('leaves the vehicle exactly where the feed put it', () => {
    const { layer, marks } = build();
    layer.upsert([
      makeVehicle({ point: { lon: 5, lat: 6, altitude_m: null }, speed_ms: 20, bearing: 90 }),
    ]);

    layer.advance();

    const key = transitKey(makeVehicle());
    expect(markFor(marks, key)?.position).toEqual({ x: 5, y: 6, z: 0 });
  });
});

describe('TransitLayer badge placement', () => {
  it('holds its badges still across passes rather than walking them a cell per frame', () => {
    // This layer draws the most badges of any, so it feels a self-displacement first. It releases its
    // own lattice claims before making them again, so a pass contends with the other layers and never
    // with itself. One pass looks right either way; the fault only appears on the second.
    const { layer, badges, frame } = build();
    badgeSlots.reset();
    layer.replace(crowd(TRANSIT_CLUSTER_MIN, 400, 300));

    frame();
    const first = { ...badges.items.find((item) => item.show)?.pixelOffset };
    for (let pass = 0; pass < 5; pass += 1) {
      frame();
    }

    expect({ ...badges.items.find((item) => item.show)?.pixelOffset }).toEqual(first);
  });

  it('gives up the point it holds when the rail switches the layer off', () => {
    // A dark layer that kept its claims would push every other layer's badges aside for as long as it
    // stayed off, which reads as the other layers being wrong.
    const { layer, frame } = build();
    badgeSlots.reset();
    layer.replace(crowd(TRANSIT_CLUSTER_MIN, 400, 300));
    frame();
    expect(badgeSlots.claimed).toBeGreaterThan(0);

    layer.setVisible(false);
    frame();

    expect(badgeSlots.claimed).toBe(0);
  });
});

describe('TransitLayer clustering', () => {
  it('leaves a cell one short of the minimum drawn as vehicles', () => {
    const short = TRANSIT_CLUSTER_MIN - 1;
    const { layer, marks, badges, frame } = build();
    layer.upsert(crowd(short));

    frame();

    expect(marks.items.filter((item) => item.show)).toHaveLength(short);
    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('replaces a crowded cell with one badge carrying the count', () => {
    const many = TRANSIT_CLUSTER_MIN + 3;
    const { layer, marks, badges, badgeLabels, frame } = build();
    layer.upsert(crowd(many));

    frame();

    expect(layer.count).toBe(many);
    expect(marks.items.filter((item) => item.show)).toHaveLength(0);
    expect(badges.items.filter((item) => item.show)).toHaveLength(1);
    expect(badgeLabels.items.find((item) => item.show)?.text).toBe(String(many));
  });

  it('groups harder than the vessel layer, because it is denser still', () => {
    // Aircraft ten, vessels fifteen, satellites thirty. This one is tuned to the zoom it is read
    // at rather than inherited: at a city zoom a 56-pixel cell holds about eight full-size marks.
    expect(TRANSIT_CLUSTER_MIN).toBeGreaterThan(8);
    expect(TRANSIT_CLUSTER_MIN).toBeLessThan(20);
  });

  it('publishes a count that adds up, which is what the rail rests on', () => {
    const grouped = TRANSIT_CLUSTER_MIN;
    const { layer, frame } = build();
    layer.upsert([...crowd(grouped), ...crowd(1, 900, 500, 'alone')]);

    frame();

    const state = layer.clusterState;
    expect(state).toMatchObject({ onScreen: grouped + 1, individuals: 1, groups: 1 });
    expect(state.individuals + state.inGroups).toBe(state.onScreen);
  });

  it('hides its badges with the rail switch', () => {
    const { layer, badges, badgeLabels, frame } = build();
    layer.upsert(crowd(TRANSIT_CLUSTER_MIN));
    frame();

    layer.setVisible(false);

    expect(badges.show).toBe(false);
    expect(badgeLabels.show).toBe(false);
    expect(layer.count).toBe(TRANSIT_CLUSTER_MIN);
  });

  it('keeps the selected vehicle labelled through a regroup that leaves it drawn', () => {
    // The label rule is evaluated inside the clustering pass as well as on upsert, so a pass has to
    // preserve it. A selected vehicle that is not grouped keeps its label.
    const { layer, labels, frame } = build();
    layer.upsert(crowd(2));
    const key = transitKey({ feed_id: 'tfl-london', entity_id: 'V0001' });
    layer.setSelected(key);

    frame();

    expect(labels.items.filter((item) => item.show)).toHaveLength(1);
  });

  it('does no work at all while the layer is switched off', () => {
    // The pass is O(n) over every vehicle and n is twenty thousand at the peak, so projecting a
    // hidden layer would be the largest piece of discarded work in the app.
    const { layer, marks, badges, frame } = build();
    layer.upsert(crowd(TRANSIT_CLUSTER_MIN));
    frame();
    expect(badges.items.filter((item) => item.show)).toHaveLength(1);

    layer.setVisible(false);
    // Move every vehicle somewhere that would regroup differently, then run a pass.
    layer.upsert(crowd(TRANSIT_CLUSTER_MIN, 700, 700));
    frame();

    // Untouched: the marks still carry the grouping from the last pass that ran.
    expect(marks.items.filter((item) => item.show)).toHaveLength(0);
    expect(layer.clusterState.inGroups).toBe(TRANSIT_CLUSTER_MIN);
  });

  it('pools its badges rather than removing them', () => {
    const { layer, badges, frame } = build();
    layer.upsert(crowd(TRANSIT_CLUSTER_MIN));
    frame();
    layer.replace([]);

    frame();

    expect(badges.timesRemoved).toBe(0);
    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('sends a picked badge to a camera position rather than to a card', () => {
    const { layer, badges, frame } = build();
    layer.upsert(crowd(TRANSIT_CLUSTER_MIN));
    frame();
    const pickId = badges.items.find((item) => item.show)?.id ?? null;

    const target = layer.clusterFlyTo(pickId);

    expect(parseClusterPickId(pickId)?.layerKey).toBe(TRANSIT_CLUSTER_KEY);
    expect(target?.count).toBe(TRANSIT_CLUSTER_MIN);
    expect(target?.altitudeM).toBeGreaterThan(0);
  });

  it('refuses another layer badge, so one click belongs to one layer', () => {
    const { layer } = build();

    expect(layer.clusterFlyTo('cluster:vessels:0')).toBeNull();
    expect(layer.clusterFlyTo('satellite:25544')).toBeNull();
    expect(layer.clusterFlyTo(null)).toBeNull();
  });

  it('refuses a badge that has since dissolved rather than flying to whatever is there now', () => {
    // Cells are numbered per pass, so an id captured from a click can name a cell that is no longer
    // a group. Resolving it to the current occupant would fly the camera somewhere nobody clicked.
    const { layer, frame } = build();
    layer.upsert(crowd(2));
    frame();

    expect(layer.clusterFlyTo('cluster:transit:0')).toBeNull();
  });

  it('keeps a grouped vehicle hidden when a fresh position arrives for it', () => {
    const { layer, marks, frame } = build();
    layer.upsert(crowd(TRANSIT_CLUSTER_MIN));
    frame();

    layer.upsert(crowd(1));

    expect(marks.items.filter((item) => item.show)).toHaveLength(0);
  });
});

describe('TransitLayer.setSelected', () => {
  it('ignores a repeat of the current selection', () => {
    // An early return rather than a second pass over the marks. Clicking the same vehicle twice is
    // the commonest interaction there is.
    const { layer, marks } = build();
    layer.upsert([makeVehicle()]);
    const key = transitKey(makeVehicle());

    layer.setSelected(key);
    layer.setSelected(key);

    const expected = iconImage('vehicle', TRANSIT_COLOUR, true, SELECTED_TRANSIT_ICON_PX);
    expect(markFor(marks, key)?.image).toBe(expected);
  });

  it('forgets the selection when the selected vehicle leaves the feed', () => {
    // A vehicle goes out of service and its key comes back on the next shift. Reappearing must not
    // silently come back selected, having never been picked.
    const { layer, marks } = build();
    const key = transitKey(makeVehicle());
    layer.upsert([makeVehicle()]);
    layer.setSelected(key);

    layer.replace([]);
    layer.upsert([makeVehicle()]);

    const unselected = iconImage('vehicle', TRANSIT_COLOUR, false, TRANSIT_ICON_PX);
    expect(markFor(marks, key)?.image).toBe(unselected);
  });

  it('survives selecting a vehicle the layer does not hold', () => {
    const { layer } = build();
    layer.upsert([makeVehicle()]);

    expect(() => {
      layer.setSelected('no-such-feed\tno-such-entity');
    }).not.toThrow();
  });
});

describe('TransitLayer.countInView', () => {
  /**
   * Here for parity with the other layers, and tested for the same reason.
   *
   * The rail should use `clusterState.onScreen` instead: that projects every vehicle through the
   * camera matrix, where this depends on `camera.computeViewRectangle`, which reads zero at
   * whole-globe zoom while marks are visibly drawn. Given a rectangle that really does cover what
   * the camera sees, though, the counting itself is correct, and that is what this pins down.
   */
  it('counts only the vehicles inside the rectangle', () => {
    const { layer } = build();
    layer.upsert([
      makeVehicle({ entity_id: 'in', point: { lon: 0, lat: 51, altitude_m: null } }),
      makeVehicle({ entity_id: 'out', point: { lon: 120, lat: -30, altitude_m: null } }),
    ]);

    expect(layer.countInView({ west: -10, south: 45, east: 10, north: 60 })).toBe(1);
  });

  it('counts everything when the rectangle is the whole world', () => {
    // Real longitudes and latitudes, not `crowd`'s. That helper places vehicles by screen pixel,
    // which the projection fake passes straight through, so it happily produces a latitude of 100.
    // Fine for the clustering tests and meaningless to a function that compares real geography.
    const { layer } = build();
    layer.upsert(
      [
        [-170, -80],
        [0, 0],
        [24.9, 60.2],
        [179, 82],
      ].map(([lon, lat], index) =>
        makeVehicle({
          entity_id: `world-${index}`,
          point: { lon: lon ?? 0, lat: lat ?? 0, altitude_m: null },
        }),
      ),
    );

    expect(layer.countInView({ west: -180, south: -90, east: 180, north: 90 })).toBe(4);
  });
});

describe('TransitLayer sizing', () => {
  it('draws the smallest directional mark in the app, because it is the densest layer', () => {
    // Vessels are 22 and satellites 18. This one carries two to three times the records of the
    // next biggest, concentrated in cities rather than spread over an ocean.
    expect(TRANSIT_ICON_PX).toBeLessThan(22);
    expect(SELECTED_TRANSIT_ICON_PX).toBeGreaterThan(TRANSIT_ICON_PX);
  });

  it('shrinks with camera range, and never shrinks the selected vehicle', () => {
    const { layer, marks, frame } = build();
    layer.upsert([makeVehicle()]);
    frame();
    const scale = markFor(marks, transitKey(makeVehicle()))?.scaleByDistance as {
      nearValue: number;
      farValue: number;
    };
    expect(scale.nearValue).toBe(1);
    expect(scale.farValue).toBeLessThan(0.3);

    layer.setSelected(transitKey(makeVehicle()));

    const selected = markFor(marks, transitKey(makeVehicle()))?.scaleByDistance as {
      farValue: number;
    };
    expect(selected.farValue).toBe(1);
  });
});

describe('the peak load', () => {
  it('regroups twenty thousand vehicles without growing or churning a collection', () => {
    // The measured daily peak is 20,349 vehicles, which is why this is the number.
    //
    // **There is deliberately no wall-clock assertion here, and that is a correction.** The first
    // version of this test measured the pass and asserted it under 120ms. In isolation it takes
    // 12.6ms, instrumented or not. Inside the full suite, where vitest runs files in parallel
    // workers, the same pass measured 792ms and 1508ms on two runs out of three: a 120-fold spread
    // that has nothing to do with the code under test. That is a flake dressed as a guard, and it
    // failed the shared gate twice before this comment replaced it.
    //
    // What is asserted instead is the thing that actually breaks: every vehicle is accounted for,
    // and a pass over twenty thousand of them neither grows a collection nor removes from one.
    // To take the timing figure, run this file alone with
    // `pnpm vitest run src/globe/layers/transit.test.ts --coverage=false` and time the pass by
    // hand; it is 12.6ms on this machine and coverage instrumentation barely moves it, unlike the
    // SGP4 loop in `../satellites/orbit.test.ts`.
    const { layer, marks, badges, frame } = build();
    layer.upsert(
      Array.from({ length: 20_000 }, (_unused, index) =>
        makeVehicle({
          entity_id: `peak-${index}`,
          point: {
            lon: ((index * 7) % 1400) + 100,
            lat: ((index * 13) % 800) + 100,
            altitude_m: null,
          },
        }),
      ),
    );
    frame();
    const drawn = marks.items.length;
    const badgesDrawn = badges.items.length;

    frame();

    expect(layer.count).toBe(20_000);
    // The count adds up at peak, which is the promise clustering makes however many there are.
    const state = layer.clusterState;
    expect(state.onScreen).toBe(state.individuals + state.inGroups);
    expect(state.groups).toBeGreaterThan(0);
    // A second pass over the same twenty thousand allocates no new primitive and removes none.
    expect(marks.items).toHaveLength(drawn);
    expect(badges.items).toHaveLength(badgesDrawn);
    expect(marks.timesRemoved).toBe(0);
    expect(badges.timesRemoved).toBe(0);
  });
});
