<script setup>
import { storeToRefs } from 'pinia';
import { computed, inject, nextTick, ref, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import UiSlider from '../../kit/UiSlider.js';
import { missionSitePin } from '../../placeCard.js';
import { usePinnedStore } from '../../stores/pinned.js';
import { useSpaceMissionsStore } from '../../stores/spaceMissions.js';
import UiButton from '../../kit/UiButton.vue';
import UiCloseButton from '../../kit/UiCloseButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import CloseUpMap from './CloseUpMap.vue';

// Inspect replaces the mission roster with these details. The header close
// button in NearbyMissions.vue returns to the roster. The launches layer
// handles replay and site focus. Pin saves the launch site, and the Data
// Layers row handles stepping between missions.
const { mission: m, layer } = storeToRefs(useSpaceMissionsStore());
const pinned = usePinnedStore();
const root = ref(null);
const mapsAllowed = inject('contextMapsAllowed', ref(true));
const contextViewShown = inject('contextViewShown', true);

const hasSite = computed(() => Number.isFinite(m.value?.lat) && Number.isFinite(m.value?.lon));
const replaying = computed(() => Boolean(m.value?.replay.active));
const hero = computed(() => (replaying.value ? 'replay' : mapsAllowed.value && hasSite.value ? 'map' : 'none'));
// The map's caption names the launch site, as a place card names its place.
const mapCard = computed(() => (m.value?.site ? { layerId: 'place', title: m.value.site } : null));

const tiles = computed(() => {
  const mission = m.value;
  if (!mission) return [];
  return [
    { field: 'time', label: t('Launch time'), value: mission.when || mission.time },
    { field: 'orbit', label: t('Orbit'), value: mission.orbit },
    { field: 'status', label: t('Status'), value: mission.status },
  ].filter((tile) => tile.value);
});

const sitePin = computed(() => missionSitePin(m.value));
const isPinned = computed(() => Boolean(sitePin.value && pinned.isPinned(sitePin.value.key)));
function togglePin() {
  if (sitePin.value) pinned.toggle(sitePin.value);
}


// Each newly presented selection returns Context, which holds the Missions
// list, to the top.
watch(
  () => m.value?.scrollRequest,
  async (request) => {
    if (request === undefined) return;
    await nextTick();
    const scroller = root.value?.closest('body.mobile-shell #right-context-rail') ??
      root.value?.closest('.global-context-panel-inner');
    if (scroller) scroller.scrollTop = 0;
  },
  { immediate: true },
);
</script>

<template>
  <aside id="space-mission-panel" ref="root" class="entity-card context-space-mission-detail" :aria-label="t('Selected Space Mission')" :hidden="!m">
    <div v-if="m && hero !== 'none'" class="entity-hero" :data-hero="hero">
      <div v-if="hero === 'replay'" class="entity-hero__layer is-shown mission-card__replay" data-mission-replay-hero>
        <UiIcon name="rocket_launch" :size="null" />
        <strong>{{ m.replay.transportLabel || t('Ascent replay') }}</strong>
        <span v-if="m.distance || m.speed" class="mission-card__telemetry">{{ [m.distance, m.speed].filter(Boolean).join(' · ') }}</span>
      </div>
      <CloseUpMap v-else :key="`map-${m.id}`" class="entity-hero__layer is-shown" :active="contextViewShown" :lat="m.lat" :lon="m.lon" icon="rocket_launch" :card="mapCard" />
    </div>

    <header class="entity-card__head">
      <div class="entity-card__name">
        <span class="entity-card__kind">{{ t('Space Missions') }}<template v-if="m?.provider"> · <span data-mission-provider>{{ m.provider }}</span></template></span>
        <h3 class="entity-card__title" data-mission-title>{{ m?.title }}</h3>
        <span v-if="m?.status" class="mission-card__status" data-mission-status>{{ m.status }}</span>
      </div>
    </header>

    <div v-if="m" class="entity-card__actions mission-card__actions">
      <div class="entity-card__action-row">
        <UiButton v-if="m?.replay.available && !replaying" class="entity-card__action" data-mission-replay :title="t('Replay the estimated ascent with a following camera')" @click="layer?.startSelectedReplay()">
          <UiIcon name="replay" :size="null" />{{ t('Replay') }}
        </UiButton>
        <div v-if="replaying" class="mission-replay-transport" :class="{ 'is-paused': m.replay.paused }" data-mission-replay-transport role="group" :aria-label="m.replay.transportLabel || t('Ascent replay')">
          <UiButton class="entity-card__action" data-mission-replay-toggle :label="m.replay.toggleLabel" @click="layer?.toggleReplayPause()">{{ m.replay.toggleText }}</UiButton>
          <UiCloseButton class="entity-card__action" data-mission-replay-cancel glyph="icon" bare :title="t('Cancel replay')" :label="t('Cancel replay')" @click="layer?.cancelReplay()" />
        </div>
        <UiButton class="entity-card__action" data-mission-focus @click="layer?.focusSelectedLaunchSite()">
          <UiIcon name="my_location" :size="null" />{{ t('Fly to') }}
        </UiButton>
        <UiButton v-if="sitePin" class="entity-card__action entity-card__action--pin" data-mission-pin :pressed="isPinned" pressed-class="entity-card__action--on" :title="isPinned ? t('Unpin from the Pinned tab') : t('Pin to the Pinned tab')" @click="togglePin">
          <UiIcon name="keep" :size="null" />{{ isPinned ? t('Pinned') : t('Pin') }}
        </UiButton>
      </div>
    </div>

    <div class="mission-replay-speed-control" :hidden="!replaying">
      <div class="mission-replay-speed-header"><label for="space-mission-replay-speed">{{ t('REPLAY SPEED') }}</label><output class="gev-slider-value" for="space-mission-replay-speed" data-mission-replay-speed-output>{{ m ? m.replay.speedText : '1×' }}</output></div>
      <UiSlider id="space-mission-replay-speed" hold min="0.25" max="4" step="0.25" data-mission-replay-speed :aria-label="t('Replay speed multiplier')" :model-value="m ? m.replay.speed : 1" :style="m && { '--replay-speed-progress': m.replay.speedProgress }" @update:model-value="layer?.setReplaySpeed($event)" />
      <div class="mission-replay-speed-scale" aria-hidden="true"><span>0.25×</span><span>1×</span><span>4×</span></div>
    </div>

    <div v-if="tiles.length" class="entity-card__tiles" :style="{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }">
      <div v-for="tile in tiles" :key="tile.field" class="entity-card__tile" :data-mission-tile="tile.field" :title="tile.value">
        <span>{{ tile.label }}</span>
        <strong>{{ tile.value }}</strong>
      </div>
    </div>

    <!-- Open for each mission as it shows (the key makes it new), so its
         payloads and stages are in view; folding it lasts while the same
         mission stays. -->
    <details v-if="m" :key="`more:${m.id}`" class="entity-card__section entity-card__more" data-mission-more open>
      <summary class="entity-card__more-title">{{ t('More details') }}</summary>
      <dl class="entity-card__facts">
        <div v-if="m.site" class="entity-card__fact">
          <dt>{{ t('Launch site') }}</dt>
          <dd data-mission-site :title="m.site">{{ m.site }}</dd>
        </div>
        <div v-if="m.ascent" class="entity-card__fact">
          <dt>{{ t('Ascent path') }}</dt>
          <dd data-mission-ascent-source>{{ m.ascent }}</dd>
        </div>
        <div v-if="m.distance" class="entity-card__fact">
          <dt>{{ t('Altitude') }}</dt>
          <dd data-mission-distance>{{ m.distance }}</dd>
        </div>
        <div v-if="m.speed" class="entity-card__fact">
          <dt>{{ t('Speed') }}</dt>
          <dd data-mission-speed :title="m.speedTitle">{{ m.speed }}</dd>
        </div>
      </dl>
      <section class="mission-data-section">
        <h4>{{ t('PAYLOAD') }}</h4>
        <div class="mission-table-scroll ui-scroll">
          <table class="mission-data-table">
            <thead><tr><th>{{ t('NAME') }}</th><th>{{ t('TYPE') }}</th><th>{{ t('DESTINATION') }}</th></tr></thead>
            <tbody data-mission-payloads><tr v-if="!m.payloads.length"><td colspan="3" class="mission-table-empty">{{ t('PAYLOAD DATA UNAVAILABLE') }}</td></tr><tr v-for="(payload, index) in m.payloads" :key="index"><td>{{ payload.name }}<small v-if="payload.detail">{{ payload.detail }}</small></td><td>{{ payload.type }}</td><td>{{ payload.destination }}</td></tr><tr v-if="m.payloadsMore"><td colspan="3" class="mission-table-empty">{{ m.payloadsMore }}</td></tr></tbody>
          </table>
        </div>
      </section>
      <section v-if="m.stages.length" class="mission-data-section" data-mission-stages-section>
        <h4>{{ t('STAGE / RE-ENTRY / RECOVERY') }}</h4>
        <div class="mission-table-scroll ui-scroll">
          <table class="mission-data-table">
            <thead><tr><th>{{ t('STAGE') }}</th><th>{{ t('STATUS') }}</th><th>{{ t('FINAL POSITION') }}</th></tr></thead>
            <tbody data-mission-stages><tr v-for="(stage, index) in m.stages" :key="index"><td>{{ stage.name }}<small v-if="stage.detail">{{ stage.detail }}</small></td><td>{{ stage.status }}</td><td>{{ stage.destination }}<small>{{ stage.position }}</small></td></tr></tbody>
          </table>
        </div>
      </section>
    </details>
  </aside>
</template>
