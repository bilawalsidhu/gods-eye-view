/**
 * @module render/cesium/draw
 * @description The Cesium renderer's draw port
 * (`src/render/contract/draw.d.ts`): batched sets of items, each set one
 * primitive collection in the scene, rebuilt when its items change. Every
 * item carries a pick id `{set, id, meta, lodGroup}`, which the query port
 * (`ports.js`) reads picks back through.
 *
 * Clamped items follow the ground as Cesium's own entities do: a clamped
 * point is a billboard of a drawn dot, a draped line a ground polyline, a
 * clamped fill a ground primitive (packed so no two fills in one overlap,
 * so overlapping translucent fills blend as they did). A rebuilt set keeps
 * drawing its last ground primitives until the new ones are ready, so a
 * refresh never blinks. `horizonCull` hides a set's points and icons past
 * the ellipsoid's horizon, each frame before it draws, tested at the
 * position each was given (not where clamping put it).
 *
 * Built over a scene by `createCesiumPorts`, and on its own over a Cesium
 * viewer with no renderer bound, when code first asks
 * `findDraw` for one (`rendererOf.js`).
 */
import * as Cesium from 'cesium';
import { provideUnboundDraw } from '../rendererOf.js';
import { listenerList, toCartesian, uncaught } from './common.js';

/** The contract's colour as Cesium's. */
export function toColor(color, alpha = 1) {
  if (color === undefined || color === null)
    return Cesium.Color.WHITE.withAlpha(alpha);
  const c =
    typeof color === 'string'
      ? Cesium.Color.fromCssColorString(color)
      : new Cesium.Color(color[0], color[1], color[2], color[3] ?? 1);
  return c.withAlpha(c.alpha * alpha);
}

