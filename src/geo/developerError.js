// Ported from CesiumJS 1.138 (Apache-2.0) — DeveloperError.js
//
// The error Cesium throws for invalid arguments. Its debug argument checks are
// live in Cesium's Source modules (Node tests, the Vite dev server) and
// stripped from production builds; src/geo throws the same name and message
// wherever Cesium does while DEBUG is on (see debug.js).

export class DeveloperError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeveloperError';
  }
}
