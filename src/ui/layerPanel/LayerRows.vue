<script setup>
import RailChips from '../rail/RailChips.vue';
import RailRowList from '../rail/RailRowList.vue';
import RowRange from './RowRange.vue';
import RowSlider from './RowSlider.vue';
import RowSwitch from './RowSwitch.vue';
import RowText from './RowText.vue';
import { vClassToggle } from '../rail/classToggle.js';
import UiIcon from '../kit/UiIcon.vue';
import { Switch } from '../shadcn/switch/index.ts';
import { computed, shallowRef, onMounted, onBeforeUnmount } from 'vue';
import { t } from '../../i18n/index.js';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../shadcn/collapsible/index.ts';
const minimal = shallowRef(false);
let themeObserver;
onMounted(() => {
  const sync = () => {
    minimal.value = document.documentElement.dataset.uiTheme === 'minimal';
  };
  themeObserver = new MutationObserver(sync);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-ui-theme'],
  });
  sync();
});
onBeforeUnmount(() => themeObserver?.disconnect());

const icons = {
  flights: 'flight',
  military: 'flight',
  'local-adsb': 'radar',
  satellites: 'satellite_alt',
  'ais-live-vessels': 'directions_boat',
  traffic: 'car',
  transit: 'train',
  bikeshare: 'bike',
  cctv: 'videocam',
  'street-level': 'streetview',
  'recent-imagery': 'satellite_alt',
  'local-datacenters': 'server',
  'military-installations': 'building',
  'alpr-cameras': 'videocam',
  'telegeography-submarine-cables': 'cable',
  'local-dams': 'water',
  'sea-marks': 'water',
  'air-quality': 'cloud',
  wind: 'cloud',
  'weather-radar': 'radar',
  'weather-satellite': 'cloud',
  'weather-lightning': 'cloud',
  'weather-cyclones': 'cloud',
  radio: 'radio',
  dispatch: 'radio',
  'drone-airspace': 'warning',
  directions: 'place',
  'osm-places': 'place',
};

// The data layer rows under their group headings. LayerPanel presents every
// value; clicks reach it with the layer id, and it re-reads the live
// descriptor before acting.
const props = defineProps({
  items: { type: Array, required: true },
  sectionContent: { type: Boolean, default: false },
  master: { type: Object, default: null },
  onToggleAll: { type: Function, default: () => {} },
  onToggle: { type: Function, default: () => {} },
  onChip: { type: Function, default: () => {} },
  onListItem: { type: Function, default: () => {} },
  onSlider: { type: Function, default: () => {} },
  onRange: { type: Function, default: () => {} },
});
const sections = computed(() => {
  const groups = [];
  for (const item of props.items) {
    if (item.heading)
      groups.push({
        key: item.key,
        label: item.heading,
        items: [],
      });
    else {
      if (!groups.length)
        groups.push({ key: 'ungrouped', label: '', items: [] });
      groups.at(-1).items.push(item);
    }
  }
  return groups;
});
</script>

