/**
 * Tests for the social post layer.
 *
 * Most of this file guards ADR 005 rather than the drawing. The rule that a location worked out from
 * a post's words must never be presented as one a source reported is the reason the layer exists in
 * this shape, and it is a rule that would go on passing every other test in the suite the day it
 * stopped holding. So the pin and the ring are asserted as *different marks*, the pin's anchor is
 * asserted, and there is a test that no code path can produce a pin for a derived post.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SocialPost } from '../../types/entities';

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
    VerticalOrigin: { BOTTOM: 'BOTTOM', CENTER: 'CENTER' },
    // Exposed so a test can prove the colour cache stops the layer reparsing CSS.
    __cssColourCalls: cssColourCalls,
  };
});

const { __cssColourCalls: cssColourCalls } = (await import('cesium')) as unknown as {
  __cssColourCalls: { count: number };
};

const {
  SELECTED_SOCIAL_ICON_PX,
  SOCIAL_CLUSTER_KEY,
  RING_LEGIBLE_FLOOR_PX,
  SOCIAL_CLUSTER_MIN,
  SOCIAL_ICON_PX,
  MEDIA_PROXY_PATH,
  SocialLayer,
  isObservedPosition,
  proxiedMediaUrl,
  socialKey,
  socialLabel,
} = await import('./social');
const { areaRingImage, clusterBadgeImage, iconImage, pinTipOffsetPx } = await import('../icons');
const { CLUSTER_FILL, SOCIAL_COLOUR, clusterBadgePx } = await import('../palette');
const { CLUSTER_CELL_PX, CLUSTER_FLY_FLOOR_M, parseClusterPickId } = await import('../cluster');
const { badgeSlots } = await import('../badge-slots');

/** A Commons photograph: the source gave us the coordinate, so there is no derivation. */
function upstreamPost(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    kind: 'social_post',
    source: 'wikimedia-commons',
    post_id: 'File:Tower_Bridge.jpg',
    url: 'https://commons.wikimedia.org/wiki/File:Tower_Bridge.jpg',
    author_handle: null,
    posted_at: '2026-08-20T09:00:00Z',
    text: 'Tower Bridge from the south bank',
    point: { lon: -0.0754, lat: 51.5055, altitude_m: null },
    location_basis: 'upstream',
    media: [],
    retrieved_at: '2026-08-23T12:00:00Z',
    ...overrides,
  };
}

/**
 * A Mastodon post: no coordinate anywhere in the source, so the position was resolved from words.
 *
 * One of **two** structurally different derived posts. The contract's validator accepts either the
 * phrase plus the place it matched, or the count of files sharing the coordinate, and forbids all
 * three on an upstream post. So a factory per kind rather than one factory with a flag, because the
 * shapes genuinely differ and a test that built an impossible one would prove nothing.
 */
function derivedPost(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    kind: 'social_post',
    source: 'mas.to',
    post_id: '109876543210',
    url: 'https://mas.to/@someone/109876543210',
    author_handle: '@someone@mas.to',
    posted_at: '2026-08-23T11:40:00Z',
    text: 'Beautiful morning in London today',
    point: { lon: -0.1276, lat: 51.5072, altitude_m: null },
    location_basis: 'derived',
    location_phrase: 'in London',
    place_name: 'London',
    media: [],
    retrieved_at: '2026-08-23T12:00:00Z',
    ...overrides,
  };
}

/**
 * A Commons file whose coordinate several files share, which is the kind the live adapter emits most.
 *
 * Measured 2026-08-24 through the fixed adapter: a Charing Cross search returns zero upstream posts
 * and fifty derived, the largest group sharing one coordinate across fifty files. Seven decimal
 * places is about a centimetre and no two independent fixes agree to a centimetre, so an exact
 * repeat is a copied value. There is no phrase and no matched place, because nothing was read from
 * any words: `coordinate_shared_by` is the whole of the evidence.
 */
function sharedCoordinatePost(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    kind: 'social_post',
    source: 'wikimedia-commons',
    post_id: 'File:London_Unsplash_1.jpg',
    url: 'https://commons.wikimedia.org/wiki/File:London_Unsplash_1.jpg',
    author_handle: null,
    posted_at: '2026-08-20T09:00:00Z',
    text: 'London, United Kingdom',
    point: { lon: -0.127758, lat: 51.507351, altitude_m: null },
    location_basis: 'derived',
    coordinate_shared_by: 356,
    media: [],
    retrieved_at: '2026-08-24T12:00:00Z',
    ...overrides,
  };
}

