import * as geo from '../../../geo/index.js';
import { MAX_DOTS } from '../policy.js';

// Point handles keep the same mutable fields the shared traffic motion loop uses.
// The GPU gets two packed draws, including the preset's optional colored outlines.
function createTrafficPoints(engine) {
  const points = new Set(),
    renderSets = [];
  for (const [role, order] of [
    ['outline', 0],
    ['fill', 1],
  ]) {
    renderSets.push(
      engine.movers.createSet({
        id: 'traffic-' + role,
        kind: 'point',
        order,
        capacity: MAX_DOTS,
        depthTest: 'normal',
        pickable: false,
        point: { sizePx: 1, outlinePx: 0 },
      }),
    );
  }
  const color = [0, 0, 0, 0];
  let empty = true;
  const range = (p, d) => {
    if (!p) return 1;
    // The engine's distance scalar interpolates in squared range.
    const x = Math.min(
      1,
      Math.max(
        0,
        (d * d - p.near * p.near) / (p.far * p.far - p.near * p.near),
      ),
    );
    return p.nearValue + (p.farValue - p.nearValue) * Math.pow(x, 0.2);
  };
  return {
    show: true,
    add(spec) {
      const pos = geo.cartesian3.clone(spec.position);
      const p = {
        ...spec,
        show: spec.show ?? true,
        get position() {
          return pos;
        },
        set position(v) {
          geo.cartesian3.clone(v, pos);
        },
      };
      points.add(p);
      return p;
    },
    remove(point) {
      return points.delete(point);
    },
    removeAll() {
      points.clear();
      this.flush();
    },
    flush() {
      if (!points.size && empty) return;
      empty = points.size === 0;
      const center = engine.camera.livePosition;
      const sizes = [0, 0];
      if (this.show && center)
        for (const p of points) {
          if (
            !p.show ||
            p.pixelSize <= 0 ||
            !engine.projector.horizonVisible(p.position)
          )
            continue;
          const distance = geo.cartesian3.distance(p.position, center),
            scale = range(p.scaleByDistance, distance),
            alpha = range(p.translucencyByDistance, distance);
          if (alpha <= 0) continue;
          for (
            let i = p.outlineWidth > 0 && p.outlineColor ? 0 : 1;
            i < 2;
            i++
          ) {
            const c = i ? p.color : p.outlineColor;
            color[0] = c.red;
            color[1] = c.green;
            color[2] = c.blue;
            color[3] = c.alpha * alpha;
            renderSets[i].set(sizes[i]++, {
              position: p.position,
              scale: Math.max(
                0,
                (p.pixelSize + (i ? 0 : 2 * p.outlineWidth)) * scale,
              ),
              color,
              show: true,
            });
          }
        }
      for (let i = 0; i < 2; i++) {
        renderSets[i].setCount(sizes[i]);
        renderSets[i].commit();
      }
    },
    destroy() {
      for (const set of renderSets) set.destroy();
      points.clear();
    },
  };
}
export function createTrafficNavaraRenderer(engine, native) {
  const { view } = native;
  const points = createTrafficPoints(engine);
  const surface = {
    engine,
    canvas: engine.host.canvas,
    postRender: engine.frames.postRender,
    get sampleHeightSupported() {
      return engine.surface.supported;
    },
    sampleHeight: (p) =>
      engine.maps.photorealActive()
        ? engine.surface.sampleHeight(p)
        : engine.surface.terrainHeight(p),
    project: (world, out) => engine.projector.worldToWindow(world, out),
    get ready() {
      return engine.surface.tilesLoaded();
    },
    get surfaceKey() {
      return engine.maps.photorealActive() ? 'tiles' : 'terrain';
    },
  };
  const makeHeat = (roads, tint, width, alpha) => {
    if (!roads.length) return null;
    const source = view.addSource({
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: roads.map((r) => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: r.coords },
        })),
      },
    });
    const css =
      (Math.round(tint.red * 255) << 16) |
      (Math.round(tint.green * 255) << 8) |
      Math.round(tint.blue * 255);
    let layer;
    try {
      layer = view.addLayer({
        type: 'vector',
        source,
        polyline: {
          color: css,
          width,
          opacity: alpha,
          clampToGround: true,
          transparent: true,
          lit: false,
        },
      });
    } catch (e) {
      source.delete();
      throw e;
    }
    let current = alpha;
    layer.on('featureUpdated', ({ evaluator }) =>
      evaluator.evaluate(() => ({ opacity: current })),
    );
    return {
      setAlpha(a) {
        if (Math.abs(a - current) > 0.015) {
          current = a;
          layer.forceUpdate();
        }
      },
      destroy() {
        layer.delete();
        source.delete();
      },
    };
  };
  return { points, surface, makeHeat, destroy: () => points.destroy() };
}
