/**
 * Tests for the city layer, against a fake Cesium.
 *
 * Cesium is mocked rather than driven for real because a `LabelCollection` is a WebGL
 * resource and there is no context in a test runner. The fake is faithful in the two places
 * that matter: assigning a position clones it, exactly as Cesium's setter does, and the
 * collection records every `add`, `remove` and `removeAll` so the render policy can be
 * asserted rather than assumed.
 *
 * Three claims are what most of this file exists to prove, because all three are in the
 * phase 4 acceptance criteria and all three are easy to assert and never check.
 *
 * Labels are banded by population, so a world view is capitals and a city view is towns.
 * The collection is mutated in place and never rebuilt, however far the camera moves.
 * And a switched-off layer costs nothing: no per-frame work, no glyph churn, no request.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cesium', () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- a vi.mock factory is hoisted above every import in the file, so it cannot reference anything declared outside itself.
  function makeLabel() {
    let position = { x: 0, y: 0, z: 0 };
    return {
      get position() {
        return position;
      },
      // Cesium's position setter clones, which is what lets the layer reuse one scratch
      // vector for every city in a refresh. A fake that aliased instead would make every
      // label appear to sit on top of the last one written.
      set position(value: { x: number; y: number; z: number }) {
        position = { x: value.x, y: value.y, z: value.z };
      },
      show: false,
      text: '',
      // `Label.id` in Cesium is `any` and is documented as the user-defined object handed
      // back by `Scene#pick`. Nothing about the label's appearance reads it, which is the
      // whole reason a pick id can be added without changing the picture.
      id: undefined as unknown,
      font: '',
      fillColor: undefined as unknown,
      style: undefined as unknown,
      outlineColor: undefined as unknown,
      outlineWidth: 0,
      horizontalOrigin: undefined as unknown,
      verticalOrigin: undefined as unknown,
      distanceDisplayCondition: undefined as unknown,
    };
  }

  class FakeLabelCollection {
    readonly items: ReturnType<typeof makeLabel>[] = [];
    readonly options: unknown;
    show = true;
    timesRemoved = 0;

    constructor(options?: unknown) {
      this.options = options;
    }

    add(options?: Record<string, unknown>): ReturnType<typeof makeLabel> {
      const label = makeLabel();
      Object.assign(label, options ?? {});
      this.items.push(label);
      return label;
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
  const conditionsMade = { count: 0 };

  return {
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
        conditionsMade.count += 1;
      }
    },
    HorizontalOrigin: { CENTER: 'CENTER', LEFT: 'LEFT' },
    // A real column-major 4x4 multiply rather than a stub. The label reservation builds its view
    // projection by multiplying the camera's projection and view matrices and hands the product to
    // `projectToScreen`, so a fake that ignored its operands would make the reservation land wherever
    // the stub happened to point. The projection maths itself is tested for real in
    // `globe/cluster.test.ts`, which needs no Cesium at all.
    Matrix4: class FakeMatrix4 {
      readonly length = 16;
      [index: number]: number;

      constructor() {
        for (let at = 0; at < 16; at += 1) {
          this[at] = 0;
        }
      }

      static multiply(left: FakeMatrix4, right: FakeMatrix4, result: FakeMatrix4): FakeMatrix4 {
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
    LabelCollection: FakeLabelCollection,
    LabelStyle: { FILL_AND_OUTLINE: 'FILL_AND_OUTLINE' },
    VerticalOrigin: { CENTER: 'CENTER' },
    // Exposed so the allocation claims can be proved rather than described.
    __cssColourCalls: cssColourCalls,
    __conditionsMade: conditionsMade,
  };
});

const { __cssColourCalls: cssColourCalls, __conditionsMade: conditionsMade } = (await import(
  'cesium'
)) as unknown as {
  __cssColourCalls: { count: number };
  __conditionsMade: { count: number };
};

const {
  CITY_LABEL_BUDGET,
  CITY_LABEL_CELL_PX,
  CITY_LAYER,
  CITY_PICK_PREFIX,
  CityLayer,
  POPULATION_BANDS,
  bandFor,
  cityView,
  geonamesFromPickId,
} = await import('./cities');
const { makeCity } = await import('../../testing/city');
const { badgeSlots } = await import('../badge-slots');
const { CLUSTER_CELL_PX } = await import('../cluster');
import type { City } from '../../types/entities';

interface FakeLabel {
  position: { x: number; y: number; z: number };
  show: boolean;
  text: string;
  id: unknown;
  font: string;
  fillColor: unknown;
  style: unknown;
  outlineColor: unknown;
  outlineWidth: number;
  horizontalOrigin: unknown;
  verticalOrigin: unknown;
  distanceDisplayCondition: { near: number; far: number } | undefined;
}

interface FakeLabelCollection {
  items: FakeLabel[];
  options: unknown;
  show: boolean;
  timesRemoved: number;
}

/**
 * A view projection that maps world x and y straight to pixels in a 1400 by 800 viewport.
 *
 * Column-major, like Cesium's own layout. Only the terms `projectToScreen` reads are set.
 */
function pixelProjection(): number[] {
  const m = Array.from({ length: 16 }, () => 0);
  m[0] = 2 / 1400;
  m[12] = -1;
  m[5] = -2 / 800;
  m[13] = 1;
  m[15] = 1;
  return m;
}