const VIEWPORT_W = 1600;
const VIEWPORT_H = 1000;

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
    pixelOffset: { x: number; y: number };
    show: boolean;
    id: string | undefined;
    image: string;
    scaleByDistance: unknown;
    alignedAxis: { x: number; y: number; z: number };
    width: number;
    height: number;
    text: string;
    horizontalOrigin: unknown;
    verticalOrigin: unknown;
  }[];
  timesRemoved: number;
  options: unknown;
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
  const layer = new SocialLayer(scene as unknown as ConstructorParameters<typeof SocialLayer>[0]);
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

/** `count` derived posts that all resolve to the same city centroid, which is the real worst case. */
function sameCity(count: number, lon = 100, lat = 100): SocialPost[] {
  // The id carries the coordinate as well as the index, because two batches at two places are two
  // different sets of posts and a shared id would silently overwrite rather than add.
  return Array.from({ length: count }, (_unused, index) =>
    derivedPost({
      post_id: `p${lon}_${lat}_${String(index).padStart(4, '0')}`,
      point: { lon, lat, altitude_m: null },
    }),
  );
}

describe('SocialLayer badge identity', () => {
  it('draws a group as one ring in the colour it draws its own marks in', () => {
    // A group is a merged asset now rather than a counted hexagon, so this asserts the icon and
    // its hue together. The colour is the same constant the rail is handed for its legend row, so
    // the globe and the key cannot drift apart.
    const { layer, badges, frame } = build();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN, 300, 300));

    frame();

    const drawn = badges.items.find((item) => item.show)?.image;
    expect(drawn).toBe(areaRingImage(SOCIAL_ICON_PX, SOCIAL_COLOUR, false));
    // Not a hexagon of any colour, which is the thing that was asked to go.
    expect(drawn).not.toBe(
      clusterBadgeImage(clusterBadgePx(SOCIAL_CLUSTER_MIN), CLUSTER_FILL, SOCIAL_COLOUR),
    );
  });

  it('never merges a group into a pin, however many of its posts were reported ones', () => {
    // The ADR 005 assertion, and the one thing in this file that must not be relaxed for looks. A
    // pin's tip claims *here, at this point, exactly*, and the mean of a hundred exact coordinates
    // is a place none of them reported. So even a group made entirely of upstream posts merges
    // into the ring, which claims *somewhere in this* and is true of every group.
    const { layer, badges, frame } = build();
    layer.upsert(
      sameCity(SOCIAL_CLUSTER_MIN + 6, 300, 300).map((post) => ({
        ...post,
        location_basis: 'upstream' as const,
        place_name: null,
      })),
    );

    frame();

    const drawn = badges.items.find((item) => item.show)?.image;
    expect(drawn).toBe(areaRingImage(SOCIAL_ICON_PX, SOCIAL_COLOUR, false));
    expect(drawn).not.toBe(iconImage('pin', SOCIAL_COLOUR, false, SOCIAL_ICON_PX));
  });

  it('draws a merged ring at one post size however many it stands for', () => {
    // "Do not scale the asset icon size when merging, keep at the current size". The old badge
    // grew with the count, from 30 pixels to 48.
    const { layer, badges, frame } = build();

    layer.replace(sameCity(SOCIAL_CLUSTER_MIN, 300, 300));
    frame();
    const smallWidth = badges.items.find((item) => item.show)?.width;

    layer.replace(sameCity(SOCIAL_CLUSTER_MIN * 100, 300, 300));
    frame();
    const large = badges.items.find((item) => item.show);

    expect(smallWidth).toBe(SOCIAL_ICON_PX);
    expect(large?.width).toBe(SOCIAL_ICON_PX);
    expect(large?.height).toBe(SOCIAL_ICON_PX);
  });

  it('leaves a merged ring unrotated, because a post carries no bearing', () => {
    // A post is a fixed event at a place. There is nothing to average and nothing to point.
    const { layer, badges, frame } = build();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN, 300, 300));

    frame();

    expect(badges.items.find((item) => item.show)?.alignedAxis).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('isObservedPosition', () => {
  it('is true only when the source supplied the coordinate', () => {
    expect(isObservedPosition(upstreamPost())).toBe(true);
    expect(isObservedPosition(derivedPost())).toBe(false);
  });

  it('mirrors the contract property rather than leaving callers to compare a string', () => {
    // The contract says why it exists: a consumer comparing the literal is one typo away from
    // treating a guess as a fix. This test is what makes the duplication safe.
    expect(isObservedPosition({ location_basis: 'upstream' })).toBe(true);
    expect(isObservedPosition({ location_basis: 'derived' })).toBe(false);
  });
});

