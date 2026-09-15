import { advectParticle, sampleWind, windColor, windSpeed } from './model.js';

/**
 * Canvas particle renderer for a global wind field.
 *
 * Particles are advected in lon/lat by the sampled field and projected to the
 * screen through Cesium each frame. Particles hidden by the globe are skipped
 * with an `EllipsoidalOccluder`, and trails fade into a translucent backdrop.
 *
 * @param {{cesium: object, container: HTMLElement, getViewer: Function}} options
 */
export function createWindRendering({ cesium, container, getViewer } = {}) {
  let canvas = null;
  let context = null;
  let field = null;
  let particles = [];
  let frame = null;
  let running = false;
  let lastTime = 0;
  let cssWidth = 1;
  let cssHeight = 1;
  let warned = false;

  const randomParticle = () => ({
    lon: Math.random() * 360 - 180,
    lat: Math.random() * 178 - 89,
    age: Math.random() * 180,
  });

  /**
   * Spawn a particle inside the current view. Prefers the camera's visible
   * rectangle (robust at any zoom), then ellipsoid picking, then a whole-globe
   * fallback. Seeding globally would leave almost nothing on screen at regional
   * zoom, which reads as "the layer is broken".
   */
  const spawnParticle = (scene) => {
    const camera = scene?.camera;
    if (camera?.computeViewRectangle && cesium.Ellipsoid && cesium.Math) {
      try {
        const rect = camera.computeViewRectangle(cesium.Ellipsoid.WGS84);
        if (rect) {
          const west = cesium.Math.toDegrees(rect.west);
          let east = cesium.Math.toDegrees(rect.east);
          const south = cesium.Math.toDegrees(rect.south);
          const north = cesium.Math.toDegrees(rect.north);
          if (east < west) east += 360; // rectangle crosses the antimeridian
          const lon = west + Math.random() * (east - west);
          const lat = south + Math.random() * (north - south);
          return {
            lon: ((lon + 180) % 360 + 360) % 360 - 180,
            lat: Math.max(-89, Math.min(89, lat)),
            age: Math.random() * 30,
          };
        }
      } catch {
        /* fall through to the global fallback */
      }
    }
    return randomParticle();
  };

  const budget = () =>
    Math.max(4000, Math.min(12000, Math.floor((cssWidth * cssHeight) / 150)));

  const seed = () => {
    particles = [];
    const limit = budget();
    const scene = getViewer?.()?.scene;
    for (let i = 0; i < limit; i += 1) particles.push(spawnParticle(scene));
  };

  const resize = (viewer) => {
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const sceneCanvas = viewer?.scene?.canvas;
    cssWidth = sceneCanvas?.clientWidth || container?.clientWidth || 1;
    cssHeight = sceneCanvas?.clientHeight || container?.clientHeight || 1;
    canvas.width = Math.floor(cssWidth * ratio);
    canvas.height = Math.floor(cssHeight * ratio);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    context.setTransform?.(ratio, 0, 0, ratio, 0, 0);
  };

  /** Project lon/lat to CSS pixels, or null when hidden by the globe. */
  const project = (scene, occluder, lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const cartesian = cesium.Cartesian3.fromDegrees(lon, lat, 0);
    if (occluder && !occluder.isPointVisible(cartesian)) return null;
    return cesium.SceneTransforms.worldToWindowCoordinates(scene, cartesian);
  };

  const draw = (time) => {
    frame = null;
    if (!running) return;
    const viewer = getViewer?.();
    if (!viewer || viewer.isDestroyed?.()) return;
    try {
      resize(viewer);
      const dt = lastTime ? Math.min(1, Math.max(0, (time - lastTime) / 1000)) : 0.016;
      lastTime = time;
      // Fade previous trails by ERASING them (destination-out). A translucent
      // black fill would instead accumulate alpha and saturate the overlay.
      context.globalCompositeOperation = 'destination-out';
      context.fillStyle = 'rgba(0, 0, 0, 0.02)';
      context.fillRect(0, 0, cssWidth, cssHeight);
      if (!field) {
        frame = globalThis.requestAnimationFrame(draw);
        return;
      }
      const scene = viewer.scene;
      // Real wind (m/s) is invisible at globe scale, so the advection is
      // exaggerated in proportion to camera height: the same visual speed is
      // legible whether the camera is at street level or over a whole hemisphere.
      const cameraHeight = scene.camera?.positionCartographic?.height ?? 1e6;
      const speedScale = Math.max(1, Math.min(4000, cameraHeight / 400));
      let occluder = null;
      try {
        if (cesium.EllipsoidalOccluder && cesium.Ellipsoid && scene.camera?.positionWC)
          occluder = new cesium.EllipsoidalOccluder(cesium.Ellipsoid.WGS84, scene.camera.positionWC);
      } catch {
        occluder = null; // fall back to frustum-only culling
      }
      context.lineWidth = 1.8;
      context.globalAlpha = 0.9;
      // Normal (non-additive) blending: additive strokes saturate to white when
      // many trails overlap over a dark globe.
      context.globalCompositeOperation = 'source-over';
      for (const particle of particles) {
        const wind = sampleWind(field, particle.lon, particle.lat);
        const before = { lon: particle.lon, lat: particle.lat };
        advectParticle(particle, wind, dt, { speedScale });
        particle.age += dt;
        // A NaN/Infinity position (polar divide-by-zero or a bad grid value)
        // must never reach Cesium: it throws and would abort the whole frame.
        if (!Number.isFinite(particle.lon) || !Number.isFinite(particle.lat)) {
          Object.assign(particle, spawnParticle(scene));
          continue;
        }
        const point = project(scene, occluder, particle.lon, particle.lat);
        const offscreen =
          !point ||
          point.x < 0 ||
          point.y < 0 ||
          point.x > cssWidth ||
          point.y > cssHeight;
        if (particle.age > 240 || offscreen) {
          Object.assign(particle, spawnParticle(scene));
          continue;
        }
        const previous = project(scene, occluder, before.lon, before.lat);
        if (!previous) continue;
        const speed = windSpeed(wind.u, wind.v);
        context.strokeStyle = windColor(speed);
        context.beginPath();
        context.moveTo(previous.x, previous.y);
        context.lineTo(point.x, point.y);
        context.stroke();
      }
      context.globalAlpha = 1;
    } catch (error) {
      if (!warned) {
        console.warn('[Data:Wind] frame failed:', error?.message || error);
        warned = true;
      }
    }
    frame = globalThis.requestAnimationFrame(draw);
  };

  return {
    /** Create and append the overlay canvas. */
    attach() {
      if (canvas) return;
      canvas = document.createElement('canvas');
      canvas.dataset.gevWind = '1';
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = '1';
      context = canvas.getContext('2d');
      container.appendChild(canvas);
    },
    /** Install a wind field and (re)seed particles. */
    setField(next) {
      field = next;
      if (canvas) {
        resize(getViewer?.());
        seed();
      }
    },
    /** Start the animation loop. Safe to call before a field is installed. */
    start() {
      if (running || !canvas) return;
      running = true;
      lastTime = 0;
      frame = globalThis.requestAnimationFrame(draw);
    },
    /** Stop the animation loop. */
    stop() {
      running = false;
      if (frame !== null) globalThis.cancelAnimationFrame(frame);
      frame = null;
    },
    /** Clear the canvas and particles without removing the canvas. */
    clear() {
      particles = [];
      context?.clearRect(0, 0, cssWidth, cssHeight);
    },
    /** Stop and remove the overlay canvas. Idempotent. */
    destroy() {
      this.stop();
      this.clear();
      canvas?.remove();
      canvas = null;
      context = null;
    },
    /** Test seam: the current particle count. */
    getParticleCount() {
      return particles.length;
    },
  };
}
