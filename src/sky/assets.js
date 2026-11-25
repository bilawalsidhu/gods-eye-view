/**
 * @module sky/assets
 * @description The sky background's bundled data, Cesium-free: the
 * bright-star catalogue (`buildStarVertices` in `./stars.js` decodes it) and
 * the Milky Way glow's six cube faces, both in ICRF/J2000. See
 * `src/data/local_data/sky/README.md` for their sources and licences.
 */

/** The bright-star catalogue pack (`{ stars: [raDeg, decDeg, vmag, bv, …] }`). */
export const STAR_CATALOGUE_URL = new URL(
  '../data/local_data/sky/bright_stars.json',
  import.meta.url,
);

/**
 * The Milky Way's cube faces in the WebGL face order and layout: +X toward
 * the March equinox, +Z toward the north celestial pole, uploaded without
 * flipping.
 */
export const MILKY_WAY_FACE_URLS = Object.freeze({
  positiveX: new URL(
    '../data/local_data/sky/milkyway_px.webp',
    import.meta.url,
  ),
  negativeX: new URL(
    '../data/local_data/sky/milkyway_nx.webp',
    import.meta.url,
  ),
  positiveY: new URL(
    '../data/local_data/sky/milkyway_py.webp',
    import.meta.url,
  ),
  negativeY: new URL(
    '../data/local_data/sky/milkyway_ny.webp',
    import.meta.url,
  ),
  positiveZ: new URL(
    '../data/local_data/sky/milkyway_pz.webp',
    import.meta.url,
  ),
  negativeZ: new URL(
    '../data/local_data/sky/milkyway_nz.webp',
    import.meta.url,
  ),
});

/** The Milky Way glow's brightness at `SkySettings.milkyWay` 1: the stars carry the sky. */
export const MILKY_WAY_INTENSITY = 0.4;