describe('the two location bases are drawn as different marks', () => {
  it('draws a reported coordinate as a pin', () => {
    const { layer, marks } = build();

    layer.upsert([upstreamPost()]);

    const mark = markFor(marks, socialKey(upstreamPost()));
    expect(mark?.image).toBe(iconImage('pin', SOCIAL_COLOUR, false, SOCIAL_ICON_PX));
  });

  it('draws a worked-out coordinate as a hollow ring, never a pin', () => {
    // The whole of ADR 005 in one assertion. A city-level gazetteer match drawn as a point asserts
    // a place nobody reported; a ring has no tip and no centre and says "somewhere in this".
    const { layer, marks } = build();

    layer.upsert([derivedPost()]);

    const mark = markFor(marks, socialKey(derivedPost()));
    expect(mark?.image).toBe(areaRingImage(SOCIAL_ICON_PX, SOCIAL_COLOUR, false));
    expect(mark?.image).not.toBe(iconImage('pin', SOCIAL_COLOUR, false, SOCIAL_ICON_PX));
  });

  it('keeps them different marks when selected too, so the halo cannot flatten the distinction', () => {
    const { layer, marks } = build();
    layer.upsert([upstreamPost(), derivedPost()]);

    layer.setSelected(socialKey(derivedPost()));

    const derived = markFor(marks, socialKey(derivedPost()));
    expect(derived?.image).toBe(areaRingImage(SELECTED_SOCIAL_ICON_PX, SOCIAL_COLOUR, true));
    expect(derived?.image).not.toBe(iconImage('pin', SOCIAL_COLOUR, true, SELECTED_SOCIAL_ICON_PX));
  });

  it('produces a pin for no derived post by any route', () => {
    // Belt and braces on the rule that matters most: whatever combination of basis and selection,
    // a derived post is never handed the pin image.
    const { layer, marks } = build();
    const pins = new Set([
      iconImage('pin', SOCIAL_COLOUR, false, SOCIAL_ICON_PX),
      iconImage('pin', SOCIAL_COLOUR, true, SELECTED_SOCIAL_ICON_PX),
    ]);

    layer.upsert([derivedPost({ post_id: 'a' }), derivedPost({ post_id: 'b' })]);
    layer.setSelected(socialKey(derivedPost({ post_id: 'b' })));

    for (const item of marks.items) {
      expect(pins.has(item.image)).toBe(false);
    }
  });

  it('re-anchors a selected pin, so clicking one does not make it jump', () => {
    // The halo changes the view box from 96 units to 160, which moves where the tip sits inside the
    // image by about a fifth of the drawn height. Reusing the unselected offset left a selected pin
    // roughly six pixels above its own coordinate, so the mark leapt on click and the pin pointed at
    // the wrong place while it was the one thing being looked at.
    const { layer, marks } = build();
    const key = socialKey(upstreamPost());
    layer.upsert([upstreamPost()]);

    layer.setSelected(key);

    const pin = markFor(marks, key);
    expect(pin?.pixelOffset.y).toBeCloseTo(pinTipOffsetPx(SELECTED_SOCIAL_ICON_PX, true), 6);
    // Not the unselected figure, and not the unselected figure merely rescaled either.
    expect(pin?.pixelOffset.y).not.toBeCloseTo(pinTipOffsetPx(SOCIAL_ICON_PX, false), 1);
  });

  it('anchors a pin by its tip and centres a ring, which is what each one claims', () => {
    const { layer, marks } = build();

    layer.upsert([upstreamPost(), derivedPost()]);

    const pin = markFor(marks, socialKey(upstreamPost()));
    const ring = markFor(marks, socialKey(derivedPost()));
    // A pin hangs from the bottom of its image, nudged down so the drawn tip lands on the
    // coordinate rather than a fraction above it. The figure comes from the pin's own geometry.
    expect(pin?.verticalOrigin).toBe('BOTTOM');
    expect(pin?.pixelOffset.y).toBeCloseTo(pinTipOffsetPx(SOCIAL_ICON_PX, false), 6);
    expect(pin?.pixelOffset.y).toBeGreaterThan(0);
    // A ring claims an area, so there is nothing to anchor.
    expect(ring?.verticalOrigin).toBe('CENTER');
    expect(ring?.pixelOffset.y).toBe(0);
  });
});

