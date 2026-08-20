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
 * `PointPrimitiveCollection` mutated in place, never through the Entity API, and a retired
 * aircraft's primitives are pooled rather than removed. If a refactor ever swaps that for
 * remove-and-re-add, these tests fail.
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
      // Cesium's position setters clone, which is what lets the layer reuse one scratch
      // vector for every aircraft in a frame. A fake that aliased instead would make
      // every aircraft appear to sit on top of the last one drawn.
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
      // longitude and latitude that reached Cesium; turning those into ECEF metres is
      // Cesium's job and testing it here would test the fake.
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

const { AircraftLayer } = await import('./aircraft');
const { makeAircraft } = await import('../../testing/aircraft');
const {
  EMERGENCY_COLOUR,
  EMERGENCY_PIXEL_SIZE,
  POINT_PIXEL_SIZE,
  SELECTED_PIXEL_SIZE,
  SELECTION_COLOUR,
  CLASS_COLOURS,
} = await import('../palette');

interface FakeCollection {
  items: {
    position: { x: number; y: number; z: number };
    show: boolean;
    id: string | undefined;
    color: unknown;
    pixelSize: number;
    outlineWidth: number;
    outlineColor: unknown;
    text: string;
    fillColor: unknown;
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
  const layer = new AircraftLayer(
    scene as unknown as ConstructorParameters<typeof AircraftLayer>[0],
  );
  const [points, labels] = primitives;
  if (points === undefined || labels === undefined) {
    throw new Error('the layer did not add both collections to the scene');
  }
  return { layer, points, labels };
}

/** The point currently drawn for this aircraft, found by the id the layer stamps on it. */
function pointFor(points: FakeCollection, icao24: string) {
  return points.items.find((item) => item.id === icao24);
}

describe('AircraftLayer construction', () => {
  it('draws through primitive collections, with the opaque fast path on the points', () => {
    const { points, labels } = build();

    // Two collections, both registered with the scene. If this ever became one Entity per
    // aircraft the collections would not exist at all.
    expect(points.options).toEqual({ blendOption: 'OPAQUE' });
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

    expect(pointFor(points, 'aaa111')?.color).toEqual({ css: CLASS_COLOURS.military });
    expect(pointFor(points, 'aaa111')?.pixelSize).toBe(POINT_PIXEL_SIZE);
    // Size as well as colour: red alone would be invisible to a red/green deficiency.
    expect(pointFor(points, 'bbb222')?.color).toEqual({ css: EMERGENCY_COLOUR });
    expect(pointFor(points, 'bbb222')?.pixelSize).toBe(EMERGENCY_PIXEL_SIZE);
    expect(pointFor(points, 'bbb222')?.outlineColor).toEqual({ css: EMERGENCY_COLOUR });
    expect(pointFor(points, 'bbb222')?.outlineWidth).toBe(2);
  });

  it('gives a routine aircraft a transparent outline rather than a zero-width red one', () => {
    const { layer, points } = build();

    layer.upsert([makeAircraft({ icao24: 'abc123' })], 'aircraft');

    // Cesium antialiases the edge against the outline colour whatever the width, so a
    // zero-width red ring fringed every ordinary aircraft in alert red.
    expect(pointFor(points, 'abc123')?.outlineWidth).toBe(0);
    expect(pointFor(points, 'abc123')?.outlineColor).toBe('TRANSPARENT');
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

    // Two parses at most: the class hue and the label colour. Parsing per aircraft per
    // update would be the hottest thing in the loop.
    expect(cssColourCalls.count - before).toBeLessThanOrEqual(2);
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

  it('rings the selected aircraft in white without changing its hue', () => {
    context.layer.setSelected('aaa111');

    const point = pointFor(context.points, 'aaa111');
    expect(point?.outlineColor).toEqual({ css: SELECTION_COLOUR });
    expect(point?.outlineWidth).toBe(2);
    expect(point?.pixelSize).toBe(SELECTED_PIXEL_SIZE);
    expect(point?.color).toEqual({ css: CLASS_COLOURS.commercial });
  });

  it('clears the ring off the aircraft that was selected before', () => {
    context.layer.setSelected('aaa111');

    context.layer.setSelected('bbb222');

    expect(pointFor(context.points, 'aaa111')?.outlineWidth).toBe(0);
    expect(pointFor(context.points, 'aaa111')?.pixelSize).toBe(POINT_PIXEL_SIZE);
    expect(pointFor(context.points, 'bbb222')?.outlineWidth).toBe(2);
  });

  it('deselects on null', () => {
    context.layer.setSelected('aaa111');

    context.layer.setSelected(null);

    expect(pointFor(context.points, 'aaa111')?.outlineWidth).toBe(0);
  });

  it('lets an emergency win over selection, so an alert is never dressed down', () => {
    context.layer.upsert([makeAircraft({ icao24: 'aaa111', squawk: '7700' })], 'aircraft');

    context.layer.setSelected('aaa111');

    const point = pointFor(context.points, 'aaa111');
    expect(point?.pixelSize).toBe(EMERGENCY_PIXEL_SIZE);
    expect(point?.color).toEqual({ css: EMERGENCY_COLOUR });
  });

  it('forgets the selection when the selected aircraft leaves the feed', () => {
    context.layer.setSelected('aaa111');

    context.layer.remove(['aaa111'], 'aircraft');
    context.layer.upsert([makeAircraft({ icao24: 'aaa111' })], 'aircraft');

    // Reappearing must not silently come back selected, having never been picked.
    expect(pointFor(context.points, 'aaa111')?.outlineWidth).toBe(0);
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
