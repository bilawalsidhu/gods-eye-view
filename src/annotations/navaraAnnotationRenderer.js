// The annotation board on the Navara engine: the hybrid renderer's routing
// (hybridAnnotationRenderer.js) with a Navara world renderer for the marks
// draped on the ground — area footprints and routes as clamped meshes — and
// the shared screen-space SVG board (callouts, reticles, rings, arrows) over
// the engine's projector (screenScene.js). No Cesium, no three.

import { showOsmCredit, hideOsmCredit } from '../data/dataCredits.js';
import { createHybridAnnotationRenderer } from './hybridAnnotationRenderer.js';
import { screenSceneFromEngine } from './screenScene.js';

// The world renderer's palette (worldAnnotationRenderer.js).
const PALETTE = {
  primary: 0x8be9ff,
  amber: 0xffb547,
  cyan: 0x39d0ff,
  green: 0x5dff9f,
  red: 0xff6b6b,
};

/**
 * A map colour (0xRRGGBB) on `view`: the planet's photographic exposure is
 * compensated before its tone-mapping pass so the palette stays readable.
 */
function displayColor({ view, NavaraColor }, hex) {
  const c = new NavaraColor().setHex(hex);
  const exposure = Math.max(1, view.toneMappingExposure ?? 1);
  const [r, g, b] = c.toArray();
  return c.setRGBLinear(r / exposure, g / exposure, b / exposure);
}

/** 0.6 .. 1.0 at ~0.8 Hz, the Cesium marks' pulse. */
export function pulseFactor(now = performance.now()) {
  return 0.8 + 0.2 * Math.sin(now * 0.005);
}

const closedRing = (ring) => {
  const [first] = ring;
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1]
    ? ring.map(([lon, lat]) => [lon, lat])
    : [...ring.map(([lon, lat]) => [lon, lat]), [first[0], first[1]]];
};

/**
 * The draped parts of one mark, as plain data: `{ kind: 'polygon' |
 * 'polyline', geojson, alpha, pulse, width? }`. Areas (a building, a
 * district, a multi-part outline with holes) are a fill and an outline per
 * ring, as the Cesium world renderer draws them; a route is one line.
 * Anything else is screen-space only (none).
 */
export function drapedParts(anno) {
  if (anno.ring?.length >= 3) {
    const building = anno.footprintKind === 'building';
    const parts =
      Array.isArray(anno.polygons) && anno.polygons.length
        ? anno.polygons
        : [[anno.ring]];
    const out = [];
    for (const [outer, ...holes] of parts) {
      if (!Array.isArray(outer) || outer.length < 3) continue;
      const rings = [outer, ...holes.filter((hole) => hole?.length >= 3)];
      out.push({
        kind: 'polygon',
        geojson: { type: 'Polygon', coordinates: rings.map(closedRing) },
        alpha: building ? 0.45 : anno.synthesized ? 0.1 : 0.2,
        pulse: true,
      });
      for (const ring of rings)
        out.push({
          kind: 'polyline',
          geojson: { type: 'LineString', coordinates: closedRing(ring) },
          width: building ? 3 : 6,
          // Approximate outlines are fainter (Cesium dashes them).
          alpha: building ? 0.7 : anno.synthesized ? 0.6 : 1,
          pulse: false,
        });
    }
    return out;
  }
  if (anno.type === 'route' && Array.isArray(anno.path) && anno.path.length) {
    const coordinates = anno.path.map((p) => [p.lon, p.lat]);
    return coordinates.length >= 2
      ? [
          {
            kind: 'polyline',
            geojson: { type: 'LineString', coordinates },
            width: 9,
            alpha: 1,
            pulse: false,
          },
        ]
      : [];
  }
  return [];
}

/**
 * The world half on Navara: one clamped mesh per draped part, its opacity
 * following the mark's fade and pulse each frame and its visibility the
 * mark's `hidden`. Renderer contract: add / remove / sync / destroy.
 * @param {import('../globe/contract.js').GlobeEngine} engine
 * @param {{ view: object, NavaraColor: Function }} views The Navara view and
 *   its colour class (src/app/navaraMode.js).
 */
