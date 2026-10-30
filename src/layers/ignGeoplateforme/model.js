/**
 * @module layers/ignGeoplateforme/model
 *
 * The IGN Géoplateforme raster basemap, described. Pure — no Cesium, no
 * network.
 *
 * WHY THE TILE URL IS BUILT HERE: the service publishes no <ResourceURL> in
 * its GetCapabilities document, so the GetTile KVP request has to be
 * assembled from the parameters the document does declare. The REST paths
 * under /ge-services/ are dead (404).
 */
// A portable export (package.json): no i18n here. The labels stay English
// data; the Layers panel shows them translated.
const msg = (text) => text;

export const IGN_OVERLAY_SOURCE_ID = 'ign-geoplateforme';

/** The tile matrix set the Plan IGN layers are published in. */
export const IGN_TILE_MATRIX_SET = 'PM_0_19';
/** Highest published tile matrix. */
export const IGN_MAX_ZOOM = 19;

/**
 * The raster layers the Géoplateforme publishes.
 *
 * `PLANIGNV2` is the current French raster basemap; `PLANIGNV2.L93` is the
 * same product reprojected into Lambert-93; `ORTHOPHOTOS` is the aerial
 * orthophoto layer.
 */
export const IGN_RASTER_LAYERS = Object.freeze([
  Object.freeze({ id: 'PLANIGNV2', label: msg('Plan IGN v2') }),
  Object.freeze({
    id: 'PLANIGNV2.L93',
    label: msg('Plan IGN v2 (Lambert 93)'),
  }),
  Object.freeze({ id: 'ORTHOPHOTOS', label: msg('IGN Orthophotos') }),
]);

/**
 * The vector cadastre layers the Géoplateforme publishes.
 *
 * They are named here so the layer can state the truth: the vector cadastre
 * is served over WMS GetMap, which answers 500 for many requests, so this
 * layer does NOT offer it.
 */
export const IGN_VECTOR_LAYERS = Object.freeze([
  Object.freeze({
    id: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS',
    label: msg('IGN Cadastral parcels (vector)'),
  }),
  Object.freeze({
    id: 'CADASTRAL.PARCELS.SECTIONS',
    label: msg('IGN Cadastral sections (vector)'),
  }),
]);

/**
 * The layer's own description of what it shows.
 */
export const IGN_DESCRIPTION = msg(
  'French topographic base map · IGN Géoplateforme (Plan IGN v2)',
);

/**
 * The imagery-provider description for the Plan IGN layer.
 *
 * The browser resolves {z}/{x}/{y} against the LOCAL proxy template, so it
 * never names an upstream URL itself — the proxy resolves the upstream from
 * its own server-side allow-list.
 *
 * @param {string} [layer='PLANIGNV2'] The raster layer to request.
 * @returns {object} Imagery provider description.
 */
export function ignImageryDescriptor(layer = 'PLANIGNV2') {
  const id = String(layer || 'PLANIGNV2');
  return {
    url: `/api/ign-geoplateforme/tiles/${id}/{z}/{x}/{y}.png`,
    layer: id,
    tileMatrixSet: IGN_TILE_MATRIX_SET,
    maximumLevel: IGN_MAX_ZOOM,
    credit: msg('IGN Géoplateforme · Plan IGN v2'),
  };
}
