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
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cesium', () => {
  /** One shape for points and labels alike: the layer only ever assigns fields. */
  // eslint-disable-next-line unicorn/consistent-function-scoping -- a vi.mock factory is hoisted above every import in the file, so it cannot reference anything declared outside itself.
  function makePrimitive() {
    let position = { x: 0, y: 0, z: 0 };
    return {
      get position() {
        return position;
      },
      // Cesium's position setters clone. A fake that aliased instead would make every
      // vessel appear to sit on top of the last one drawn.
      set position(value: { x: number; y: number; z: number }) {
        position = { x: value.x, y: value.y, z: value.z };
      },
      show: false,
      id: undefined as string | undefined,
      color: undefined as unknown,
      pixelSize: 0,
      outlineWidth: 0,
      outlineColor: undefined as unknown,
      text: '',
      fillColor: undefined as unknown,
      font: '',
      style: undefined as unknown,
      horizontalOrigin: undefined as unknown,
      verticalOrigin: undefined as unknown,
      pixelOffset: undefined as unknown,
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

    add(): ReturnType<typeof makePrimitive> {
      const primitive = makePrimitive();
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
    BlendOption: { OPAQUE: 'OPAQUE' },
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
    HorizontalOrigin: { LEFT: 'LEFT' },
    LabelCollection: FakeCollection,
    LabelStyle: { FILL_AND_OUTLINE: 'FILL_AND_OUTLINE' },
    PointPrimitiveCollection: FakeCollection,
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
  VESSEL_PIXEL_SIZE,
  SELECTED_VESSEL_PIXEL_SIZE,
  MAX_DEAD_RECKON_SECONDS,
} = await import('./vessels');
const { makeVessel } = await import('../../testing/vessel');
const { SELECTION_COLOUR } = await import('../palette');

interface FakeCollection {
  show?: boolean;
  items: {
    position: { x: number; y: number; z: number };
    show: boolean;
    id: string | undefined;
    color: unknown;
    pixelSize: number;
    outlineWidth: number;
    outlineColor: unknown;
    text: string;
  }[];
  timesRemoved: number;
  options: unknown;
}

/** A layer wired to a fake scene, plus direct handles on the collections it created. */
function build() {
  const primitives: FakeCollection[] = [];
  const scene = {
    primitives: {
      add: (collection: FakeCollection) => {
        primitives.push(collection);
      },
    },
  };
  const layer = new VesselLayer(scene as unknown as ConstructorParameters<typeof VesselLayer>[0]);
  const [points, labels] = primitives;
  if (points === undefined || labels === undefined) {
    throw new Error('the layer did not add both collections to the scene');
  }
  return { layer, points, labels };
}

/** The point currently drawn for this vessel, found by the MMSI the layer stamps on it. */
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

describe('VesselLayer construction', () => {
  it('draws through primitive collections, with the opaque fast path on the points', () => {
    const { points, labels } = build();

    // Two collections, both registered with the scene. One Cesium Entity per vessel would
    // mean these did not exist at all.
    expect(points.options).toEqual({ blendOption: 'OPAQUE' });
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

    expect(pointFor(points, '230000001')?.color).toEqual({ css: UNDER_WAY_COLOUR });
    expect(pointFor(points, '230000002')?.color).toEqual({ css: STOPPED_COLOUR });
  });

  it('draws vessels small, so a full berth keeps its structure', () => {
    const { layer, points } = build();

    layer.upsert([makeVessel({ mmsi: '230123450' })]);

    expect(pointFor(points, '230123450')?.pixelSize).toBe(VESSEL_PIXEL_SIZE);
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

    // Two parses at most for a fleet all in the same state: the hue and the label colour.
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

  it('rings the selected vessel in white without changing its hue', () => {
    context.layer.setSelected('230000001');

    const point = pointFor(context.points, '230000001');
    expect(point?.outlineColor).toEqual({ css: SELECTION_COLOUR });
    expect(point?.outlineWidth).toBe(2);
    expect(point?.pixelSize).toBe(SELECTED_VESSEL_PIXEL_SIZE);
    expect(point?.color).toEqual({ css: UNDER_WAY_COLOUR });
  });

  it('clears the ring off the vessel that was selected before', () => {
    context.layer.setSelected('230000001');

    context.layer.setSelected('230000002');

    expect(pointFor(context.points, '230000001')?.outlineWidth).toBe(0);
    expect(pointFor(context.points, '230000001')?.outlineColor).toBe('TRANSPARENT');
    expect(pointFor(context.points, '230000001')?.pixelSize).toBe(VESSEL_PIXEL_SIZE);
    expect(pointFor(context.points, '230000002')?.outlineWidth).toBe(2);
  });

  it('deselects on null', () => {
    context.layer.setSelected('230000001');

    context.layer.setSelected(null);

    expect(pointFor(context.points, '230000001')?.outlineWidth).toBe(0);
  });

  it('ignores a repeat of the current selection', () => {
    context.layer.setSelected('230000001');

    context.layer.setSelected('230000001');

    expect(pointFor(context.points, '230000001')?.outlineWidth).toBe(2);
  });

  it('survives selecting a vessel the layer does not hold', () => {
    context.layer.setSelected('230999999');

    expect(pointFor(context.points, '230000001')?.outlineWidth).toBe(0);
  });

  it('keeps the selection ring across a position update', () => {
    context.layer.setSelected('230000001');

    context.layer.upsert([makeVessel({ mmsi: '230000001' })]);

    // The ring is reapplied on upsert rather than being lost until the next click.
    expect(pointFor(context.points, '230000001')?.outlineWidth).toBe(2);
    expect(pointFor(context.points, '230000001')?.pixelSize).toBe(SELECTED_VESSEL_PIXEL_SIZE);
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