it('draws the other kind of derived post as a ring too', () => {
  // Two structurally different derived posts and one mark between them, which is the point: the
  // ring says "somewhere in this" whether the derivation came from words or from a coordinate that
  // several files share. A viewer should not have to know which, only that it was worked out.
  const { layer, marks } = build();

  layer.upsert([sharedCoordinatePost()]);

  const mark = markFor(marks, socialKey(sharedCoordinatePost()));
  expect(mark?.image).toBe(areaRingImage(SOCIAL_ICON_PX, SOCIAL_COLOUR, false));
  expect(mark?.verticalOrigin).toBe('CENTER');
  expect(mark?.pixelOffset.y).toBe(0);
});

it('treats a shared coordinate as worked out, not reported', () => {
  // The fix to the Commons adapter runs through this one line. Before it, these arrived labelled
  // upstream and every one of them drew a pin asserting an exact point.
  expect(isObservedPosition(sharedCoordinatePost())).toBe(false);
});

it('labels a shared-coordinate post by its source, having no matched place to name', () => {
  // Nothing was read from any words, so there is no place name and none is invented.
  expect(socialLabel(sharedCoordinatePost())).toBe('wikimedia-commons');
});

describe('socialKey', () => {
  it('keys on the source and the post id together', () => {
    // A Commons page id and a Mastodon status id are different namespaces and will collide.
    expect(socialKey({ source: 'a', post_id: '1' })).not.toBe(
      socialKey({ source: 'b', post_id: '1' }),
    );
  });

  it('uses a separator neither half can contain', () => {
    expect(socialKey({ source: 'a:b', post_id: 'c' })).not.toBe(
      socialKey({ source: 'a', post_id: 'b:c' }),
    );
  });

  it('keeps two posts from different sources apart on the globe', () => {
    const { layer } = build();

    layer.upsert([
      upstreamPost({ source: 'wikimedia-commons', post_id: '1' }),
      derivedPost({ source: 'mas.to', post_id: '1' }),
    ]);

    expect(layer.count).toBe(2);
  });
});

describe('socialLabel', () => {
  it('names the place a derived post matched, which is what the derivation resolved to', () => {
    expect(socialLabel(derivedPost())).toBe('London');
  });

  it('names the source for an upstream post, which carries no matched place by contract', () => {
    expect(socialLabel(upstreamPost())).toBe('wikimedia-commons');
  });

  it('never puts a post text on the globe', () => {
    // A truncated sentence from someone's post is unreadable as a label and a worse thing to put on
    // a map than the name of a city.
    const wordy = derivedPost({ text: 'A very long post about something that happened in London' });

    expect(socialLabel(wordy)).not.toContain('happened');
  });
});

