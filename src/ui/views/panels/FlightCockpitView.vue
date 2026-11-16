<script setup>
import * as Cesium from 'cesium';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import { ESRI_IMAGERY_CREDIT, createEsriImagery } from '../../../maps/imagery.js';
import { destroyPreviewWidget } from '../../previewWidget.js';
import PreviewHud from './PreviewHud.vue';

// What the crew sees: the view ahead from the aircraft's own position,
// height and heading, a little nose down, over Esri World Imagery (the
// app's keyless basemap) on a plain ellipsoid with the sky's haze. It takes
// turns with the turning model, as a satellite's ground view does. It draws
// only when asked (a still, moved along with the craft while it shows) and
// holds still while hidden. Its credit line sits in the corner. Speed and
// altitude ride on tapes either side, as on a head-up display: the ticks
// roll as the figures change, with the figure boxed in the middle.
const props = defineProps({
  lat: { type: Number, default: null },
  lon: { type: Number, default: null },
  /** Height above the ellipsoid, metres. */
  altitudeM: { type: Number, default: null },
  /** Degrees from north. */
  heading: { type: Number, default: null },
  /** Ground speed, metres a second. */
  speedMps: { type: Number, default: null },
  /** Whether the view is the one showing. */
  active: { type: Boolean, default: false },
});
const emit = defineEmits(['failed']);

const host = ref(null);
let widget = null;

/** A ground floor for the eye, so a landed or taxiing craft is not underground. */
const MIN_EYE_M = 60;

function place() {
  if (!widget || !Number.isFinite(props.lat) || !Number.isFinite(props.lon)) return;
  const height = Math.max(MIN_EYE_M, Number.isFinite(props.altitudeM) ? props.altitudeM : 0);
  widget.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(props.lon, props.lat, height),
    orientation: {
      heading: Cesium.Math.toRadians(Number.isFinite(props.heading) ? props.heading : 0),
      pitch: Cesium.Math.toRadians(-9),
      roll: 0,
    },
  });
  widget.scene.requestRender();
}

onMounted(async () => {
  try {
    widget = new Cesium.CesiumWidget(host.value, {
      baseLayer: false,
      skyBox: false,
      scene3DOnly: true,
      shadows: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      showRenderLoopErrors: false,
      contextOptions: { webgl: { alpha: false, antialias: true } },
      creditContainer: document.createElement('div'),
    });
    const scene = widget.scene;
    scene.screenSpaceCameraController.enableInputs = false;
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1820');
    scene.globe.showGroundAtmosphere = true;
    scene.fog.enabled = true;
    scene.camera.frustum.fov = Cesium.Math.toRadians(70);
    // Tiles arriving ask for a frame, so the still fills in as they load.
    scene.globe.tileLoadProgressEvent.addEventListener(() => scene.requestRender());
    place();
    const imagery = await createEsriImagery();
    if (!widget) return;
    scene.imageryLayers.addImageryProvider(imagery);
    scene.requestRender();
  } catch {
    emit('failed');
  }
});

// While it shows, the view keeps up with the craft as the card refreshes.
watch(
  () => [props.active, props.lat, props.lon, props.altitudeM, props.heading],
  () => props.active && place(),
);

onBeforeUnmount(() => {
  destroyPreviewWidget(widget);
  widget = null;
});

const feet = computed(() =>
  Number.isFinite(props.altitudeM) ? `${(Math.round((props.altitudeM * 3.28084) / 100) * 100).toLocaleString('en-US')} ft` : '',
);
// The tapes: one tick every 10 kt and every 100 ft, 8 px apart; the ticks
// roll by the remainder, so a change in the figure moves them.
const TICK_PX = 8;
const knots = computed(() => (Number.isFinite(props.speedMps) ? Math.round(props.speedMps * 1.94384) : null));
const altFeet = computed(() => (Number.isFinite(props.altitudeM) ? Math.round(props.altitudeM * 3.28084) : null));
const roll = (value, per) => (value === null ? 0 : ((value % per) / per) * TICK_PX);
const speedRoll = computed(() => `${roll(knots.value, 10)}px`);
const altRoll = computed(() => `${roll(altFeet.value, 100)}px`);
const course = computed(() => (Number.isFinite(props.heading) ? `${String(Math.round(props.heading) % 360).padStart(3, '0')}°` : ''));
</script>

<template>
  <div class="flight-cockpit" aria-hidden="true">
    <div ref="host" class="flight-cockpit__scene"></div>
    <PreviewHud variant="cockpit" :running="active" />
    <span class="flight-cockpit__horizon"><i></i></span>
    <span v-if="knots !== null" class="flight-cockpit__tape flight-cockpit__tape--speed">
      <i class="flight-cockpit__ticks" :style="{ backgroundPositionY: speedRoll }"></i>
      <b>{{ knots }}</b><em>{{ t('KT') }}</em>
    </span>
    <span v-if="altFeet !== null" class="flight-cockpit__tape flight-cockpit__tape--alt">
      <i class="flight-cockpit__ticks" :style="{ backgroundPositionY: altRoll }"></i>
      <b>{{ altFeet.toLocaleString('en-US') }}</b><em>{{ t('FT') }}</em>
    </span>
    <span class="flight-cockpit__label">{{ t('Cockpit view') }}<strong>{{ [feet, course].filter(Boolean).join(' · ') }}</strong></span>
    <span class="flight-cockpit__credit">{{ ESRI_IMAGERY_CREDIT }}</span>
  </div>
</template>
