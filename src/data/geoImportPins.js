/**
 * The Cesium-bound part of the file import: what `geoFileImport.js` parsed
 * and bounded, loaded as a Cesium data source, scrubbed, grounded, its pins
 * drawn in one billboard collection, and its footprint read back.
 */
import { followedOf, stopFollowing } from './followed.js';
import * as Cesium from 'cesium';
import {
  GeoImportError,
  MAX_IMPORT_ENTITIES,
  boundedImport,
  importFeatureName,
} from './geoImportShared.js';
import { msg } from '../i18n/marker.js';
import { heightsFor } from '../render/cesium/heights.js';

const STYLE = [
  'image',
  'scale',
  'rotation',
  'alignedAxis',
  'horizontalOrigin',
  'verticalOrigin',
  'color',
  'eyeOffset',
  'pixelOffset',
  'width',
  'height',
  'scaleByDistance',
  'translucencyByDistance',
  'pixelOffsetScaleByDistance',
  'distanceDisplayCondition',
  'sizeInMeters',
  'disableDepthTestDistance',
  'imageSubRegion',
];

class ImportedBillboards extends Cesium.BillboardCollection {
  update(frameState) {
    // Height queries should find the map, never another imported marker.
    // Ordinary click picks and rendered screenshots still include the pins.
    if (frameState.passes.pick && frameState.passes.offscreen) return;
    super.update(frameState);
  }
}

/** Own static imported pins without a per-frame Entity visualizer walk. */
export function createImportedPins(dataSource, viewer) {
  const all = dataSource.entities.values.slice();
  const now = Cesium.JulianDate.now();
  const pins = all.filter((entity) => entity.billboard && entity.position);
  if (!pins.length) return { mount() {}, sync() {}, destroy() {} };
  const collection = new ImportedBillboards({ scene: viewer.scene });
  const billboards = [];
  try {
    for (const entity of pins) {
      const position = entity.position.getValue(now);
      if (
        !position ||
        ![position.x, position.y, position.z].every(Number.isFinite)
      )
        throw new Error('Invalid imported point position.');
      const options = {
        id: entity,
        position,
        show:
          entity.isShowing && entity.billboard.show?.getValue(now) !== false,
        heightReference: Cesium.HeightReference.NONE,
      };
      for (const key of STYLE) {
        const value = entity.billboard[key]?.getValue(now);
        if (value !== undefined) options[key] = value;
      }
      billboards.push(collection.add(options));
    }
  } catch (error) {
    collection.destroy();
    throw error;
  }
  // Rebuild once before the source is added to DataSourceDisplay. Removing
  // one entity at a time would itself make this transition quadratic.
  dataSource.entities.suspendEvents();
  try {
    dataSource.entities.removeAll();
    for (const entity of all)
      if (!entity.billboard || !entity.position)
        dataSource.entities.add(entity);
  } finally {
    dataSource.entities.resumeEvents();
  }
  Object.defineProperty(dataSource, 'importedEntities', {
    value: all,
    configurable: true,
  });
  Object.defineProperty(dataSource, 'importedBillboards', {
    value: collection,
    configurable: true,
  });
  let show = dataSource.show,
    mounted = false,
    destroyed = false;
  Object.defineProperty(dataSource, 'show', {
    configurable: true,
    get: () => show,
    set(value) {
      show = Boolean(value);
      dataSource.entities.show = show;
      collection.show = show;
    },
  });
  collection.show = show;
  return {
    mount() {
      if (destroyed || mounted) return;
      viewer.scene.primitives?.add(collection);
      mounted = true;
    },
    sync() {
      if (destroyed) return;
      for (let i = 0; i < pins.length; i++) {
        billboards[i].position = pins[i].position.getValue(now);
        billboards[i].show =
          pins[i].isShowing && pins[i].billboard.show?.getValue(now) !== false;
      }
      viewer.scene.requestRender?.();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const followedEntity = followedOf(viewer)?.entity;
      if (followedEntity && pins.includes(followedEntity))
        stopFollowing(viewer);
      if (viewer.selectedEntity && pins.includes(viewer.selectedEntity))
        viewer.selectedEntity = undefined;
      if (mounted && !viewer.scene.primitives?.isDestroyed?.())
        viewer.scene.primitives?.remove(collection);
      if (!collection.isDestroyed()) collection.destroy();
      all.length = 0;
      pins.length = 0;
      billboards.length = 0;
    },
  };
}

