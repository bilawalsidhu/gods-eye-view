<script setup>
import { destroyPreviewWidget } from '../../previewWidget.js';
import * as Cesium from 'cesium';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

// A flight's route on a small globe of its own at the top of its card: the
// great circle from origin to destination, solid where it has flown and
// dashed ahead, the two airports marked with their codes, and a plane icon
// where the craft is now, pointing the way it is flying. On opening, the flown part draws out from the
// origin to the craft. The globe uses Cesium's bundled Natural Earth image,
// so it fetches no map tiles. It holds still, north up and framed on the
// route; the plane points at the destination. The card names the airports'
// cities under its progress bar.
const props = defineProps({
  /** `{code, lat, lon}` of the origin airport. */
  from: { type: Object, required: true },
  /** `{code, lat, lon}` of the destination airport. */
  to: { type: Object, required: true },
  /** The craft's position now. */
  at: { type: Object, default: null },
  /** Its heading in degrees; without one the icon points along the route. */
  heading: { type: Number, default: null },
  /** Whether the tile is the one showing; a hidden one stops drawing. */
  active: { type: Boolean, default: true },
});

const host = ref(null);
const failed = ref(false);
let widget = null;
let removeTick = null;
let entities = null;
let plane = null;
let flownLine = null;
let aheadLine = null;
/** True while the plane flies in from the origin; position updates wait. */
let flyingIn = false;

const CYAN = Cesium.Color.fromCssColorString('#36dcff');

// The plane: the Material "flight" silhouette, nose up (north), white with a
// cyan glow, drawn once as an image.
const PLANE_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 32 32" width="64" height="64">' +
    '<defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4"/></filter></defs>' +
    '<path filter="url(#g)" fill="#36dcff" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>' +
    '<path fill="#ffffff" stroke="#0b1820" stroke-width="0.6" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>' +
    '</svg>',
)}`;

/** The initial bearing (degrees from north) of the great circle a → b. */
function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x =
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/**
 * Billboard placement for the plane, nose along `deg` from north: the icon's
 * up is tied to the local north direction on the globe and turned from there,
 * so it points the right way in this tilted view too.
 */
function planePose(at, deg) {
  const position = Cesium.Cartesian3.fromDegrees(at.lon, at.lat, 30_000);
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const north = Cesium.Matrix4.getColumn(frame, 1, new Cesium.Cartesian4());
  return {
    position,
    rotation: -Cesium.Math.toRadians(deg),
    alignedAxis: new Cesium.Cartesian3(north.x, north.y, north.z),
  };
}
/**
 * The point on the route (the great circle from origin to destination)
 * nearest the craft. The craft is drawn there and the route split there, so
 * the path stays one smooth arc: a craft a little off the direct line
 * (vectors, airways, a detour) would otherwise bend it into a sharp corner.
 */
function onRoute(at) {
  if (!at || !Number.isFinite(at.lat)) return null;
  const route = new Cesium.EllipsoidGeodesic(
    Cesium.Cartographic.fromDegrees(props.from.lon, props.from.lat),
    Cesium.Cartographic.fromDegrees(props.to.lon, props.to.lat),
  );
  const here = Cesium.Cartesian3.fromDegrees(at.lon, at.lat);
  let best = null;
  let bestDistance = Infinity;
  const STEPS = 200;
  for (let i = 0; i <= STEPS; i++) {
    const c = route.interpolateUsingFraction(i / STEPS);
    const d = Cesium.Cartesian3.distanceSquared(here, Cesium.Cartesian3.fromRadians(c.longitude, c.latitude));
    if (d < bestDistance) {
      bestDistance = d;
      best = { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
    }
  }
  return best;
}

// The nose points at the destination: along the great circle from here.
const planeHeading = (at) => bearing(at, props.to);

// The compass: the view is north up, so N sits at the top; a cyan needle
// shows the course to the destination, with its bearing in degrees.
const course = computed(() => {
  const at = props.at && Number.isFinite(props.at.lat) ? props.at : props.from;
  return Math.round(bearing(at, props.to));
});
const courseLabel = computed(() => {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${String(course.value).padStart(3, '0')}° ${points[Math.round(course.value / 45) % 8]}`;
});
const AMBER = Cesium.Color.fromCssColorString('#ffb86b');