/** Identity, so multiplying by the view matrix leaves the projection alone. */
function identityMatrix(): number[] {
  const m = Array.from({ length: 16 }, () => 0);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** A layer wired to a fake scene, plus a direct handle on the collection it created. */
function build() {
  const collections: FakeLabelCollection[] = [];
  const scene = {
    primitives: {
      add: (collection: FakeLabelCollection) => {
        collections.push(collection);
      },
    },
    // The label cell grid is measured in pixels, so the layer reads the viewport. 1400x800 is the
    // size every collision measurement in this file was taken at.
    drawingBufferWidth: 1400,
    drawingBufferHeight: 800,
    // The canvas, for the drawing-buffer to CSS pixel ratio the label reservation carries. Equal to
    // the buffer, which is what Cesium does unless `resolutionScale` is changed.
    canvas: { clientWidth: 1400, clientHeight: 800 },
    // A camera, because the reservation projects each label through the real view projection rather
    // than through this layer's flat cell arithmetic. The two spaces agree over a city and diverge at
    // a whole-Earth view, so the reservation has to use the one the badges use.
    //
    // A matrix that maps world x and y straight to pixels, so a test can put a city at a pixel and
    // assert on it, and an eye at the origin, which is what every layer fixture here does. The
    // occlusion half of the reservation cannot be modelled faithfully against a pixel passthrough,
    // because these fake positions are nowhere near an ellipsoid; `occludedByGlobe` has its own
    // tests in `globe/cluster.test.ts` against real earth-fixed geometry.
    camera: {
      frustum: { projectionMatrix: pixelProjection() },
      viewMatrix: identityMatrix(),
      positionWC: { x: 0, y: 0, z: 0 },
    },
  };
  const layer = new CityLayer(scene as unknown as ConstructorParameters<typeof CityLayer>[0]);
  const [labels] = collections;
  if (labels === undefined) {
    throw new Error('the layer did not add its collection to the scene');
  }
  return { layer, labels };
}

/** Camera heights the acceptance criteria talk about, in metres. */
const WHOLE_GLOBE_M = 20_000_000;
const CONTINENT_M = 4_000_000;
const COUNTRY_M = 800_000;
const REGION_M = 150_000;
const STREET_M = 1000;

/** The whole world in view, at a given height. */
function everywhere(heightM: number) {
  return { west: -180, south: -90, east: 180, north: 90, heightM };
}

/** The names currently drawn, in the order the layer wrote them. */
function drawn(labels: FakeLabelCollection): string[] {
  return labels.items.filter((label) => label.show).map((label) => label.text);
}

/**
 * One city per band, spread out, so only population decides what is drawn.
 *
 * They used to share one point, which made the same claim more directly. They cannot any more: the
 * layer now draws one label per screen cell, so six cities at one coordinate is six cities in one
 * cell and only the largest would appear. Forty degrees apart is more than one cell wide at every
 * view these tests use, which is a whole-world rectangle where a 96px cell spans about 25 degrees
 * of longitude, so the cell rule never fires here and population is still the only thing deciding.
 */
const LADDER: City[] = [
  makeCity({ geonames_id: 1, name: 'Tokyo', population: 24_874_500, point: at(-150, 0) }),
  makeCity({ geonames_id: 2, name: 'Hamburg', population: 1_845_000, point: at(-100, 0) }),
  makeCity({ geonames_id: 3, name: 'Cardiff', population: 447_000, point: at(-50, 0) }),
  makeCity({ geonames_id: 4, name: 'Cambridge', population: 158_000, point: at(0, 0) }),
  makeCity({ geonames_id: 5, name: 'Hastings', population: 92_000, point: at(50, 0) }),
  makeCity({ geonames_id: 6, name: 'Ely', population: 20_112, point: at(100, 0) }),
];

/** A city at a given pixel, given the fixture's projection maps world x and y straight to pixels. */
function cityAtPixel(x: number, y: number, name = 'London') {
  return makeCity({ name, population: 9_000_000, point: { lon: x, lat: y, altitude_m: null } });
}

describe('CityLayer holding lattice space so a badge cannot cover a name', () => {
  /** A view rectangle wide enough to contain a city placed at a pixel rather than at a coordinate. */
  const PIXEL_VIEW = { west: -2000, south: -2000, east: 2000, north: 2000, heightM: WHOLE_GLOBE_M };

  it('reserves the pixels a drawn label paints', () => {
    // The whole point. A cluster badge is drawn on a lattice point; a name that holds the points it
    // covers pushes the badge off them. Measured before this: 31 label-and-badge overlaps at a
    // whole-globe view, hitting Shanghai, Istanbul, Moscow, Hangzhou, London and New York City.
    const { layer } = build();
    badgeSlots.reset();
    layer.load([cityAtPixel(300, 200)]);

    layer.refresh(PIXEL_VIEW);

    expect(badgeSlots.claimed).toBeGreaterThan(0);
  });

  it('reserves more points for a long name than a short one', () => {
    // A label is wide, so reserving only the cell its centre falls in would leave a badge sitting on
    // the second half of the word. This is the half of `reserve` that a point could not carry.
    const short = build();
    badgeSlots.reset();
    short.layer.load([cityAtPixel(300, 200, 'Ur')]);
    short.layer.refresh(PIXEL_VIEW);
    const forShort = badgeSlots.claimed;

    const long = build();
    badgeSlots.reset();
    long.layer.load([cityAtPixel(300, 200, 'Comodoro Rivadavia')]);
    long.layer.refresh(PIXEL_VIEW);

    expect(badgeSlots.claimed).toBeGreaterThan(forShort);
  });

  it('places the reservation through the camera projection, not the label cell arithmetic', () => {
    // The trap this would otherwise have walked into. `cellFor` interpolates longitude and latitude
    // linearly across the view rectangle and says so in its own comment; badge positions come from
    // the camera's own view projection. The two agree over a city and diverge at a whole-globe view,
    // worst near the limb, which is exactly where the collisions were. A reservation placed with the
    // flat arithmetic would move badges convincingly and move them off the wrong pixels.
    //
    // The projection here maps world x and y straight to pixels, so a city at 300, 200 must hold the
    // lattice point at pixel 300, 200. `cellFor` over this view rectangle would put it elsewhere
    // entirely, because 300 of a 4000-wide span is a fifth of the way across the screen.
    const { layer } = build();
    badgeSlots.reset();
    layer.load([cityAtPixel(300, 200)]);
    layer.refresh(PIXEL_VIEW);

    const out = { x: 0, y: 0 };
    badgeSlots.claim('transit', 300, 200, out);
    const projected = {
      x: (Math.floor(300 / CLUSTER_CELL_PX) + 0.5) * CLUSTER_CELL_PX,
      y: (Math.floor(200 / CLUSTER_CELL_PX) + 0.5) * CLUSTER_CELL_PX,
    };
    // The point at the projected pixel is taken, so a badge asking for it is sent elsewhere.
    expect(out).not.toEqual(projected);
  });

  it('reserves nothing for a label it did not draw', () => {
    // Only the names on screen hold points. A city outside the view rectangle is never written, and
    // holding a point for it would push a badge off a pixel nothing occupies.
    const { layer } = build();
    badgeSlots.reset();
    layer.load([cityAtPixel(9000, 9000)]);

    layer.refresh(PIXEL_VIEW);

    expect(badgeSlots.claimed).toBe(0);
  });

  it('gives its points back when the rail switches the layer off', () => {
    // A dark layer that kept them would push every other layer's badges aside for as long as it
    // stayed off, which reads as the other layers being wrong.
    const { layer } = build();
    badgeSlots.reset();
    layer.load([cityAtPixel(300, 200)]);
    layer.refresh(PIXEL_VIEW);
    expect(badgeSlots.claimed).toBeGreaterThan(0);

    layer.setVisible(false);

    expect(badgeSlots.claimed).toBe(0);
  });

  it('frees the points a moved label has left, rather than accumulating them', () => {
    // Released and re-made in one pass, like every other holder. Without the release the layer would
    // hold every point every camera position ever put a label on, and the badges would be pushed off
    // pixels no name has occupied for minutes. Two passes with the label in different places is the
    // smallest test that sees it: reserving the same points twice looks identical either way.
    const { layer } = build();
    badgeSlots.reset();
    layer.load([cityAtPixel(300, 200)]);
    layer.refresh(PIXEL_VIEW);
    const forOne = badgeSlots.claimed;
    expect(forOne).toBeGreaterThan(0);

    layer.load([cityAtPixel(900, 600)]);
    layer.refresh({ ...PIXEL_VIEW, heightM: WHOLE_GLOBE_M - 1 });

    // Not twice as many. The exact count differs between the two places, because a box wider than a
    // cell clips to a different number of columns depending where its edges fall, so the assertion is
    // that the old points came back rather than that the number is identical.
    expect(badgeSlots.claimed).toBeLessThan(forOne * 2);
    const out = { x: 0, y: 0 };
    badgeSlots.claim('transit', 300, 200, out);
    expect(out).toEqual({
      x: (Math.floor(300 / CLUSTER_CELL_PX) + 0.5) * CLUSTER_CELL_PX,
      y: (Math.floor(200 / CLUSTER_CELL_PX) + 0.5) * CLUSTER_CELL_PX,
    });
  });
});

describe('the population bands', () => {
  it('never lets a smaller city be visible from further away', () => {
    // The early exit in `refresh` depends on this: once a band is out of range every band
    // below it is too, so the scan can stop rather than walking the whole gazetteer.
    const limits = POPULATION_BANDS.map((band) => band.farM);
    const floors = POPULATION_BANDS.map((band) => band.minPopulation);

    expect(limits.toSorted((left, right) => right - left)).toEqual(limits);
    expect(floors.toSorted((left, right) => right - left)).toEqual(floors);
  });

  it('puts each measured slice of the real file in its own band', () => {
    // The thresholds are the ones measured against cities15000.txt on 2026-08-19, so a
    // population either side of a boundary must land in the band the docstring claims.
    expect(bandFor(24_874_500).farM).toBe(25_000_000);
    expect(bandFor(5_000_000).farM).toBe(25_000_000);
    expect(bandFor(4_999_999).farM).toBe(6_000_000);
    expect(bandFor(300_000).farM).toBe(2_000_000);
    expect(bandFor(299_999).farM).toBe(700_000);
    expect(bandFor(50_000).farM).toBe(250_000);
    expect(bandFor(49_999).farM).toBe(80_000);
    expect(bandFor(0).farM).toBe(80_000);
  });

  it('gives a nonsense population the smallest band rather than throwing', () => {
    // The contract forbids it (`ge=0`), so this is the guard that stops a future contract
    // change turning into an exception inside the render path.
    expect(bandFor(-1).farM).toBe(80_000);
  });

  it('names the layer the way the backend does', () => {
    expect(CITY_LAYER).toBe('cities');
  });
});

describe('CityLayer construction', () => {
  it('draws through one label collection and creates no labels until asked', () => {
    const { layer, labels } = build();

    expect(labels.items).toHaveLength(0);
    expect(layer.count).toBe(0);
    expect(layer.held).toBe(0);
  });
});

describe('CityLayer.load', () => {
  it('sorts the gazetteer biggest first rather than trusting the payload order', () => {
    const { layer, labels } = build();

    // Deliberately smallest first, which is not what /api/cities answers. The budget picks
    // "the biggest in view" by taking the first ones it finds, so the order is load-bearing.
    layer.load(LADDER.toReversed());
    layer.refresh(everywhere(WHOLE_GLOBE_M));

    expect(layer.held).toBe(6);
    expect(drawn(labels)).toEqual(['Tokyo']);
  });

  it('breaks a population tie on the GeoNames id, so the order is total', () => {
    const { layer, labels } = build();

    // Apart, because two cities at one coordinate now share one cell and only the winner draws.
    // The tie-break is about sort order, so the two have to be drawable for the order to be
    // observable at all.
    layer.load([
      makeCity({ geonames_id: 900, name: 'Second', population: 6_000_000, point: at(60, 0) }),
      makeCity({ geonames_id: 100, name: 'First', population: 6_000_000, point: at(-60, 0) }),
    ]);
    layer.refresh(everywhere(WHOLE_GLOBE_M));

    expect(drawn(labels)).toEqual(['First', 'Second']);
  });

  it('creates no labels on its own', () => {
    const { layer, labels } = build();

    layer.load(LADDER);

    // Holding the whole file is cheap; labelling it is not. Nothing is drawn until a camera
    // position says what is worth drawing.
    expect(layer.held).toBe(6);
    expect(labels.items).toHaveLength(0);
  });
});

describe('CityLayer banding by camera height', () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
    context.layer.load(LADDER);
  });

  it('shows capitals only from a whole-globe view', () => {
    context.layer.refresh(everywhere(WHOLE_GLOBE_M));

    expect(drawn(context.labels)).toEqual(['Tokyo']);
  });

  it('adds the million-plus cities at continent framing', () => {
    context.layer.refresh(everywhere(CONTINENT_M));

    expect(drawn(context.labels)).toEqual(['Tokyo', 'Hamburg']);
  });

  it('is readable at country zoom: down to 300,000 and no further', () => {
    context.layer.refresh(everywhere(COUNTRY_M));

    // Acceptance criterion 4's first half. Cambridge at 158,000 has a 700km limit, so it is
    // correctly absent from a view 800km up.
    expect(drawn(context.labels)).toEqual(['Tokyo', 'Hamburg', 'Cardiff']);
  });

  it('adds towns at regional framing', () => {
    context.layer.refresh(everywhere(REGION_M));

    expect(drawn(context.labels)).toEqual(['Tokyo', 'Hamburg', 'Cardiff', 'Cambridge', 'Hastings']);
  });

  it('shows the smallest places only at city and street zoom', () => {
    context.layer.refresh(everywhere(STREET_M));

    expect(drawn(context.labels)).toContain('Ely');
  });

  it('stops scanning as soon as the bands run out of range', () => {
    context.layer.refresh(everywhere(WHOLE_GLOBE_M));

    // The early exit, measured rather than described: one record considered out of six, so
    // the real layer looks at fifty-nine rows and not 34,072 to draw a world view.
    expect(context.layer.scanned).toBe(1);
  });

  it('walks the whole gazetteer only when the camera is low enough to need it', () => {
    context.layer.refresh(everywhere(STREET_M));

    expect(context.layer.scanned).toBe(6);
  });

  it('carries the band limit onto the label as its display condition', () => {
    context.layer.refresh(everywhere(STREET_M));

    const conditions = context.labels.items.map((label) => label.distanceDisplayCondition);
    // Near is zero everywhere: a capital stays labelled when you are standing in it.
    expect(conditions[0]).toEqual({ near: 0, far: 25_000_000 });
    expect(conditions[5]).toEqual({ near: 0, far: 80_000 });
  });

  it('gives a big city a heavier label than a small one', () => {
    context.layer.refresh(everywhere(STREET_M));

    const [biggest] = context.labels.items;
    const smallest = context.labels.items[5];
    expect(biggest?.font).not.toBe(smallest?.font);
    expect(biggest?.fillColor).not.toEqual(smallest?.fillColor);
    // Outlined against the imagery, or a pale name over cloud is unreadable.
    expect(biggest?.style).toBe('FILL_AND_OUTLINE');
    expect(biggest?.outlineColor).toBe('BLACK');
    // Centred on the place: a city is a name on the map, not a dot with a name beside it.
    expect(biggest?.horizontalOrigin).toBe('CENTER');
    expect(biggest?.verticalOrigin).toBe('CENTER');
  });
});

