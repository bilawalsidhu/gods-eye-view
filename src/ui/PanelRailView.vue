<script setup>
import UiSelect from './kit/UiSelect.js';
import UiButton from './kit/UiButton.vue';
import {
  UiMenu,
  UiMenuTrigger,
  UiMenuContent,
  UiMenuItem,
} from './kit/UiPrimitives.js';
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../i18n/index.js';
import UiRail from './kit/UiRail.vue';
import {
  PANEL_RAIL_FALLBACK_ICON,
  PANEL_RAIL_ITEMS,
} from './panelRailCatalog.js';
import { usePanelStore } from './stores/panels.js';
import { useHudStore } from './stores/hud.js';
import { useWorldTimeStore } from './stores/worldTime.js';
import MinimalSearch from './MinimalSearch.vue';
import UiIcon from './kit/UiIcon.vue';
import { useVoiceStore } from './stores/voice.js';

const props = defineProps({
  /** `left` or `right`. */
  side: { type: String, required: true },
  /** Open or close a panel; receives the panel id. */
  onSelect: { type: Function, required: true },
});

const panels = usePanelStore();
const hud = useHudStore();
const voice = useVoiceStore();
const minimal = computed(() => hud.hud?.variant === 'minimal');
const clock = useWorldTimeStore();
const { time, timelineOpen } = storeToRefs(clock);
const { toolsOpen } = storeToRefs(panels);
function runVoice(action) {
  toolsOpen.value = false;
  voice.controls?.emit(action);
}
function choosePanel(panelId) {
  toolsOpen.value = false;
  props.onSelect(panelId);
}
const items = computed(() =>
  (minimal.value && props.side === 'left'
    ? [...panels.sides.left, ...panels.sides.right]
    : panels.sides[props.side]
  )
    .filter((panel) => panel.available)
    .map((panel) => {
      const item = PANEL_RAIL_ITEMS[panel.id];
      return {
        id: panel.id,
        icon: item?.icon ?? PANEL_RAIL_FALLBACK_ICON,
        // Static markup is translated at boot, so a host's title already is.
        label: item ? t(item.label) : panel.title,
      };
    }),
);
const active = computed(() =>
  minimal.value && props.side === 'left'
    ? (panels.openPanelId('left') ?? panels.openPanelId('right'))
    : panels.openPanelId(props.side),
);
const label = computed(() =>
  minimal.value
    ? t('Panels')
    : props.side === 'left'
      ? t('Left panels')
      : t('Right panels'),
);
</script>

<template>
  <UiRail
    v-if="!minimal"
    :items="items"
    :active="active"
    :side="side"
    :label="label"
    :panel-open="active !== null"
    collapsible
    @select="onSelect"
  />
  <div
    v-if="minimal && side === 'left'"
    class="minimal-filter-controls"
    :data-timeline-open="timelineOpen"
    :aria-label="t('Panels')"
  >
    <UiButton
      type="button"
      class="minimal-filter-toggle"
      data-rail-item="data-panel"
      :aria-pressed="active === 'data-panel'"
      :aria-expanded="panels.isOpen('data-panel')"
      aria-controls="data-panel"
      @keydown.esc.prevent.stop="
        panels.isOpen('data-panel') && onSelect('data-panel')
      "
      @click="onSelect('data-panel')"
      >{{ t('Layers') }}<UiIcon name="chevron_down" :size="14"
    /></UiButton>
    <UiSelect
      id="minimal-time-select"
      class="console-time-trigger"
      :model-value="time.live ? '0' : 'replay'"
      :aria-label="t('World time')"
      :title="
        time.supported
          ? t('World time')
          : t('Enable a layer with historical data to replay time')
      "
      @update:model-value="clock.selectPreset"
    >
      <option value="0">{{ t('Live') }}</option>
      <option value="1" :disabled="!time.supported">{{
        t('1 hour ago')
      }}</option>
      <option value="24" :disabled="!time.supported">{{
        t('24 hours ago')
      }}</option>
      <option value="timeline" :disabled="!time.supported">{{
        t('Timeline')
      }}</option>
      <option v-if="!time.live" value="replay" disabled>{{
        t('Replay')
      }}</option>
    </UiSelect>
    <UiMenu v-model:open="toolsOpen">
      <UiMenuTrigger as-child
        ><UiButton
          type="button"
          class="minimal-filter-toggle"
          data-minimal-tools-trigger
          >{{ t('Tools') }}<UiIcon name="chevron_down" :size="14" /></UiButton
      ></UiMenuTrigger>
      <UiMenuContent
        id="minimal-tools-menu"
        align="start"
        :side-offset="8"
        :collision-padding="12"
        class="w-52"
        :aria-label="t('Tools')"
      >
        <UiMenuItem
          v-for="item in items.filter((item) => item.id !== 'data-panel')"
          :key="item.id"
          :data-rail-item="item.id"
          :aria-pressed="item.id === active"
          @select="choosePanel(item.id)"
          >{{ item.label }}</UiMenuItem
        >
        <UiMenuItem v-if="voice.controls" @select="runVoice('chat-button')"
          ><UiIcon name="chat" :size="16" />{{ t('Chat') }}</UiMenuItem
        >
        <UiMenuItem v-if="voice.controls" @select="runVoice('button')"
          ><UiIcon name="mic" :size="16" />{{ t('Voice') }}</UiMenuItem
        >
      </UiMenuContent>
    </UiMenu>
    <MinimalSearch :panels="items" :on-panel="choosePanel" />
  </div>
</template>
