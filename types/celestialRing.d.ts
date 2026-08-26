/**
 * Type declarations for celestialRing.js — provides keyhole geometry used by scopeMask.
 * celestialRing.js is still JavaScript; these declarations allow TypeScript to resolve
 * imports from scopeMask.ts without @ts-ignore.
 */

declare module './celestialRing.js' {
  export const KEYHOLE_OUTER_RADIUS: number;
  export const GLOBE_ENTER_CLEARANCE_PX: number;
  export const GLOBE_EXIT_CLEARANCE_PX: number;
  export const CELESTIAL_PLANE_EPSILON: number;
  export const KEYHOLE_LABEL_FEATHER_RATIO: number;
  export const KEYHOLE_LABEL_FEATHER_MAX_RATIO: number;
  export const KEYHOLE_OUTSIDE_OPACITY_DEFAULT: number;
  export const CELESTIAL_MAX_FRAME_RATE: number;
  export const CELESTIAL_MAX_BACKING_PIXELS: number;
  export const CELESTIAL_MAX_BACKING_DIMENSION: number;

  interface KeyholeGeometry {
    centerX: number;
    centerY: number;
    radius: number;
  }

  function setKeyholeFadeTuning(opts?: { fadeRatio?: number; outsideOpacity?: number }): void;
  function getKeyholeFadeTuning(): { fadeRatio: number; outsideOpacity: number };
  function getKeyholeGeometry(width: number, height: number): KeyholeGeometry;
  function keyholeLabelAlpha(labelX: number, labelY: number, width: number, height: number): number;
  function keyholeLabelAlphaFromGeometry(labelX: number, labelY: number, geometry: KeyholeGeometry): number;
  function normalizeAngle(angle: number): number;
  function circularAngleDistance(a: number, b: number): number;
  function isCelestialRingStyleSupported(styleName: string): boolean;
  function celestialScreenAngle(rightComponent: number, upComponent: number, lastAngle?: number): number;
  function isFullGlobeInsideKeyhole(geometry: KeyholeGeometry, wasVisible?: boolean): boolean;
  function earthDiscScreenRadius(cameraDistance: number, viewportHeight: number, fovy: number): number;
  function projectEarthDiscToViewport(opts: object): object;
  // eslint-disable-next-line no-shadow
  class CelestialRing {
    constructor(viewer: Cesium.Viewer, styleName?: string);
    destroy(): void;
  }

  export {
    setKeyholeFadeTuning,
    getKeyholeFadeTuning,
    getKeyholeGeometry,
    keyholeLabelAlpha,
    keyholeLabelAlphaFromGeometry,
    normalizeAngle,
    circularAngleDistance,
    isCelestialRingStyleSupported,
    celestialScreenAngle,
    isFullGlobeInsideKeyhole,
    earthDiscScreenRadius,
    projectEarthDiscToViewport,
    CelestialRing,
  };
}
