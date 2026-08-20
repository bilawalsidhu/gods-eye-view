/**
 * Tests for the satellite layer, against a fake Cesium.
 *
 * Same approach as `aircraft.test.ts` and for the same reason: every collection here is a
 * WebGL resource and there is no context in a test runner. The fake is faithful where it
 * matters, which is that assigning a position clones it and that the collections record every
 * `add` and `remove`.
 *
 * Most of what follows is the render contract rather than the drawing. Satellites go through
 * a `PointPrimitiveCollection` mutated in place, a retired satellite's primitive is pooled
 * rather than removed, and exactly one polyline exists no matter how many satellites are on
 * the globe. A refactor to the Entity API, or to a trail per object, fails here.
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
      color: undefined as unknown,
      pixelSize: 0,
      outlineWidth: 0,
      outlineColor: undefined as unknown,
      // Polyline fields.
      positions: [] as { x: number; y: number; z: number }[],
      width: 0,
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
    BlendOption: { OPAQUE: 'OPAQUE' },
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
    PointPrimitiveCollection: FakeCollection,
    PolylineCollection: FakeCollection,
  };
});

const {
  ORBIT_TRAIL_WIDTH,
  SATELLITE_COLOUR,
  SATELLITE_PICK_PREFIX,
  SATELLITE_PIXEL_SIZE,
  SATELLITE_SELECTED_PIXEL_SIZE,
  SatelliteLayer,
  noradFromPickId,
} = await import('./satellites');
const { SELECTION_COLOUR } = await import('../palette');

interface FakeCollection {
  items: {
    position: { x: number; y: number; z: number };
    show: boolean;
    id: string | undefined;
    color: unknown;
    pixelSize: number;
    outlineWidth: number;
    outlineColor: unknown;
    positions: { x: number; y: number; z: number }[];
    width: number;
    material: unknown;
  }[];
  show: boolean;
  timesRemoved: number;
  options: unknown;
}

/** A layer wired to a fake scene, plus handles on the two collections it created. */
function build() {
  const primitives: FakeCollection[] = [];
  const scene = {
    primitives: {
      add: (collection: FakeCollection) => {
        primitives.push(collection);
      },
    },
  };
  const layer = new SatelliteLayer(
    scene as unknown as ConstructorParameters<typeof SatelliteLayer>[0],
  );
  const [points, trails] = primitives;
  if (points === undefined || trails === undefined) {
    throw new Error('the layer did not add both collections to the scene');
  }
  return { layer, points, trails };
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
  it('draws through primitive collections, with the opaque fast path on the points', () => {
    const { points, trails } = build();

    expect(points.options).toEqual({ blendOption: 'OPAQUE' });
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

  it('paints one hue for the layer and the small unselected size', () => {
    const { layer, points } = build();

    layer.apply(...tick([ISS]));

    const point = pointFor(points, ISS.id);
    expect(point?.color).toMatchObject({ css: SATELLITE_COLOUR });
    expect(point?.pixelSize).toBe(SATELLITE_PIXEL_SIZE);
    // Transparent rather than a zero-width coloured outline: Cesium antialiases the edge
    // against the outline colour either way.
    expect(point?.outlineWidth).toBe(0);
    expect(point?.outlineColor).toBe('TRANSPARENT');
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

describe('selection', () => {
  it('rings and enlarges the selected satellite and nothing else', () => {
    const { layer, points } = build();
    layer.apply(...tick([ISS, HST]));

    layer.setSelected(ISS.id);

    expect(pointFor(points, ISS.id)?.pixelSize).toBe(SATELLITE_SELECTED_PIXEL_SIZE);
    expect(pointFor(points, ISS.id)?.outlineWidth).toBe(2);
    expect(pointFor(points, ISS.id)?.outlineColor).toMatchObject({ css: SELECTION_COLOUR });
    expect(pointFor(points, HST.id)?.pixelSize).toBe(SATELLITE_PIXEL_SIZE);
  });

  it('clears the previous ring when the selection moves, and on deselection', () => {
    const { layer, points } = build();
    layer.apply(...tick([ISS, HST]));

    layer.setSelected(ISS.id);
    layer.setSelected(HST.id);

    expect(pointFor(points, ISS.id)?.outlineWidth).toBe(0);
    expect(pointFor(points, HST.id)?.outlineWidth).toBe(2);

    layer.setSelected(null);
    expect(pointFor(points, HST.id)?.outlineWidth).toBe(0);
  });

  it('does nothing when the same satellite is selected twice', () => {
    const { layer, points } = build();
    layer.apply(...tick([ISS]));

    layer.setSelected(ISS.id);
    layer.setSelected(ISS.id);

    expect(pointFor(points, ISS.id)?.pixelSize).toBe(SATELLITE_SELECTED_PIXEL_SIZE);
  });

  it('selects a satellite that has not been drawn yet, and rings it when it arrives', () => {
    const { layer, points } = build();

    layer.setSelected(ISS.id);
    layer.apply(...tick([ISS]));

    expect(pointFor(points, ISS.id)?.outlineWidth).toBe(2);
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
