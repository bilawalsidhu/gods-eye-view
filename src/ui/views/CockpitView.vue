<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../i18n/index.js';
import {
  createInstrumentState,
  createRouteState,
  createVisionState,
} from '../cockpitInstrumentState.js';
import { vClassToggle } from '../rail/classToggle.js';
import { useCockpitStore } from '../stores/cockpit.js';
import { useGlobeActionsStore } from '../stores/globeActions.js';
import CockpitBriefing from './panels/CockpitBriefing.vue';
import CockpitContext from './panels/CockpitContext.vue';
import CockpitOrbital from './panels/CockpitOrbital.vue';
import CockpitProgress from './panels/CockpitProgress.vue';
import CockpitRadar from './panels/CockpitRadar.vue';
import CockpitRollingValue from './panels/CockpitRollingValue.vue';
import CockpitUtilityControls from './panels/CockpitUtilityControls.vue';

// The Cockpit HUD. The Cockpit controller presents the instruments, the
// destination arrow and the vision selector on every HUD update; until it
// does, they show the state they start in. The controller also publishes
// which surfaces are shown and the utility strip's measured layout; the
// layout pass stays with it, and the controls keep its listeners.
const { presence, instruments, route, vision, utilityLayout } =
  storeToRefs(useCockpitStore());
const active = computed(() => Boolean(presence.value?.active));
// A vessel subject swaps the aviation readouts for bridge ones.
const bridge = computed(() => presence.value?.subjectKind === 'vessel');
// A satellite subject keeps only its orbital HUD over the nadir picture.
const orbital = computed(() => presence.value?.subjectKind === 'satellite');
// An application provider's subject (src/cockpitSubjectProviders.js): a
// window view whose readouts, labels and texts the provider words.
const generic = computed(() => presence.value?.subjectGeneric === true);
const labels = computed(() => presence.value?.subjectLabels ?? null);
const subject = computed(() =>
  generic.value
    ? presence.value.subjectKind
    : bridge.value
      ? 'vessel'
      : orbital.value
        ? 'satellite'
        : 'aircraft',
);
const hudLabel = computed(() =>
  generic.value
    ? labels.value?.view
    : bridge.value
      ? t('Ship bridge view')
      : orbital.value
        ? t('Satellite orbital view')
        : t('Aircraft cockpit view'),
);
const exitLabel = computed(() =>
  generic.value
    ? labels.value?.exit
    : bridge.value
      ? t('Exit bridge view')
      : orbital.value
        ? t('Exit orbital view')
        : t('Exit cockpit view'),
);
const exitText = computed(() =>
  generic.value
    ? labels.value?.exitText
    : bridge.value
      ? t('EXIT BRIDGE')
      : orbital.value
        ? t('EXIT ORBIT')
        : t('EXIT COCKPIT'),
);
// Look-around: on a bridge, or in a provider's view that has it.
const looks = computed(
  () => bridge.value || (generic.value && Boolean(presence.value?.subjectLook)),
);
const aheadLabel = computed(() =>
  generic.value
    ? presence.value?.subjectLook?.aheadLabel
    : t('Look ahead: turn the bridge view back to the bow'),
);
const veilStyle = computed(() => ({
  opacity: String(hud.value.veil?.level ?? 0),
}));
const globe = useGlobeActionsStore();
const { resetBusy } = storeToRefs(globe);
const initialInstruments = createInstrumentState();
const initialRoute = createRouteState();
const initialVision = createVisionState();
const hud = computed(() => instruments.value ?? initialInstruments);
// The bridge tape scrolls continuously: its minor ticks shift with the
// division nearest the caret.
const tapeShift = computed(
  () => hud.value.compass?.find((division) => division.active)?.slot ?? 0,
);
const direction = computed(() => (route.value ?? initialRoute).direction);
// Where a bridge view is turned; an aircraft's always rests.
const look = computed(() => hud.value.look ?? initialInstruments.look);
const v = computed(() => vision.value ?? initialVision);
const visionLabel = computed(() =>
  t('Current cockpit vision style: {style}. Activate for next style.', {
    style: v.value.name,
  }),
);
const visionTitle = computed(() =>
  t('Current style: {style} — click for next', { style: v.value.name }),
);
// The utility strip's measured anchor and height limits; a null value leaves
// the stylesheet's fallback.
const utilityStyle = computed(() => ({
  '--cockpit-utility-top': utilityLayout.value?.top ?? null,
  '--cockpit-utility-max-height': utilityLayout.value?.maxHeight ?? null,
  '--cockpit-utility-expanded-max-height':
    utilityLayout.value?.expandedMaxHeight ?? null,
}));
const tickStyle = (tick) =>
  tick.slot === null
    ? undefined
    : { '--slot': tick.slot, '--depth': tick.depth, '--curve': tick.curve };