describe('SocialLayer', () => {
  it('draws through four collections, all on the translucent pass', () => {
    const { marks, badges, badgeLabels } = build();

    expect((marks.options as { blendOption: string }).blendOption).toBe('TRANSLUCENT');
    expect((badges.options as { blendOption: string }).blendOption).toBe('TRANSLUCENT');
    expect((badgeLabels.options as { blendOption: string }).blendOption).toBe('TRANSLUCENT');
  });

  it('never interpolates and never draws a route between two posts', () => {
    // ADR 005: a post is a fixed event with a timestamp and no motion, and two posts joined to one
    // profile are two dated points where the line between them is not evidence. A polyline
    // collection appearing in this layer is the regression this asserts against.
    const { layer, marks, labels, badges, badgeLabels } = build();
    layer.upsert([upstreamPost({ post_id: '1' }), upstreamPost({ post_id: '2' })]);

    expect(layer.advance()).toBe(false);
    // Four collections and no more: two billboard, two label, no polyline.
    expect([marks, labels, badges, badgeLabels]).toHaveLength(4);
  });

  it('leaves a post exactly where the source put it', () => {
    const { layer, marks } = build();
    const key = socialKey(upstreamPost());
    layer.upsert([upstreamPost({ point: { lon: 12, lat: 34, altitude_m: null } })]);

    layer.advance();

    expect(markFor(marks, key)?.position).toEqual({ x: 12, y: 34, z: 0 });
  });

  it('mutates in place across updates rather than adding a second primitive', () => {
    const { layer, marks } = build();
    layer.upsert([upstreamPost()]);
    const first = marks.items[0];

    for (let index = 0; index < 30; index += 1) {
      layer.upsert([upstreamPost({ point: { lon: index, lat: 2, altitude_m: null } })]);
    }

    expect(marks.items).toHaveLength(1);
    expect(marks.items[0]).toBe(first);
  });

  it('never removes a primitive from a collection', () => {
    const { layer, marks, labels } = build();
    layer.replace([upstreamPost({ post_id: 'a' }), upstreamPost({ post_id: 'b' })]);
    layer.remove([socialKey(upstreamPost({ post_id: 'a' }))]);
    layer.replace([]);

    expect(marks.timesRemoved).toBe(0);
    expect(labels.timesRemoved).toBe(0);
  });

  it('keeps the posts a snapshot still reports and drops only the rest', () => {
    // A partial overlap rather than a clean swap. The Commons and Mastodon pollers both re-serve
    // most of what they served last cycle, so this is the ordinary path, not the edge one.
    const { layer } = build();
    layer.replace([upstreamPost({ post_id: 'a' }), upstreamPost({ post_id: 'b' })]);

    layer.replace([upstreamPost({ post_id: 'b' }), upstreamPost({ post_id: 'c' })]);

    expect(layer.count).toBe(2);
    expect(layer.countInView({ west: -180, south: -90, east: 180, north: 90 })).toBe(2);
  });

  it('ignores a removal for a post it never held', () => {
    const { layer } = build();
    layer.upsert([upstreamPost()]);

    layer.remove(['nowhere\tnothing']);

    expect(layer.count).toBe(1);
  });

  it('parses each CSS colour once however many posts use it', () => {
    const { layer } = build();
    const before = cssColourCalls.count;

    layer.upsert(sameCity(30));

    expect(cssColourCalls.count - before).toBeLessThanOrEqual(2);
  });

  it('labels only the selected post', () => {
    const { layer, labels } = build();
    layer.upsert(sameCity(3));
    expect(labels.items.filter((item) => item.show)).toHaveLength(0);

    layer.setSelected(socialKey({ source: 'mas.to', post_id: 'p100_100_0001' }));

    expect(labels.items.filter((item) => item.show)).toHaveLength(1);
  });

  it('forgets the selection when the selected post leaves the feed', () => {
    const { layer, marks } = build();
    const key = socialKey(derivedPost());
    layer.upsert([derivedPost()]);
    layer.setSelected(key);

    layer.replace([]);
    layer.upsert([derivedPost()]);

    expect(markFor(marks, key)?.image).toBe(areaRingImage(SOCIAL_ICON_PX, SOCIAL_COLOUR, false));
  });

  it('ignores a repeat of the current selection', () => {
    const { layer, marks } = build();
    layer.upsert([derivedPost()]);
    const key = socialKey(derivedPost());

    layer.setSelected(key);
    layer.setSelected(key);

    expect(markFor(marks, key)?.image).toBe(
      areaRingImage(SELECTED_SOCIAL_ICON_PX, SOCIAL_COLOUR, true),
    );
  });

  it('counts what is inside a rectangle, for parity with the other layers', () => {
    const { layer } = build();
    layer.upsert([
      upstreamPost({ post_id: 'in', point: { lon: 0, lat: 51, altitude_m: null } }),
      upstreamPost({ post_id: 'out', point: { lon: 120, lat: -30, altitude_m: null } }),
    ]);

    expect(layer.countInView({ west: -10, south: 45, east: 10, north: 60 })).toBe(1);
  });

  it('routes media through our own origin and never at the provider', () => {
    // ADR 005 has media proxied and cached rather than hot-linked. Nothing in this layer fetches
    // media, but the helper lives here so no caller ever has to build the path itself, and this
    // test is what stops a well-meaning tidy-up shortening it back to the provider URL.
    const provider = 'https://upload.wikimedia.org/wikipedia/commons/a/b/Thing.jpg?width=500';

    const proxied = proxiedMediaUrl(provider);

    expect(proxied.startsWith(`${MEDIA_PROXY_PATH}?`)).toBe(true);
    expect(proxied.startsWith('https://')).toBe(false);
    // Encoded, or the provider's own query joins ours and the backend sees a truncated URL.
    expect(proxied).not.toContain('?width=');
    expect(new URLSearchParams(proxied.split('?', 2)[1]).get('url')).toBe(provider);
  });
});

