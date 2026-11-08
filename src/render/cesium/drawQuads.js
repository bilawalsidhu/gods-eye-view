/**
 * @module render/cesium/drawQuads
 * @description The Cesium draw port's `quads` sets: each item a unit plane
 * primitive scaled to its `size`, posed by its `center` and `orientation`
 * (the plane lies in the orientation's local x–y plane, width along x,
 * height along y, its face toward local +z), textured with its image,
 * video or canvas, and its outline beside it, as a Cesium plane entity
 * draws them. An update moves, turns, resizes, shows or retextures the
 * plane where it is; only a change of pickability or of outline rebuilds
 * it.
 *
 * Choices the contract leaves open, taken conservatively:
 * - `orientation` turns the plane in the Earth-fixed frame.
 * - A canvas is read when an item first names it, as a Cesium material
 *   reads one: to show new pixels, name another canvas (two canvases in
 *   turn, say). The material takes a new image on the frame after it is
 *   named, so the two drawn frames after a change are asked for (asked
 *   for again once a hidden quad shows).
 * - A video is read every drawn frame, and keeps frames coming while it
 *   plays and its quad shows (starting again as it plays, seeks or has
 *   data again); a video whose size changes is read at its new size. A
 *   change between a video and another source makes a new material, so
 *   neither reads into the other's texture.
 * - Quads are lit by the scene's light and always draw translucent, their
 *   image's own alpha read, as a plane entity's transparent image material
 *   does.
 */
import * as Cesium from 'cesium';
import { toCartesian } from './common.js';

const scratchQuaternion = new Cesium.Quaternion();
const scratchScale = new Cesium.Cartesian3();

/** What a quad's material shows: an element, or an image's URL. */
function sourceOf(source, toImage) {
  if (source?.video) return source.video;
  if (source?.canvas) return source.canvas;
  if (source && 'image' in source) return toImage(source.image);
  throw new Error('a quad takes an image, a video or a canvas');
}

/** An outline as a key; '' for none. */
const outlineKey = (outline) =>
  outline
    ? `${typeof outline.color === 'string' ? outline.color : outline.color.join(',')}|${outline.widthPx}`
    : '';

/**
 * The quads part of a Cesium draw port.
 * @param {{toColor: Function, toImage: Function,
 *   pickId: Function, replaceHost: Function, lineWidth: (px: number) => number,
 *   requestRender: () => void}} options From the draw port.
 */