export function createNavaraWorldAnnotationRenderer(
  engine,
  { view, NavaraColor },
  { now = () => performance.now() } = {},
) {
  // mark -> its meshes: { handle, kind, alpha, pulse, opacity, visible }
  const drawn = new Map();
  const credited = new Set();
  let destroyed = false;

  const targetOpacity = (anno, part, at) =>
    Math.max(
      0,
      Math.min(
        1,
        (anno.alpha ?? 1) * part.alpha * (part.pulse ? pulseFactor(at) : 1),
      ),
    );

  function add(anno) {
    if (destroyed) return;
    const parts = drapedParts(anno);
    // Published before any mesh lands, so a mid-add failure leaves the meshes
    // that did land reachable by remove().
    const meshes = [];
    drawn.set(anno, meshes);
    const color = displayColor(
      { view, NavaraColor },
      PALETTE[anno.color] ?? PALETTE.primary,
    );
    const at = now();
    for (const part of parts) {
      const opacity = targetOpacity(anno, part, at);
      const visible = !anno.hidden;
      const handle = view.addMesh({
        [part.kind]: {
          geojson: part.geojson,
          clampToGround: true,
          color,
          transparent: true,
          opacity,
          ...(part.kind === 'polyline' ? { width: part.width } : {}),
        },
        visible,
        lit: false,
        pickable: false,
      });
      meshes.push({ ...part, handle, opacity, visible });
    }
    if (
      anno.type === 'route' ||
      (meshes.length &&
        anno.ring?.length >= 3 &&
        !anno.synthesized &&
        (anno.outlineCredit === 'tiles' || anno.outlineCredit === 'osm'))
    ) {
      credited.add(anno);
      showOsmCredit(
        engine,
        anno,
        anno.type === 'route'
          ? undefined
          : { openMapTiles: anno.outlineCredit === 'tiles' },
      );
    }
    engine.render.request('annotations');
  }

  function remove(anno) {
    const meshes = drawn.get(anno);
    if (credited.delete(anno)) hideOsmCredit(engine, anno);
    if (!meshes) return;
    drawn.delete(anno);
    for (const mesh of meshes) {
      try {
        mesh.handle.delete();
      } catch {
        /* the view went first */
      }
    }
    engine.render.request('annotations');
  }

  /** Follow each mark's fade, pulse and visibility. */
  function sync() {
    if (destroyed) return;
    const at = now();
    let changed = false;
    for (const [anno, meshes] of drawn) {
      for (const mesh of meshes) {
        const opacity = targetOpacity(anno, mesh, at);
        const visible = !anno.hidden && opacity > 0;
        if (
          visible === mesh.visible &&
          Math.abs(opacity - mesh.opacity) < 0.004
        )
          continue;
        mesh.handle.update({
          [mesh.kind]: { opacity },
          visible,
        });
        mesh.opacity = opacity;
        mesh.visible = visible;
        changed = true;
      }
    }
    if (changed) engine.render.request('annotations');
  }

  // The pulse animates every frame the engine draws (the board holds
  // continuous rendering while a mark is visible).
  const offFrame = engine.frames.preRender.addEventListener(sync);

  function destroy() {
    if (destroyed) return;
    offFrame();
    for (const anno of [...drawn.keys()]) remove(anno);
    for (const anno of credited) hideOsmCredit(engine, anno);
    credited.clear();
    destroyed = true;
  }

  return {
    add,
    remove,
    sync,
    destroy,
    /** The meshes drawn now, for diagnostics and the QA handle. */
    diagnostics: () => ({
      marks: drawn.size,
      meshes: [...drawn.values()].reduce((n, meshes) => n + meshes.length, 0),
    }),
  };
}

/**
 * The annotation board's renderer on a Navara scene: draped areas and routes
 * on the engine, every other mark and every caption on the shared SVG board.
 * `screen` passes options to the screen renderer (its store, in tests).
 */
export function createNavaraAnnotationRenderer(engine, views, { screen } = {}) {
  const world = createNavaraWorldAnnotationRenderer(engine, views);
  const renderer = createHybridAnnotationRenderer(null, {
    engine,
    world,
    screenScene: screenSceneFromEngine(engine),
    screen,
  });
  return { ...renderer, diagnostics: world.diagnostics };
}