describe('CityLayer view filtering', () => {
  it('draws only what is inside the view rectangle', () => {
    const { layer, labels } = build();
    layer.load([
      makeCity({ geonames_id: 1, name: 'London', population: 8_961_989, point: londonPoint() }),
      makeCity({ geonames_id: 2, name: 'Tokyo', population: 24_874_500, point: tokyoPoint() }),
    ]);

    layer.refresh({ west: -10, south: 45, east: 5, north: 60, heightM: WHOLE_GLOBE_M });

    expect(drawn(labels)).toEqual(['London']);
  });

  it('handles a view that crosses the antimeridian, where west is east of east', () => {
    const { layer, labels } = build();
    layer.load([
      makeCity({ geonames_id: 1, name: 'Suva', population: 6_000_000, point: at(178.44, -18.14) }),
      makeCity({ geonames_id: 2, name: 'Apia', population: 6_000_000, point: at(-171.76, -13.83) }),
      makeCity({ geonames_id: 3, name: 'Accra', population: 6_000_000, point: at(-0.19, 5.55) }),
    ]);

    // Cesium's own convention, and one of the four in this project that disagree: a view
    // straddling 180 degrees comes back with west greater than east.
    layer.refresh({ west: 170, south: -30, east: -170, north: 0, heightM: WHOLE_GLOBE_M });

    expect(drawn(labels).toSorted((left, right) => left.localeCompare(right))).toEqual([
      'Apia',
      'Suva',
    ]);
  });

  it('excludes a city north or south of the view', () => {
    const { layer, labels } = build();
    layer.load([
      makeCity({ geonames_id: 1, name: 'Tromso', population: 6_000_000, point: at(18.95, 69.65) }),
      makeCity({
        geonames_id: 2,
        name: 'Hobart',
        population: 6_000_000,
        point: at(147.32, -42.88),
      }),
    ]);

    layer.refresh({ west: -180, south: -10, east: 180, north: 10, heightM: WHOLE_GLOBE_M });

    expect(drawn(labels)).toEqual([]);
  });

  it('positions each label at its own coordinate, longitude first, on the ellipsoid', () => {
    const { layer, labels } = build();
    layer.load([
      makeCity({ geonames_id: 1, name: 'London', population: 8_961_989, point: londonPoint() }),
      makeCity({ geonames_id: 2, name: 'Tokyo', population: 24_874_500, point: tokyoPoint() }),
    ]);

    layer.refresh(everywhere(WHOLE_GLOBE_M));

    // Tokyo first, because the order is population descending. The clone-on-assign behaviour
    // of the real setter is what makes this hold while the layer reuses one scratch vector.
    expect(labels.items[0]?.position).toEqual({ x: 139.69171, y: 35.6895, z: 0 });
    expect(labels.items[1]?.position).toEqual({ x: -0.12574, y: 51.50853, z: 0 });
  });
});

