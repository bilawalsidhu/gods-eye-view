<script setup>
import { storeToRefs } from 'pinia';
import { nextTick, ref, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import UiSlider from '../../kit/UiSlider.js';
import { useSpaceMissionsStore } from '../../stores/spaceMissions.js';
import UiButton from '../../kit/UiButton.vue';
import UiCloseButton from '../../kit/UiCloseButton.vue';

// The selected space mission. The launches layer presents it
// and hides the panel while none is selected; the roster beside it hides
// while it shows. Buttons call the layer's panel commands.
const { mission: m, layer } = storeToRefs(useSpaceMissionsStore());
const root = ref(null);

// Each newly presented selection returns the mission panel to the top.
const SCROLLER = '.space-missions-panel-inner';
watch(
  () => m.value?.scrollRequest,
  async (request) => {
    if (request === undefined) return;
    await nextTick();
    const scroller = root.value?.closest(SCROLLER);
    if (scroller) scroller.scrollTop = 0;
  },
);
</script>

<template>
  <aside id="space-mission-panel" ref="root" class="context-space-mission-detail" :aria-label="t('Selected Space Mission')" :hidden="!m">
    <div class="space-mission-view-header"><span>{{ t('SELECTED SPACE MISSION') }}</span><UiCloseButton data-mission-close bare :title="t('Show all missions')" :label="t('Deselect mission')" @click="layer?.deselectMission()" /></div>
    <div class="space-mission-detail">
      <strong data-mission-title>{{ m ? m.title : t('MISSION') }}</strong>
      <span data-mission-field data-mission-provider :hidden="m && !m.provider">{{ m?.provider }}</span>
      <span data-mission-field :hidden="m && !m.status">{{ t('STATUS · ') }}<b data-mission-status>{{ m?.status }}</b></span>
      <span data-mission-field :hidden="m && !m.site">{{ t('LAUNCH SITE · ') }}<b data-mission-site>{{ m?.site }}</b></span>
      <span data-mission-field :hidden="m && !m.time">{{ t('LAUNCH TIME · ') }}<b data-mission-time>{{ m?.time }}</b></span>
      <span data-mission-field :hidden="m && !m.orbit">{{ t('ORBIT · ') }}<b data-mission-orbit>{{ m?.orbit }}</b></span>
      <span>{{ t('ASCENT PATH · ') }}<b data-mission-ascent-source>{{ m?.ascent }}</b></span>
      <span data-mission-field :hidden="m && !m.distance">{{ t('CURRENT DISTANCE FROM EARTH · ') }}<b data-mission-distance>{{ m?.distance }}</b></span>
      <span data-mission-field :hidden="m && !m.speed">{{ t('SATELLITE SPEED · ') }}<b data-mission-speed :title="m?.speedTitle">{{ m?.speed }}</b></span>
    </div>
    <section class="mission-data-section">
      <h4>{{ t('PAYLOAD') }}</h4>
      <div class="mission-table-scroll ui-scroll">
        <table class="mission-data-table">
          <thead><tr><th>{{ t('NAME') }}</th><th>{{ t('TYPE') }}</th><th>{{ t('DESTINATION') }}</th></tr></thead>
          <tbody data-mission-payloads>
            <template v-if="m"><tr v-if="!m.payloads.length"><td colspan="3" class="mission-table-empty">{{ t('PAYLOAD DATA UNAVAILABLE') }}</td></tr><tr v-for="(payload, index) in m.payloads" :key="index"><td>{{ payload.name }}<small v-if="payload.detail">{{ payload.detail }}</small></td><td>{{ payload.type }}</td><td>{{ payload.destination }}</td></tr><tr v-if="m.payloadsMore"><td colspan="3" class="mission-table-empty">{{ m.payloadsMore }}</td></tr></template>
          </tbody>
        </table>
      </div>
    </section>
    <section class="mission-data-section" data-mission-stages-section :hidden="m && !m.stages.length">
      <h4>{{ t('STAGE / RE-ENTRY / RECOVERY') }}</h4>
      <div class="mission-table-scroll ui-scroll">
        <table class="mission-data-table">
          <thead><tr><th>{{ t('STAGE') }}</th><th>{{ t('STATUS') }}</th><th>{{ t('FINAL POSITION') }}</th></tr></thead>
          <tbody data-mission-stages>
            <template v-if="m"><tr v-if="!m.stages.length"><td colspan="3" class="mission-table-empty">{{ t('NO STAGE RE-ENTRY / RECOVERY DATA') }}</td></tr><tr v-for="(stage, index) in m.stages" :key="index"><td>{{ stage.name }}<small v-if="stage.detail">{{ stage.detail }}</small></td><td>{{ stage.status }}</td><td>{{ stage.destination }}<small>{{ stage.position }}</small></td></tr></template>
          </tbody>
        </table>
      </div>
    </section>
    <div class="mission-replay-speed-control" :hidden="m && !m.replay.available">
      <div class="mission-replay-speed-header"><label for="space-mission-replay-speed">{{ t('REPLAY SPEED') }}</label><output class="gev-slider-value" for="space-mission-replay-speed" data-mission-replay-speed-output>{{ m ? m.replay.speedText : '1×' }}</output></div>
      <UiSlider id="space-mission-replay-speed" hold min="0.25" max="4" step="0.25" data-mission-replay-speed :aria-label="t('Replay speed multiplier')" :model-value="m ? m.replay.speed : 1" :style="m && { '--replay-speed-progress': m.replay.speedProgress }" @update:model-value="layer?.setReplaySpeed($event)" />
      <div class="mission-replay-speed-scale" aria-hidden="true"><span>0.25×</span><span>1×</span><span>4×</span></div>
    </div>
    <div class="mission-action-row">
      <UiButton class="mission-focus-button" data-mission-focus @click="layer?.focusSelectedLaunchSite()">{{ t('FOCUS') }}</UiButton>
      <UiButton class="mission-replay-button" data-mission-replay :pressed="m?.replay.active ?? false" :title="t('Replay the estimated ascent with a following camera')" :hidden="m && (m.replay.active || !m.replay.available)" :disabled="m && !m.replay.available" @click="layer?.startSelectedReplay()">{{ t('REPLAY ASCENT') }}</UiButton>
      <div class="mission-replay-transport" :class="{ 'is-paused': m?.replay.paused }" data-mission-replay-transport :hidden="!m?.replay.active" :aria-label="m?.replay.transportLabel">
        <UiButton data-mission-replay-toggle :title="m ? m.replay.toggleLabel : t('Pause replay')" :aria-label="m ? m.replay.toggleLabel : t('Pause replay')" :disabled="m && !m.replay.active" @click="layer?.toggleReplayPause()">{{ m ? m.replay.toggleText : 'Ⅱ' }}</UiButton>
        <UiCloseButton class="cancel" data-mission-replay-cancel bare :title="t('Cancel replay')" :label="t('Cancel replay')" @click="layer?.cancelReplay()" />
      </div>
    </div>
    <div class="space-mission-nav">
      <UiButton class="mission-nav-button" data-mission-prev :title="t('Previous mission')" :disabled="m?.previousDisabled" @click="layer?.selectPreviousMission()"><span aria-hidden="true">‹</span> {{ t('PREV') }}</UiButton>
      <span class="mission-nav-index" data-mission-index>{{ m ? m.index : '—' }}</span>
      <UiButton class="mission-nav-button" data-mission-next :title="t('Next mission')" :disabled="m?.nextDisabled" @click="layer?.selectNextMission()">{{ t('NEXT') }} <span aria-hidden="true">›</span></UiButton>
    </div>
    <UiButton class="panel-layer-toggle" data-mission-show-all @click="layer?.deselectMission()">{{ t('SHOW ALL / DESELECT') }}</UiButton>
  </aside>
</template>
