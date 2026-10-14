// Whether src/geo runs Cesium's debug argument checks.
//
// Cesium wraps its argument checks in `//>>includeStart('debug')` pragmas: they
// are live in its Source modules (Node tests, the Vite dev server) and stripped
// from Build/Cesium, which vite-plugin-cesium copies into production builds.
// src/geo does the same: every Check call and every debug throw sits in an
// `if (DEBUG)` block. DEBUG is true in Node (no import.meta.env) and in Vite
// dev; `vite build` folds it to false and the minifier drops the blocks, so a
// production build returns what release Cesium returns (NaN, not a throw, for
// a degenerate input).

export const DEBUG = import.meta.env?.PROD !== true;