export function createQuadSets({
  toColor,
  toImage,
  pickId,
  replaceHost,
  lineWidth,
  requestRender,
}) {
  /** Materials replaced this frame, destroyed once it has drawn. */
  let retired = [];

  /** Media events after which a video draws again, with no frame asked. */
  const VIDEO_EVENTS = ['play', 'playing', 'canplay', 'loadeddata', 'seeked'];

  /** Ask for frames on the entry's video's events, while it shows one. */
  function watchVideo(entry) {
    unwatchVideo(entry);
    const video = entry.source;
    if (!isVideo(video)) return;
    const wake = () => requestRender();
    for (const name of VIDEO_EVENTS) video.addEventListener?.(name, wake);
    entry.unwatch = () => {
      for (const name of VIDEO_EVENTS) video.removeEventListener?.(name, wake);
    };
  }

  function unwatchVideo(entry) {
    entry.unwatch?.();
    entry.unwatch = null;
  }

  /** The set's host, made once: its quads are changed where they are. */
  function hostOf(record) {
    if (record.host && !record.host.isDestroyed?.()) return record.host;
    const host = new Cesium.PrimitiveCollection();
    const quads = new Map();
    // Materials hold their textures, which primitives leave alone: the
    // host destroys them as it goes.
    const destroyHost = host.destroy.bind(host);
    host.destroy = () => {
      for (const entry of quads.values()) {
        freeMaterial(entry.material);
        unwatchVideo(entry);
      }
      quads.clear();
      return destroyHost();
    };
    record.quads = quads;
    replaceHost(record, host);
    return host;
  }

  function freeMaterial(material) {
    if (material && !material.isDestroyed()) material.destroy();
  }

  function imageMaterial(source, alpha) {
    return Cesium.Material.fromType('Image', {
      image: source,
      color: Cesium.Color.WHITE.withAlpha(alpha),
    });
  }

  /** Each live entry's pick id, for height queries to see through. */
  function notePickIds(record) {
    record.pickIds = [];
    for (const entry of record.quads.values())
      record.pickIds.push(entry.pickId);
  }

  function matrixOf(item, result) {
    const q = item.orientation;
    scratchQuaternion.x = q.x;
    scratchQuaternion.y = q.y;
    scratchQuaternion.z = q.z;
    scratchQuaternion.w = q.w;
    scratchScale.x = item.size[0];
    scratchScale.y = item.size[1];
    scratchScale.z = 1;
    return Cesium.Matrix4.fromTranslationQuaternionRotationScale(
      toCartesian(item.center),
      scratchQuaternion,
      scratchScale,
      result,
    );
  }

  const pickableOf = (record, item) =>
    record.spec.pickable !== false && item.pickable !== false;

  /** Build an entry's primitives anew (it is new, or picks or outline changed). */
  function build(record, entry) {
    const host = record.host;
    const item = entry.item;
    const allowPicking = pickableOf(record, item);
    const modelMatrix = matrixOf(item, new Cesium.Matrix4());
    entry.source = sourceOf(item.source, toImage);
    entry.alpha = item.alpha ?? 1;
    entry.material = imageMaterial(entry.source, entry.alpha);
    entry.videoSize = null;
    entry.fill = host.add(
      new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.PlaneGeometry({
            vertexFormat:
              Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          }),
          id: entry.pickId,
        }),
        appearance: new Cesium.MaterialAppearance({
          material: entry.material,
          translucent: true,
          closed: false,
        }),
        modelMatrix,
        allowPicking,
        asynchronous: false,
        show: item.show !== false,
      }),
    );
    entry.outline = null;
    if (item.outline) {
      const color = toColor(item.outline.color);
      entry.outline = host.add(
        new Cesium.Primitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: new Cesium.PlaneOutlineGeometry(),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
            },
            id: entry.pickId,
          }),
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: color.alpha < 1,
            renderState: { lineWidth: lineWidth(item.outline.widthPx ?? 1) },
          }),
          modelMatrix: Cesium.Matrix4.clone(modelMatrix),
          allowPicking,
          asynchronous: false,
          show: item.show !== false,
        }),
      );
    }
    entry.pickable = allowPicking;
    entry.outlineKey = outlineKey(item.outline);
    entry.uploadFrames = 2;
    watchVideo(entry);
  }

  function drop(record, id) {
    const entry = record.quads.get(id);
    if (!entry) return;
    record.quads.delete(id);
    unbuild(record, entry);
  }

  function unbuild(record, entry) {
    const host = record.host;
    for (const primitive of [entry.fill, entry.outline])
      if (primitive && host && !host.isDestroyed()) host.remove(primitive);
    freeMaterial(entry.material);
    unwatchVideo(entry);
    entry.fill = entry.outline = entry.material = null;
  }

  /** A new material for an entry, the old one freed once the frame drew. */
  function rebind(entry) {
    const old = entry.material;
    entry.material = imageMaterial(entry.source, entry.alpha);
    entry.fill.appearance.material = entry.material;
    entry.videoSize = null;
    entry.uploadFrames = 2;
    if (old) retired.push(old);
  }

  function put(record, item) {
    let entry = record.quads.get(item.id);
    if (!entry) {
      entry = { item, pickId: pickId(record, item) };
      record.quads.set(item.id, entry);
      build(record, entry);
      return;
    }
    entry.item = item;
    // The pick id is the primitives' own object: changed where it is.
    entry.pickId.meta = item.meta;
    if (
      entry.pickable !== pickableOf(record, item) ||
      entry.outlineKey !== outlineKey(item.outline)
    ) {
      unbuild(record, entry);
      build(record, entry);
      return;
    }
    const show = item.show !== false;
    matrixOf(item, entry.fill.modelMatrix);
    entry.fill.show = show;
    if (entry.outline) {
      Cesium.Matrix4.clone(entry.fill.modelMatrix, entry.outline.modelMatrix);
      entry.outline.show = show;
    }
    const alpha = item.alpha ?? 1;
    if (alpha !== entry.alpha) {
      entry.alpha = alpha;
      entry.material.uniforms.color = Cesium.Color.WHITE.withAlpha(alpha);
    }
    const source = sourceOf(item.source, toImage);
    if (source !== entry.source) {
      const video = isVideo(source) || isVideo(entry.source);
      entry.source = source;
      if (video) {
        // To or from a video: a material of its own, so the video's frames
        // are not copied into another source's texture, or the other way.
        rebind(entry);
        watchVideo(entry);
      } else {
        // Another canvas or URL: the material reads it anew.
        entry.material.uniforms.image = source;
        entry.uploadFrames = 2;
      }
    }
  }

  /** Add or change items, by id; true once handled (always, for quads). */
  function upsert(record, list) {
    hostOf(record);
    for (const item of list) put(record, item);
    notePickIds(record);
    requestRender();
    return true;
  }

  /** The set's items as they are now: quads gone dropped, the rest kept. */
  function rebuild(record) {
    hostOf(record);
    for (const id of [...record.quads.keys()])
      if (!record.items.has(id)) drop(record, id);
    for (const item of record.items.values()) put(record, item);
    notePickIds(record);
  }

  const isVideo = (source) =>
    typeof globalThis.HTMLVideoElement === 'function' &&
    source instanceof globalThis.HTMLVideoElement;

  /**
   * Each frame, before it draws: a video whose size changed since its
   * texture was made is read at its new size.
   */
  function beforeRender(sets) {
    for (const record of sets) {
      if (record.kind !== 'quads' || !record.quads) continue;
      for (const entry of record.quads.values()) {
        const video = entry.source;
        if (!entry.fill || !isVideo(video) || video.readyState < 2) continue;
        const size = `${video.videoWidth}x${video.videoHeight}`;
        if (entry.videoSize === null) entry.videoSize = size;
        else if (entry.videoSize !== size) rebind(entry);
      }
    }
  }

  /**
   * After a frame drew: the materials it replaced go, and a playing video
   * on a shown quad, or an image a material is still to take, asks for the
   * next frame. True when one did.
   */
  function afterRender(sets) {
    for (const material of retired) freeMaterial(material);
    retired = [];
    let playing = false;
    for (const record of sets) {
      if (record.kind !== 'quads' || !record.quads) continue;
      if (record.spec.show === false || record.host?.show === false) continue;
      for (const entry of record.quads.values()) {
        if (!entry.fill?.show) continue;
        // Only a frame that drew the quad counts toward taking its image.
        if (entry.uploadFrames > 0) {
          entry.uploadFrames -= 1;
          playing = true;
        }
        const video = entry.source;
        if (
          isVideo(video) &&
          !video.paused &&
          !video.ended &&
          video.readyState >= 2
        )
          playing = true;
      }
    }
    return playing;
  }

  return { build: rebuild, upsert, beforeRender, afterRender };
}
