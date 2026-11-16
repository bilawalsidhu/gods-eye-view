import { fromDegrees } from '../../geo/ellipsoid.js';
import { distance } from '../../geo/vector.js';
import { findCamera, findFrame } from '../../render/rendererOf.js';
import { hexColor } from '../../render/color.js';
import { LAUNCH_PAD_ZONE_RADIUS_M } from './policy.js';

/** The zone's colour: a faint fill under a brighter rim. */
const ZONE_COLOR = '#22e6e6';
const ZONE_FILL_ALPHA = 0.105;
const ZONE_RIM_ALPHA = 0.72;
/** The rim's width, a fraction of the zone's radius. */
const ZONE_RIM_WIDTH = 0.033;
/** Where the zone's soft edge starts, a fraction of its radius. */
const ZONE_EDGE = 0.985;
/** How much brighter the rim glows than its colour. */
const ZONE_RIM_GLOW = 0.35;
/** The zone image's side, pixels. */
const ZONE_IMAGE_PX = 512;

const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * The zone's colour and alpha at `r`, a fraction of its radius from its
 * centre: the fill's colour, easing into the rim's (which glows a little)
 * over `ZONE_RIM_WIDTH` just inside a soft edge, nothing past it.
 * @param {number} r
 * @returns {[number, number, number, number]} `r, g, b, a`, 0..1.
 */
export function launchPadZoneColour(r) {
  const [red, green, blue] = hexColor(ZONE_COLOR, 1);
  const inside = 1 - smoothstep(ZONE_EDGE, 1, r);
  const rim = smoothstep(ZONE_EDGE - ZONE_RIM_WIDTH, ZONE_EDGE, r) * inside;
  const glow = 1 + ZONE_RIM_GLOW * rim;
  return [
    Math.min(1, red * glow),
    Math.min(1, green * glow),
    Math.min(1, blue * glow),
    inside * (ZONE_FILL_ALPHA + (ZONE_RIM_ALPHA - ZONE_FILL_ALPHA) * rim),
  ];
}

/** The zone's image, made on first use; null where there is no 2D canvas. */
let zoneImage;

/**
 * The zone as an image fill: `launchPadZoneColour` across a square canvas,
 * its centre at the middle and its edge at the sides.
 * @param {() => HTMLCanvasElement} [createCanvas]
 * @returns {?{canvas: HTMLCanvasElement, key: string}}
 */
export function launchPadZoneImage(
  createCanvas = () => globalThis.document?.createElement('canvas'),
) {
  if (zoneImage !== undefined) return zoneImage;
  const canvas = createCanvas();
  const context = canvas?.getContext?.('2d');
  if (!context) return (zoneImage = null);
  canvas.width = ZONE_IMAGE_PX;
  canvas.height = ZONE_IMAGE_PX;
  const image = context.createImageData(ZONE_IMAGE_PX, ZONE_IMAGE_PX);
  const half = ZONE_IMAGE_PX / 2;
  for (let y = 0; y < ZONE_IMAGE_PX; y++)
    for (let x = 0; x < ZONE_IMAGE_PX; x++) {
      const r = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
      const colour = launchPadZoneColour(r);
      const at = (y * ZONE_IMAGE_PX + x) * 4;
      for (let k = 0; k < 4; k++)
        image.data[at + k] = Math.round(colour[k] * 255);
    }
  context.putImageData(image, 0, 0);
  return (zoneImage = { canvas, key: 'launch-pad-zone' });
}

export function createLaunchPad({
  state: layerState,
  services,
  parts,
  source,
}) {
  function zoneSet() {
    return layerState._missionSets?.pad ?? null;
  }

  function hideLaunchPadZone() {
    const item = layerState._launchPadZoneItem;
    if (!item || item.show === false) return;
    layerState._launchPadZoneItem = { ...item, show: false };
    zoneSet()?.upsert([layerState._launchPadZoneItem]);
  }

  function removeLaunchPadZonePrimitive() {
    if (layerState._launchPadZoneItem) zoneSet()?.clear();
    layerState._launchPadZoneItem = null;
    layerState._launchPadZoneLaunchId = null;
  }

  /**
   * The zone drawn around a launch's pad, draped on the ground (and on the
   * pad's mesh); a plain fill where there is no canvas to draw it with.
   */
  function createLaunchPadZonePrimitive(launch) {
    removeLaunchPadZonePrimitive();
    const image = launchPadZoneImage();
    const item = {
      id: `rocket-pad-zone:${launch.id}`,
      geometry: {
        kind: 'ellipse',
        center: { lon: launch.lon, lat: launch.lat },
        semiMajor: LAUNCH_PAD_ZONE_RADIUS_M,
        semiMinor: LAUNCH_PAD_ZONE_RADIUS_M,
      },
      fill: image ? { image } : hexColor(ZONE_COLOR, ZONE_FILL_ALPHA),
      height: 'clampGround',
      clampTo: 'both',
      show: true,
    };
    layerState._launchPadZoneItem = item;
    zoneSet()?.set([item]);
    layerState._launchPadZoneLaunchId = launch.id;
  }

  /** Before each frame: the rings' labels, and the selected pad's zone. */
  function updateLaunchPadZone() {
    if (!layerState._enabled || !parts.rendering.missionsShown()) {
      hideLaunchPadZone();
      return;
    }
    const nowMs = Date.now();
    if (nowMs - layerState._lastMissionRingRotationMs >= 1000) {
      parts.orbitRendering.updateMissionOrbitPrimitiveFrames(
        layerState.orbitNow(),
      );
      layerState._lastMissionRingRotationMs = nowMs;
    }
    const launch = layerState._launches.find(
      (item) => item.id === layerState._selectedLaunchId,
    );
    const pose = findCamera(layerState._viewer)?.pose();
    if (!launch || !pose) {
      hideLaunchPadZone();
      return;
    }
    const launchPosition = fromDegrees(launch.lon, launch.lat);
    const visible = parts.policyHelpers.launchPadZoneVisible({
      layerActive: parts.rendering.missionsShown(),
      selectedLaunchId: layerState._selectedLaunchId,
      launchId: launch.id,
      cameraHeightM: pose.height,
      cameraDistanceM: distance(pose.position, launchPosition),
    });
    if (!visible) {
      hideLaunchPadZone();
      return;
    }
    if (layerState._launchPadZoneLaunchId !== launch.id)
      createLaunchPadZonePrimitive(launch);
    else if (layerState._launchPadZoneItem.show === false) {
      layerState._launchPadZoneItem = {
        ...layerState._launchPadZoneItem,
        show: true,
      };
      zoneSet()?.upsert([layerState._launchPadZoneItem]);
    }
  }

  function initLaunchPadZonePrimitive() {
    if (!layerState._viewer || layerState._launchPadZoneRemover) return;
    layerState._launchPadZoneRemover =
      findFrame(layerState._viewer)?.on('preRender', updateLaunchPadZone) ??
      null;
  }

  function destroyLaunchPadZonePrimitive() {
    if (layerState._launchPadZoneRemover) layerState._launchPadZoneRemover();
    layerState._launchPadZoneRemover = null;
    removeLaunchPadZonePrimitive();
  }
  return {
    hideLaunchPadZone,
    removeLaunchPadZonePrimitive,
    createLaunchPadZonePrimitive,
    initLaunchPadZonePrimitive,
    destroyLaunchPadZonePrimitive,
    updateLaunchPadZone,
  };
}