describe('SocialLayer clustering', () => {
  it('groups posts that resolve to the very same coordinate', () => {
    // The case no other layer has. A gazetteer match on "London" resolves to the city centroid, so
    // posts mentioning it stack perfectly at every zoom and no amount of pulling in separates them.
    const { layer, marks, badges, badgeLabels, frame } = build();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN + 2));

    frame();

    expect(marks.items.filter((item) => item.show)).toHaveLength(0);
    expect(badges.items.filter((item) => item.show)).toHaveLength(1);
    // No count on the globe any more: a group is drawn as one post pin, per Alexander Fanthome's
    // instruction on 2026-08-24 to merge grouped assets into one icon. Asserting the label's
    // absence rather than dropping the assertion, because a stray label is what would quietly
    // bring the clutter back.
    expect(badgeLabels.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('draws a lone post as a post', () => {
    const { layer, marks, badges, frame } = build();
    layer.upsert([derivedPost()]);

    frame();

    expect(marks.items.filter((item) => item.show)).toHaveLength(1);
    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('groups a mere pair, so no mark is ever drawn over another mark', () => {
    // The measured invariant and the reason the minimum is two. A cell is already the separability
    // test, so at two every post still drawn as its own mark is provably alone in its cell. Raise it
    // and the extra marks are ones sharing a cell: at four, 94 of Manhattan's 131 marks overlapped
    // another at an 8km view. An overlapped pin painted over a ring shows a worked-out location as a
    // reported one, which is the presentation ADR 005 exists to forbid, arrived at by accident.
    const { layer, marks, badges, badgeLabels, frame } = build();
    layer.upsert(sameCity(2));

    frame();

    expect(marks.items.filter((item) => item.show)).toHaveLength(0);
    expect(badges.items.filter((item) => item.show)).toHaveLength(1);
    expect(badgeLabels.items.filter((item) => item.show)).toHaveLength(0);
  });

  it('groups at the lowest count of any layer, and the reason is different from theirs', () => {
    // Aircraft 10, transit 12, vessels 15, satellites 30. Those answer "when do marks stop being
    // separable". This one answers "when does a mark start hiding another mark", and the answer to
    // that is always two.
    expect(SOCIAL_CLUSTER_MIN).toBe(2);
  });

  it('publishes a count that adds up', () => {
    const { layer, frame } = build();
    layer.upsert([...sameCity(SOCIAL_CLUSTER_MIN, 100, 100), ...sameCity(1, 900, 500)]);

    frame();

    const state = layer.clusterState;
    expect(state.onScreen).toBe(state.individuals + state.inGroups);
    expect(state.groups).toBe(1);
  });

  it('sends a picked badge to a camera position rather than to a card', () => {
    const { layer, badges, frame } = build();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN));
    frame();
    const pickId = badges.items.find((item) => item.show)?.id ?? null;

    const target = layer.clusterFlyTo(pickId);

    expect(parseClusterPickId(pickId)?.layerKey).toBe(SOCIAL_CLUSTER_KEY);
    expect(target?.count).toBe(SOCIAL_CLUSTER_MIN);
  });

  it('refuses another layer badge and a badge that has dissolved', () => {
    const { layer, frame } = build();
    layer.upsert(sameCity(2));
    frame();

    expect(layer.clusterFlyTo('cluster:transit:0')).toBeNull();
    expect(layer.clusterFlyTo(null)).toBeNull();
    expect(layer.clusterFlyTo('cluster:social:0')).toBeNull();
  });

  it('hides its badges with the rail switch and does no pass while off', () => {
    const { layer, badges, badgeLabels, frame } = build();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN));
    frame();

    layer.setVisible(false);
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN, 700, 700));
    frame();

    expect(badges.show).toBe(false);
    expect(badgeLabels.show).toBe(false);
    expect(layer.clusterState.inGroups).toBe(SOCIAL_CLUSTER_MIN);
  });

  it('still frames a group whose members share one exact coordinate', () => {
    // Measured, not supposed. 500 Commons files inside 10km of Charing Cross carry 46 distinct
    // coordinates between them, and 356 of the 500 sit on one: 51.507351, -0.127758, the London
    // city centroid, stamped on bulk Unsplash uploads. A group of extent zero is the normal case
    // here rather than a degenerate one, and a flight that framed its extent would fly into the
    // ground.
    const { layer, badges, frame } = build();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN, 400, 400));
    frame();

    const target = layer.clusterFlyTo(badges.items.find((item) => item.show)?.id ?? null);

    expect(target?.altitudeM).toBeGreaterThanOrEqual(CLUSTER_FLY_FLOOR_M);
    expect(Number.isFinite(target?.altitudeM ?? NaN)).toBe(true);
  });

  it('keeps a perfectly coincident stack as one badge, because no zoom separates it', () => {
    // The truthful outcome rather than a shortcoming. Posts on one coordinate cannot be pulled
    // apart, so the badge stays and its count is the only honest thing to draw. What must never
    // happen is the stack dissolving into marks that hide each other and undercount by 355.
    const { layer, marks, badges, frame } = build();
    layer.upsert(sameCity(40, 300, 300));

    frame();

    expect(marks.items.filter((item) => item.show)).toHaveLength(0);
    expect(badges.items.filter((item) => item.show)).toHaveLength(1);
    expect(layer.clusterState.inGroups).toBe(40);
  });

  it('clears a badge that has dissolved rather than leaving it on screen', () => {
    // Badges are pooled, so a group that breaks up leaves a primitive behind holding last frame's
    // count and last frame's pick id. Left showing, it is a lie about a group that no longer exists
    // and it still answers a click.
    const { layer, badges, badgeLabels, frame } = build();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN, 500, 500));
    frame();
    const stale = badges.items.find((item) => item.show)?.id ?? null;
    expect(stale).not.toBeNull();

    layer.replace(sameCity(1, 500, 500));
    frame();

    expect(badges.items.filter((item) => item.show)).toHaveLength(0);
    expect(badgeLabels.items.filter((item) => item.show)).toHaveLength(0);
    expect(layer.clusterFlyTo(stale)).toBeNull();
  });

  it('steps aside when another layer already holds the point it wanted', () => {
    // The cross-layer case, with a real layer on one side of it. Every mover layer bins on the same
    // 56px lattice, so two layers whose members fall in one cell used to draw on the identical pixel
    // and one badge vanished under the other completely. Measured on the live feeds at the opening
    // view on 2026-08-24: 8 of 24 badges hidden outright, and a viewer counted sixteen.
    const { layer, badges, frame } = build();
    badgeSlots.reset();
    badgeSlots.begin(VIEWPORT_W, VIEWPORT_H, CLUSTER_CELL_PX);
    const taken = { x: 0, y: 0 };
    badgeSlots.claim('aircraft', 617, 431, taken);
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN, 617, 431));

    frame();

    const badge = badges.items.find((item) => item.show);
    const drawn = { x: 617 + (badge?.pixelOffset.x ?? 0), y: 431 + (badge?.pixelOffset.y ?? 0) };
    expect(drawn).not.toEqual(taken);
    // A whole cell away, so the widest badge cannot reach across.
    expect(Math.hypot(drawn.x - taken.x, drawn.y - taken.y)).toBeGreaterThanOrEqual(
      CLUSTER_CELL_PX,
    );
  });

  it('holds still across passes, rather than walking a cell further every frame', () => {
    // A layer releases its own claims before making them again, so its second pass contends with the
    // other layers and never with itself. Without that it displaces its own badge one cell per frame
    // and the badges crawl across the map while the camera sits still. Two passes is the smallest
    // test that sees it: one pass looks perfect either way.
    const { layer, badges, frame } = build();
    badgeSlots.reset();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN, 617, 431));

    frame();
    const first = { ...badges.items.find((item) => item.show)?.pixelOffset };
    for (let pass = 0; pass < 5; pass += 1) {
      frame();
    }
    const sixth = { ...badges.items.find((item) => item.show)?.pixelOffset };

    expect(sixth).toEqual(first);
  });

  it('takes the point it wanted when no other layer is holding it', () => {
    const { layer, badges, frame } = build();
    badgeSlots.reset();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN, 617, 431));

    frame();

    const badge = badges.items.find((item) => item.show);
    const wanted = {
      x: (Math.floor(617 / CLUSTER_CELL_PX) + 0.5) * CLUSTER_CELL_PX,
      y: (Math.floor(431 / CLUSTER_CELL_PX) + 0.5) * CLUSTER_CELL_PX,
    };
    expect(617 + (badge?.pixelOffset.x ?? 0)).toBeCloseTo(wanted.x, 6);
    expect(431 + (badge?.pixelOffset.y ?? 0)).toBeCloseTo(wanted.y, 6);
  });

  it('draws a merged group at the members mean position, not nudged onto a lattice point', () => {
    // Replaces a test about the badge and its count label moving together under the lattice nudge.
    // Both halves of that are gone: there is no count label, and a merged icon is drawn where its
    // members actually are rather than on a cell centre. What is worth keeping is the invariant
    // underneath it, that the drawn position is derived from the members and not from the grid,
    // because a group pinned to a cell centre would drift as the camera moved and read as a mark
    // that had moved when nothing had.
    const { layer, badges, frame } = build();
    badgeSlots.reset();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN, 617, 431));

    frame();

    const badge = badges.items.find((item) => item.show);
    if (badge === undefined) throw new Error('expected a merged group');
    // Every member of `sameCity` is at the identical coordinate, so their mean is that coordinate
    // and the drawn position must be it. A lattice-nudged badge would sit on the cell centre,
    // which for 617 is a different number: 617 is not a cell centre, which is why it was chosen.
    const cellCentreX = (Math.floor(617 / CLUSTER_CELL_PX) + 0.5) * CLUSTER_CELL_PX;
    expect(cellCentreX).not.toBeCloseTo(617, 6);
    expect(badge.position.x).toBeCloseTo(617, 3);
    expect(badge.position.y).toBeCloseTo(431, 3);
  });

  it('pools its badges rather than removing them', () => {
    const { layer, badges, frame } = build();
    layer.upsert(sameCity(SOCIAL_CLUSTER_MIN));
    frame();
    layer.replace([]);

    frame();

    expect(badges.timesRemoved).toBe(0);
  });
});