/** Points along the great circle from a to b, `t` from 0 to 1. */
function arc(a, b, steps = 64, upTo = 1) {
  const start = Cesium.Cartographic.fromDegrees(a.lon, a.lat);
  const end = Cesium.Cartographic.fromDegrees(b.lon, b.lat);
  const geodesic = new Cesium.EllipsoidGeodesic(start, end);
  const out = [];
  const n = Math.max(2, Math.round(steps * upTo));
  for (let i = 0; i <= n; i++) {
    const c = geodesic.interpolateUsingFraction((i / n) * upTo);
    out.push(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 30_000));
  }
  return out;
}

function draw() {
  if (!widget) return;
  const { from, to } = props;
  const at = onRoute(props.at);
  entities?.removeAll();
  entities = widget.entities;
  const pin = (place, color) =>
    entities.add({
      position: Cesium.Cartesian3.fromDegrees(place.lon, place.lat),
      point: { pixelSize: 7, color, outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1 },
      label: {
        text: place.code || '',
        font: '600 11px ui-monospace, monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -14),
      },
    });
  pin(from, CYAN.withAlpha(0.9));
  pin(to, AMBER);

  // Ahead of the craft, dashed; behind it, solid, drawing out on open.
  aheadLine = entities.add({
    polyline: {
      positions: arc(at || from, to),
      width: 1.5,
      material: new Cesium.PolylineDashMaterialProperty({ color: AMBER.withAlpha(0.8), dashLength: 10 }),
      arcType: Cesium.ArcType.NONE,
    },
  });
  if (at) {
    let progress = 0;
    const flown = (flownLine = entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => arc(from, at, 48, Math.max(0.02, progress)), false),
        width: 2.5,
        material: new Cesium.PolylineGlowMaterialProperty({ color: CYAN, glowPower: 0.25 }),
        arcType: Cesium.ArcType.NONE,
      },
    }));
    // The fly-in waits until the globe has drawn (its imagery loads a moment
    // after the card opens), at most 1.5 s, so it is seen from the start.
    let began = null;
    const opened = performance.now();
    // The plane starts at the origin and flies out along the flown line as it
    // draws, arriving where the craft is now; it points at the destination
    // all the way.
    const start = planePose(from, planeHeading(from));
    plane = entities.add({
      position: start.position,
      billboard: {
        image: PLANE_ICON,
        width: 26,
        height: 26,
        rotation: start.rotation,
        alignedAxis: start.alignedAxis,
      },
    });
    const leg = new Cesium.EllipsoidGeodesic(
      Cesium.Cartographic.fromDegrees(from.lon, from.lat),
      Cesium.Cartographic.fromDegrees(at.lon, at.lat),
    );
    const ease = (x) => 1 - (1 - x) ** 3;
    flyingIn = true;
    const grow = () => {
      if (began === null) {
        if (!widget.scene.globe.tilesLoaded && performance.now() - opened < 1500) return;
        began = performance.now();
      }
      const raw = Math.min(1, (performance.now() - began) / 1600);
      progress = ease(raw);
      const c = leg.interpolateUsingFraction(progress);
      const where = { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
      const pose = planePose(where, planeHeading(where));
      plane.position = pose.position;
      plane.billboard.rotation = pose.rotation;
      plane.billboard.alignedAxis = pose.alignedAxis;
      if (raw >= 1) {
        flyingIn = false;
        flown.polyline.positions = arc(from, at, 48);
        widget?.scene.preRender.removeEventListener(grow);
      }
    };
    widget.scene.preRender.addEventListener(grow);
  }

  // Frame the whole route, north up, looking down at a slight tilt; the view
  // holds still so the plane and labels keep their bearings.
  const points = [from, to, ...(at ? [at] : [])].map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat));
  const sphere = Cesium.BoundingSphere.fromPoints(points);
  const range = Math.max(1_800_000, sphere.radius * 3.2);
  removeTick?.();
  removeTick = null;
  const center = Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(sphere.center) || sphere.center;
  widget.camera.lookAt(center, new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-62), range));
  widget.scene.requestRender();
}

