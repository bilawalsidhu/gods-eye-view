import { createWindRelief } from './relief.js';
import { createWindGpuRendering } from './gpuRendering.js';
import { advectParticle, sampleWind } from './model.js';
import {
  createFieldRaster,
  trailEraseAlpha,
  windTrailColor,
} from './fields.js';

/** Globe-projected surface flow plus one owned, static Cesium imagery field. */
export function createWindRendering({
  cesium,
  container,
  getViewer,
  createGpuRendering = createWindGpuRendering,
  onStatusChange,
} = {}) {
  let canvas = null;
  let context = null;
  let snapshot = null;
  let field = null;
  let particles = [];
  let frame = null;
  let running = false;
  let lastTime = null;
  let cssWidth = 1;
  let cssHeight = 1;
  let warned = false;
  let overlay = 'none';
  let paused = false;
  let reducedMotion = false;
  let imagery = null;
  let imageryCollection = null;
  let imageryError = null;
  let imageryErrorRemove = null;
  let media = null;
  let removers = [];
  let bounds = null;
  let cameraChanged = true;
  let painted = 0;
  const gpu = createGpuRendering({ cesium, getViewer });
  let gpuActive = false;
  let reportedGpuReady = null;
  let gpuNarrow = false;
  let flowTime = 0;
  const relief = createWindRelief({ cesium, getViewer });
  const signature = Array(8).fill(null);
  const wind = { u: 0, v: 0 };
  const before = { lon: 0, lat: 0 };
  const world =
    typeof cesium.Cartesian3 === 'function' ? new cesium.Cartesian3() : {};
  const screenA =
    typeof cesium.Cartesian2 === 'function' ? new cesium.Cartesian2() : {};
  const screenB =
    typeof cesium.Cartesian2 === 'function' ? new cesium.Cartesian2() : {};
  const degree = Math.PI / 180;
  const hidden = () => globalThis.document?.hidden === true;
  const still = () => paused || reducedMotion;
  const budget = () =>
    Math.max(
      200,
      Math.min(
        cssWidth < 600 ? 1000 : 3000,
        Math.floor((cssWidth * cssHeight) / 420),
      ),
    );
  const viewerReady = () => {
    const viewer = getViewer?.();
    return viewer && !viewer.isDestroyed?.() ? viewer : null;
  };

  function cancel() {
    if (frame !== null) globalThis.cancelAnimationFrame(frame);
    frame = null;
  }
  function schedule() {
    if (running && field && canvas && !hidden() && !still() && frame === null)
      frame = globalThis.requestAnimationFrame(draw);
  }
  function clearPixels() {
    context?.clearRect(0, 0, cssWidth, cssHeight);
  }

  function resize(viewer) {
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    cssWidth =
      viewer?.scene?.canvas?.clientWidth || container?.clientWidth || 1;
    cssHeight =
      viewer?.scene?.canvas?.clientHeight || container?.clientHeight || 1;
    const width = Math.max(1, Math.floor(cssWidth * ratio));
    const height = Math.max(1, Math.floor(cssHeight * ratio));
    // Assigning even unchanged dimensions erases a real canvas.
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    context.setTransform?.(ratio, 0, 0, ratio, 0, 0);
    return true;
  }

  function checkCamera(scene) {
    const camera = scene.camera;
    const position = camera?.positionWC;
    const values = [
      position?.x,
      position?.y,
      position?.z,
      camera?.heading,
      camera?.pitch,
      camera?.roll,
      cssWidth,
      cssHeight,
    ];
    let changed = false;
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== signature[i]) changed = true;
      signature[i] = values[i];
    }
    return changed;
  }

  function updateBounds(scene) {
    bounds = null;
    if (!scene.camera?.computeViewRectangle || !cesium.Ellipsoid) return;
    try {
      const rect = scene.camera.computeViewRectangle(cesium.Ellipsoid.WGS84);
      if (!rect) return;
      const west = rect.west / degree;
      let east = rect.east / degree;
      const south = Math.max(-89, rect.south / degree);
      const north = Math.min(89, rect.north / degree);
      if (east < west) east += 360;
      if (
        [west, east, south, north].every(Number.isFinite) &&
        east > west &&
        north > south
      )
        bounds = {
          west,
          east,
          sinSouth: Math.sin(south * degree),
          sinNorth: Math.sin(north * degree),
        };
    } catch {
      /* A sky-facing camera can have no earth rectangle. */
    }
  }

  function makeOccluder(scene) {
    if (
      !cesium.EllipsoidalOccluder ||
      !cesium.Ellipsoid ||
      !scene.camera?.positionWC
    )
      return null;
    return new cesium.EllipsoidalOccluder(
      cesium.Ellipsoid.WGS84,
      scene.camera.positionWC,
    );
  }

  function project(scene, occluder, lon, lat, result) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const point = cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      0,
      cesium.Ellipsoid?.WGS84,
      world,
    );
    if (occluder && !occluder.isPointVisible(point)) return null;
    const projected = cesium.SceneTransforms.worldToWindowCoordinates(
      scene,
      point,
      result,
    );
    if (
      !projected ||
      !Number.isFinite(projected.x) ||
      !Number.isFinite(projected.y)
    )
      return null;
    // A perspective surface normal dims the limb instead of accumulating a bright rim.
    const camera = scene.camera?.positionWC;
    const dx = camera?.x - point.x;
    const dy = camera?.y - point.y;
    const dz = camera?.z - point.z;
    const denominator =
      Math.hypot(point.x, point.y, point.z) * Math.hypot(dx, dy, dz);
    const cosine =
      denominator > 0
        ? (point.x * dx + point.y * dy + point.z * dz) / denominator
        : 1;
    projected.visibility = Number.isFinite(cosine)
      ? Math.max(0, Math.min(1, cosine / 0.3))
      : 1;
    return projected;
  }
  const inView = (point) =>
    point &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x <= cssWidth &&
    point.y <= cssHeight;

  function spawn(particle, scene, occluder) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const west = bounds?.west ?? -180;
      const east = bounds?.east ?? 180;
      const low = bounds?.sinSouth ?? -0.9998;
      const high = bounds?.sinNorth ?? 0.9998;
      particle.lon = ((west + Math.random() * (east - west) + 540) % 360) - 180;
      particle.lat = Math.asin(low + Math.random() * (high - low)) / degree;
      particle.age = 1 + Math.random() * 7;
      particle.life = 8 + Math.random() * 4;
      if (inView(project(scene, occluder, particle.lon, particle.lat, screenA)))
        return;
    }
  }
  function seed(scene, occluder) {
    const count = budget();
    if (particles.length > count) particles.length = count;
    while (particles.length < count)
      particles.push({ lon: 0, lat: 0, age: 0, life: 10 });
    updateBounds(scene);
    for (const particle of particles) spawn(particle, scene, occluder);
  }

  function removeImagery() {
    imageryErrorRemove?.();
    imageryErrorRemove = null;
    if (imagery && imageryCollection && !imageryCollection.isDestroyed?.())
      imageryCollection.remove(imagery, true);
    imagery = null;
    imageryCollection = null;
  }
  function installImagery() {
    removeImagery();
    imageryError = null;
    const viewer = viewerReady();
    if (!snapshot || overlay === 'none' || !viewer) return;
    const raster = createFieldRaster(snapshot, overlay);
    if (!raster) {
      imageryError = `${overlay} field unavailable`;
      return;
    }
    const collection = viewer.imageryLayers ?? viewer.scene?.imageryLayers;
    if (!collection || !cesium.SingleTileImageryProvider) {
      imageryError = 'Globe imagery unavailable';
      return;
    }
    try {
      const texture = document.createElement('canvas');
      texture.width = raster.width;
      texture.height = raster.height;
      const ctx = texture.getContext('2d');
      const pixels = ctx.createImageData(raster.width, raster.height);
      pixels.data.set(raster.rgba);
      ctx.putImageData(pixels, 0, 0);
      const provider = new cesium.SingleTileImageryProvider({
        url: texture.toDataURL('image/png'),
        tileWidth: raster.width,
        tileHeight: raster.height,
        rectangle: cesium.Rectangle.MAX_VALUE,
      });
      imagery = collection.addImageryProvider(provider);
      imageryCollection = collection;
      imagery.alpha = 0.85;
      imageryErrorRemove = provider.errorEvent?.addEventListener(() => {
        imageryError = 'Globe field image unavailable';
      });
      viewer.scene?.requestRender?.();
    } catch {
      removeImagery();
      imageryError = 'Globe field image unavailable';
    }
  }

  /** No idle animation for pause/reduced motion; scene events repaint only changed views. */
  function viewChanged() {
    if (gpuActive) {
      const viewer = viewerReady();
      const narrow = (viewer?.scene?.canvas?.clientWidth || 800) < 700;
      if (running && field && !hidden() && narrow !== gpuNarrow) {
        gpuNarrow = narrow;
        gpuActive = gpu.setField(field);
        if (!gpuActive && viewer) {
          resize(viewer);
          seed(viewer.scene, makeOccluder(viewer.scene));
        }
        motionChanged();
      }
      const ready = gpuActive ? gpu.getDiagnostics().ready : null;
      if (ready !== reportedGpuReady) {
        reportedGpuReady = ready;
        onStatusChange?.();
      }
      return; // Cesium projects persistent curves; only a responsive budget change rebuilds them.
    }
    if (!running || !field || hidden() || !canvas) return;
    const viewer = viewerReady();
    if (!viewer) return;
    const resized = resize(viewer);
    if (resized || checkCamera(viewer.scene)) {
      cameraChanged = true;
      if (still()) paint(viewer, 0, true);
      else schedule();
    }
  }
  function motionChanged() {
    reducedMotion = media?.matches === true;
    cancel();
    lastTime = null;
    cameraChanged = true;
    gpu.setOptions({ overlay, paused: still() });
    if (!running || !field || hidden()) return;
    const viewer = viewerReady();
    if (gpuActive) {
      gpu.tick(flowTime);
      viewer?.scene?.requestRender?.();
      schedule();
      return;
    }
    if (still() && viewer) paint(viewer, 0, true);
    else schedule();
  }
  function listen(target, event, callback) {
    if (!target?.addEventListener) return;
    target.addEventListener(event, callback);
    removers.push(() => target.removeEventListener(event, callback));
  }
  function attachListeners() {
    if (removers.length) return;
    media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    reducedMotion = media?.matches === true;
    listen(media, 'change', motionChanged);
    listen(globalThis.document, 'visibilitychange', motionChanged);
    listen(globalThis, 'resize', viewChanged);
    const viewer = viewerReady();
    const event = viewer?.scene?.preRender ?? viewer?.scene?.camera?.changed;
    if (event?.addEventListener) {
      const remove = event.addEventListener(viewChanged);
      removers.push(
        typeof remove === 'function'
          ? remove
          : () => event.removeEventListener(viewChanged),
      );
    }
  }
  function detachListeners() {
    for (const remove of removers) remove();
    removers = [];
    media = null;
  }

  function paint(viewer, dt, staticFrame, fadeSeconds = dt) {
    const scene = viewer.scene;
    const resized = resize(viewer);
    const changed = checkCamera(scene) || cameraChanged || resized;
    const occluder = makeOccluder(scene);
    if (changed) {
      clearPixels();
      updateBounds(scene);
      cameraChanged = false;
    }
    if (particles.length !== budget()) seed(scene, occluder);
    if (staticFrame) clearPixels();
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'destination-out';
    context.fillStyle = `rgba(0,0,0,${trailEraseAlpha(fadeSeconds)})`;
    context.fillRect(0, 0, cssWidth, cssHeight);
    context.globalCompositeOperation = 'source-over';
    context.lineCap = 'round';
    const cameraHeight = scene.camera?.positionCartographic?.height ?? 1e6;
    const speedScale = Math.max(0.002, Math.min(4000, cameraHeight / 400));
    const advection = { speedScale };
    // Stroke length is a display sample of the local field, not frame travel.
    // At low FPS capped advection still moves the head by dt, but a readable
    // world-anchored tail survives without extra projections or screen stretching.
    const strokeSeconds = staticFrame ? 3 : 2;
    painted = 0;
    for (const particle of particles) {
      sampleWind(field, particle.lon, particle.lat, wind);
      if (!staticFrame) {
        advectParticle(particle, wind, dt, advection);
        particle.age += dt;
      }
      let point = project(scene, occluder, particle.lon, particle.lat, screenB);
      if (changed && !inView(point)) {
        // Refill newly exposed regions while retaining world anchors still in view.
        spawn(particle, scene, occluder);
        sampleWind(field, particle.lon, particle.lat, wind);
        point = project(scene, occluder, particle.lon, particle.lat, screenB);
      }
      if (particle.age > particle.life || !inView(point)) {
        spawn(particle, scene, occluder);
        continue;
      }
      before.lon = particle.lon;
      before.lat = particle.lat;
      advectParticle(before, wind, -strokeSeconds, advection);
      const previous = project(
        scene,
        occluder,
        before.lon,
        before.lat,
        screenA,
      );
      if (!inView(previous)) continue;
      const startX = previous.x;
      const startY = previous.y;
      const visibility = previous.visibility;
      const distance = Math.hypot(point.x - startX, point.y - startY);
      // Perspective/frustum jumps and antimeridian discontinuities never become strokes.
      if (
        Math.abs(before.lon - particle.lon) > 180 ||
        distance > Math.min(80, cssWidth * 0.08)
      )
        continue;
      const alpha =
        Math.min(visibility, point.visibility) *
        Math.min(1, particle.age / 0.8, (particle.life - particle.age) / 1.2);
      if (alpha <= 0) continue;
      const speed = Math.hypot(wind.u, wind.v);
      context.globalAlpha = alpha * 0.55;
      context.lineWidth = 1.0;
      context.strokeStyle =
        overlay === 'none' ? windTrailColor(speed) : '#9ddce4';
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(point.x, point.y);
      context.stroke();
      if (distance > 0.6) {
        context.globalAlpha = alpha * 0.9;
        context.strokeStyle = '#d6f4f5';
        context.lineWidth = 1.35;
        context.beginPath();
        context.moveTo(
          startX + (point.x - startX) * 0.72,
          startY + (point.y - startY) * 0.72,
        );
        context.lineTo(point.x, point.y);
        context.stroke();
      }
      if (staticFrame) {
        // Preserve direction at rest with a small arrowhead, without moving the field.
        if (distance > 2) {
          const ux = (point.x - startX) / distance;
          const uy = (point.y - startY) / distance;
          context.beginPath();
          context.moveTo(point.x - ux * 3 - uy * 2, point.y - uy * 3 + ux * 2);
          context.lineTo(point.x, point.y);
          context.lineTo(point.x - ux * 3 + uy * 2, point.y - uy * 3 - ux * 2);
          context.stroke();
        }
      }
      painted++;
    }
    context.globalAlpha = 1;
  }

  function draw(time) {
    frame = null;
    if (!running || !field || hidden() || still()) return;
    const viewer = viewerReady();
    if (!viewer) return;
    try {
      const resized = !gpuActive && resize(viewer);
      if (resized) cameraChanged = true;
      const elapsed =
        lastTime === null ? 1 / 60 : Math.max(0, (time - lastTime) / 1000);
      // Limit full particle paints to 30 Hz while preserving elapsed-time motion/fading.
      if (lastTime === null || elapsed >= 0.032 || cameraChanged) {
        if (gpuActive) {
          flowTime += elapsed;
          gpu.tick(flowTime);
          viewer.scene.requestRender();
          cameraChanged = false;
        } else paint(viewer, Math.min(0.1, elapsed), false, elapsed);
        lastTime = time;
      }
    } catch (error) {
      if (!warned) {
        console.warn('[Data:Wind] frame failed:', error?.message || error);
        warned = true;
      }
    }
    schedule();
  }

  return {
    attach() {
      if (canvas) return;
      canvas = document.createElement('canvas');
      canvas.dataset.gevWind = '1';
      Object.assign(canvas.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '1',
      });
      canvas.setAttribute?.('aria-hidden', 'true');
      context = canvas.getContext('2d');
      container.appendChild(canvas);
    },
    setField(next) {
      snapshot = next;
      field = next?.grid ? { ...next.grid, u: next.u, v: next.v } : next;
      cameraChanged = true;
      lastTime = null;
      cancel();
      if (canvas && field) {
        const viewer = viewerReady();
        gpuNarrow = (viewer?.scene?.canvas?.clientWidth || 800) < 700;
        gpuActive = gpu.supported() && gpu.setField(field);
        reportedGpuReady = gpuActive ? gpu.getDiagnostics().ready : null;
        flowTime = 0;
        clearPixels();
        particles = [];
        if (viewer && !gpuActive) {
          resize(viewer);
          seed(viewer.scene, makeOccluder(viewer.scene));
        }
        installImagery();
        relief.attach();
        motionChanged();
      }
    },
    setOptions(options = {}) {
      const nextOverlay = ['none', 'speed', 'temperature', 'pressure'].includes(
        options.overlay,
      )
        ? options.overlay
        : overlay;
      const newPaused =
        typeof options.paused === 'boolean' ? options.paused : paused;
      const changedOverlay = nextOverlay !== overlay;
      const changedPause = newPaused !== paused;
      overlay = nextOverlay;
      paused = newPaused;
      if (changedOverlay) {
        installImagery();
        clearPixels();
      }
      if (changedOverlay || changedPause) motionChanged();
    },
    start() {
      if (running || !canvas) return;
      running = true;
      attachListeners();
      motionChanged();
    },
    stop() {
      running = false;
      cancel();
      lastTime = null;
      detachListeners();
      gpu.setOptions({ overlay, paused: true });
    },
    clear() {
      cancel();
      snapshot = null;
      field = null;
      particles = [];
      painted = 0;
      gpu.clear();
      relief.clear();
      gpuActive = false;
      reportedGpuReady = null;
      flowTime = 0;
      removeImagery();
      imageryError = null;
      clearPixels();
    },
    destroy() {
      this.stop();
      this.clear();
      gpu.destroy();
      relief.destroy();
      canvas?.remove();
      canvas = null;
      context = null;
    },
    getParticleCount() {
      return gpuActive ? gpu.getParticleCount() : particles.length;
    },
    getDiagnostics() {
      return {
        overlay,
        paused,
        reducedMotion,
        hidden: hidden(),
        particleCount: gpuActive ? gpu.getParticleCount() : particles.length,
        renderMode: gpuActive ? 'gpu-streamlines' : 'canvas-fallback',
        gpu: gpu.getDiagnostics(),
        relief: relief.getDiagnostics(),
        painted,
        framePending: frame !== null,
        imageryActive: imagery !== null,
        imageryError,
      };
    },
  };
}
