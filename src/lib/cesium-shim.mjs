/**
 * Cesium ESM shim.
 *
 * The CDN script tag sets `window.Cesium` as a global (UMD build with no named
 * exports). This shim is the single import target for all `import * as Cesium
 * from 'cesium'` statements in the codebase. Vite aliases 'cesium' to this
 * file so the shim is bundled, and the shim re-exports the global.
 */
export default window.Cesium;
export const Cesium = window.Cesium;
