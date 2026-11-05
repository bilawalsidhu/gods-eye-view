<script setup>
import { computed } from 'vue';
import { t } from '../../i18n/index.js';
import UiButton from '../kit/UiButton.vue';
import UiEmpty from '../kit/UiEmpty.vue';
import UiSelect from '../kit/UiSelect.js';
import RailChips from '../rail/RailChips.vue';
import NewsCard from './NewsCard.vue';

// The News panel: the last 24 hours only. Hotspot chips, filters, the chosen
// event, "In view" (reports near the view centre while the camera is low)
// and a continuous feed, newest first. It renders the `feed` view the news
// layer publishes and acts only through `onParams`.
const props = defineProps({
  view: { type: Object, default: null },
  onParams: { type: Function, default: () => {} },
});

const filters = computed(() => props.view?.filters ?? {});
const chips = computed(() =>
  (props.view?.hotspots ?? []).map((chip) => ({
    id: chip.id,
    label: `${chip.label} ${chip.count}`,
    active: chip.active,
    title: chip.label,
  })),
);
const severityOptions = computed(() => {
  const levels = props.view?.severities ?? [];
  return [
    { value: '0', label: t('Any severity') },
    ...levels.slice(1, 3).map((level) => ({
      value: String(level.value),
      label: t('{severity} and above', { severity: level.label }),
    })),
    ...levels.slice(3).map((level) => ({
      value: String(level.value),
      label: t('{severity} only', { severity: level.label }),
    })),
  ];
});
const categoryOptions = computed(() => [
  { value: 'all', label: t('All categories') },
  ...(props.view?.categories ?? []),
]);
const selectedId = computed(() => props.view?.selected?.id ?? null);
// The chosen event leads the panel unless the feed already shows it open.
const selectedApart = computed(() => {
  const chosen = props.view?.selected;
  if (!chosen) return null;
  const listed =
    props.view.items.some((item) => item.id === chosen.id) ||
    (props.view.inView.active &&
      props.view.inView.items.some((item) => item.id === chosen.id));
  return listed ? null : chosen;
});
const status = computed(() => {
  const view = props.view;
  if (!view) return '';
  if (view.error) return view.error;
  if (view.loading && !view.items.length) return t('Reading the news…');
  return '';
});

const setFilter = (name, value) =>
  props.onParams({ filters: { [name]: value } });
function choose(item) {
  if (item.id === selectedId.value) props.onParams({ clear: true });
  else props.onParams({ reportId: item.id, focus: true });
}
const clear = () => props.onParams({ clear: true });
</script>

<template>
  <section
    v-if="view"
    class="news-readout"
    :aria-label="t('News, last 24 hours')"
  >
    <p class="news-readout__window ui-mono">{{ t('Last 24 h') }}</p>
    <div class="news-readout__chips" role="group" :aria-label="t('Hotspots')">
      <RailChips
        :chips="chips"
        :on-select="(chip) => setFilter('hotspot', chip.id)"
      />
    </div>
    <div class="news-readout__filters">
      <UiSelect
        class="gev-field news-filter"
        :aria-label="t('Severity')"
        :model-value="String(filters.minSeverity ?? 2)"
        :options="severityOptions"
        @update:model-value="setFilter('minSeverity', Number($event))"
      />
      <UiSelect
        class="gev-field news-filter"
        :aria-label="t('Category')"
        :model-value="filters.category ?? 'all'"
        :options="categoryOptions"
        @update:model-value="setFilter('category', $event)"
      />
      <label class="news-toggle"
        ><input
          type="checkbox"
          :checked="filters.includeMinor === true"
          @change="setFilter('includeMinor', $event.target.checked)"
        /><span>{{ t('Include minor news') }}</span></label
      >
      <label class="news-toggle"
        ><input
          type="checkbox"
          :checked="filters.cards !== false"
          @change="setFilter('cards', $event.target.checked)"
        /><span>{{ t('Show event cards') }}</span></label
      >
    </div>

    <NewsCard
      v-if="selectedApart"
      class="news-readout__selected"
      :item="selectedApart"
      open
      :on-choose="choose"
      :on-clear="clear"
    />

    <section
      v-if="view.inView.active"
      class="news-readout__section"
      :aria-label="t('In view')"
    >
      <h3 class="news-readout__head ui-mono">{{ t('In view') }}</h3>
      <p v-if="view.inView.error" class="news-readout__status">
        {{ view.inView.error }}
      </p>
      <UiEmpty
        v-else-if="!view.inView.items.length && !view.inView.loading"
        class="news-readout__empty"
        :title="t('Nothing reported near here in the last 24 h')"
      />
      <ol
        v-else
        class="news-readout__list"
        :class="{ 'is-stale': view.inView.loading }"
        :aria-busy="view.inView.loading ? 'true' : 'false'"
      >
        <li v-for="item in view.inView.items" :key="item.id">
          <NewsCard
            :item="item"
            :open="item.id === selectedId"
            :on-choose="choose"
            :on-clear="clear"
          />
        </li>
      </ol>
    </section>

    <section class="news-readout__section" :aria-label="t('Latest news')">
      <h3 class="news-readout__head ui-mono">{{ t('Latest') }}</h3>
      <ol
        v-if="view.items.length"
        class="news-readout__list news-readout__feed"
      >
        <li v-for="item in view.items" :key="item.id">
          <NewsCard
            :item="item"
            :open="item.id === selectedId"
            :on-choose="choose"
            :on-clear="clear"
          />
        </li>
      </ol>
      <UiEmpty
        v-else-if="!view.loading && !view.error"
        class="news-readout__empty"
        :title="t('No news matches these filters in the last 24 h')"
      />
      <div class="news-readout__footer">
        <span class="news-readout__status" role="status">{{ status }}</span>
        <UiButton
          v-if="view.hasMore && !view.loading"
          class="data-toggle-chip"
          type="button"
          @click="onParams({ loadMore: true })"
          >{{ t('Load older news') }}</UiButton
        >
      </div>
    </section>

    <details class="news-legend">
      <summary>{{ t('How to read the map') }}</summary>
      <p>{{ t('Colour: severity · icon: type of event') }}</p>
      <ul class="news-legend__severity">
        <li
          v-for="level in view.severities"
          :key="level.value"
          :style="{ '--news-color': level.color }"
        >
          {{ level.label }}
        </li>
      </ul>
      <p>{{
        t(
          'Solid rim: reported by both sides or independently. Dashed rim: a claim. Thin rim: one source, or one side’s own press.',
        )
      }}</p>
      <p>{{
        t(
          'Larger: more sources · fainter: older. Picture card: a major or fast-growing event with two or more sources.',
        )
      }}</p>
      <p>{{
        t('Side labels describe the source, not whether a report is true.')
      }}</p>
    </details>
  </section>
</template>
