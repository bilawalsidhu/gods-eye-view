import * as Cesium from 'cesium';
import { aircraftIconArtwork, aircraftIconKind } from './aircraftIcons.js';
import { AircraftSurfaceGpu } from './aircraftSurfaceGpu.js';

const surfaces = new WeakMap();

/** Compile the ordinary white silhouettes once. Special gradient artwork stays
 * native, preserving its compositing contract rather than approximating it. */
export function compileAircraftArtwork(kind) {
  const artwork = aircraftIconArtwork(kind);
  if (!artwork || artwork.includes('<defs') || kind.startsWith('tr3b'))
    return null;
  const xml = new DOMParser().parseFromString(
    `<svg>${artwork}</svg>`,
    'image/svg+xml',
  );
  const parts = [];
  const visit = (node, parent, alpha) => {
    const n = (name) => Number(node.getAttribute(name) || 0);
    let matrix = parent;
    for (const match of (node.getAttribute('transform') || '').matchAll(
      /([a-zA-Z]+)\(([^)]+)\)/g,
    )) {
      const values = match[2]
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (
        match[1] !== 'rotate' ||
        ![1, 3].includes(values.length) ||
        !values.every(Number.isFinite)
      )
        throw new Error('Unsupported aircraft transform');
      const [angle, cx = 0, cy = 0] = values;
      matrix = matrix.translate(cx, cy).rotate(angle).translate(-cx, -cy);
    }
    const opacity = alpha * Number(node.getAttribute('opacity') || 1);
    if (node.tagName === 'g') {
      for (const child of node.children) visit(child, matrix, opacity);
      return;
    }
    const raw = new Path2D();
    switch (node.tagName) {
      case 'path':
        raw.addPath(new Path2D(node.getAttribute('d')));
        break;
      case 'circle':
        raw.arc(n('cx'), n('cy'), n('r'), 0, Math.PI * 2);
        break;
      case 'ellipse':
        raw.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), 0, 0, Math.PI * 2);
        break;
      case 'rect':
        raw.roundRect(n('x'), n('y'), n('width'), n('height'), n('rx'));
        break;
      default:
        throw new Error(`Unsupported aircraft artwork: ${node.tagName}`);
    }
    const path = new Path2D();
    path.addPath(raw, matrix);
    parts.push({
      path,
      opacity: opacity * Number(node.getAttribute('fill-opacity') || 1),
      stroke: node.getAttribute('stroke'),
      lineWidth: n('stroke-width'),
    });
  };
  for (const child of xml.documentElement.children)
    visit(child, new DOMMatrix(), 1);
  return parts;
}

