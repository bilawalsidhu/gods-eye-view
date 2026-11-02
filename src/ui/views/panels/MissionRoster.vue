<script setup>
import { storeToRefs } from 'pinia';
import { onBeforeUpdate, onUpdated, ref } from 'vue';
import { t } from '../../../i18n/index.js';
import { useContextStore } from '../../stores/context.js';
import UiEmpty from '../../kit/UiEmpty.vue';

// The Space Missions roster. The launches layer presents it; until it does,
// the list shows its loading line. Hover and keyboard focus drive the
// layer's preview, and a click selects the mission.
const { missionRoster: roster, missionsLayer: layer } = storeToRefs(useContextStore());
const root = ref(null);

const CONTINUATION = '[data-mission-roster-focus-continuation]';
const rosterIndex = (el) => {
  const item = el?.closest?.('[data-mission-roster-index]');
  return item && root.value?.contains(item) ? Number(item.dataset.missionRosterIndex) : null;
};

// A changed roster resets the layer's preview. The old list rebuilt its
// rows, so the next pointer movement entered the row under the pointer; a
// row Vue keeps re-enters on its next movement the same way.
let pointerStale = false;
function move(index) {
  if (!pointerStale) return;
  pointerStale = false;
  layer.value?.rosterPointerEnter(index);
}
function enter(index) {
  pointerStale = false;
  layer.value?.rosterPointerEnter(index);
}

function blur(event) {
  layer.value?.rosterBlur(rosterIndex(event.relatedTarget));
}

// A refresh keeps keyboard focus on the same mission by identity: browsers
// drop focus from a node Vue moves or removes, so it is found again by id,
// or continues beyond the list when the mission departed. A changed roster
// resets the layer's preview, so a mission still focused takes it back.
let focusedId = null;
onBeforeUpdate(() => {
  const active = document.activeElement;
  focusedId = root.value?.contains(active) ? active.closest?.('[data-mission-roster-id]')?.dataset.missionRosterId ?? null : null;
});
onUpdated(() => {
  pointerStale = true;
  const id = focusedId;
  focusedId = null;
  const list = root.value;
  if (!id || !list) return;
  const active = document.activeElement;
  if (!list.contains(active)) {
    const retained = [...list.querySelectorAll('[data-mission-roster-id]')].find((item) => item.dataset.missionRosterId === id);
    (retained || list.querySelector(CONTINUATION))?.focus({ preventScroll: true });
  }
  const index = rosterIndex(document.activeElement);
  if (index !== null) layer.value?.rosterFocus(index);
});
</script>

<template>
  <div id="space-mission-roster" ref="root" class="space-mission-roster" :aria-label="t('Available Space Missions')">
    <div class="space-mission-roster-header">
      <div>
        <strong>{{ t('AVAILABLE MISSIONS') }}</strong>
        <span>{{ t('SELECT A MISSION TO INSPECT') }}</span>
      </div>
      <output data-mission-roster-count>{{ roster ? roster.count : '—' }}</output>
    </div>
    <div class="space-mission-roster-list ui-scroll" data-mission-roster-list>
      <UiEmpty v-if="!roster" class="space-mission-roster-empty" :title="t('LOADING 30-DAY MISSION INDEX')" />
      <UiEmpty v-else-if="!roster.entries.length" class="space-mission-roster-empty" :title="roster.empty" />
      <button v-for="entry in roster?.entries" v-else :key="entry.id" type="button" class="space-mission-roster-item" :data-mission-roster-index="entry.index" :data-mission-roster-id="entry.id" :aria-label="entry.ariaLabel" @click="layer?.selectMissionAt(entry.index)" @mouseenter="enter(entry.index)" @mousemove="move(entry.index)" @mouseleave="layer?.rosterPointerLeave()" @focus="layer?.rosterFocus(entry.index)" @blur="blur"><span class="space-mission-roster-marker" :style="{ '--mission-roster-color': entry.color }" aria-hidden="true"></span><span class="space-mission-roster-copy"><strong>{{ entry.label }}</strong><small>{{ entry.provider }} · {{ entry.date }}</small></span><span class="space-mission-roster-chevron" aria-hidden="true">›</span></button>
    </div>
    <p class="space-mission-roster-focus-continuation" tabindex="-1" data-mission-roster-focus-continuation>{{ t('TAB PREVIEWS · ENTER / SPACE SELECTS') }}</p>
  </div>
</template>
