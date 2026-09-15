import {
  advectParticle,
  metersPerDegreeLon,
  sampleWind,
  windColor,
  windSpeed,
} from './model.js';

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

  const MAX_TRAIL_LENGTH = 10;

  const randomParticle = () => {
    const life = 1.4 + Math.random() * 1.8;
    return {
      lon: Math.random() * 360 - 180,
      lat: Math.random() * 178 - 89,
      age: Math.random() * life,
      life,
      trail: [],
    };
  };

  const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
  const clampLat = (lat) => Math.max(-89, Math.min(89, lat));
  const finite = (value) => Number.isFinite(value);

  /**
   * The camera's visible geographic bounds, or null when it cannot be computed
   * (`computeViewRectangle` returns NaN at very close zoom). Falls back to a
   * height-scaled spread around the camera subpoint.
   * @returns {?{west: number, east: number, south: number, north: number}}
   */
  const viewBounds = (scene) => {
    const camera = scene?.camera;
    const math = cesium.Math;
    if (camera?.computeViewRectangle && cesium.Ellipsoid && math) {
      try {
        const rect = camera.computeViewRectangle(cesium.Ellipsoid.WGS84);
        if (rect) {
          const west = math.toDegrees(rect.west);
          const east = math.toDegrees(rect.east);
          const south = math.toDegrees(rect.south);
          const north = math.toDegrees(rect.north);
          if (
            finite(west) &&
            finite(east) &&
            finite(south) &&
            finite(north) &&
            east > west
          )
            return { west, east, south, north };
        }
      } catch {
        /* fall through to the subpoint spread */
      }
    }
    const carto = camera?.positionCartographic;
    if (carto && finite(carto.longitude) && finite(carto.latitude) && math) {
      const height = finite(carto.height) ? carto.height : 1e6;
      const spread = Math.min(
        60,
        Math.max(0.5, math.toDegrees(Math.acos(6378137 / (6378137 + height)))),
      );
      const lon = math.toDegrees(carto.longitude);
      const lat = math.toDegrees(carto.latitude);
      return {
        west: lon - spread,
        east: lon + spread,
        south: lat - spread,
        north: lat + spread,
      };
    }
    return null;
  };

  /** A particle with a finite lifetime and staggered age so the field keeps reseeding smoothly. */
  const particleAt = (lon, lat, age = null) => {
    const life = 1.4 + Math.random() * 1.8;
    return {
      lon: wrapLon(lon),
      lat: clampLat(lat),
      age: age !== null ? age : Math.random() * life,
      life,
      trail: [],
    };
  };

  /** Spawn a particle inside the current view (uniform over the bounds). */
  const spawnParticle = (scene) => {
    const bounds = viewBounds(scene);
    if (bounds) {
      const lon = bounds.west + Math.random() * (bounds.east - bounds.west);
      const lat = bounds.south + Math.random() * (bounds.north - bounds.south);
      return particleAt(lon, lat, 0);
    }
    const p = randomParticle();
    p.age = 0;
    return p;
  };

  const budget = () =>
    Math.max(3200, Math.min(6000, Math.floor((cssWidth * cssHeight) / 140)));

  /**
   * Seed particles on a jittered grid over the visible bounds. Uniform coverage
   * is what keeps the layer from looking patchy or clumped like random seeding.
   */
  const seed = () => {
    particles = [];
    const limit = budget();
    const scene = getViewer?.()?.scene;
    const bounds = viewBounds(scene);
    if (!bounds) {
      for (let i = 0; i < limit; i += 1) particles.push(randomParticle());
      return;
    }
    const width = Math.max(0.01, bounds.east - bounds.west);
    const height = Math.max(0.01, bounds.north - bounds.south);
    const aspect = Math.max(1, width / height);
    const cols = Math.max(1, Math.round(Math.sqrt(limit * aspect)));
    const rows = Math.max(1, Math.ceil(limit / cols));
    for (let row = 0; row < rows && particles.length < limit; row += 1) {
      for (let col = 0; col < cols && particles.length < limit; col += 1) {
        const lon = bounds.west + ((col + Math.random()) / cols) * width;
        const lat = bounds.south + ((row + Math.random()) / rows) * height;
        particles.push(particleAt(lon, lat));
      }
    }
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

  let lastCamX = 0;
  let lastCamY = 0;
  let lastCamZ = 0;
  let lastCamHeading = 0;
  let lastCamPitch = 0;

  const draw = (time) => {
    frame = null;
    if (!running) return;
    const viewer = getViewer?.();
    if (!viewer || viewer.isDestroyed?.()) return;
    try {
      resize(viewer);
      const dt = lastTime
        ? Math.min(0.1, Math.max(0.001, (time - lastTime) / 1000))
        : 0.016;
      lastTime = time;

      if (!field) {
        frame = globalThis.requestAnimationFrame(draw);
        return;
      }
      const scene = viewer.scene;
      let occluder = null;
      try {
        if (
          cesium.EllipsoidalOccluder &&
          cesium.Ellipsoid &&
          scene.camera?.positionWC
        )
          occluder = new cesium.EllipsoidalOccluder(
            cesium.Ellipsoid.WGS84,
            scene.camera.positionWC,
          );
      } catch {
        occluder = null; // fall back to frustum-only culling
      }

      // Camera motion check: if camera moved significantly, clear trails to prevent smearing
      const camera = scene?.camera;
      const camPos = camera?.positionWC;
      const camX = camPos?.x ?? 0;
      const camY = camPos?.y ?? 0;
      const camZ = camPos?.z ?? 0;
      const camHeading = camera?.heading ?? 0;
      const camPitch = camera?.pitch ?? 0;

      const cameraMoved =
        Math.abs(camX - lastCamX) > 5 ||
        Math.abs(camY - lastCamY) > 5 ||
        Math.abs(camZ - lastCamZ) > 5 ||
        Math.abs(camHeading - lastCamHeading) > 0.002 ||
        Math.abs(camPitch - lastCamPitch) > 0.002;

      if (cameraMoved) {
        lastCamX = camX;
        lastCamY = camY;
        lastCamZ = camZ;
        lastCamHeading = camHeading;
        lastCamPitch = camPitch;
        for (let i = 0; i < particles.length; i += 1) {
          particles[i].trail.length = 0;
        }
      }

      // Redraw fresh frame: clean screen eliminates static clumps and smearing
      context.clearRect?.(0, 0, cssWidth, cssHeight);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.globalCompositeOperation = 'source-over';

      for (const particle of particles) {
        const wind = sampleWind(field, particle.lon, particle.lat);
        const speed = windSpeed(wind.u, wind.v);

        // Stagnant air penalty to prevent accumulation in dead calm zones
        if (speed < 0.2) {
          particle.age += dt * 2;
        } else {
          particle.age += dt;
        }

        const beforeLon = particle.lon;
        const beforeLat = particle.lat;

        // Dynamic step speed based on local wind speed:
        // Calm wind moves gently (~1.3 - 1.8 px), gale winds flow swiftly (~4.5 - 5.5 px)
        if (speed > 0.01) {
          const speedT = Math.min(1, speed / 30);
          const targetPx = 1.3 + Math.pow(speedT, 0.75) * 4.2;
          const cosLat = Math.max(
            0.05,
            Math.cos((particle.lat * Math.PI) / 180),
          );
          const probeLon = particle.lon + (wind.u / speed) * (0.001 / cosLat);
          const probeLat = particle.lat + (wind.v / speed) * 0.001;
          const probe = project(scene, occluder, probeLon, probeLat);
          const start = project(scene, occluder, particle.lon, particle.lat);
          if (probe && start) {
            const px = Math.hypot(probe.x - start.x, probe.y - start.y);
            if (px > 0.001) {
              const scale = targetPx / px;
              // RK2 midpoint advection for smooth streamline curvature along vortices
              const halfDt = (0.0005 * scale * 111320) / speed;
              const midLon =
                particle.lon +
                (wind.u * halfDt) / metersPerDegreeLon(particle.lat);
              const midLat = Math.max(
                -89,
                Math.min(89, particle.lat + (wind.v * halfDt) / 111320),
              );
              const midWind = sampleWind(field, midLon, midLat);
              const fullDt = (0.001 * scale * 111320) / speed;
              advectParticle(particle, midWind, fullDt, { speedScale: 1 });
            }
          }
        }

        if (!Number.isFinite(particle.lon) || !Number.isFinite(particle.lat)) {
          Object.assign(particle, spawnParticle(scene));
          particle.trail.length = 0;
          continue;
        }

        const head = project(scene, occluder, particle.lon, particle.lat);
        const offscreen =
          !head ||
          head.x < -10 ||
          head.y < -10 ||
          head.x > cssWidth + 10 ||
          head.y > cssHeight + 10;

        if (particle.age >= particle.life || offscreen) {
          Object.assign(particle, spawnParticle(scene));
          particle.trail.length = 0;
          continue;
        }

        // Maintain continuous streamline trail
        if (particle.trail.length === 0) {
          const prev = project(scene, occluder, beforeLon, beforeLat);
          if (prev) particle.trail.push({ x: prev.x, y: prev.y });
        }
        particle.trail.push({ x: head.x, y: head.y });
        if (particle.trail.length > MAX_TRAIL_LENGTH) {
          particle.trail.shift();
        }

        const trail = particle.trail;
        const len = trail.length;
        if (len >= 2) {
          const color = windColor(speed);
          const lifeFrac = Math.min(
            1,
            Math.max(0, particle.age / particle.life),
          );
          const lifeFade = Math.sin(lifeFrac * Math.PI);

          if (len < 4) {
            // Short streamline segment
            context.strokeStyle = color;
            context.lineWidth = 1.1;
            context.globalAlpha = 0.5 * lifeFade;
            context.beginPath();
            context.moveTo(trail[0].x, trail[0].y);
            for (let i = 1; i < len; i += 1) {
              context.lineTo(trail[i].x, trail[i].y);
            }
            context.stroke();
          } else {
            // Mature streamline with subtle tapered and faded trail (tail -> head)
            const mid = Math.floor(len * 0.45);

            // Tail section: faint, delicate
            context.strokeStyle = color;
            context.lineWidth = 0.85;
            context.globalAlpha = 0.22 * lifeFade;
            context.beginPath();
            context.moveTo(trail[0].x, trail[0].y);
            for (let i = 1; i <= mid; i += 1) {
              context.lineTo(trail[i].x, trail[i].y);
            }
            context.stroke();

            // Head section: brighter, tapered width
            context.lineWidth = 1.65;
            context.globalAlpha = 0.82 * lifeFade;
            context.beginPath();
            context.moveTo(trail[mid].x, trail[mid].y);
            for (let i = mid + 1; i < len; i += 1) {
              context.lineTo(trail[i].x, trail[i].y);
            }
            context.stroke();
          }
        }
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
      // The layer hands over the source manifest, whose grid metadata is nested
      // under `grid`; flatten it into the `{ u, v, nx, ny, lo1, la1, dx, dy }`
      // shape sampleWind expects. Without this every index is NaN and nothing
      // is ever drawn.
      field = next?.grid ? { ...next.grid, u: next.u, v: next.v } : next;
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
