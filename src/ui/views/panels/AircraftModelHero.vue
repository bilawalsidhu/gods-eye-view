<script setup>
import { destroyPreviewWidget } from '../../previewWidget.js';
import * as Cesium from 'cesium';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CLASS_MODEL_REAL, CLASS_MODEL_URL } from '../../../data/aircraftClass.js';
import PreviewHud from './PreviewHud.vue';
import { t } from '../../../i18n/index.js';

// The selected aircraft's own model, turning slowly at the top of its card:
// the same per-class mesh the globe draws (a Cessna for light aircraft, a
// 787 for widebodies, the shared airliner otherwise). It renders in a small
// Cesium scene of its own with no globe, sky or imagery, and is torn down
// with the card. A satellite's card uses it too, with a NASA model in place
// of the aircraft class's (`modelUrl`).
//
// Its look changes as it turns: a whole rotation as it is, then a short
// wireframe scan (under a third of a turn, about six seconds), then round
// again. The change each way is a reveal: a bright ring grows from the
// craft's centre out to its edges, turning it to white wire inside it on the
// way in and back to the model on the way out. In wire the body goes near-black with its own
// colours faintly showing (solar panels stay blue).
// One custom shader does it all, driven by a uniform, because a shader set on
// a model after it is ready does nothing in this Cesium.
//
// While it turns, one callout at a time sits in the frame's top-left corner,
// HUD-style, telling something worked out about the flight (phase, flight
// level, Mach, what its squawk means, signal age). Each runs three states:
//   enter 0-2.3 s  the label and value slide in;
//   hold  2.3-5.2 s a thin timer under the value fills;
//   exit  5.2-6.2 s the text fades; a short gap, then the next one.
const props = defineProps({
  /** Aircraft class from the record (light, airliner, widebody...). */
  aircraftClass: { type: String, default: '' },
  /** A model to show instead of the class's own (a satellite's, say). */
  modelUrl: { type: String, default: '' },
  /** Degrees to turn that model about its east axis to lie level. */
  modelTilt: { type: Number, default: 0 },
  /** How far the camera stands, in bounding radii. */
  viewRange: { type: Number, default: 1.9 },
  /** The aircraft's heading, so the turntable starts facing its way. */
  heading: { type: Number, default: 0 },
  /** `[{label, value}]` figures to call out, in order. */
  callouts: { type: Array, default: () => [] },
  /** Whether the tile is the one showing; a hidden one stops drawing. */
  active: { type: Boolean, default: true },
});
const emit = defineEmits(['failed', 'cycle']);

const host = ref(null);
const failed = ref(false);
watch(failed, (now) => now && emit('failed'));
// A hidden tile keeps drawing until its model has loaded, then rests on its
// last frame; shown again, it draws once straight away so there is no gap.
let ready = false;
function syncLoop() {
  if (!widget || widget.isDestroyed()) return;
  const run = props.active || !ready;
  if (run && !widget.useDefaultRenderLoop) {
    widget.resize();
    widget.render();
  }
  widget.useDefaultRenderLoop = run;
}
watch(() => props.active, syncLoop);
let widget = null;
let model = null;
let removeTick = null;

/** How long each look lasts, and each reveal between them, in turns. */
const PLAIN_TURNS = 1;
const SCAN_TURNS = 0.3;
const REVEAL_TURNS = 0.07;
/** How long (ms) the plain model holds after the reveal before a cycle ends. */
const HOLD_MS = 700;
const phase = ref('plain');

