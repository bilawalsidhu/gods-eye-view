/**
 * Cesium viewer construction and render policy.
 *
 * Two things live here and nothing else: how the globe is built, and when it is allowed
 * to draw. Everything drawn on it belongs to a layer module.
 */

import {
  Cartesian3,
  Color,
  Credit,
  ImageryLayer,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
  WebMapTileServiceImageryProvider,
  WebMercatorTilingScheme,
} from 'cesium';
import type { Cartesian2 } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

const GIBS_LAYER = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';

/**
 * The braced names left in are Cesium's own placeholders and it fills them in per tile.
 *
 * Concatenated rather than assembled with `String.replace`, which treats `$&` and friends
 * in the replacement as substitution patterns and would silently rewrite the URL, and
 * rather than as a template literal, where `{Time}` reads as a mistyped `${Time}`.
 */
const GIBS_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' +
  GIBS_LAYER +
  '/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpg';

const GIBS_TILE_MATRIX_SET = 'GoogleMapsCompatible_Level9';

const GIBS_MAXIMUM_LEVEL = 8;
/** Level 9 is the deepest this matrix set publishes, and level indices are zero-based. */

/**
 * The date whose imagery to request, as `YYYY-MM-DD` in UTC.
 *
 * Yesterday, not today. GIBS builds a day's mosaic as the satellite passes land, so a
 * request for the current date returns black gaps over everywhere the spacecraft has not
 * reached yet, which reads as a broken globe rather than as missing data.
 */
export function imageryDate(now: Date = new Date()): string {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return yesterday.toISOString().slice(0, 10);
}

/**
 * NASA GIBS true-colour imagery. No Cesium ion token and no API key of any kind.
 */
export function gibsImagery(date: string = imageryDate()): WebMapTileServiceImageryProvider {
  return new WebMapTileServiceImageryProvider({
    url: GIBS_URL,
    layer: GIBS_LAYER,
    style: 'default',
    format: 'image/jpeg',
    tileMatrixSetID: GIBS_TILE_MATRIX_SET,
    tilingScheme: new WebMercatorTilingScheme(),
    maximumLevel: GIBS_MAXIMUM_LEVEL,
    // Web Mercator has no imagery beyond about 85 degrees, so asking for the poles just
    // produces failed tile requests.
    rectangle: Rectangle.fromDegrees(-180, -85, 180, 85),
    dimensions: { Time: date },
    credit: new Credit('Imagery courtesy of NASA EOSDIS GIBS'),
    enablePickFeatures: false,
  });
}

export interface GlobeHandle {
  viewer: Viewer;
  /** Ask for one frame. Called whenever data changes, because render mode is on demand. */
  requestRender: () => void;
  destroy: () => void;
}

/**
 * Build the globe.
 *
 * `requestRenderMode` is on, so an idle scene costs nothing and every change has to ask
 * for a frame. The widgets that imply a time dimension (animation, timeline) are off:
 * phase 1 shows live positions only, and a timeline the user can scrub would be lying.
 */
export function createGlobe(container: HTMLElement): GlobeHandle {
  const viewer = new Viewer(container, {
    baseLayer: new ImageryLayer(gibsImagery()),
    baseLayerPicker: false,
    geocoder: false,
    animation: false,
    timeline: false,
    homeButton: false,
    fullscreenButton: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    vrButton: false,
    // The card is our own docked panel; Cesium's floating info box and selection ring
    // are the pattern we are deliberately not using.
    infoBox: false,
    selectionIndicator: false,
    requestRenderMode: true,
    // Nothing in the scene is time-dynamic, so the clock alone must never trigger a
    // frame. Dead reckoning asks for its own renders.
    maximumRenderTimeChange: Infinity,
  });

  // Dark and low-chroma so the map reads as context. Saturated colour belongs to
  // entities and alerts.
  viewer.scene.globe.baseColor = Color.fromCssColorString('#0a1017');
  viewer.scene.globe.showGroundAtmosphere = false;
  viewer.scene.backgroundColor = Color.fromCssColorString('#05080c');
  viewer.scene.highDynamicRange = false;

  viewer.camera.setView({
    // London, where the default aircraft poll is centred.
    destination: Cartesian3.fromDegrees(-0.12, 51.5, 2_400_000),
  });

  const requestRender = (): void => {
    viewer.scene.requestRender();
  };

  // A hidden tab must not burn a GPU. Cesium keeps its own requestAnimationFrame loop
  // running otherwise, and browsers throttle rather than stop it.
  const onVisibilityChange = (): void => {
    const visible = document.visibilityState !== 'hidden';
    viewer.useDefaultRenderLoop = visible;
    if (visible) {
      requestRender();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  onVisibilityChange();

  return {
    viewer,
    requestRender,
    destroy: () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      viewer.destroy();
    },
  };
}

/**
 * Drive dead reckoning and ask for a frame whenever something moved.
 *
 * Its own animation frame loop rather than Cesium's `preRender`, because with
 * `requestRenderMode` on a paused scene does not raise render events and so cannot drive
 * its own interpolation. `advance` returns whether anything actually moved, so a globe
 * with nothing on it, or nothing with a track and a speed, still costs nothing.
 *
 * Returns a function that stops the loop.
 */
export function startMotionLoop(
  handle: GlobeHandle,
  advance: (nowMs: number) => boolean,
): () => void {
  let frame = 0;
  const tick = (): void => {
    if (document.visibilityState !== 'hidden' && advance(Date.now())) {
      handle.requestRender();
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
  };
}

/**
 * Report what the user clicked on the globe.
 *
 * A picked point primitive comes back with whatever `id` was set when it was created, so
 * the aircraft layer's identity travels with the primitive. A click on nothing reports
 * null, which deselects.
 */
export function installPicking(handle: GlobeHandle, onPick: (id: string | null) => void): void {
  const handler = new ScreenSpaceEventHandler(handle.viewer.scene.canvas);
  handler.setInputAction((movement: { position: Cartesian2 }) => {
    const picked: unknown = handle.viewer.scene.pick(movement.position);
    const id: unknown = (picked as { id?: unknown } | undefined)?.id;
    onPick(typeof id === 'string' ? id : null);
  }, ScreenSpaceEventType.LEFT_CLICK);
}
