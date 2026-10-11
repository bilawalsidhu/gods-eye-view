import { ATTRIBUTION, TRAVEL_SCALE_S } from './model.js';
import { compositeTileTemplate, recolorPattern } from './pattern.js';

const SETTLE_TIMEOUT_MS = 3000;
const PATTERN_ALPHA = 0.85;

function recolorTile(image, createCanvas) {
  const canvas = createCanvas();
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  // Cesium hands ImageBitmaps already flipped; a canvas upload flips again.
  const flip =
    typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
  if (flip) context.setTransform(1, 0, 0, -1, 0, image.height);
  context.drawImage(image, 0, 0);
  if (flip) context.setTransform(1, 0, 0, 1, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  recolorPattern(pixels.data);
  context.putImageData(pixels, 0, 0);
  image.close?.();
  return canvas;
}

/**
 * One draped pattern layer per frame time on the current imagery host, plus
 * static streaks and rain discs as scene primitives. Nothing animates; a new
 * frame or host requests one render.
 */
export function createMigrationRendering({
  viewer,
  cesium,
  getHost,
  onChange = () => {},
  createCanvas = () => globalThis.document.createElement('canvas'),
  setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutImpl = (id) => globalThis.clearTimeout(id),
}) {
  const credit = new cesium.Credit(ATTRIBUTION, false);
  let shown = null;
  let incoming = null;
  let motion = null;
  let streaks = null;
  let discs = null;
  let hidden = false;
  let error = null;
  let time = null;
  const requestRender = () => viewer.scene.requestRender();

  function removeLayer(record) {
    if (!record) return;
    clearTimeoutImpl(record.timer);
    try {
      record.collection.remove(record.layer, true);
    } catch {
      /* the collection is already gone */
    }
  }

  function promote(record) {
    if (incoming !== record) return;
    clearTimeoutImpl(record.timer);
    incoming = null;
    removeLayer(shown);
    shown = record;
    record.layer.alpha = hidden ? 0 : PATTERN_ALPHA;
    onChange();
    requestRender();
  }

  function addPattern(at) {
    const collection = getHost().collection;
    if (!collection) return null;
    const provider = new cesium.UrlTemplateImageryProvider({
      url: compositeTileTemplate(at),
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      maximumLevel: 8,
      enablePickFeatures: false,
      hasAlphaChannel: true,
      credit,
    });
    const record = {
      collection,
      layer: null,
      timer: null,
      loaded: 0,
      pending: 0,
    };
    const requestImage = provider.requestImage.bind(provider);
    provider.requestImage = (x, y, level, request) => {
      const result = requestImage(x, y, level, request);
      if (!result) return result;
      record.pending++;
      return Promise.resolve(result)
        .then((image) => {
          record.loaded++;
          return recolorTile(image, createCanvas);
        })
        .finally(() => {
          // The previous time stays visible until this one has drawn a batch.
          if (--record.pending === 0 && record.loaded > 0) promote(record);
          requestRender();
        });
    };
    provider.errorEvent.addEventListener((event) => {
      event.retry = false;
      if (record !== incoming && record !== shown) return;
      error = 'Some reflectivity tiles unavailable';
      onChange();
    });
    record.layer = collection.addImageryProvider(provider);
    record.layer.alpha = 0;
    record.timer = setTimeoutImpl(() => promote(record), SETTLE_TIMEOUT_MS);
    return record;
  }

  function clearMotion() {
    for (const primitive of [streaks, discs])
      if (primitive && !primitive.isDestroyed?.())
        viewer.scene.primitives.remove(primitive);
    streaks = null;
    discs = null;
  }

  function drawMotion() {
    clearMotion();
    if (hidden || motion?.kind !== 'reduced') return;
    const lines = new cesium.PolylineCollection();
    const instances = [];
    for (const station of motion.stations) {
      const { lat, lon, elevM } = station.position;
      if (station.kind === 'tracked') {
        const { towardDeg, speedMs } = station.track;
        const height =
          elevM + (station.fit.beamHeightM[0] + station.fit.beamHeightM[1]) / 2;
        const origin = cesium.Cartesian3.fromDegrees(lon, lat, height);
        const frame = cesium.Transforms.eastNorthUpToFixedFrame(origin);
        const length = speedMs * TRAVEL_SCALE_S;
        const radians = cesium.Math.toRadians(towardDeg);
        const tip = cesium.Matrix4.multiplyByPoint(
          frame,
          new cesium.Cartesian3(
            Math.sin(radians) * length,
            Math.cos(radians) * length,
            0,
          ),
          new cesium.Cartesian3(),
        );
        lines.add({
          positions: [origin, tip],
          width: 9,
          material: cesium.Material.fromType('PolylineArrow', {
            color: cesium.Color.fromCssColorString('#f4fffd'),
          }),
        });
      } else if (station.kind === 'precipitation') {
        instances.push(
          new cesium.GeometryInstance({
            geometry: new cesium.EllipseGeometry({
              center: cesium.Cartesian3.fromDegrees(lon, lat),
              semiMajorAxis: motion.sampleRadiusKm * 1000,
              semiMinorAxis: motion.sampleRadiusKm * 1000,
              height: elevM + 200,
            }),
            attributes: {
              color: cesium.ColorGeometryInstanceAttribute.fromColor(
                cesium.Color.fromCssColorString('#8a9096').withAlpha(0.45),
              ),
            },
          }),
        );
      }
    }
    streaks = viewer.scene.primitives.add(lines);
    if (instances.length)
      discs = viewer.scene.primitives.add(
        new cesium.Primitive({
          geometryInstances: instances,
          appearance: new cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
          }),
          asynchronous: false,
        }),
      );
  }

  function clear() {
    removeLayer(incoming);
    removeLayer(shown);
    incoming = shown = null;
    clearMotion();
    motion = null;
    time = null;
    error = null;
    hidden = false;
    requestRender();
  }

  return {
    /** Idempotent for the same time and motion object. */
    show(frame) {
      const changedTime = frame.time !== time;
      const changedMotion = frame.motion !== motion;
      time = frame.time;
      motion = frame.motion;
      if (changedTime) {
        error = null;
        removeLayer(incoming);
        incoming = addPattern(frame.time);
      }
      if (changedMotion || changedTime) drawMotion();
      requestRender();
    },
    setHidden(next) {
      if (hidden === next) return;
      hidden = next;
      if (shown) shown.layer.alpha = hidden ? 0 : PATTERN_ALPHA;
      drawMotion();
      requestRender();
    },
    /** The host changed: drape the current time on the new collection. */
    rehome() {
      removeLayer(incoming);
      removeLayer(shown);
      incoming = shown = null;
      if (time) incoming = addPattern(time);
      requestRender();
    },
    clear,
    destroy: clear,
    getDiagnostics() {
      return {
        time,
        loading: Boolean(incoming),
        error,
        host: getHost().kind,
        streaks: streaks?.length ?? 0,
      };
    },
  };
}