describe('CityLayer render policy', () => {
  it('never removes a label from the collection, however far the camera moves', () => {
    const { layer, labels } = build();
    layer.load(LADDER);

    for (const heightM of [WHOLE_GLOBE_M, STREET_M, COUNTRY_M, REGION_M, WHOLE_GLOBE_M]) {
      layer.refresh(everywhere(heightM));
    }

    // `remove` on a collection forces Cesium to rebuild its buffers, and the camera moves
    // constantly. Six labels were ever created and none was handed back.
    expect(labels.timesRemoved).toBe(0);
    expect(labels.items).toHaveLength(6);
  });

  it('reuses the same label objects when the visible set grows again', () => {
    const { layer, labels } = build();
    layer.load(LADDER);
    layer.refresh(everywhere(STREET_M));
    const created = [...labels.items];

    layer.refresh(everywhere(WHOLE_GLOBE_M));
    layer.refresh(everywhere(STREET_M));

    expect(labels.items).toHaveLength(6);
    expect(labels.items).toEqual(created);
    expect(drawn(labels)).toHaveLength(6);
  });

  it('hides and empties the labels it no longer needs', () => {
    const { layer, labels } = build();
    layer.load(LADDER);
    layer.refresh(everywhere(STREET_M));

    layer.refresh(everywhere(WHOLE_GLOBE_M));

    expect(layer.count).toBe(1);
    const spare = labels.items[5];
    expect(spare?.show).toBe(false);
    // Emptied as well as hidden: an empty label hands its glyph billboards back to Cesium's
    // spare pool, where a hidden one still holding text keeps them.
    expect(spare?.text).toBe('');
  });

  it('caps the labels at one per screen cell, well under its own budget', () => {
    // The budget is no longer the binding limit and this is where that shows. At 1400x800 with
    // 96px cells the grid is 15 columns by 9 rows, so **135** labels is the most that can ever be
    // drawn however many cities are in view, against a `CITY_LABEL_BUDGET` of 600. The budget
    // stays as a backstop because it is viewport-independent and the cell count is not, but the
    // reason it existed, holding glyph billboards down, is now met several times over: 135 names
    // is about 1,100 glyphs where the budget allowed roughly 5,000.
    const { layer, labels } = build();
    layer.load(
      Array.from({ length: CITY_LABEL_BUDGET + 100 }, (_unused, index) =>
        makeCity({
          geonames_id: index + 1,
          name: `Place ${index}`,
          population: 6_000_000,
          // Spread over the whole globe, so the cell grid rather than the clustering is what caps
          // this. Packed into seven degrees they would all share one cell and one would draw.
          point: at(-180 + (index * 360) / (CITY_LABEL_BUDGET + 100), (index % 17) * 5 - 40),
        }),
      ),
    );

    layer.refresh(everywhere(WHOLE_GLOBE_M));

    // The grid is 15 by 9 at this viewport, so 135 is the ceiling and the budget is never reached.
    const cells = Math.ceil(1400 / CITY_LABEL_CELL_PX) * Math.ceil(800 / CITY_LABEL_CELL_PX);

    expect(cells).toBe(135);
    expect(layer.count).toBeLessThanOrEqual(cells);
    expect(layer.count).toBeLessThan(CITY_LABEL_BUDGET);
    // Everything is still held: the cap is on what is drawn, never on what the layer knows.
    expect(layer.held).toBe(CITY_LABEL_BUDGET + 100);
    expect(labels.items).toHaveLength(layer.count);
  });

  it('parses each label colour once however many cities use it', () => {
    const { layer } = build();
    layer.load(
      Array.from({ length: 200 }, (_unused, index) =>
        makeCity({ geonames_id: index + 1, name: `Place ${index}`, population: 6_000_000 }),
      ),
    );
    const before = cssColourCalls.count;

    layer.refresh(everywhere(WHOLE_GLOBE_M));

    // One band, one colour, one parse. Parsing per label per camera move would be the
    // hottest thing in the refresh.
    expect(cssColourCalls.count - before).toBeLessThanOrEqual(1);
  });

  it('allocates one display condition per band, not one per label', () => {
    const { layer } = build();
    layer.load(LADDER);
    const before = conditionsMade.count;

    layer.refresh(everywhere(STREET_M));
    layer.refresh(everywhere(WHOLE_GLOBE_M));
    layer.refresh(everywhere(STREET_M));

    // Six bands, six objects, across three full repaints of six labels.
    expect(conditionsMade.count - before).toBe(6);
  });

  it('does nothing at all when the camera has not moved', () => {
    const { layer, labels } = build();
    layer.load(LADDER);
    expect(layer.refresh(everywhere(COUNTRY_M))).toBe(true);
    const painted = labels.items.map((label) => ({ ...label }));

    const again = layer.refresh(everywhere(COUNTRY_M));

    // This is what makes the layer safe to call from a per-frame loop: a settled camera is
    // five number comparisons and no writes, so there is no per-frame cost to pay.
    expect(again).toBe(false);
    expect(labels.items.map((label) => ({ ...label }))).toEqual(painted);
  });
});

