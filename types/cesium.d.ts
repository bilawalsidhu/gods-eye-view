/**
 * Cesium global type declarations.
 *
 * Cesium is loaded via CDN <script> tag and exposed as a global `Cesium` object.
 * This file provides TypeScript type definitions for the subset of the Cesium
 * API that the codebase actually uses.
 */

/** Cesium namespace — provides types like Cesium.Viewer */
declare namespace Cesium {
  class Viewer {
    container: Element;
    scene: Scene;
    dataSources: DataSourceCollection;
    entities: EntityCollection;
    camera: Camera;
    clock: Clock;
  }

  interface Scene {
    requestRenderMode: boolean;
    requestRender(): void;
    maximumRenderTimeChange: number;
    preRender: Event;
  }

  interface DataSourceCollection {}

  interface EntityCollection {
    add(entity: object): object;
    remove(entity: object): boolean;
  }

  interface Camera {
    positionCartographic: Cartographic;
    moveEnd: Event;
    setView(options: CameraViewOptions): void;
    flyTo(options: FlyToOptions): object;
  }

  interface Event {
    addEventListener(listener: () => void): void;
    removeEventListener(listener: () => void): void;
  }

  interface Cartographic {
    height: number;
  }

  interface CameraViewOptions {
    destination: Cartesian3 | Rectangle;
    orientation?: { heading?: number; pitch?: number; roll?: number };
    duration?: number;
  }

  interface FlyToOptions {
    destination: Cartesian3;
    orientation?: object;
    duration?: number;
  }

  interface Cartesian3 {
    x: number;
    y: number;
    z: number;
  }

  interface Rectangle {}

  interface Clock {}
}

/** Cesium global — the actual runtime object injected by the CDN <script> tag */
declare const Cesium: typeof Cesium;