describe('SocialLayer sizing', () => {
  it('draws the largest mark in the app, because this layer is sparse and is the subject', () => {
    // Commons geosearch caps at 500 results over a 10km radius, so a viewport holds hundreds where
    // transit holds ten thousand. Posts are what was asked for rather than context around it.
    expect(SOCIAL_ICON_PX).toBeGreaterThan(22);
    expect(SELECTED_SOCIAL_ICON_PX).toBeGreaterThan(SOCIAL_ICON_PX);
  });

  it('shrinks gently with range, and not at all when selected', () => {
    const { layer, marks } = build();
    layer.upsert([upstreamPost()]);
    const key = socialKey(upstreamPost());
    const scale = markFor(marks, key)?.scaleByDistance as { nearValue: number; farValue: number };
    expect(scale.nearValue).toBe(1);
    // The floor is the ring's, not a taste judgement. Measured on a size ramp: the hole reads down
    // to about 14px and is mush at 10px, and a ring with no hole is a filled mark with a centre,
    // which is the presentation ADR 005 forbids. So the ramp may never take the mark below the
    // size at which the hollow survives.
    expect(SOCIAL_ICON_PX * scale.farValue).toBeGreaterThanOrEqual(RING_LEGIBLE_FLOOR_PX);

    layer.setSelected(key);

    expect((markFor(marks, key)?.scaleByDistance as { farValue: number }).farValue).toBe(1);
  });
});