// Model space, normalised so the craft reaches about 1.7 from its centre.
// u_reveal runs 0 to 2: from 0 to 1 the edge grows from the centre and
// leaves wire inside it; at 1 it is all wire; from 1 to 2 it grows again and
// leaves the model inside it. Outside that range the model draws as it is.
const LOOK_SHADER = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  if (u_reveal <= 0.0 || u_reveal >= 2.0) return;
  vec3 p = fsInput.attributes.positionMC / u_half;
  bool entering = u_reveal < 1.0;
  float r = length(p);
  float front = mix(0.0, 1.8, entering ? u_reveal : u_reveal - 1.0);
  float edge = 1.0 - smoothstep(0.0, 0.05, abs(r - front));
  vec3 white = vec3(0.9, 0.96, 1.0);
  bool wire = entering ? r < front : r > front;
  if (!wire) {
    material.emissive += white * edge * 1.4;
    return;
  }
  // A fine grid: many small cells, hairline lines.
  vec3 q = p * 18.0;
  vec3 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec3(1e-4));
  float line = (1.0 - clamp(min(min(g.x, g.y), g.z) * 2.4, 0.0, 1.0)) * 0.7;
  vec3 base = material.diffuse;
  // Opaque: a near-black body with white lines on it and its own colour
  // faintly through, which reads as a wireframe against the dark card (a
  // translucent model does not blend onto this scene's transparent canvas).
  material.diffuse = base * 0.12 + vec3(0.015, 0.02, 0.03);
  material.specular = vec3(0.0);
  material.emissive = white * line + base * 0.35 + white * edge * 1.4;
}`;
let lookShader = null;

const classModelUrl = (cls) => CLASS_MODEL_REAL[cls]?.url || CLASS_MODEL_URL[cls] || '/models/airplane.glb';

// One callout's whole life: enter 2.3 s + hold 2.9 s + exit 1.0 s + 0.3 s gap.
const CYCLE_MS = 6500;
const CALLOUT_TIMING = { enter: 2300, leave: 1000 };
const page = ref(0);
let cycle = null;
const shown = computed(() => {
  const list = props.callouts;
  if (!list.length) return null;
  const index = page.value % list.length;
  return { ...list[index], index, total: list.length };
});
const pad = (n) => String(n).padStart(2, '0');

async function show(cls) {
  if (!widget) return;
  ready = false;
  syncLoop();
  const scene = widget.scene;
  if (model) {
    scene.primitives.remove(model);
    model = null;
  }
  const origin = Cesium.Cartesian3.fromDegrees(0, 0, 0);
  lookShader = new Cesium.CustomShader({
    uniforms: {
      u_reveal: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_half: { type: Cesium.UniformType.FLOAT, value: 20 },
    },
    fragmentShaderText: LOOK_SHADER,
  });
  try {
    model = await Cesium.Model.fromGltfAsync({
      url: props.modelUrl || classModelUrl(cls),
      customShader: lookShader,
      modelMatrix: Cesium.Matrix4.multiplyByMatrix3(
        Cesium.Transforms.eastNorthUpToFixedFrame(origin),
        Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(props.modelTilt)),
        new Cesium.Matrix4(),
      ),
      // A light rim so the mesh reads against the dark card.
      silhouetteColor: Cesium.Color.WHITE.withAlpha(0.3),
      silhouetteSize: 1,
    });
  } catch {
    failed.value = true;
    return;
  }
  if (!widget) return;
  scene.primitives.add(model);
  model.readyEvent.addEventListener(() => {
    if (!widget) return;
    const sphere = model.boundingSphere;
    // The craft reaches about 0.6 of its bounding radius from the centre.
    lookShader.setUniform('u_half', sphere.radius * 0.6);
    const start = Cesium.Math.toRadians(props.heading + 140);
    let heading = start;
    const began = performance.now();
    let cycleMs = 0;
    let lastFrame = began;
    let holdMs = null;
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const range = sphere.radius * props.viewRange;
    const frame = () => {
      heading += 0.005;
      const turns = (heading - start) / (2 * Math.PI);
      // Where in the scan it is, and from that how far each reveal has gone.
      const into = (turns % (PLAIN_TURNS + SCAN_TURNS)) - PLAIN_TURNS;
      const ease = (x) => x * x * (3 - 2 * x);
      let reveal = 0;
      if (!still && into >= 0) {
        if (into < REVEAL_TURNS) reveal = ease(into / REVEAL_TURNS);
        else if (into > SCAN_TURNS - REVEAL_TURNS) reveal = 1 + ease((into - (SCAN_TURNS - REVEAL_TURNS)) / REVEAL_TURNS);
        else reveal = 1;
      }
      const next = reveal > 0 && reveal < 2 ? 'scan' : 'plain';
      // One look and its scan make a cycle; say when one ends, and how long
      // it took, so a card can give something else the same time.
      // Only time spent drawing counts: a hidden preview stops drawing.
      const now = performance.now();
      const drawn = now - lastFrame < 250 ? now - lastFrame : 0;
      cycleMs += drawn;
      lastFrame = now;
      // The cycle ends once the reveal back to the model has finished and the
      // plain model has held a moment, never mid-reveal.
      if (phase.value === 'scan' && next === 'plain') holdMs = 0;
      if (holdMs !== null && next === 'plain') {
        holdMs += drawn;
        if (holdMs >= HOLD_MS) {
          emit('cycle', cycleMs);
          cycleMs = 0;
          holdMs = null;
        }
      }
      if (next !== phase.value) phase.value = next;
      lookShader.setUniform('u_reveal', reveal);
      widget.camera.lookAt(sphere.center, new Cesium.HeadingPitchRange(heading, Cesium.Math.toRadians(-18), range));
    };
    frame();
    removeTick?.();
    removeTick = scene.preRender.addEventListener(frame);
    widget.render();
    ready = true;
    syncLoop();
  });
}

onMounted(() => {
  try {
    widget = new Cesium.CesiumWidget(host.value, {
      globe: false,
      skyBox: false,
      skyAtmosphere: false,
      baseLayer: false,
      scene3DOnly: true,
      shadows: false,
      showRenderLoopErrors: false,
      contextOptions: { webgl: { alpha: true, antialias: true } },
      // The globe's own credits already show; this scene has none to add.
      creditContainer: document.createElement('div'),
    });
    const scene = widget.scene;
    scene.backgroundColor = Cesium.Color.TRANSPARENT;
    scene.light = new Cesium.DirectionalLight({
      direction: Cesium.Cartesian3.normalize(new Cesium.Cartesian3(-0.4, -0.6, -0.7), new Cesium.Cartesian3()),
      intensity: 2.4,
    });
    scene.screenSpaceCameraController.enableInputs = false;
    void show(props.aircraftClass);
    // Under reduced motion the first set of callouts stays.
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (!still) cycle = setInterval(() => page.value++, CYCLE_MS);
  } catch {
    failed.value = true;
  }
});

watch(
  () => [props.aircraftClass, props.modelUrl],
  () => void show(props.aircraftClass),
);

onBeforeUnmount(() => {
  clearInterval(cycle);
  removeTick?.();
  removeTick = null;
  destroyPreviewWidget(widget);
  widget = null;
  model = null;
});
</script>

<template>
  <div v-if="!failed" class="aircraft-hero">
    <div ref="host" class="aircraft-hero__scene" aria-hidden="true"></div>
    <PreviewHud variant="model" />
    <Transition name="aircraft-hero-legend">
      <p v-if="phase === 'scan'" class="aircraft-hero__scan" aria-hidden="true">{{ t('Scanning') }}</p>
    </Transition>
    <Transition name="aircraft-hero-callout" mode="out-in" :duration="CALLOUT_TIMING">
      <div v-if="shown" :key="page" class="aircraft-hero__callout" role="status">
        <span class="aircraft-hero__label">{{ shown.label }}<em>{{ pad(shown.index + 1) }} / {{ pad(shown.total) }}</em></span>
        <strong class="aircraft-hero__value">{{ shown.value }}</strong>
        <i class="aircraft-hero__timer" aria-hidden="true"></i>
      </div>
    </Transition>
  </div>
</template>