/** An image reference as something a billboard takes. */
export function toImage(image) {
  if (typeof image === 'string') return image;
  if (image?.svg)
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}`;
  if (image?.canvas) return image.canvas;
  throw new Error('the Cesium renderer takes URL, SVG and canvas images only');
}

/** Cesium's height reference for an item's `height` and `clampTo`. */
export function heightReferenceOf(height, clampTo = 'both') {
  const H = Cesium.HeightReference;
  if (height === 'clampGround')
    return (
      { terrain: H.CLAMP_TO_TERRAIN, tiles: H.CLAMP_TO_3D_TILE }[clampTo] ??
      H.CLAMP_TO_GROUND
    );
  if (height === 'relativeGround')
    return (
      { terrain: H.RELATIVE_TO_TERRAIN, tiles: H.RELATIVE_TO_3D_TILE }[
        clampTo
      ] ?? H.RELATIVE_TO_GROUND
    );
  return H.NONE;
}

/** Cesium's classification for what clamped lines and fills drape onto. */
const classificationOf = (clampTo = 'both') =>
  ({
    terrain: Cesium.ClassificationType.TERRAIN,
    tiles: Cesium.ClassificationType.CESIUM_3D_TILE,
  })[clampTo] ?? Cesium.ClassificationType.BOTH;

const ANCHORS = {
  center: Cesium.VerticalOrigin.CENTER,
  bottom: Cesium.VerticalOrigin.BOTTOM,
  top: Cesium.VerticalOrigin.TOP,
};

/**
 * The draw port over `scene`, and what the other ports read of it: the live
 * sets by id, a version that changes with them, the scene's 3D tilesets and
 * the clamp-state watch the frame loop runs after each draw.
 * @param {{scene: object, report: (error: unknown) => void}} options
 */
export function createCesiumDraw({ scene, report }) {
  const sets = new Map();
  // Bumped on every change to the sets or what they hold.
  let setsVersion = 0;
  // A viewer can be destroyed before the layers drawing on it
  // let their sets go; those calls then have nothing left to do.
  const live = () => !scene.isDestroyed?.();
  const requestRender = () => {
    if (live()) scene.requestRender();
  };

  function makeSet(kind, spec, build) {
    if (sets.has(spec.id)) throw new Error(`a set with id ${spec.id} is live`);
    const items = new Map();
    const listeners = { ready: listenerList(report) };
    const record = {
      kind,
      spec,
      items,
      listeners,
      host: null,
      pickIds: [],
      // What it drew before its ground primitives were ready, still shown.
      retiring: null,
      pending: null,
      // The host's ground primitives, and the collection beside them.
      ground: null,
      own: null,
      // Each point or icon at its position, for the horizon cull.
      placed: [],
    };
    // Each build records its items' pick ids, for height queries to see
    // through.
    const rebuild = () => {
      record.pickIds = [];
      record.placed = [];
      build(record);
      setsVersion += 1;
    };
    record.rebuild = rebuild;
    const handle = {
      id: spec.id,
      set(list) {
        items.clear();
        for (const item of list) items.set(item.id, item);
        rebuild();
        requestRender();
      },
      upsert(list) {
        for (const item of list) items.set(item.id, item);
        rebuild();
        requestRender();
      },
      remove(ids) {
        for (const id of ids) items.delete(id);
        rebuild();
        requestRender();
      },
      clear() {
        items.clear();
        rebuild();
        requestRender();
      },
      setOptions(options) {
        const culled = spec.horizonCull;
        const clampTo = spec.clampTo;
        Object.assign(spec, options);
        // What clamped items clamp to is built into them.
        if (spec.clampTo !== clampTo) rebuild();
        setsVersion += 1;
        showHosts(record);
        // No longer culled: what the cull hid comes back.
        if (culled && !spec.horizonCull) uncull(record);
        requestRender();
      },
      size: () => items.size,
      get show() {
        return spec.show !== false;
      },
      set show(value) {
        spec.show = value;
        showHosts(record);
        requestRender();
      },
      on(event, cb) {
        return listeners[event]?.on(cb) ?? (() => {});
      },
      dispose() {
        if (record.host && !record.host.isDestroyed?.() && live())
          scene.primitives.remove(record.host);
        record.host = null;
        retire(record);
        // A newer set under the same id is not this handle's to remove.
        if (sets.get(spec.id) === record) sets.delete(spec.id);
        setsVersion += 1;
        requestRender();
      },
    };
    sets.set(spec.id, record);
    setsVersion += 1;
    return handle;
  }

  function pickId(record, item) {
    const id = {
      set: record.spec.id,
      id: item.id,
      meta: item.meta,
      lodGroup: item.lodGroup,
    };
    record.pickIds.push(id);
    return id;
  }

  /**
   * Draw `host` for the set in place of what it drew. With `ground` (its
   * ground primitives), the new host's ground primitives stay hidden and
   * the old host keeps drawing until every one is ready, then they swap in
   * one frame, as the entities' ground batches do; a host still waiting
   * when the next one comes is dropped.
   */
  function replaceHost(record, host, ground = null, own = null) {
    const old = record.host;
    const waiting = ground?.length ? ground : null;
    // Only old ground primitives wait for the new ones: the rest of the old
    // host goes now, as the new host's own parts draw at once.
    if (
      old &&
      waiting &&
      !record.retiring &&
      !record.pending &&
      record.ground
    ) {
      record.retiring = old;
      if (record.own) old.remove(record.own);
    } else if (old) scene.primitives.remove(old);
    if (!waiting) retire(record);
    // Hidden one by one: a hidden collection would not build them.
    if (waiting) for (const primitive of waiting) primitive.show = false;
    record.pending = waiting;
    record.ground = waiting;
    record.own = waiting ? own : null;
    record.host = host;
    scene.primitives.add(host);
    showHosts(record);
  }

  function showHosts(record) {
    const show = record.spec.show !== false;
    if (record.host) record.host.show = show;
    if (record.retiring) record.retiring.show = show;
  }

  function retire(record) {
    if (record.retiring && !record.retiring.isDestroyed?.() && live())
      scene.primitives.remove(record.retiring);
    record.retiring = null;
  }

  /**
   * After a draw: a set whose ground primitives are all ready shows them,
   * and lets go of what drew in their place.
   */
  function swapReady() {
    for (const record of sets.values()) {
      const ground = record.pending;
      if (!ground || ground.some((p) => !p.isDestroyed() && !p.ready)) continue;
      for (const primitive of ground) primitive.show = true;
      record.pending = null;
      retire(record);
      requestRender();
    }
  }

  // The horizon cull: a point or icon past the ellipsoid's horizon from the
  // eye is hidden, as layers drawn without depth test used to do themselves.
  let occluder = null;
  function cullHorizon() {
    for (const record of sets.values()) {
      if (!record.spec.horizonCull || !record.placed.length) continue;
      const eye = scene.camera?.positionWC;
      // The eye is ECEF in 3D only.
      if (
        !eye ||
        (scene.mode ?? Cesium.SceneMode.SCENE3D) !== Cesium.SceneMode.SCENE3D
      )
        return;
      occluder ??= new Cesium.EllipsoidalOccluder(
        scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
        eye,
      );
      occluder.cameraPosition = eye;
      for (const placed of record.placed) {
        const show = placed.shown && occluder.isPointVisible(placed.position);
        if (placed.primitive.show !== show) placed.primitive.show = show;
      }
    }
  }

  function uncull(record) {
    for (const placed of record.placed) placed.primitive.show = placed.shown;
  }

  /** Remember a drawn point or icon for the horizon cull. */
  function place(record, primitive, position, shown) {
    record.placed.push({ primitive, position, shown });
  }

  // Atlases icons name images from, by id: `{atlas, slot}` reads the slot
  // when its set is built, and registering an atlas again rebuilds the icon
  // sets that drew from it.
  const atlases = new Map();

  /**
   * An icon's image: an atlas slot read through its atlas, or undefined
   * while its atlas or slot is not registered (it draws once it is).
   */
  function iconImage(record, image) {
    if (typeof image?.atlas !== 'string') return image;
    record.atlases.add(image.atlas);
    return atlases.get(image.atlas)?.[image.slot];
  }

  function buildIcons(record) {
    const host = new Cesium.BillboardCollection({ scene });
    record.atlases = new Set();
    for (const item of record.items.values()) {
      const image = iconImage(record, item.image);
      if (image === undefined) continue;
      // A generated image is one texture under its key, however many icons
      // draw it.
      const keyed = image?.canvas && typeof image.key === 'string';
      const position = toCartesian(item.pos);
      const options = {
        position,
        ...(keyed ? {} : { image: toImage(image) }),
        width: item.size[0] * (item.scale ?? 1),
        height: item.size[1] * (item.scale ?? 1),
        color: toColor(item.color, item.alpha ?? 1),
        verticalOrigin: ANCHORS[item.anchor ?? 'center'],
        disableDepthTestDistance: item.disableDepthTest ?? 0,
        heightReference: heightReferenceOf(item.height, record.spec.clampTo),
        show: item.show !== false,
        id: pickId(record, item),
      };
      if (item.rotationMode === 'screen') options.rotation = item.rotation ?? 0;
      if (item.rotationMode === 'course') {
        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
        options.alignedAxis = Cesium.Matrix4.multiplyByPointAsVector(
          enu,
          Cesium.Cartesian3.UNIT_Y,
          new Cesium.Cartesian3(),
        );
        options.rotation = -Cesium.Math.toRadians(item.course ?? 0);
      }
      const billboard = host.add(options);
      if (keyed) billboard.setImage(image.key, image.canvas);
      place(record, billboard, position, options.show);
    }
    replaceHost(record, host);
  }

  function buildPoints(record) {
    let points = null;
    let dots = null;
    for (const item of record.items.values()) {
      const position = toCartesian(item.pos);
      const show = item.show !== false;
      const heightReference = heightReferenceOf(
        item.height,
        record.spec.clampTo,
      );
      let primitive;
      if (heightReference === Cesium.HeightReference.NONE) {
        points ??= new Cesium.PointPrimitiveCollection();
        primitive = points.add({
          position,
          pixelSize: item.pixelSize,
          color: toColor(item.color),
          outlineColor: toColor(item.outlineColor ?? [0, 0, 0, 0]),
          outlineWidth: item.outlineWidth ?? 0,
          disableDepthTestDistance: item.disableDepthTest ?? 0,
          show,
          id: pickId(record, item),
        });
      } else {
        // Point primitives cannot follow the ground.
        dots ??= new Cesium.BillboardCollection({ scene });
        primitive = addDot(dots, item, {
          position,
          heightReference,
          show,
          id: pickId(record, item),
        });
      }
      place(record, primitive, position, show);
    }
    let host = points ?? dots ?? new Cesium.PointPrimitiveCollection();
    if (points && dots) {
      host = new Cesium.PrimitiveCollection();
      host.add(points);
      host.add(dots);
    }
    replaceHost(record, host);
  }

  /**
   * A clamped point as Cesium's entity points draw one: a billboard of a
   * dot drawn at its pixel size, one texture per look.
   */
  function addDot(collection, item, options) {
    const color = toColor(item.color);
    const outlineColor = toColor(item.outlineColor ?? [0, 0, 0, 0]);
    const outlineWidth = Math.round(item.outlineWidth ?? 0);
    let pixelSize = Math.max(1, Math.round(item.pixelSize));
    let scale = 1;
    if (outlineWidth <= 0) {
      // Drawn large and scaled down, as the entity points are.
      scale = pixelSize / 50;
      pixelSize = 50;
    }
    const css = color.toCssColorString();
    const cssOutline = outlineColor.toCssColorString();
    const billboard = collection.add({
      ...options,
      scale,
      disableDepthTestDistance: item.disableDepthTest ?? 0,
    });
    billboard.setImage(
      JSON.stringify([css, pixelSize, cssOutline, outlineWidth]),
      Cesium.createBillboardPointCallback(
        color.alpha,
        css,
        cssOutline,
        outlineWidth,
        pixelSize,
      ),
    );
    return billboard;
  }

  function lineMaterial(style) {
    switch (style.kind) {
      case 'solid':
        return Cesium.Material.fromType('Color', {
          color: toColor(style.color),
        });
      case 'glow':
        return Cesium.Material.fromType('PolylineGlow', {
          color: toColor(style.color),
          glowPower: style.power,
          taperPower: style.taper ?? 1,
        });
      case 'dash':
        return Cesium.Material.fromType('PolylineDash', {
          color: toColor(style.color),
          gapColor: toColor(style.gapColor ?? [0, 0, 0, 0]),
          dashLength: style.length,
          ...(style.pattern16 !== undefined
            ? { dashPattern: style.pattern16 }
            : {}),
        });
      case 'arrow':
        return Cesium.Material.fromType('PolylineArrow', {
          color: toColor(style.color),
        });
      default:
        throw new Error(`the Cesium renderer has no ${style.kind} lines`);
    }
  }

  function linePositions(item) {
    const flat = item.positions instanceof Float64Array;
    const points = [];
    const n = flat ? item.positions.length / 3 : item.positions.length;
    for (let i = 0; i < n; i++)
      points.push(
        flat
          ? new Cesium.Cartesian3(
              item.positions[i * 3],
              item.positions[i * 3 + 1],
              item.positions[i * 3 + 2],
            )
          : toCartesian(item.positions[i]),
      );
    if (item.mode !== 'geodesic') return points;
    const dense = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = Cesium.Cartographic.fromCartesian(points[i]);
      const b = Cesium.Cartographic.fromCartesian(points[i + 1]);
      const geodesic = new Cesium.EllipsoidGeodesic(a, b);
      for (let k = 0; k < 64; k++) {
        const s = k / 64;
        const at = geodesic.interpolateUsingFraction(s);
        dense.push(
          Cesium.Cartesian3.fromRadians(
            at.longitude,
            at.latitude,
            a.height + (b.height - a.height) * s,
          ),
        );
      }
    }
    dense.push(points.at(-1));
    return dense;
  }

  function buildLines(record) {
    const host = new Cesium.PolylineCollection();
    const draped = new Map();
    for (const item of record.items.values()) {
      if (item.mode === 'draped') {
        if (item.style.kind !== 'solid')
          throw new Error('the Cesium renderer drapes solid lines only');
        const clampTo = item.clampTo ?? record.spec.clampTo ?? 'both';
        if (!draped.has(clampTo)) draped.set(clampTo, []);
        draped.get(clampTo).push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions: linePositions(item),
              width: item.widthPx,
              arcType: Cesium.ArcType.GEODESIC,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                toColor(item.style.color),
              ),
              show: new Cesium.ShowGeometryInstanceAttribute(
                item.show !== false,
              ),
            },
            id: pickId(record, item),
          }),
        );
        continue;
      }
      host.add({
        positions: linePositions(item),
        width: item.widthPx,
        material: lineMaterial(item.style),
        show: item.show !== false,
        id: pickId(record, item),
      });
    }
    if (!draped.size) return replaceHost(record, host);
    // Draped lines drape as the entities' clamped polylines do.
    const ground = [...draped].map(
      ([clampTo, geometryInstances]) =>
        new Cesium.GroundPolylinePrimitive({
          geometryInstances,
          appearance: new Cesium.PolylineColorAppearance(),
          classificationType: classificationOf(clampTo),
        }),
    );
    replaceHost(record, collect(host, ground), ground, host);
  }

  /** One host for a set's own collection and its ground primitives. */
  function collect(own, ground) {
    const host = new Cesium.PrimitiveCollection();
    if (own) host.add(own);
    for (const primitive of ground) host.add(primitive);
    return host;
  }

  const heightOf = (pos) =>
    'x' in pos
      ? Cesium.Cartographic.fromCartesian(toCartesian(pos)).height
      : (pos.height ?? 0);

  function shapeGeometry(item) {
    const g = item.geometry;
    const extrudedHeight = item.extrudeHeight;
    switch (g.kind) {
      case 'polygon': {
        const [outer, ...holes] = g.rings.map((ring) => ring.map(toCartesian));
        const hierarchy = new Cesium.PolygonHierarchy(
          outer,
          holes.map((h) => new Cesium.PolygonHierarchy(h)),
        );
        return {
          fill: new Cesium.PolygonGeometry({
            polygonHierarchy: hierarchy,
            height: g.perPositionHeight ? undefined : heightOf(g.rings[0][0]),
            extrudedHeight,
            perPositionHeight: g.perPositionHeight,
          }),
          ring: outer,
        };
      }
      case 'ellipse':
        return {
          fill: new Cesium.EllipseGeometry({
            center: toCartesian(g.center),
            semiMajorAxis: g.semiMajor,
            semiMinorAxis: g.semiMinor,
            rotation: g.rotation ?? 0,
            height: heightOf(g.center),
            extrudedHeight,
          }),
        };
      case 'rectangle':
        return {
          fill: new Cesium.RectangleGeometry({
            rectangle: Cesium.Rectangle.fromDegrees(
              g.rect.west,
              g.rect.south,
              g.rect.east,
              g.rect.north,
            ),
            height: g.height ?? 0,
            extrudedHeight,
          }),
        };
      case 'box': {
        const d = g.dimensions;
        return {
          fill: Cesium.BoxGeometry.fromDimensions({
            dimensions: new Cesium.Cartesian3(d.x, d.y, d.z),
          }),
          modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
            toCartesian(g.center),
          ),
        };
      }
      default:
        throw new Error(`the Cesium renderer has no ${g.kind} shapes`);
    }
  }

  /** A clamped shape's fill geometry, on the ellipsoid for draping. */
  function groundGeometry(item) {
    const g = item.geometry;
    switch (g.kind) {
      case 'polygon': {
        const [outer, ...holes] = g.rings.map((ring) => ring.map(toCartesian));
        return new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            outer,
            holes.map((h) => new Cesium.PolygonHierarchy(h)),
          ),
        });
      }
      case 'ellipse':
        if (typeof g.semiMajor !== 'number' || typeof g.semiMinor !== 'number')
          throw new Error('the Cesium renderer takes fixed ellipse radii only');
        return new Cesium.EllipseGeometry({
          center: toCartesian(g.center),
          semiMajorAxis: g.semiMajor,
          semiMinorAxis: g.semiMinor,
          rotation: g.rotation ?? 0,
        });
      case 'rectangle':
        return new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(
            g.rect.west,
            g.rect.south,
            g.rect.east,
            g.rect.north,
          ),
        });
      default:
        throw new Error(`the Cesium renderer cannot clamp ${g.kind} shapes`);
    }
  }

  /**
   * A set's clamped fills as ground primitives, packed as the entities'
   * ground batches are: a fill goes in the first batch it overlaps nothing
   * in, so overlapping translucent fills blend over each other.
   */
  function groundFills(record, items) {
    const batches = [];
    for (const item of items) {
      if (item.outline)
        throw new Error('the Cesium renderer has no clamped outlines yet');
      if (!item.fill || item.outlineOnly) continue;
      if (typeof item.fill === 'object' && !Array.isArray(item.fill))
        throw new Error('the Cesium renderer fills shapes with colours only');
      if (item.extrudeHeight !== undefined)
        throw new Error('the Cesium renderer cannot clamp extruded shapes');
      const instance = new Cesium.GeometryInstance({
        geometry: groundGeometry(item),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            toColor(item.fill),
          ),
        },
        id: pickId(record, item),
      });
      const clampTo = item.clampTo ?? record.spec.clampTo ?? 'both';
      const rectangle = instance.geometry.rectangle;
      let batch = batches.find(
        (b) => b.clampTo === clampTo && !b.rectangles.collides(rectangle),
      );
      if (!batch) {
        batch = {
          clampTo,
          instances: [],
          rectangles: new Cesium.RectangleCollisionChecker(),
        };
        batches.push(batch);
      }
      batch.rectangles.insert(String(batch.instances.length), rectangle);
      batch.instances.push(instance);
    }
    return batches.map(
      (batch) =>
        new Cesium.GroundPrimitive({
          geometryInstances: batch.instances,
          classificationType: classificationOf(batch.clampTo),
        }),
    );
  }

  function buildShapes(record) {
    const host = new Cesium.PrimitiveCollection();
    const outlines = new Cesium.PolylineCollection();
    const clamped = [];
    for (const item of record.items.values()) {
      if (item.show === false) continue;
      if (item.height === 'clampGround') {
        clamped.push(item);
        continue;
      }
      if (
        item.fill &&
        typeof item.fill === 'object' &&
        !Array.isArray(item.fill)
      )
        throw new Error('the Cesium renderer fills shapes with colours only');
      const shape = shapeGeometry(item);
      const id = pickId(record, item);
      const solid =
        item.extrudeHeight !== undefined || item.geometry.kind === 'box';
      if (item.fill && !item.outlineOnly) {
        const color = toColor(item.fill);
        host.add(
          new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
              geometry: shape.fill,
              modelMatrix: shape.modelMatrix,
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
              },
              id,
            }),
            appearance: new Cesium.PerInstanceColorAppearance({
              translucent: color.alpha < 1,
              closed: solid,
              // Flat shapes unlit: lit, their two triangles shade apart.
              flat: !solid,
            }),
            asynchronous: false,
          }),
        );
      }
      if (item.outline && shape.ring)
        outlines.add({
          positions: [...shape.ring, shape.ring[0]],
          width: item.outlineWidth ?? 1,
          material: Cesium.Material.fromType('Color', {
            color: toColor(item.outline),
          }),
          id,
        });
    }
    host.add(outlines);
    const ground = groundFills(record, clamped);
    if (!ground.length) return replaceHost(record, host);
    replaceHost(record, collect(host, ground), ground, host);
  }

  function buildModels(record) {
    const host = new Cesium.PrimitiveCollection();
    replaceHost(record, host);
    // A model counts as loading until it is ready or fails, not when added;
    // each model settles once, and a failure is kept for `whenSettled`.
    host.loading = record.items.size;
    host.failed = 0;
    for (const item of record.items.values()) {
      let settled = false;
      const settle = (failed) => {
        if (settled) return;
        settled = true;
        host.loading -= 1;
        if (failed) host.failed += 1;
        scene.requestRender();
      };
      const o = item.orientation;
      const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
        toCartesian(item.pos),
        new Cesium.HeadingPitchRoll(o.heading, o.pitch, o.roll),
      );
      Cesium.Model.fromGltfAsync({
        url: item.url,
        modelMatrix,
        scale: item.scale ?? 1,
        minimumPixelSize: item.minPixelSize ?? 0,
        // All textures before ready, so a settled capture is the whole model.
        incrementallyLoadTextures: false,
        id: pickId(record, item),
      }).then(
        (model) => {
          // Rebuilt, disposed, or the renderer is gone.
          if (record.host !== host || host.isDestroyed())
            return model.destroy();
          host.add(model);
          model.readyEvent.addEventListener(() => {
            settle(false);
            record.listeners.ready.fire(item.id);
          });
          model.errorEvent.addEventListener(() => settle(true));
          scene.requestRender();
        },
        () => settle(true),
      );
    }
  }

  /** The 3D tilesets in the scene, shown or not. */
  function tilesets() {
    const found = [];
    const primitives = scene.primitives;
    const n = primitives?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const primitive = primitives.get(i);
      if (primitive instanceof Cesium.Cesium3DTileset) found.push(primitive);
    }
    return found;
  }

  /**
   * The Cesium port draws clamped items where it is given them; it does not
   * drape them onto 3D tiles yet, so over shown tiles it is `overlay`.
   * Terrain and the ellipsoid always take draped items.
   */
  const clampState = () =>
    tilesets().some((tileset) => tileset.show) ? 'overlay' : 'draped';
  const clampListeners = listenerList(report);
  // The state last told, while anyone listens; measured after each drawn
  // frame, when what the base holds can have changed.
  let toldClamp = null;
  function watchClamp() {
    if (clampListeners.size === 0) return;
    const state = clampState();
    if (state === toldClamp) return;
    toldClamp = state;
    clampListeners.fire(state);
  }

  const draw = {
    icons: (spec) => makeSet('icons', { ...spec }, buildIcons),
    points: (spec) => makeSet('points', { ...spec }, buildPoints),
    lines: (spec) => makeSet('lines', { ...spec }, buildLines),
    shapes: (spec) => makeSet('shapes', { ...spec }, buildShapes),
    models: (spec) => makeSet('models', { ...spec }, buildModels),
    clampState,
    on(event, cb) {
      if (event !== 'clampState') return () => {};
      if (clampListeners.size === 0) toldClamp = clampState();
      return clampListeners.on(cb);
    },
    atlas(id, images) {
      atlases.set(id, { ...images });
      let rebuilt = false;
      for (const record of [...sets.values()])
        if (record.kind === 'icons' && record.atlases?.has(id)) {
          record.rebuild();
          rebuilt = true;
        }
      if (rebuilt) scene.requestRender();
    },
  };

  return {
    port: draw,
    sets,
    version: () => setsVersion,
    tilesets,
    /** Whether a set's ground primitives are still being built. */
    building: () => [...sets.values()].some((record) => record.pending),
    /** Each frame, before it draws: the horizon cull. */
    beforeRender: cullHorizon,
    /** Each frame, after it drew: clamp state, and ground swaps. */
    afterRender() {
      watchClamp();
      swapReady();
    },
    /**
     * Let go of the sets; with `removeHosts`, take what they draw out of
     * the scene too (a scene the port does not own outlives it).
     */
    dispose({ removeHosts = false } = {}) {
      clampListeners.clear();
      // Late model loads find no host and destroy themselves.
      for (const record of sets.values()) {
        if (removeHosts && !scene.isDestroyed?.()) {
          if (record.host) scene.primitives.remove(record.host);
          retire(record);
        }
        record.host = null;
      }
      sets.clear();
    },
  };
}

// A Cesium viewer with no renderer bound to it gets a
// draw port over its scene when code first asks `findDraw` for one. A
// renderer bound later supersedes it: released, its sets keep drawing until
// their owners dispose them; gone with the viewer, it lets them go.
provideUnboundDraw((viewer) => {
  const scene = viewer.scene;
  // By shape, not `instanceof`: the viewer may come from another
  // copy of Cesium.
  if (
    typeof scene?.primitives?.add !== 'function' ||
    typeof scene.postRender?.addEventListener !== 'function' ||
    typeof scene.requestRender !== 'function'
  )
    return null;
  const part = createCesiumDraw({ scene, report: uncaught });
  const offs = [
    scene.preRender?.addEventListener?.(() => part.beforeRender()),
    scene.postRender.addEventListener(() => part.afterRender()),
  ];
  const off = () => offs.splice(0).forEach((remove) => remove?.());
  return {
    port: part.port,
    dispose() {
      off();
      part.dispose({ removeHosts: true });
    },
    // Released, its sets still draw, culled and swapped as before; the
    // hooks go with the scene.
    release() {},
  };
});