class AircraftSurface {
  constructor(viewer) {
    this.viewer = viewer;
    this.sources = new Set();
    this.artwork = new Map();
    this.matrix = new Cesium.Matrix4();
    this.stats = {
      active: false,
      drawn: 0,
      width: 0,
      height: 0,
      pixelBytes: 0,
      paintMs: 0,
    };
    viewer.gevAircraftSurfaceDiagnostics = () => this.stats;
    this.removeBegin = viewer.scene.preRender.addEventListener(() => {
      for (const source of this.sources) source.painting = false;
    });
    this.removeEnd = viewer.scene.postRender.addEventListener(() =>
      this.draw(),
    );
  }
  paintShape(ctx, geometry, color, alpha) {
    ctx.fillStyle = color;
    for (const part of geometry) {
      ctx.globalAlpha = alpha * part.opacity;
      ctx.fill(part.path);
      if (part.stroke) {
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = part.stroke;
        ctx.lineWidth = part.lineWidth;
        ctx.lineJoin = 'round';
        ctx.stroke(part.path);
      }
    }
  }
  enabled() {
    return (
      !this.failed &&
      this.viewer.gevAircraftSurfaceEnabled?.() === true &&
      this.viewer.scene.mode === Cesium.SceneMode.SCENE3D
    );
  }
  geometry(image) {
    const kind = aircraftIconKind(image);
    if (!kind) return null;
    if (!this.artwork.has(kind)) {
      try {
        this.artwork.set(kind, compileAircraftArtwork(kind));
      } catch {
        this.artwork.set(kind, null);
        (this.stats.artworkFallbacks ??= []).push(kind);
      }
    }
    return this.artwork.get(kind);
  }
  accept(source, collection, revision) {
    if (!this.enabled() || !source.enabled()) return false;
    if (
      revision !== undefined &&
      source.revision === revision &&
      source.collection === collection
    ) {
      if (source.visible && !this.ensureGpu()) return false;
      source.painting = source.visible;
      return true;
    }
    let visible = false;
    for (let i = 0; i < collection.length; i++) {
      const b = collection.get(i);
      if (b.show && b.color.alpha > 0) visible = true;
      if (
        b.show &&
        (!this.geometry(b.image) ||
          b.sizeInMeters ||
          b.disableDepthTestDistance !== Infinity)
      )
        return false;
    }
    if (visible && !this.ensureGpu()) return false;
    source.collection = collection;
    source.painting = visible;
    source.visible = visible;
    source.revision = revision;
    return true;
  }
  ensureGpu() {
    if (this.gpu) return true;
    const canvas = document.createElement('canvas');
    canvas.className = 'gev-aircraft-surface';
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '1',
    });
    try {
      this.gpu = new AircraftSurfaceGpu(canvas, (kind, ctx) =>
        this.paintShape(ctx, this.artwork.get(kind), 'white', 1),
      );
    } catch (error) {
      this.failed = true;
      this.stats.fallbackReason = error.message;
      canvas
        .getContext('webgl2')
        ?.getExtension('WEBGL_lose_context')
        ?.loseContext();
      canvas.width = canvas.height = 1;
      return false;
    }
    this.canvas = canvas;
    this.needsPaint = true;
    canvas.addEventListener('webglcontextlost', (event) => {
      if (canvas !== this.canvas) return;
      event.preventDefault();
      this.failed = true;
      this.stats.fallbackReason =
        'Aircraft surface context lost; native rendering restored';
      this.viewer.scene.requestRender();
    });
    this.viewer.scene.canvas.parentElement.appendChild(canvas);
    return true;
  }
  disposeGpu() {
    if (!this.gpu) return;
    const gpu = this.gpu,
      canvas = this.canvas;
    this.gpu = null;
    this.canvas = null;
    gpu.destroy();
    canvas.remove();
    // Context-loss events are asynchronous; the discarded canvas must not
    // poison a subsequently created surface.
  }
  draw() {
    const started = performance.now(),
      { scene, camera } = this.viewer;
    let capacity = 0;
    for (const source of this.sources)
      if (source.painting) capacity += source.collection.length;
    const active = this.enabled() && capacity > 0;
    this.stats.active = active;
    if (!active) {
      this.stats.drawn = 0;
      this.disposeGpu();
      Object.assign(this.stats, {
        width: 0,
        height: 0,
        pixelBytes: 0,
        atlasAndBufferBytes: 0,
      });
      return;
    }
    const width = scene.canvas.clientWidth,
      height = scene.canvas.clientHeight;
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1),
      pw = Math.round(width * ratio),
      ph = Math.round(height * ratio);
    const m = Cesium.Matrix4.multiply(
      camera.frustum.projectionMatrix,
      camera.viewMatrix,
      this.matrix,
    );
    let changed =
      this.needsPaint ||
      !this.lastMatrix ||
      !Cesium.Matrix4.equals(m, this.lastMatrix) ||
      this.stats.width !== pw ||
      this.stats.height !== ph;
    for (const source of this.sources) {
      if (
        source.lastPainting !== source.painting ||
        (source.painting &&
          (source.revision === undefined ||
            source.lastRevision !== source.revision ||
            source.lastCollection !== source.collection))
      )
        changed = true;
    }
    if (!changed) {
      this.stats.paintMs = 0;
      return;
    }
    const gpu = this.gpu;
    gpu.begin(width, height, pw, ph, capacity);
    for (const source of [...this.sources].sort((a, b) => a.order - b.order)) {
      if (!source.painting) continue;
      const collection = source.collection;
      for (let i = 0; i < collection.length; i++) {
        const b = collection.get(i);
        if (!b.show || b.color.alpha <= 0) continue;
        const p = b.position,
          clipW = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
        if (!(clipW > 0)) continue;
        const x =
          (((m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / clipW) * 0.5 +
            0.5) *
          width;
        const y =
          (0.5 -
            ((m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / clipW) * 0.5) *
          height;
        const distance = Cesium.Cartesian3.distance(camera.positionWC, p);
        const scale =
            b.scale * source.distanceScale(b.scaleByDistance, distance),
          w = b.width * scale,
          h = b.height * scale;
        if (x + w < 0 || y + h < 0 || x - w > width || y - h > height) continue;
        gpu.add(b, aircraftIconKind(b.image), x, y, w, h);
      }
    }
    gpu.flush();
    this.needsPaint = false;
    this.lastMatrix = Cesium.Matrix4.clone(m, this.lastMatrix);
    for (const source of this.sources) {
      source.lastPainting = source.painting;
      source.lastRevision = source.revision;
      source.lastCollection = source.collection;
    }
    Object.assign(this.stats, {
      drawn: gpu.count,
      width: pw,
      height: ph,
      pixelBytes: pw * ph * 4,
      atlasAndBufferBytes: gpu.bytes,
      paintMs: performance.now() - started,
    });
  }
  release(source) {
    this.sources.delete(source);
    this.needsPaint = true;
    if (this.sources.size) return;
    this.removeBegin();
    this.removeEnd();
    this.disposeGpu();
    surfaces.delete(this.viewer);
    delete this.viewer.gevAircraftSurfaceDiagnostics;
  }
}

