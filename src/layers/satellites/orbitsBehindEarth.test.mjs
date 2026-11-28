import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { gstime } from 'satellite.js';
import { drawOf } from '../../render/rendererOf.js';
// The Cesium draw port, for a viewer with no renderer bound.
import '../../render/cesium/unbound.js';
import { ISS_NORAD, TRACKED_ORBIT_COLOR } from './policy.js';
import { createRendering } from './rendering.js';

// Node has no WebGL context to report line-width limits.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;

/** A scene with what the draw port touches: primitives and its events. */
function fakeScene() {
  const added = [];
  return {
    added,
    postRender: new Cesium.Event(),
    preRender: new Cesium.Event(),
    camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    getHeight: () => undefined,
    primitives: {
      add: (primitive) => (added.push(primitive), primitive),
      remove: (primitive) => {
        const at = added.indexOf(primitive);
        if (at >= 0) added.splice(at, 1);
        return at >= 0;
      },
      length: 0,
    },
    requestRender() {},
    isDestroyed: () => false,
  };
}

/** Run `fn` with the image classes Cesium's materials look for. */
function withImageClasses(fn) {
  const names = [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ];
  const real = names.map((name) => globalThis[name]);
  for (const name of names) globalThis[name] ??= class {};
  try {
    return fn();
  } finally {
    names.forEach((name, i) => (globalThis[name] = real[i]));
  }
}

/** Every primitive under `host`, collections opened. */
function primitivesIn(host, out = []) {
  out.push(host);
  if (host instanceof Cesium.PrimitiveCollection)
    for (let i = 0; i < host.length; i++) primitivesIn(host.get(i), out);
  return out;
}

/** The orbit rings' layer, drawing into Cesium over a scene of its own. */
function ringsOverCesium() {
  const scene = fakeScene();
  const viewer = { scene, isDestroyed: () => false };
  const state = {
    now: Date.now,
    _points: new Map(),
    _orbitPaths: new Map(),
    _catalog: new Map([
      [ISS_NORAD, { satrec: {} }],
      [20580, { satrec: {} }],
    ]),
    _viewer: viewer,
    _trackedNorad: null,
    _enabled: true,
    _params: { showPoints: true, showOrbits: true },
  };
  // Half an orbit at 7,000 km: round the far side of the Earth too.
  const path = Array.from({ length: 13 }, (_, i) => {
    const a = (i / 12) * Math.PI;
    return { x: 7e6 * Math.cos(a), y: 7e6 * Math.sin(a), z: 0 };
  });
  const rendering = createRendering({
    state,
    services: {
      focus: {
        focusNowMs: (ms) => ms,
        getFocusTarget: () => null,
        focusPassIsNeeded: () => false,
      },
    },
    parts: {
      orbits: { computeOrbitPath: () => path },
      tracking: { _getTrackedFramePosition: () => null },
    },
  });
  rendering._attach(viewer);
  return { scene, state, rendering, draw: drawOf(viewer) };
}

test('satellite orbits are hidden by the Earth behind it, not drawn over it', () =>
  withImageClasses(() => {
    const { scene, state, rendering } = ringsOverCesium();
    try {
      rendering._showOrbitPath(ISS_NORAD, TRACKED_ORBIT_COLOR);
      rendering._showOrbitPath(20580, TRACKED_ORBIT_COLOR);
      const all = scene.added.flatMap((host) => primitivesIn(host));
      // Nothing draws where the Earth is in front of a ring.
      assert.equal(
        all.filter(
          (p) => p instanceof Cesium.Primitive && p.depthFailAppearance,
        ).length,
        0,
        'no ring has a colour behind the surface',
      );
      // Both rings are plain depth-tested polylines, the ISS's as any other.
      const polylines = all.filter(
        (p) => p instanceof Cesium.PolylineCollection,
      );
      const lines = polylines.flatMap((c) =>
        Array.from({ length: c.length }, (_, i) => c.get(i)),
      );
      const byId = new Map(lines.map((line) => [line.id.id, line]));
      const iss = byId.get(String(ISS_NORAD));
      const other = byId.get('20580');
      assert.ok(iss && other, 'both rings are drawn');
      assert.equal(iss.width, 2, 'the ISS ring is as wide as any');
      assert.equal(other.width, 2);
      assert.ok(
        Cesium.Color.equals(
          iss.material.uniforms.color,
          new Cesium.Color(1, 1, 0, 0.6),
        ),
        'the ISS ring has no colour of its own',
      );
      assert.ok(
        Cesium.Color.equals(
          other.material.uniforms.color,
          new Cesium.Color(1, 1, 0, 0.6),
        ),
      );

      // Turned with the Earth: moved where it is drawn, still with nothing
      // behind the surface.
      const before = iss.positions[0].clone();
      rendering._updateOrbitPathRotations(new Date(Date.now() + 600_000));
      const after = scene.added
        .flatMap((host) => primitivesIn(host))
        .filter((p) => p instanceof Cesium.Primitive && p.depthFailAppearance);
      assert.equal(after.length, 0, 'a turned ring stays hidden behind it');
      const path = state._orbitPaths.get(ISS_NORAD);
      const angle = -(gstime(new Date(Date.now() + 600_000)) - path.gmstAtBake);
      assert.ok(Math.abs(angle) > 0);
      assert.ok(
        !Cesium.Cartesian3.equalsEpsilon(iss.positions[0], before, 1e-3),
        'the ring moved in place',
      );

      // The orbit dim keeps it hidden behind the Earth.
      assert.equal(rendering._setOrbitPathAlpha(ISS_NORAD, 0.5), true);
      assert.equal(path.item.depthFail, undefined);
      assert.ok(Math.abs(iss.material.uniforms.color.alpha - 0.3) < 1e-9);
    } finally {
      rendering._detach();
    }
  }));