</script>

<template>
  <!-- Aircraft first-person view, a vessel's bridge or a satellite's nadir view. It can be entered from the visible view switcher. -->
  <section id="cockpit-hud" :aria-label="hudLabel" :hidden="!active" :data-subject="subject" :data-generic="generic ? '' : undefined" :data-progress="generic && hud.progress ? '' : undefined" :style="utilityStyle" v-class-toggle="{ 'signals-active': active, 'context-active': Boolean(presence?.context) }" :data-layer="orbital ? 'satellites' : hud.layer ?? undefined">
    <!-- A provider's view may darken the picture (a veil), the HUD above it. -->
    <div v-if="generic && hud.veil" class="cockpit-veil" :class="{ streaks: hud.veil.streaks }" :style="veilStyle" aria-hidden="true"></div>
    <!-- In orbit the picture keeps only the nadir reticle, readout and zoom. -->
    <CockpitOrbital v-if="orbital" />
    <!-- One optical coordinate system: every targeting mark shares this center.
         Decorative only; telemetry and interactive panels remain separate.
         A bridge looks out through straight window mullions instead: a header
         beam, two pane posts and the sill either side of the console. -->
    <svg v-if="bridge" class="cockpit-frame-lines cockpit-bridge-frame" viewBox="0 0 1200 720" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor">
        <path d="M0 96H1200 M0 101H1200"/>
        <path d="M324 101V600 M876 101V600"/>
        <path d="M0 600H324 M876 600H1200"/>
      </g>
    </svg>
    <svg v-else-if="!orbital && !generic" class="cockpit-frame-lines" viewBox="0 0 1200 720" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor">
        <path d="M42 106H234L266 126H334 M866 126H934L966 106H1158 M42 114H226L258 136H318 M882 136H942L974 114H1158"/>
        <path d="M42 616H226L254 598H320 M880 598H946L974 616H1158 M42 624H238L266 606H330 M870 606H934L962 624H1158"/>
        <path d="M322 650H878L858 622H728L708 634H492L472 622H342Z M348 659H852"/>
        <path d="M72 160H144L158 174V186 M1056 160H1128L1142 174V186 M72 562H144L158 548V536 M1056 562H1128L1142 548V536"/>
      </g>
      <path class="cockpit-frame-warning" d="M338 645H476L490 654H710L724 645H862" fill="none"/>
      <path class="cockpit-frame-meter" d="M372 642H418 M782 642H828"/>
    </svg>
    <div v-if="!bridge && !orbital && !generic" class="cockpit-scan-array" aria-hidden="true">
      <svg class="cockpit-target-geometry" viewBox="0 0 600 600" fill="none" focusable="false">
        <g class="cockpit-target-hairline">
          <circle cx="300" cy="300" r="276"/>
          <circle class="cockpit-target-drift" cx="300" cy="300" r="250" stroke-dasharray="1 13"/>
          <circle cx="300" cy="300" r="164"/>
          <path d="M190 237V363 M410 237V363 M99 227H139 M461 227H501 M99 373H139 M461 373H501"/>
          <path d="M86 113H118L134 129 M514 113H482L466 129 M86 487H118L134 471 M514 487H482L466 471"/>
        </g>
        <g class="cockpit-target-side-arcs">
          <path d="M70 167A266 266 0 0 0 70 433 M530 167A266 266 0 0 1 530 433"/>
        </g>
        <g class="cockpit-target-ticks">
          <path d="M166 125A220 220 0 0 1 434 125 M166 475A220 220 0 0 0 434 475"/>
        </g>
        <g class="cockpit-target-dots">
          <path d="M180 130A208 208 0 0 1 420 130 M180 470A208 208 0 0 0 420 470"/>
        </g>
        <g class="cockpit-target-warning-dots">
          <path d="M172 112A227 227 0 0 1 428 112 M172 488A227 227 0 0 0 428 488"/>
        </g>
        <g class="cockpit-target-core">
          <!-- One outer ring and a spaced rotor leave the aiming center open. -->
          <circle class="cockpit-target-orbit" cx="300" cy="300" r="132" stroke-dasharray="186 21"/>
          <circle class="cockpit-target-rotor" cx="300" cy="300" r="104" stroke-dasharray="128 35" transform="rotate(9 300 300)"/>
          <path class="cockpit-target-spokes" d="M206 206L250 250 M350 350L394 394 M394 206L350 250 M250 350L206 394"/>
          <path d="M168 291H180V309H168 M432 291H420V309H432"/>
          <circle cx="206" cy="206" r="3"/><circle cx="394" cy="206" r="3"/>
          <circle cx="206" cy="394" r="3"/><circle cx="394" cy="394" r="3"/>
        </g>
      </svg>
    </div>
    <div v-if="!orbital" class="cockpit-visor-shell" aria-hidden="true">
      <!-- A ship's bridge keeps no roll arc or pitch ladder. -->
      <div v-if="!bridge && !generic" class="cockpit-roll-arc">
        <span style="--slot:-3;--depth:3">−30</span>
        <span style="--slot:-2;--depth:2">−20</span>
        <span style="--slot:-1;--depth:1">−10</span>
        <span class="active" style="--slot:0;--depth:0">0</span>
        <span style="--slot:1;--depth:1">+10</span>
        <span style="--slot:2;--depth:2">+20</span>
        <span style="--slot:3;--depth:3">+30</span>
      </div>
      <div v-if="!bridge && !generic" class="cockpit-pitch-rail cockpit-pitch-rail-left">
        <span>+20</span><span>+10</span><span class="active">00</span><span>−10</span><span>−20</span>
      </div>
      <div v-if="!bridge && !generic" class="cockpit-pitch-rail cockpit-pitch-rail-right">
        <span>+20</span><span>+10</span><span class="active">00</span><span>−10</span><span>−20</span>
      </div>
      <div class="cockpit-horizon-guide">
        <span></span><small>{{ t('LEVEL') }}</small><span></span>
      </div>
      <div id="cockpit-route-direction" class="cockpit-route-direction" :hidden="!direction.visible" :aria-label="t('Estimated destination direction')" :style="direction.angle === null ? undefined : { '--route-angle': direction.angle }">
        <svg class="cockpit-route-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 2 4.58 19.93c-.34.83.51 1.63 1.31 1.27L12 18.47l6.11 2.73c.8.36 1.65-.44 1.31-1.27L12 2Z" />
        </svg>
        <small id="cockpit-route-direction-label">{{ direction.label }}</small>
      </div>
      <div v-if="!generic" class="cockpit-visor-status cockpit-visor-status-left">{{ bridge ? t('BRIDGE WINDOW · FWD') : t('OPTICAL PLANE · 01') }}</div>
      <div v-if="!generic" class="cockpit-visor-status cockpit-visor-status-right">{{ bridge ? (hud.trackSource === 'course' ? t('COURSE HOLD · AIS') : hud.trackSource === 'heading' ? t('HEADING HOLD · AIS') : t('NO HEADING · AIS')) : t('VISOR LOCK · ACTIVE') }}</div>
    </div>
    <div v-if="!orbital && !generic" id="cockpit-speed-rim" class="cockpit-altitude-rim cockpit-speed-rim" v-class-toggle="{ unavailable: hud.speedRim.unavailable }">
      <span class="cockpit-altitude-rim-label">{{ bridge ? t('SPEED OVER GROUND · KTS') : t('GROUND SPEED · KTS') }}</span>
      <div class="cockpit-altitude-rim-rail"></div>
      <div class="cockpit-altitude-rim-scale">
        <span v-for="(tick, index) in hud.speedRim.ticks" :key="index" data-speed-rim-tick :hidden="tick.hidden" :class="{ major: tick.major }" :style="tickStyle(tick)"><b>{{ tick.label }}</b><i></i></span>
      </div>
      <div class="cockpit-altitude-rim-pointer">
        <span class="material-symbols-outlined">arrow_right</span>
        <strong id="cockpit-speed-rim-value">{{ hud.speedRim.value }}</strong>
      </div>
    </div>
    <div v-if="!orbital && !generic" id="cockpit-altitude-rim" class="cockpit-altitude-rim" :hidden="bridge" v-class-toggle="{ unavailable: hud.altitudeRim.unavailable }">
      <span class="cockpit-altitude-rim-label">{{ t('ALTITUDE · FT') }}</span>
      <div class="cockpit-altitude-rim-rail"></div>
      <div class="cockpit-altitude-rim-scale">
        <span v-for="(tick, index) in hud.altitudeRim.ticks" :key="index" data-altitude-rim-tick :hidden="tick.hidden" :class="{ major: tick.major }" :style="tickStyle(tick)"><b>{{ tick.label }}</b><i></i></span>
      </div>
      <div class="cockpit-altitude-rim-pointer">
        <strong id="cockpit-altitude-rim-value">{{ hud.altitudeRim.value }}</strong>
        <span class="material-symbols-outlined">arrow_left</span>
      </div>
    </div>
    <div class="cockpit-topline">
      <div>
        <span class="cockpit-kicker">{{ generic ? hud.kicker : bridge ? t('BRIDGE VIEW') : t('FIRST PERSON') }}</span>
        <strong id="cockpit-callsign">{{ hud.callsign }}</strong>
        <span id="cockpit-aircraft-meta" v-class-toggle="{ emergency: hud.meta.emergency }" class="cockpit-aircraft-meta" :data-tone="generic ? hud.meta.tone : undefined">{{ hud.meta.text }}</span>
      </div>
      <div class="cockpit-vision-controls" role="group" :aria-label="t('Cockpit vision style')">
        <button id="cockpit-vision-previous" class="cockpit-vision-nav" type="button" :aria-label="t('Previous cockpit vision style')" :title="t('Previous vision style')">
          <span class="material-symbols-outlined" aria-hidden="true">chevron_left</span>
          <small>{{ t('PREV') }}</small>
        </button>
        <button id="cockpit-vision-current" class="cockpit-vision-current" type="button" :data-cockpit-vision="v.mode" :aria-label="visionLabel" :title="visionTitle">
          <small>{{ t('CURRENT') }}</small>
          <strong id="cockpit-vision-current-label" aria-live="polite">{{ v.label }}</strong>
        </button>
        <button id="cockpit-vision-next" class="cockpit-vision-nav" type="button" :aria-label="t('Next cockpit vision style')" :title="t('Next vision style')">
          <small>{{ t('NEXT') }}</small>
          <span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>
        </button>
      </div>
    </div>
    <div v-if="!orbital && !generic" class="cockpit-reticle material-symbols-outlined" aria-hidden="true">my_location</div>
    <!-- A provider's banner: a status that names where the subject is. -->
    <div v-if="generic && hud.banner" class="cockpit-banner" role="status" :data-tone="hud.banner.tone">
      <strong>{{ hud.banner.title }}</strong>
      <small v-if="hud.banner.detail">{{ hud.banner.detail }}</small>
    </div>
    <!-- A view turned off its rest says where it looks and offers the way back. -->
    <div v-if="looks" class="cockpit-look" :hidden="!look.offset">
      <span id="cockpit-look-readout" class="cockpit-look-readout" aria-live="polite">{{ look.readout }}</span>
      <button id="cockpit-look-ahead" type="button" class="cockpit-look-ahead" :aria-label="aheadLabel" :title="t('Look ahead (Home or 0)')" aria-keyshortcuts="Home 0">
        <span>{{ t('LOOK AHEAD') }}</span>
      </button>
    </div>
    <div v-if="!orbital" class="cockpit-compass" :aria-label="generic ? hudLabel : bridge ? t('Current vessel heading') : t('Current aircraft heading')">
      <div class="cockpit-instrument-row">
        <!-- A provider's HUD view without a speed has no speed readout. -->
        <div v-if="!generic || hud.speed" class="cockpit-readout cockpit-speed">
          <span v-if="!generic" class="cockpit-readout-label">{{ bridge ? t('SPEED OVER GROUND') : t('GROUND SPEED') }}</span>
          <span v-else-if="hud.speedTag" class="cockpit-readout-label cockpit-speed-tag" :data-tone="hud.speedTone">{{ hud.speedTag }}</span>
          <CockpitRollingValue id="cockpit-speed-value" tag="strong" :reading="hud.speed" placeholder="---" />
          <span class="cockpit-readout-unit">{{ generic ? hud.speedUnit : t('KTS') }}</span>
        </div>
        <div class="cockpit-heading-value"><CockpitRollingValue id="cockpit-heading-value" :reading="hud.heading" placeholder="---" :circular-range="360" /><small>°</small></div>
        <div v-if="bridge" class="cockpit-readout cockpit-altitude cockpit-course">
          <span class="cockpit-readout-label">{{ t('COURSE OVER GROUND') }}</span>
          <CockpitRollingValue id="cockpit-course-value" tag="strong" :reading="hud.course" placeholder="---" :circular-range="360" />
          <span class="cockpit-readout-unit">°</span>
        </div>
        <div v-else-if="!generic" class="cockpit-readout cockpit-altitude">
          <span class="cockpit-readout-label">{{ t('ALTITUDE') }}</span>
          <CockpitRollingValue id="cockpit-altitude-value" tag="strong" :reading="hud.altitude" placeholder="-----" />
          <span class="cockpit-readout-unit">{{ t('FT') }}</span>
        </div>
      </div>
      <span class="cockpit-heading-caret material-symbols-outlined" aria-hidden="true">arrow_drop_down</span>
      <div class="cockpit-compass-tape" id="cockpit-compass-tape" aria-hidden="true" :style="bridge ? { '--tape-shift': tapeShift } : undefined"><span v-for="division in hud.compass" :key="division.heading ?? division.slot" :class="(division.active ?? division.slot === 0) ? 'active' : ''" :style="{ '--slot': division.slot, '--depth': Math.abs(division.slot) }">{{ division.label }}</span><template v-if="bridge"><i v-if="hud.compassMarkers?.prograde != null" class="cockpit-compass-marker cockpit-compass-prograde" aria-hidden="true" :style="{ '--slot': hud.compassMarkers.prograde }"></i><i v-if="hud.compassMarkers?.retrograde != null" class="cockpit-compass-marker cockpit-compass-retrograde" aria-hidden="true" :style="{ '--slot': hud.compassMarkers.retrograde }"></i></template></div>
    </div>
    <div v-if="!orbital" class="cockpit-position-readout">
      <span id="cockpit-clock">{{ hud.clock }}</span>
      <span id="cockpit-position">{{ hud.position }}</span>
    </div>
    <!-- A provider's board: its readout cards, then the sources of what they show. -->
    <div v-if="generic && (hud.readouts.length || hud.sources.length)" class="cockpit-board">
      <div v-for="row in hud.readouts" :key="row.id" class="cockpit-board-card" :data-readout="row.id" :data-tone="row.tone">
        <small v-if="row.label">{{ row.label }}</small>
        <strong v-if="row.value">{{ row.value }}</strong>
        <span v-if="row.detail">{{ row.detail }}</span>
      </div>
      <dl v-if="hud.sources.length" class="cockpit-sources">
        <div v-for="row in hud.sources" :key="row.id" :data-source="row.id" :data-tone="row.tone">
          <dt v-if="row.label">{{ row.label }}</dt>
          <dd>{{ row.text }}</dd>
        </div>
      </dl>
    </div>
    <CockpitProgress v-if="generic && hud.progress" :progress="hud.progress" />
    <CockpitContext />
    <CockpitBriefing />
    <!-- The bridge radar's console: bottom right, below the briefing card. -->
    <div v-if="bridge" class="cockpit-radar-console">
      <CockpitRadar />
    </div>
    <CockpitUtilityControls />
    <div class="cockpit-help"><bdi>{{ t('ESC EXIT') }}</bdi><template v-if="looks"> <span>·</span> <bdi>{{ t('ARROWS LOOK') }}</bdi> <span>·</span> <bdi>{{ t('HOME RESET') }}</bdi></template><template v-if="orbital"> <span>·</span> <bdi>{{ t('+/− ZOOM') }}</bdi> <span>·</span> <bdi>{{ t('ARROWS TILT') }}</bdi> <span>·</span> <bdi>{{ t('HOME NADIR') }}</bdi></template></div>
  </section>

  <nav id="view-switcher" :aria-label="t('View switcher')">
    <button id="cockpit-reset-globe" type="button" :aria-label="resetBusy ? t('Resetting cockpit to full globe view') : t('Reset cockpit to full globe view')" :title="t('Exit cockpit and return to full globe view')" :hidden="!active" @click="globe.act('reset')">
      <span class="material-symbols-outlined" aria-hidden="true">public</span>
      <span>{{ t('RESET') }}</span>
    </button>
    <button id="map-view-switch" type="button" :aria-label="exitLabel" aria-keyshortcuts="Escape" :title="exitLabel" :hidden="!active">
      <span class="material-symbols-outlined" aria-hidden="true">close_fullscreen</span>
      <span>{{ exitText }}</span>
    </button>
  </nav>
</template>