<template>
  <template v-if="minimal && !sectionContent">
    <div v-if="master" class="console-layer-master">
      <span>{{ t('All layers') }}</span>
      <small aria-live="polite">{{ master.enabled }}/{{ master.total }}</small>
      <Switch
        class="console-layer-switch"
        data-layer-master
        :model-value="master.checked"
        :data-partial="master.partial || undefined"
        :aria-label="t('All layers')"
        :aria-description="
          master.partial ? t('Some layers are enabled') : undefined
        "
        :aria-disabled="String(master.disabled || master.busy)"
        :aria-busy="String(master.busy)"
        @update:model-value="
          !master.disabled && !master.busy && onToggleAll($event)
        "
      >
        <template #thumb
          ><span
            v-if="master.partial"
            class="console-switch-partial"
            aria-hidden="true"
            >−</span
          ></template
        >
      </Switch>
    </div>
    <template v-for="section in sections" :key="section.key">
      <Collapsible
        v-if="section.label"
        as="section"
        class="console-layer-section"
        :data-section="section.key"
        default-open
      >
        <h3 class="console-layer-heading"
          ><CollapsibleTrigger as-child
            ><button type="button" class="console-section-trigger"
              ><span>{{ section.label }}</span
              ><small>{{ section.items.length }}</small
              ><UiIcon name="chevron_down" :size="14" /></button
          ></CollapsibleTrigger>
        </h3>
        <CollapsibleContent class="console-section-content"
          ><LayerRows
            :items="section.items"
            section-content
            :on-toggle="onToggle"
            :on-chip="onChip"
            :on-list-item="onListItem"
            :on-slider="onSlider"
            :on-range="onRange"
        /></CollapsibleContent>
      </Collapsible>
      <LayerRows
        v-else
        :items="section.items"
        section-content
        :on-toggle="onToggle"
        :on-chip="onChip"
        :on-list-item="onListItem"
        :on-slider="onSlider"
        :on-range="onRange"
      />
    </template>
  </template>
  <template v-else>
    <template v-for="item in items" :key="item.key"
      ><h3 v-if="item.heading" class="data-layer-group-heading">{{
        item.heading
      }}</h3
      ><div
        v-else
        class="data-toggle-row"
        v-class-toggle="{
          'data-toggle-row--count-line': item.count?.countLine,
        }"
        :data-layer-id="item.id"
        :data-layer-name="item.englishName"
        ><div class="data-toggle-top"
          ><div class="data-toggle-left"
            ><span class="data-icon legacy-layer-icon" aria-hidden="true">{{
              item.icon
            }}</span
            ><UiIcon
              class="minimal-layer-icon"
              :name="icons[item.id] ?? 'layers'"
              :size="16" /><RowText class="data-name" :text="item.name" /></div
          ><div class="data-toggle-right"
            ><RowText
              v-if="item.count"
              :class="['data-count', { 'data-count-empty': item.count.empty }]"
              :text="item.count.text"
            /><Switch
              v-if="minimal"
              class="console-layer-switch"
              :data-feed-state="item.toggle.feedState"
              :aria-disabled="String(item.toggle.ariaDisabled)"
              :aria-busy="String(item.toggle.ariaBusy)"
              :model-value="Boolean(item.toggle.classes?.active)"
              :title="item.toggle.title"
              :aria-label="item.toggle.ariaLabel"
              @update:model-value="onToggle(item.id)"
            />
            <button
              v-else
              type="button"
              role="switch"
              :class="['data-toggle-btn', item.toggle.classes]"
              :data-feed-state="item.toggle.feedState"
              :aria-disabled="String(item.toggle.ariaDisabled)"
              :aria-busy="String(item.toggle.ariaBusy)"
              :aria-checked="String(Boolean(item.toggle.classes?.active))"
              :title="item.toggle.title"
              :aria-label="item.toggle.ariaLabel"
              @click="onToggle(item.id)"
              >{{ item.toggle.text }}</button
            ></div
          ></div
        ><div class="data-toggle-meta" :title="item.meta"
          ><RowText class="legacy-layer-meta" :text="item.meta" />
          <span class="minimal-layer-meta"
            >{{ item.meta?.split(' · ')[0]
            }}<span
              v-if="!['off', 'nominal', ''].includes(item.toggle.feedState)"
              class="minimal-layer-state"
              >{{ item.toggle.text }}</span
            ></span
          ></div
        ><template v-if="item.controls"
          ><div class="data-toggle-controls" :hidden="item.controls.hidden"
            ><RailChips
              :chips="item.controls.chips"
              :on-select="(chip) => onChip(item.id, chip.id)"
            /><RowSwitch
              v-if="item.controls.segmented"
              :segmented="item.controls.segmented"
              :on-select="(optionId) => onChip(item.id, optionId)"
            /><RowSlider
              v-if="item.controls.slider"
              :slider="item.controls.slider"
              :on-input="
                (value) => onSlider(item.id, item.controls.slider.id, value)
              "
            /><RowRange
              v-if="item.controls.range"
              :range="item.controls.range"
              :on-select="
                (end, value) =>
                  onRange(item.id, item.controls.range.id, end, value)
              "
            /><span
              v-for="(entry, index) in item.controls.legend"
              :key="index"
              class="data-toggle-legend-item"
              :title="entry.blurb || undefined"
              ><span
                class="data-toggle-legend-swatch"
                :style="{ background: entry.color }"
              ></span
              ><span>{{ entry.text }}</span></span
            ><div
              v-if="item.controls.info"
              class="data-toggle-controls-info"
              :title="item.controls.info.title"
              :hidden="!item.controls.info.text"
              >{{ item.controls.info.text }}</div
            ></div
          ><RailRowList
            :list="item.controls.list"
            :on-select="
              (entry) => onListItem(item.id, entry.id)
            " /></template></div
    ></template>
  </template>
</template>