/**
 * Prepared GeoJSON as a Cesium data source: ground-clamped, one colour for
 * the file's lines, fills and markers, and no description tables.
 * @param {object} geojson
 * @param {{color: string, signal?: AbortSignal}} options `color` is a CSS color.
 */
export function loadImportedGeoJson(geojson, { color, signal }) {
  const stroke = Cesium.Color.fromCssColorString(color);
  return boundedImport(
    Cesium.GeoJsonDataSource.load(geojson, {
      clampToGround: true,
      stroke,
      fill: stroke.withAlpha(0.25),
      strokeWidth: 3,
      markerColor: stroke,
      // No HTML description table is built from the file's properties.
      describe: () => undefined,
    }),
    signal,
  );
}

/**
 * A sanitized KML document as a Cesium data source. Cesium also processes
 * KML in deferred tasks; an exception there does not reject its load
 * promise. Keep a failed file from blocking the serial queue.
 */
export async function loadImportedKml(doc, viewer, signal) {
  let removeError;
  try {
    return await boundedImport(
      Promise.race([
        Cesium.KmlDataSource.load(doc, {
          camera: viewer.scene.camera,
          canvas: viewer.scene.canvas,
          clampToGround: true,
        }),
        new Promise((_, reject) => {
          const failed = () => {
            reject(new GeoImportError(msg('That KML could not be read.')));
          };
          globalThis.addEventListener?.('error', failed);
          removeError = () => globalThis.removeEventListener?.('error', failed);
        }),
      ]),
      signal,
    );
  } finally {
    removeError?.();
  }
}

/**
 * Check, scrub and ground a loaded data source and gather its pins. The
 * refusals a person reads are `GeoImportError`s; the caller revokes what it
 * owns on any failure.
 * @returns {Promise<{entityCount: number, pins: object, refreshGround: Function}>}
 */
