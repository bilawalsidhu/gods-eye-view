import { Cartesian2, Cartographic, Math as CesiumMath } from 'cesium';

/** Read the globe center through a narrow facade; never change the globe. */
export function observedArea(application, radiusKm = 10) {
  const viewer = application.getComponents().scene?.viewer;
  if (!viewer || viewer.isDestroyed()) throw new Error('Globe is not ready.');
  const canvas = viewer.scene.canvas;
  const point = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const ray = viewer.camera.getPickRay(point);
  const position = ray && viewer.scene.globe.pick(ray, viewer.scene);
  const fallback = viewer.camera.pickEllipsoid(
    point,
    viewer.scene.globe.ellipsoid,
  );
  if (!position && !fallback)
    throw new Error('Point the center of the view at the Earth.');
  const coordinates = Cartographic.fromCartesian(position ?? fallback);
  return {
    lat: CesiumMath.toDegrees(coordinates.latitude),
    lon: CesiumMath.toDegrees(coordinates.longitude),
    radius_km: radiusKm,
  };
}

let pending;
/** Compose existing read-only queries for area investigation on first explicit use. */
export function loadInvestigationCatalog() {
  pending ??= Promise.all([
    import('../tools/index.js'),
    import('../tools/services.js'),
  ]).then(([{ composeCatalog, coreTools }, { createToolServices }]) =>
    composeCatalog({
      tools: coreTools.filter((tool) =>
        [
          'get_earthquakes',
          'find_infrastructure',
          'get_recent_imagery',
        ].includes(tool.name),
      ),
      services: createToolServices({
        fetchImpl: (...args) => globalThis.fetch(...args),
        appUrl: new URL(document.baseURI).origin,
      }),
    }),
  );
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
