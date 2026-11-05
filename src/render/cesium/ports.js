/**
 * @module render/cesium/ports
 * @description The Cesium renderer's contract ports, built over a Cesium
 * widget or viewer someone else made and configured: frame phases, the
 * draw sets, `setView` and the pose, picks and projection, and capture.
 * Building them changes nothing in the scene; only calls do.
 *
 * The conformance renderer (`sceneRenderer.js`) and the application's
 * renderer (`appRenderer.js`) both use them, so what conformance
 * checks is what the application runs. Members a port does not have are
 * absent, never stubbed.
 */
import * as Cesium from 'cesium';

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

/** A contract position as ECEF. */
export function toCartesian(pos) {
  if ('x' in pos) return new Cesium.Cartesian3(pos.x, pos.y, pos.z);
  return Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.height ?? 0);
}

const ANCHORS = {
  center: Cesium.VerticalOrigin.CENTER,
  bottom: Cesium.VerticalOrigin.BOTTOM,
  top: Cesium.VerticalOrigin.TOP,
};

/**
 * @param {object} widget A Cesium `CesiumWidget` or `Viewer`.
 */
export function createCesiumPorts(widget) {
  const scene = widget.scene;
  const camera = scene.camera;
  const sets = new Map();

  const frameListeners = { preUpdate: [], preRender: [], postRender: [] };
  let frames = 0;
  const onPhase = (phase) => (_scene, time) => {
    if (frameListeners[phase].length === 0) return;
    const t = {
      frame: frames,
      time: Cesium.JulianDate.toDate(
        time ?? widget.clock.currentTime,
      ).getTime(),
      now: performance.now(),
      dt: 1 / 60,
      rendering: phase !== 'preUpdate',
    };
    for (const cb of frameListeners[phase].slice()) cb(t);
  };
  let disposed = false;
  const removers = [
    scene.preUpdate.addEventListener(() => (frames += 1)),
    scene.preUpdate.addEventListener(onPhase('preUpdate')),
    scene.preRender.addEventListener(onPhase('preRender')),
    scene.postRender.addEventListener(onPhase('postRender')),
  ];

  // Pending one-shot renders; disposal settles them rather than leave them
  // attached to a scene that will not render again.
  const pendingRenders = new Set();
  function nextPostRender() {
    if (disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        off();
        pendingRenders.delete(done);
        resolve();
      };
      const off = scene.postRender.addEventListener(done);
      pendingRenders.add(done);
      scene.requestRender();
    });
  }

  const frame = {
    on(phase, cb) {
      frameListeners[phase].push(cb);
      return () => {
        const i = frameListeners[phase].indexOf(cb);
        if (i >= 0) frameListeners[phase].splice(i, 1);
      };
    },
    requestRender: () => scene.requestRender(),
    renderNow: () => scene.render(widget.clock.currentTime),
    renderOnce: () => nextPostRender(),
    time: () => Cesium.JulianDate.toDate(widget.clock.currentTime).getTime(),
  };

  // --- Draw ------------------------------------------------------------------

  function makeSet(kind, spec, build) {
    if (sets.has(spec.id)) throw new Error(`a set with id ${spec.id} is live`);
    const items = new Map();
    const listeners = { ready: [] };
    const record = { kind, spec, items, listeners, host: null, rebuild: null };
    const handle = {
      id: spec.id,
      set(list) {
        items.clear();
        for (const item of list) items.set(item.id, item);
        build(record);
        scene.requestRender();
      },
      upsert(list) {
        for (const item of list) items.set(item.id, item);
        build(record);
        scene.requestRender();
      },
      remove(ids) {
        for (const id of ids) items.delete(id);
        build(record);
        scene.requestRender();
      },
      clear() {
        items.clear();
        build(record);
        scene.requestRender();
      },
      setOptions(options) {
        Object.assign(spec, options);
        if (record.host) record.host.show = spec.show !== false;
        scene.requestRender();
      },
      size: () => items.size,
      get show() {
        return spec.show !== false;
      },
      set show(value) {
        spec.show = value;
        if (record.host) record.host.show = value;
        scene.requestRender();
      },
      on(event, cb) {
        listeners[event]?.push(cb);
        return () => {
          const list = listeners[event];
          const i = list?.indexOf(cb) ?? -1;
          if (i >= 0) list.splice(i, 1);
        };
      },
      dispose() {
        if (record.host && !record.host.isDestroyed?.())
          scene.primitives.remove(record.host);
        record.host = null;
        // A newer set under the same id is not this handle's to remove.
        if (sets.get(spec.id) === record) sets.delete(spec.id);
        scene.requestRender();
      },
    };
    sets.set(spec.id, record);
    return handle;
  }

  const pickId = (record, item) => ({
    set: record.spec.id,
    id: item.id,
    meta: item.meta,
  });

  function replaceHost(record, host) {
    if (record.host) scene.primitives.remove(record.host);
    record.host = host;
    host.show = record.spec.show !== false;
    scene.primitives.add(host);
  }

  function buildIcons(record) {
    const host = new Cesium.BillboardCollection({ scene });
    for (const item of record.items.values()) {
      const position = toCartesian(item.pos);
      const options = {
        position,
        image: toImage(item.image),
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
      host.add(options);
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
            for (const cb of record.listeners.ready.slice()) cb(item.id);
          });
          model.errorEvent.addEventListener(() => settle(true));
          scene.requestRender();
        },
        () => settle(true),
      );
    }
  }

  const draw = {
    icons: (spec) => makeSet('icons', { ...spec }, buildIcons),
    points: (spec) => makeSet('points', { ...spec }, buildPoints),
    lines: (spec) => makeSet('lines', { ...spec }, buildLines),
    shapes: (spec) => makeSet('shapes', { ...spec }, buildShapes),
    models: (spec) => makeSet('models', { ...spec }, buildModels),
  };

  const cameraPort = {
    setView(spec) {
      const d = spec.destination;
      if (d && 'rect' in d)
        throw new Error('the Cesium renderer takes position destinations only');
      const o = spec.orientation ?? {};
      camera.setView({
        ...(d ? { destination: toCartesian(d) } : {}),
        orientation: {
          heading: o.heading ?? 0,
          pitch: o.pitch ?? -Math.PI / 2,
          roll: o.roll ?? 0,
        },
      });
      scene.requestRender();
    },
    pose() {
      const v = (c) => ({ x: c.x, y: c.y, z: c.z });
      return {
        position: v(camera.positionWC),
        direction: v(camera.directionWC),
        up: v(camera.upWC),
        right: v(camera.rightWC),
        heading: camera.heading,
        pitch: camera.pitch,
        roll: camera.roll,
        height: camera.positionCartographic.height,
        fovy: camera.frustum.fovy,
        aspectRatio: camera.frustum.aspectRatio,
        near: camera.frustum.near,
        far: camera.frustum.far,
        frameIsIdentity: Cesium.Matrix4.equals(
          camera.transform,
          Cesium.Matrix4.IDENTITY,
        ),
      };
    },
  };

  const query = {
    pick(x, y) {
      const picked = scene.pick(new Cesium.Cartesian2(x, y));
      const id = picked?.id;
      return id && typeof id.set === 'string'
        ? { ...id, surface: false }
        : null;
    },
    project(position) {
      const s = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        toCartesian(position),
      );
      return s ? { x: s.x, y: s.y } : null;
    },
    pickEllipsoid(x, y) {
      const c = camera.pickEllipsoid(new Cesium.Cartesian2(x, y));
      return c ? { x: c.x, y: c.y, z: c.z } : null;
    },
  };

  async function capture({ type = 'png' } = {}) {
    scene.render(widget.clock.currentTime);
    return new Promise((resolve) =>
      scene.canvas.toBlob(resolve, `image/${type}`),
    );
  }

  /** The live model sets, for a renderer's own `whenSettled`. */
  const modelSets = () =>
    [...sets.values()].filter((r) => r.kind === 'models' && r.host);

  return {
    frame,
    draw,
    camera: cameraPort,
    query,
    capture,
    modelSets,
    nextPostRender,
    /** Detach from the scene; the widget's owner destroys the widget. */
    dispose() {
      disposed = true;
      for (const off of removers) off();
      for (const done of [...pendingRenders]) done();
      // Late model loads find no host and destroy themselves.
      for (const record of sets.values()) record.host = null;
      sets.clear();
    },
  };
}