export async function settleImportedSource(dataSource, viewer, signal) {
  const entityCount = dataSource.entities.values.length;
  if (entityCount > MAX_IMPORT_ENTITIES)
    throw new GeoImportError(
      `That file has ${entityCount.toLocaleString()} map objects; the limit is ${MAX_IMPORT_ENTITIES.toLocaleString()}.`,
      msg('That file has {count} map objects; the limit is {limit}.'),
      {
        count: entityCount,
        limit: MAX_IMPORT_ENTITIES,
      },
    );
  const now = Cesium.JulianDate.now();
  const drawable = dataSource.entities.values.some(
    (e) =>
      e.billboard?.image?.getValue(now) ||
      e.point ||
      e.rectangle ||
      e.polyline?.positions?.getValue(now)?.length >= 2 ||
      e.wall?.positions?.getValue(now)?.length >= 2 ||
      e.polygon?.hierarchy?.getValue(now)?.positions?.length >= 3,
  );
  if (!drawable)
    throw new GeoImportError(msg('That file has nothing to draw.'));
  scrubImportedEntities(dataSource);
  try {
    await settleGroundPins(dataSource, viewer, signal);
  } catch (error) {
    throw error instanceof GeoImportError
      ? error
      : new GeoImportError(
          msg('Ground heights could not be read. Try that file again.'),
        );
  }
  // Keep the clock invariant explicit even though unused KML dates have
  // already been stripped and all supported geometries are static.
  detachImportedTime(dataSource);
  let pins;
  try {
    pins = createImportedPins(dataSource, viewer);
  } catch {
    throw new GeoImportError(msg('That file has invalid point graphics.'));
  }
  return {
    entityCount,
    pins,
    refreshGround: (refreshSignal) =>
      settleGroundPins(
        dataSource,
        viewer,
        refreshSignal
          ? AbortSignal.any([refreshSignal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      ).then(() => pins.sync()),
  };
}

/**
 * Make every entity of an imported data source inert: no description,
 * balloon, extended data or properties, no native label, and a name that is
 * short plain text. Generated pin canvases share a data URL so Cesium uploads
 * each image once, rather than allocating a texture entry for every entity.
 * Returns how many entities were touched.
 * @param {{entities: {values: object[]}}} dataSource
 * @returns {number}
 */
export function scrubImportedEntities(dataSource) {
  const collection = dataSource?.entities;
  const list = collection?.values || [];
  const images = new Map();
  collection?.suspendEvents?.();
  try {
    for (let i = 0; i < list.length; i++) {
      const entity = list[i];
      let name;
      try {
        name = importFeatureName(
          typeof entity.name === 'string' ? entity.name : undefined,
        );
      } catch {
        name = undefined;
      }
      entity.name = name;
      entity.description = undefined;
      entity.label = undefined;
      entity.properties = undefined;
      if (entity.kml && typeof entity.kml === 'object') entity.kml = undefined;
      if (
        entity.billboard?.heightReference?.getValue?.() ===
        Cesium.HeightReference.CLAMP_TO_GROUND
      )
        entity.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
      const property = entity.billboard?.image;
      if (property?.isConstant === false) continue;
      const image = property?.getValue?.();
      if (image?.tagName === 'CANVAS') {
        let url = images.get(image);
        if (!url) {
          url = image.toDataURL();
          images.set(image, url);
        }
        entity.billboard.image = url;
      }
    }
  } finally {
    collection?.resumeEvents?.();
  }
  return list.length;
}

/**
 * Take time out of an imported data source so adding it cannot move the app's
 * shared clock: the data source reports no clock (the viewer adopts the clock
 * of every added source that has one), every entity is available for all
 * time. KML tracks have already become their original static vertices in
 * `sanitizeKmlDocument`, so no sampled-position fallback is needed here.
 * @param {object} dataSource
 * @returns {object} The same data source.
 */
export function detachImportedTime(dataSource) {
  Object.defineProperty(dataSource, 'clock', {
    configurable: true,
    enumerable: false,
    get: () => undefined,
    set: () => {},
  });
  const list = dataSource?.entities?.values || [];
  for (let i = 0; i < list.length; i++) {
    const entity = list[i];
    entity.availability = undefined;
  }
  return dataSource;
}

// Resolve a static file's ground pins in batches before they are visualized.
// Per-billboard CLAMP_TO_GROUND subscriptions scale poorly on large imports.
const groundPins = new WeakMap();
async function settleGroundPins(dataSource, viewer, signal) {
  let pins = groundPins.get(dataSource);
  if (!pins) {
    pins = [];
    for (const entity of dataSource.entities.values) {
      const reference = entity.billboard?.heightReference?.getValue?.();
      if (
        reference === Cesium.HeightReference.CLAMP_TO_GROUND ||
        reference === Cesium.HeightReference.RELATIVE_TO_GROUND
      ) {
        const position = entity.position?.getValue?.(Cesium.JulianDate.now());
        if (!position) continue;
        const cartographic = Cesium.Cartographic.fromCartesian(position);
        if (!cartographic)
          throw new GeoImportError(
            msg('That file has invalid point coordinates.'),
          );
        pins.push({
          entity,
          original: position,
          cartographic,
          offset:
            reference === Cesium.HeightReference.RELATIVE_TO_GROUND
              ? cartographic.height
              : 0,
        });
        entity.billboard.heightReference = Cesium.HeightReference.NONE;
        entity.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
      }
    }
    groundPins.set(dataSource, pins);
  }
  for (let at = 0; at < pins.length; at += 256) {
    signal?.throwIfAborted();
    const batch = pins.slice(at, at + 256);
    const positions = batch.map(
      ({ cartographic: c }) =>
        new Cesium.Cartographic(c.longitude, c.latitude, 0),
    );
    const mesh =
      viewer.scene?.globe?.show === false &&
      viewer.scene?.clampToHeightSupported;
    // A coarse rendered ellipsoid mesh can report a height kilometres below
    // zero. Its provider's exact height is zero even while a 3D map hides it;
    // a buried starting point can make the downward mesh ray miss the surface.
    const ellipsoid =
      viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider;
    const heights = viewer.scene ? heightsFor(viewer.scene) : null;
    for (let i = 0; i < positions.length; i++) {
      const sampled = ellipsoid
        ? 0
        : heights?.now(positions[i], { against: 'terrain' });
      positions[i].height = mesh
        ? (batch[i].groundHeight ??
          Math.max(0, Number.isFinite(sampled) ? sampled : 0))
        : Number.isFinite(sampled)
          ? sampled
          : batch[i].groundHeight || 0;
    }
    const points = positions.map((c) =>
      Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height),
    );
    const height = viewer.camera?.positionCartographic?.height;
    if (mesh && Number.isFinite(height) && height < 250_000) {
      const rectangle = viewer.camera.computeViewRectangle?.();
      const indices = [];
      for (let i = 0; i < positions.length; i++)
        if (rectangle && Cesium.Rectangle.contains(rectangle, positions[i]))
          indices.push(i);
      if (indices.length) {
        const resolved = await boundedImport(
          heights.clampBatch(
            indices.map((i) => {
              const c = positions[i];
              return Cesium.Cartesian3.fromRadians(
                c.longitude,
                c.latitude,
                Math.max(0, c.height),
              );
            }),
          ),
          signal,
        );
        for (let i = 0; i < indices.length; i++)
          if (resolved[i]) points[indices[i]] = resolved[i];
      }
    }
    signal?.throwIfAborted();
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const c = points[i] && Cesium.Cartographic.fromCartesian(points[i]);
      if (!c)
        throw new GeoImportError(
          msg(
            'Ground heights are not available for that file. Try again when the map has loaded.',
          ),
        );
      item.groundHeight = c.height;
      c.height += item.offset;
      item.entity.position =
        Math.abs(c.height - item.cartographic.height) < 1e-6
          ? item.original
          : Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height);
    }
    if (at + batch.length < pins.length)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** All visible positions, path vertices, polygon rings, walls and overlay bounds. */
export function dataSourcePoints(dataSource, time = Cesium.JulianDate.now()) {
  const points = [];
  const add = (position, grounded = false) => {
    if (
      !position ||
      ![position.x, position.y, position.z].every(Number.isFinite)
    )
      return;
    const c = Cesium.Cartographic.fromCartesian(position);
    if (c && Number.isFinite(c.longitude) && Number.isFinite(c.latitude))
      points.push([
        Cesium.Math.toDegrees(c.longitude),
        Cesium.Math.toDegrees(c.latitude),
        grounded ? 0 : c.height,
      ]);
  };
  if (dataSource?.show === false) return points;
  for (const entity of dataSource?.importedEntities ??
    dataSource?.entities?.values ??
    []) {
    if (entity.isShowing === false) continue;
    add(
      entity.position?.getValue?.(time),
      entity.billboard?.heightReference?.getValue?.(time) ===
        Cesium.HeightReference.CLAMP_TO_GROUND,
    );
    for (const graphic of [entity.polyline, entity.wall])
      for (const position of graphic?.positions?.getValue?.(time) || [])
        add(position, graphic.clampToGround?.getValue?.(time) === true);
    const rings = [entity.polygon?.hierarchy?.getValue?.(time)];
    while (rings.length) {
      const ring = rings.pop();
      for (const position of ring?.positions || [])
        add(
          position,
          entity.polygon?.perPositionHeight?.getValue?.(time) !== true,
        );
      for (const hole of ring?.holes || []) rings.push(hole);
    }
    const rectangle = entity.rectangle?.coordinates?.getValue?.(time);
    if (rectangle) {
      const bounds = Cesium.RectangleGeometry.computeRectangle({
        rectangle,
        rotation: entity.rectangle.rotation?.getValue?.(time) || 0,
      });
      for (const corner of [
        'southwest',
        'southeast',
        'northwest',
        'northeast',
      ]) {
        const c = Cesium.Rectangle[corner](bounds);
        if (Number.isFinite(c.longitude) && Number.isFinite(c.latitude))
          points.push([
            Cesium.Math.toDegrees(c.longitude),
            Cesium.Math.toDegrees(c.latitude),
            entity.rectangle.height?.getValue?.(time) || 0,
          ]);
      }
    }
  }
  return points;
}
