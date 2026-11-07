/**
 * @module render/cesium/draw
 * @description The Cesium renderer's draw port
 * (`src/render/contract/draw.d.ts`): batched sets of items, each set one
 * primitive collection in the scene, rebuilt when its items change. Every
 * item carries a pick id `{set, id, meta, lodGroup}`, which the query port
 * (`ports.js`) reads picks back through.
 *
 * Built over a scene by `createCesiumPorts`, and on its own over a Cesium
 * viewer with no renderer bound, when code first asks
 * `findDraw` for one (`rendererOf.js`).
 */
import * as Cesium from 'cesium';
import { provideUnboundDraw } from '../rendererOf.js';
import { listenerList, toCartesian, uncaught } from './common.js';
// A caller loads this module for a viewer of its own; what draws there
// flies through `cameraOf` too, so the camera factory comes with it.
import './camera.js';

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
    const record = { kind, spec, items, listeners, host: null, pickIds: [] };
    // Each build records its items' pick ids, for height queries to see
    // through.
    const rebuild = () => {
      record.pickIds = [];
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
        Object.assign(spec, options);
        setsVersion += 1;
        if (record.host) record.host.show = spec.show !== false;
        requestRender();
      },
      size: () => items.size,
      get show() {
        return spec.show !== false;
      },
      set show(value) {
        spec.show = value;
        if (record.host) record.host.show = value;
        requestRender();
      },
      on(event, cb) {
        return listeners[event]?.on(cb) ?? (() => {});
      },
      dispose() {
        if (record.host && !record.host.isDestroyed?.() && live())
          scene.primitives.remove(record.host);
        record.host = null;
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

  function replaceHost(record, host) {
    if (record.host) scene.primitives.remove(record.host);
    record.host = host;
    host.show = record.spec.show !== false;
    scene.primitives.add(host);
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
    }
    replaceHost(record, host);
  }

  function buildPoints(record) {
    const host = new Cesium.PointPrimitiveCollection();
    for (const item of record.items.values())
      host.add({
        position: toCartesian(item.pos),
        pixelSize: item.pixelSize,
        color: toColor(item.color),
        outlineColor: toColor(item.outlineColor ?? [0, 0, 0, 0]),
        outlineWidth: item.outlineWidth ?? 0,
        disableDepthTestDistance: item.disableDepthTest ?? 0,
        show: item.show !== false,
        id: pickId(record, item),
      });
    replaceHost(record, host);
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
    for (const item of record.items.values()) {
      if (item.mode === 'draped')
        throw new Error('the Cesium renderer has no draped lines');
      host.add({
        positions: linePositions(item),
        width: item.widthPx,
        material: lineMaterial(item.style),
        show: item.show !== false,
        id: pickId(record, item),
      });
    }
    replaceHost(record, host);
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

  function buildShapes(record) {
    const host = new Cesium.PrimitiveCollection();
    const outlines = new Cesium.PolylineCollection();
    for (const item of record.items.values()) {
      if (item.show === false) continue;
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
    replaceHost(record, host);
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
    watchClamp,
    /**
     * Let go of the sets; with `removeHosts`, take what they draw out of
     * the scene too (a scene the port does not own outlives it).
     */
    dispose({ removeHosts = false } = {}) {
      clampListeners.clear();
      // Late model loads find no host and destroy themselves.
      for (const record of sets.values()) {
        if (removeHosts && record.host && !scene.isDestroyed?.())
          scene.primitives.remove(record.host);
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
  const off = scene.postRender.addEventListener(() => part.watchClamp());
  return {
    port: part.port,
    dispose() {
      off();
      part.dispose({ removeHosts: true });
    },
    release() {
      off();
    },
  };
});