onMounted(async () => {
  try {
    widget = new Cesium.CesiumWidget(host.value, {
      baseLayer: false,
      skyBox: false,
      skyAtmosphere: false,
      scene3DOnly: true,
      shadows: false,
      showRenderLoopErrors: false,
      contextOptions: { webgl: { alpha: true, antialias: true } },
      creditContainer: document.createElement('div'),
    });
    const scene = widget.scene;
    scene.backgroundColor = Cesium.Color.TRANSPARENT;
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1820');
    scene.globe.showGroundAtmosphere = false;
    scene.globe.enableLighting = false;
    scene.screenSpaceCameraController.enableInputs = false;
    const imagery = await Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
    );
    if (!widget) return;
    const layer = scene.imageryLayers.addImageryProvider(imagery);
    // Dimmed and cooled, so the route reads over it.
    layer.brightness = 0.55;
    layer.saturation = 0.35;
    layer.contrast = 1.1;
    draw();
  } catch {
    failed.value = true;
  }
});

// A new route redraws; the craft moving along it only moves its marker and
// the two lines, without replaying the opening draw.
// Watched as strings: a fresh array each card refresh would count as a change
// every two seconds and restart the drawing and the turn.
watch(
  () => `${props.from?.code}|${props.to?.code}`,
  () => draw(),
);
watch(
  () => `${props.at?.lat?.toFixed?.(4)}|${props.at?.lon?.toFixed?.(4)}|${Math.round(props.heading ?? -1)}`,
  () => {
    const at = onRoute(props.at);
    if (!widget || !at || !plane || flyingIn) return;
    const pose = planePose(at, planeHeading(at));
    plane.position = pose.position;
    plane.billboard.rotation = pose.rotation;
    plane.billboard.alignedAxis = pose.alignedAxis;
    if (flownLine) flownLine.polyline.positions = arc(props.from, at, 48);
    if (aheadLine) aheadLine.polyline.positions = arc(at, props.to);
  },
);

// Hidden, the globe rests on its last frame; shown again, it draws once
// straight away so there is no gap.
watch(
  () => props.active,
  (active) => {
    if (!widget || widget.isDestroyed()) return;
    if (active && !widget.useDefaultRenderLoop) {
      widget.resize();
      widget.render();
    }
    widget.useDefaultRenderLoop = active;
  },
);

onBeforeUnmount(() => {
  removeTick?.();
  removeTick = null;
  destroyPreviewWidget(widget);
  widget = null;
});
</script>

<template>
  <div v-if="!failed" class="route-globe">
    <div ref="host" class="route-globe__scene" aria-hidden="true"></div>
    <div class="route-globe__compass" :title="`Course to ${to.code}: ${courseLabel}`">
      <svg viewBox="-24 -24 48 48" aria-hidden="true">
        <circle r="19" class="route-globe__compass-ring" />
        <g class="route-globe__compass-ticks">
          <line v-for="deg in [0, 45, 90, 135, 180, 225, 270, 315]" :key="deg" :transform="`rotate(${deg})`" y1="-19" :y2="deg % 90 ? -16.5 : -15" />
        </g>
        <text y="-9.5" class="route-globe__compass-n">N</text>
        <g :transform="`rotate(${course})`" class="route-globe__compass-needle">
          <path d="M0 -14 L3 2 L0 0 L-3 2 Z" />
        </g>
        <circle r="1.6" class="route-globe__compass-hub" />
      </svg>
      <span>{{ courseLabel }}</span>
    </div>
  </div>
</template>
