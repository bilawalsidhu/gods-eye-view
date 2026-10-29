import * as geo from '../../../geo/index.js';

/** Exact 30 m perspective probe, with the native 0.5–3 px basis blend. */
export function createTransitNavaraView(engine) {
  const enu = geo.matrix4.create(),
    forward = geo.cartesian3.create(),
    world = geo.cartesian3.create(),
    probe = geo.cartesian3.create(),
    at = geo.cartesian2.create(),
    ahead = geo.cartesian2.create();
  let pose = engine.camera.pose();
  const fresh = () => (pose = engine.camera.pose());
  return {
    cameraCartographic: () => fresh().cartographic,
    cameraSignature() {
      fresh();
      const p = pose.position;
      return (
        `${Math.round(p.x / 10)}:${Math.round(p.y / 10)}:${Math.round(p.z / 10)}:` +
        `${pose.heading.toFixed(3)}:${pose.pitch.toFixed(3)}:${pose.roll.toFixed(3)}`
      );
    },
    rotation(position, course, previous) {
      if (!position || !Number.isFinite(course)) return previous;
      const angle = geo.math.toRadians(course);
      geo.cartesian3.fromElements(
        Math.sin(angle) * 30,
        Math.cos(angle) * 30,
        0,
        forward,
      );
      geo.transforms.eastNorthUpToFixedFrame(
        position,
        geo.ellipsoid.WGS84,
        enu,
      );
      geo.matrix4.multiplyByPointAsVector(enu, forward, world);
      geo.cartesian3.add(position, world, probe);
      // Match the native 2 km basis probe's degeneracy threshold.
      const dx = geo.cartesian3.dot(world, pose.right) * (2000 / 30);
      const dy = -geo.cartesian3.dot(world, pose.up) * (2000 / 30);
      const basis = dx * dx + dy * dy < 0.25 ? previous : Math.atan2(-dx, -dy);
      const a = engine.projector.worldToWindow(position, at);
      const b = engine.projector.worldToWindow(probe, ahead);
      if (!a || !b) return basis;
      const x = b.x - a.x,
        y = b.y - a.y,
        separation = Math.hypot(x, y);
      const exact = Math.atan2(-x, -y);
      if (separation >= 3 || !Number.isFinite(basis)) return exact;
      if (separation <= 0.5) return basis;
      const delta = Math.atan2(
        Math.sin(exact - basis),
        Math.cos(exact - basis),
      );
      return basis + delta * ((separation - 0.5) / 2.5);
    },
    visibilityTester() {
      const camera = fresh();
      const tanY = Math.tan(camera.fovy / 2);
      const size = engine.host.size();
      const tanX = tanY * (camera.aspectRatio ?? size.width / size.height);
      const xMargin = 5 * Math.hypot(1, tanX),
        yMargin = 5 * Math.hypot(1, tanY);
      const delta = geo.cartesian3.create();
      return {
        hasFrustum: true,
        test(point) {
          geo.cartesian3.subtract(point, camera.position, delta);
          const z = geo.cartesian3.dot(delta, camera.direction);
          return {
            horizon: engine.projector.horizonVisible(point),
            inFrustum:
              z >= (camera.near ?? 0) - 5 &&
              z <= (camera.far ?? Infinity) + 5 &&
              Math.abs(geo.cartesian3.dot(delta, camera.right)) <=
                z * tanX + xMargin &&
              Math.abs(geo.cartesian3.dot(delta, camera.up)) <=
                z * tanY + yMargin,
          };
        },
      };
    },
    refresh: fresh,
  };
}