describe('CityLayer.setVisible', () => {
  it('switches the whole layer with one flag on one collection', () => {
    const { layer, labels } = build();
    layer.load(LADDER);
    layer.refresh(everywhere(STREET_M));

    layer.setVisible(false);

    expect(labels.show).toBe(false);
    expect(labels.timesRemoved).toBe(0);
    // Still held and still labelled, so switching back on needs no refetch and no rebind.
    expect(layer.held).toBe(6);
    expect(layer.count).toBe(6);
  });

  it('costs nothing while it is off: no work, no labels touched, no request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { layer, labels } = build();
    layer.load(LADDER);
    layer.refresh(everywhere(STREET_M));
    layer.setVisible(false);
    const before = labels.items.map((label) => ({ ...label }));
    const addsBefore = labels.items.length;

    // Every camera move the user could make with the layer switched off.
    const moved = [WHOLE_GLOBE_M, CONTINENT_M, COUNTRY_M, REGION_M, STREET_M].map((heightM) =>
      layer.refresh(everywhere(heightM)),
    );

    // Acceptance criterion 4's second half, proved rather than asserted: no repaint, no
    // frame requested, no label added or removed, and nothing fetched.
    expect(moved).toEqual([false, false, false, false, false]);
    expect(labels.items.map((label) => ({ ...label }))).toEqual(before);
    expect(labels.items).toHaveLength(addsBefore);
    expect(labels.timesRemoved).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('repaints for wherever the camera went while it was off', () => {
    const { layer, labels } = build();
    layer.load(LADDER);
    layer.refresh(everywhere(STREET_M));
    layer.setVisible(false);
    layer.refresh(everywhere(WHOLE_GLOBE_M));

    layer.setVisible(true);
    const repainted = layer.refresh(everywhere(WHOLE_GLOBE_M));

    expect(labels.show).toBe(true);
    expect(repainted).toBe(true);
    expect(drawn(labels)).toEqual(['Tokyo']);
  });
});

describe('cityView', () => {
  it('converts Cesium radians into contract degrees and carries the height', () => {
    const view = cityView(
      fakeScene(
        { west: -Math.PI / 2, south: -Math.PI / 4, east: Math.PI / 2, north: Math.PI / 4 },
        1234,
      ),
    );

    expect(view.west).toBeCloseTo(-90, 9);
    expect(view.south).toBeCloseTo(-45, 9);
    expect(view.east).toBeCloseTo(90, 9);
    expect(view.north).toBeCloseTo(45, 9);
    expect(view.heightM).toBe(1234);
  });

  it('falls back to the whole world when the view is not a rectangle', () => {
    // Looking at the limb from a long way out. Degrading to nothing would empty the layer at
    // exactly the zoom where its capitals are the only thing making the ocean legible.
    const view = cityView(fakeScene(undefined, 30_000_000));

    expect(view).toEqual({ west: -180, south: -90, east: 180, north: 90, heightM: 30_000_000 });
  });
});

describe('CityLayer.cityFor', () => {
  it('answers the row it was loaded with', () => {
    const { layer } = build();
    layer.load([makeCity({ geonames_id: 2_643_743, name: 'London' })]);

    expect(layer.cityFor(2_643_743)?.name).toBe('London');
  });

  it('answers null for an id it holds nothing for', () => {
    const { layer } = build();
    layer.load([makeCity({ geonames_id: 1 })]);

    // Null rather than undefined, so the caller has one absent value to test.
    expect(layer.cityFor(99_999)).toBeNull();
  });

  it('answers null before a gazetteer has been loaded at all', () => {
    const { layer } = build();

    expect(layer.cityFor(2_643_743)).toBeNull();
  });

  it('answers for a city that is not drawn, because the search box reaches those', () => {
    // The point of indexing everything held rather than the visible set. At whole-globe zoom
    // only Tokyo is above the 5M band floor, but a search for Ely still has to open its card.
    const { layer, labels } = build();
    layer.load(LADDER);
    layer.refresh(everywhere(WHOLE_GLOBE_M));

    expect(drawn(labels)).toEqual(['Tokyo']);
    expect(layer.cityFor(6)?.name).toBe('Ely');
  });

  it('builds nothing until something asks, so a session that never clicks pays nothing', () => {
    // `load` runs on every gazetteer read and most sessions never click a city. This is the
    // assertion that stops a later edit moving the build into `load` with the suite still
    // green.
    const { layer } = build();
    layer.load(LADDER);

    expect(layer.indexed).toBe(0);

    layer.cityFor(1);

    expect(layer.indexed).toBe(LADDER.length);
  });

  it('builds once, however many lookups follow', () => {
    const { layer } = build();
    layer.load(LADDER);
    layer.cityFor(1);
    layer.cityFor(2);
    layer.cityFor(99_999);

    expect(layer.indexed).toBe(LADDER.length);
  });

  it('drops the index on a reload rather than answering from the old gazetteer', () => {
    const { layer } = build();
    layer.load([makeCity({ geonames_id: 1, name: 'Ely' })]);
    expect(layer.cityFor(1)?.name).toBe('Ely');

    layer.load([makeCity({ geonames_id: 2, name: 'Cardiff' })]);

    // Back to lazy, and the city that left the file is gone rather than stale.
    expect(layer.indexed).toBe(0);
    expect(layer.cityFor(1)).toBeNull();
    expect(layer.cityFor(2)?.name).toBe('Cardiff');
  });

  it('resolves what a picked label hands back, which is the click route end to end', () => {
    const { layer, labels } = build();
    layer.load([makeCity({ geonames_id: 2_643_743, name: 'London', point: londonPoint() })]);
    layer.refresh(everywhere(STREET_M));

    const label = labels.items.find((candidate) => candidate.show);
    const picked = geonamesFromPickId(String(label?.id));

    expect(picked).not.toBeNull();
    expect(layer.cityFor(picked ?? 0)?.name).toBe('London');
  });
});

describe('the pick id', () => {
  it('routes a click on a label back to the city that drew it', () => {
    // The invariant that makes a click open a card: what the layer stamps is what the
    // resolver reads, end to end, with no third party translating between them.
    const { layer, labels } = build();
    layer.load([makeCity({ geonames_id: 2_643_743, name: 'London', point: londonPoint() })]);
    layer.refresh(everywhere(STREET_M));

    const label = labels.items.find((candidate) => candidate.text === 'London');
    expect(label).toBeDefined();
    expect(label?.id).toBe('city:2643743');
    expect(geonamesFromPickId(String(label?.id))).toBe(2_643_743);
  });

  it('gives every drawn label the id of the city in it, not the id of its pool slot', () => {
    // The pool reuses one label for a different city on every camera move, so an id written
    // once when the label was created would name whichever city happened to be drawn first.
    const { layer, labels } = build();
    layer.load(LADDER);
    layer.refresh(everywhere(STREET_M));

    const drawnIds = labels.items
      .filter((label) => label.show)
      .map((label) => geonamesFromPickId(String(label.id)));
    expect(drawnIds).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('clears the id when a label is retired, so a click cannot open a card for it', () => {
    const { layer, labels } = build();
    layer.load(LADDER);
    layer.refresh(everywhere(STREET_M));
    // Back out to the whole globe, where only Tokyo is above the 5M band floor.
    layer.refresh(everywhere(WHOLE_GLOBE_M));

    const retired = labels.items.filter((label) => !label.show);
    expect(retired.length).toBe(5);
    expect(retired.map((label) => label.id)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('adds nothing visible: the label still holds the name and only the name', () => {
    // Alexander Fanthome asked for a clean UI and the icons work is in flight next door, so
    // this is the assertion that making a label pickable did not put an id on screen.
    const { layer, labels } = build();
    layer.load([makeCity({ geonames_id: 2_643_743, name: 'London', point: londonPoint() })]);
    layer.refresh(everywhere(STREET_M));

    const label = labels.items.find((candidate) => candidate.show);
    expect(label?.text).toBe('London');
    expect(label?.text).not.toContain('city:');
    expect(label?.text).not.toContain('2643743');
  });

  it('reads a well-formed id back as a number', () => {
    expect(geonamesFromPickId('city:2643743')).toBe(2_643_743);
    // Catalogue numbers have run past seven digits: the recorded Pechersk row.
    expect(geonamesFromPickId('city:13535745')).toBe(13_535_745);
  });

  it('refuses every id the other three layers stamp', () => {
    // The whole namespace, checked rather than assumed. A bare six-hex ICAO 24-bit address
    // from `layers/aircraft.ts`, a bare nine-digit MMSI from `layers/vessels.ts`, and a
    // prefixed catalogue number from `layers/satellites.ts`.
    expect(geonamesFromPickId('4ca7b5')).toBeNull();
    expect(geonamesFromPickId('123456')).toBeNull();
    expect(geonamesFromPickId('230123450')).toBeNull();
    expect(geonamesFromPickId('satellite:25544')).toBeNull();
  });

  it('keeps the two prefixed schemes out of each other', () => {
    // `startsWith` is what the routing turns on, so neither prefix may begin with the other.
    // The literal rather than the import, because `layers/satellites.ts` reaches for Cesium
    // collections this file's mock does not carry.
    const satellitePrefix = 'satellite:';
    expect(CITY_PICK_PREFIX).toBe('city:');
    expect(CITY_PICK_PREFIX.startsWith(satellitePrefix)).toBe(false);
    expect(satellitePrefix.startsWith(CITY_PICK_PREFIX)).toBe(false);
  });

  it('refuses a click on nothing, and anything that is not a city id', () => {
    expect(geonamesFromPickId(null)).toBeNull();
    expect(geonamesFromPickId('')).toBeNull();
    expect(geonamesFromPickId('place:2643743')).toBeNull();
    expect(geonamesFromPickId('city:London')).toBeNull();
    expect(geonamesFromPickId('city:26437.43')).toBeNull();
  });

  it('refuses a bare prefix rather than resolving it to GeoNames id zero', () => {
    // `Number('')` is 0 and `Number.isSafeInteger(0)` is true, so without the positive check
    // a stray `city:` becomes a lookup that finds nothing instead of a pick that was not a
    // city, and the difference is a card that silently never opens.
    expect(geonamesFromPickId('city:')).toBeNull();
    expect(geonamesFromPickId('city:0')).toBeNull();
    expect(geonamesFromPickId('city:-1')).toBeNull();
  });
});

/**
 * One label per screen cell, which is the collision fix.
 *
 * Measured 2026-08-23 against the real file at a 1400x800 viewport, applying the layer's own bands
 * and early exit: 300km over the Randstad drew 33 labels with 22 overlapping pairs, London 51 with
 * 20, and Tokyo **122 with 168**. The worst case is not city zoom, which is the surprising half:
 * at 80km over the Randstad it was 56 labels and 11 pairs. Mid-size cities have just qualified for
 * their band at 300km while the scale is still tight enough for their names to touch.
 *
 * Simulating this rule over the same views took the residual pairs to 0, 2, 0, 1 and 2.
 */
describe('label collision', () => {
  /**
   * Three real places close enough to share one cell at this view, and the arithmetic matters.
   *
   * The Randstad rectangle below spans 3.2 degrees of longitude across 1400px, so a 96px cell is
   * about 0.22 degrees wide and 0.18 tall. Amsterdam and Haarlem are 0.25 apart and land in
   * neighbouring cells, which is the rule working rather than failing; these three are inside
   * 0.07 of each other and genuinely compete. Latitudes are equal so nothing straddles a row
   * boundary, which is what made a first attempt at this fixture pass for the wrong reason.
   */
  const CROWD: City[] = [
    makeCity({ geonames_id: 1, name: 'Amsterdam', population: 741_636, point: at(4.895, 52.37) }),
    makeCity({ geonames_id: 2, name: 'Diemen', population: 31_000, point: at(4.961, 52.37) }),
    makeCity({ geonames_id: 3, name: 'Duivendrecht', population: 4000, point: at(4.93, 52.37) }),
  ];
  /** The Randstad at 300km, which is the view the worst measurements came from. */
  const RANDSTAD = { west: 3.3, south: 51.6, east: 6.5, north: 53.1, heightM: 300_000 };

  it('draws the largest of a crowded cell and none of the rest', () => {
    const { layer, labels } = build();
    layer.load(CROWD);
    layer.refresh(RANDSTAD);

    // Amsterdam wins on population. The other two are held, just not drawn.
    expect(drawn(labels)).toEqual(['Amsterdam']);
    expect(layer.held).toBe(3);
  });

  it('lets the winner change as the camera moves, without reordering anything', () => {
    // Zoomed in, the cell covers less ground and the neighbours separate. Nothing about the
    // records changed; the cell is a function of the view.
    const { layer, labels } = build();
    layer.load(CROWD);
    layer.refresh({ west: 4.55, south: 52.25, east: 4.98, north: 52.45, heightM: 40_000 });

    expect(drawn(labels)).toContain('Amsterdam');
    expect(drawn(labels).length).toBeGreaterThan(1);
  });

  it('keeps population as the only tie-break, never proximity to a cell centre', () => {
    // `globe/cluster.ts` picks the member nearest the middle of its cell, which is right for a
    // badge that has to sit somewhere sensible and wrong for a label: the name a reader wants is
    // the biggest place, wherever in the cell it happens to fall.
    const { layer, labels } = build();
    layer.load([
      // Same latitude, so only the column can differ, and 0.05 apart is well inside one cell.
      makeCity({ geonames_id: 1, name: 'Edge', population: 900_000, point: at(3.35, 51.7) }),
      makeCity({ geonames_id: 2, name: 'Middle', population: 100_000, point: at(3.4, 51.7) }),
    ]);
    layer.refresh(RANDSTAD);

    expect(drawn(labels)).toEqual(['Edge']);
  });

  it('does not suppress anything in an empty view', () => {
    const { layer, labels } = build();
    layer.load(CROWD);
    layer.refresh({ west: -30, south: 30, east: -20, north: 40, heightM: 300_000 });

    expect(drawn(labels)).toEqual([]);
  });
});

/**
 * What a wrapped view rectangle does to label selection.
 *
 * `cityView` takes its rectangle from Cesium's `camera.computeViewRectangle`, and a rectangle
 * whose `west` exceeds its `east` is the convention for one crossing the antimeridian.
 * `pointInView` handles that correctly, with an `or` rather than an `and`. What these tests
 * answer is what this layer does when a rectangle arrives wrapped for a camera that is not over
 * the Pacific, which is the failure reported against the in-view counts: one rectangle drives
 * both, so the same wrong answer reaches the labels.
 *
 * A measurement rather than a guard. Nothing here asserts the layer is right; they record what
 * it does, so the size of the problem is on the record instead of being guessed at.
 */
describe('a wrapped view rectangle', () => {
  /** Real cities, chosen to separate the longitude test from the latitude one. */
  const WORLD: City[] = [
    makeCity({
      geonames_id: 1,
      name: 'Tokyo',
      population: 24_874_500,
      point: at(139.6917, 35.6895),
    }),
    makeCity({
      geonames_id: 2,
      name: 'London',
      population: 8_961_989,
      point: at(-0.1257, 51.5085),
    }),
    makeCity({
      geonames_id: 3,
      name: 'New York',
      population: 8_804_190,
      point: at(-74.006, 40.7128),
    }),
    makeCity({
      geonames_id: 4,
      name: 'Chicago',
      population: 2_720_546,
      point: at(-87.6298, 41.8781),
    }),
    makeCity({ geonames_id: 5, name: 'Paris', population: 2_138_551, point: at(2.3488, 48.8534) }),
  ];

  /** A plain rectangle over western Europe, at a height where every band is in range. */
  const EUROPE = { west: -10, south: 40, east: 10, north: 60, heightM: 800_000 };
  /** The same camera, with the rectangle arriving wrapped: everything except western Europe. */
  const WRAPPED = { west: 10, south: 40, east: -10, north: 60, heightM: 800_000 };

  it('draws what is in an ordinary rectangle', () => {
    const { layer, labels } = build();
    layer.load(WORLD);
    layer.refresh(EUROPE);

    expect(drawn(labels)).toEqual(['London', 'Paris']);
  });

  it('loses the near side and gains the same latitudes right round the world', () => {
    // The defect, stated plainly, and it is a band rather than a hemisphere: a wrapped
    // rectangle complements the longitude test and leaves the latitude test alone. So a camera
    // over London loses London and Paris and gains New York and Chicago, which sit at European
    // latitudes on the other side of the Atlantic. Tokyo is not drawn either, and not because
    // the layer got that one right: at 35.7°N it falls below the rectangle's own southern edge.
    const { layer, labels } = build();
    layer.load(WORLD);
    layer.refresh(WRAPPED);

    expect(drawn(labels)).toEqual(['New York', 'Chicago']);
    expect(drawn(labels)).not.toContain('London');
    expect(drawn(labels)).not.toContain('Paris');
  });

  it('cannot lean on the distance condition to hide them, and this is the measurement', () => {
    // The mitigation that looks like it should cover this does not. Every label carries a
    // `DistanceDisplayCondition(0, band.farM)`, and New York's population puts it in the
    // 5M-and-up band whose limit is 25,000km. London to New York is about 5,570km, well inside
    // it, so the GPU is never asked to drop the label. What keeps it off a low-altitude screen
    // is depth alone: it is behind the Earth. That holds while the globe covers it and stops
    // holding as the camera climbs and more of the far side comes into view, which is exactly
    // the altitude band worth worrying about, and the band where `computeViewRectangle` still
    // returns a rectangle instead of the undefined that makes `cityView` fall back to the whole
    // world.
    const { layer, labels } = build();
    layer.load(WORLD);
    layer.refresh(WRAPPED);

    const newYork = labels.items.find((label) => label.text === 'New York');
    expect(newYork?.distanceDisplayCondition?.far).toBe(25_000_000);
  });

  it('keeps the early exit, which is the one thing a wrong rectangle cannot break', () => {
    // The population walk and its exit are decided by camera height alone, so a wrong rectangle
    // cannot make this layer consider the whole gazetteer. It bounds the damage at "the wrong
    // cities of the right rank" rather than "every city in the file". Three records are above
    // the 5M floor, and the fourth ends the walk because its band is out of range at 20,000km.
    const { layer } = build();
    layer.load(WORLD);
    layer.refresh({ ...WRAPPED, heightM: 20_000_000 });

    expect(layer.scanned).toBe(3);
  });
});

function londonPoint() {
  return { lon: -0.12574, lat: 51.50853, altitude_m: null };
}

function tokyoPoint() {
  return { lon: 139.69171, lat: 35.6895, altitude_m: null };
}

function at(lon: number, lat: number) {
  return { lon, lat, altitude_m: null };
}

/** A scene whose camera answers a fixed rectangle in radians, as Cesium's does. */
function fakeScene(
  rectangle: { west: number; south: number; east: number; north: number } | undefined,
  heightM: number,
) {
  return {
    camera: {
      positionCartographic: { height: heightM },
      computeViewRectangle: () => rectangle,
    },
  } as unknown as Parameters<typeof cityView>[0];
}