/** Optional per-viewer shared surface; absent in portable/headless layer hosts. */
export function acquireAircraftSurface(
  viewer,
  enabled = () => true,
  order = 0,
  distanceScale = () => 1,
) {
  if (!viewer.gevAircraftSurfaceEnabled || typeof document === 'undefined')
    return null;
  let surface = surfaces.get(viewer);
  if (!surface) surfaces.set(viewer, (surface = new AircraftSurface(viewer)));
  const source = {
    enabled,
    order,
    distanceScale,
    painting: false,
    collection: null,
  };
  surface.sources.add(source);
  return {
    accept: (collection, revision) =>
      surface.accept(source, collection, revision),
    reset: () => {
      // Drop native object graphs, but retain lastPainting so the next draw
      // removes old pixels while another fleet keeps the shared surface alive.
      source.painting = false;
      source.visible = false;
      source.collection = null;
      source.lastCollection = null;
      source.revision = undefined;
    },
    release: () => surface.release(source),
  };
}

/** Return the shared surface statistics, or null when the host has no surface. */
export function aircraftSurfaceDiagnostics(viewer) {
  return surfaces.get(viewer)?.stats || null;
}

/** Mirror one tracked entity into a pickable native collection while the sharp
 * surface owns its 2D visual. Entity position/follow-camera and Graphics remain
 * authoritative; leaving the mode restores the original show property. */
export function createTrackedAircraftSurface(
  viewer,
  getEntity,
  enabled,
  order = 0,
  distanceScale,
) {
  const handle = acquireAircraftSurface(
    viewer,
    enabled,
    order + 2,
    distanceScale,
  );
  const collection = new Cesium.BillboardCollection();
  let entity, originalShow, originalPoint, proxy;
  const position = new Cesium.Cartesian3();
  const reset = () => {
    if (entity?.billboard) {
      entity.billboard.show = originalShow;
      entity.point = originalPoint;
    }
    entity = null;
    originalShow = originalPoint = undefined;
    proxy = null;
    collection.removeAll();
    handle.reset();
  };
  return {
    reset,
    update(frameState, shown) {
      const target = getEntity();
      const time = viewer.clock.currentTime;
      if (target !== entity) reset();
      const graphics = target?.billboard;
      const value = (key) => graphics?.[key]?.getValue(time);
      const image = value('image');
      const canPaint =
        shown &&
        enabled() &&
        viewer.gevAircraftSurfaceEnabled?.() &&
        viewer.scene.mode === Cesium.SceneMode.SCENE3D &&
        graphics &&
        target.isShowing &&
        aircraftIconKind(image) &&
        !aircraftIconKind(image).startsWith('tr3b');
      if (!canPaint) {
        reset();
        return;
      }
      if (!entity) {
        entity = target;
        originalShow = graphics.show;
        originalPoint = entity.point;
        // Cesium's EntityView advances only while a visualizer supplies a
        // bounding sphere. A transparent point retains that position anchor
        // when the original billboard visualizer is hidden by the sharp layer.
        if (!originalPoint)
          entity.point = new Cesium.PointGraphics({
            pixelSize: 1,
            color: Cesium.Color.TRANSPARENT,
            outlineWidth: 0,
          });
        graphics.show = false;
      }
      if (originalShow?.getValue(time) === false) {
        reset();
        return;
      }
      const pos = target.position?.getValue(time, position);
      if (!pos) {
        reset();
        return;
      }
      proxy ??= collection.add({ id: target });
      proxy.position = pos;
      proxy.image = image;
      for (const key of [
        'width',
        'height',
        'scale',
        'rotation',
        'color',
        'scaleByDistance',
        'disableDepthTestDistance',
      ]) {
        const v = value(key);
        if (v !== undefined) proxy[key] = v;
      }
      const sharp = handle.accept(collection, frameState.frameNumber);
      if (!sharp) {
        reset();
        return;
      }
      // This is a single followed contact. Keep its native pick buffers and
      // camera-dependent bounds current every frame; fleet deferral is where
      // batching saves work, not the tracked target.
      const start = frameState.commandList.length;
      collection.update(frameState);
      if (frameState.passes.render && !frameState.passes.pick)
        frameState.commandList.length = start;
    },
    destroy() {
      reset();
      handle.release();
      collection.destroy();
    },
  };
}
