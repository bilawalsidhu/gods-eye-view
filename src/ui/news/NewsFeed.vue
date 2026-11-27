<script setup>
import { computed } from 'vue';
import { formatNumber, t, tn } from '../../i18n/index.js';
import ContextListCard from '../kit/ContextListCard.vue';
import UiButton from '../kit/UiButton.vue';
import UiEmpty from '../kit/UiEmpty.vue';
import UiSelect from '../kit/UiSelect.js';
import RailChips from '../rail/RailChips.vue';
import NewsCard from './NewsCard.vue';

// The News panel: the window the server serves only (the last 24 hours, or
// fewer where the host serves less), or a shorter one chosen under Filters
// (24/12/6/3/1 h), and two sections. Filters folds the window, the severity
// floor and the category into one row that reads what is chosen.
// Conflicts: hotspot chips, the severity floor, the chosen event and a
// continuous feed, newest first.
// Local: every report in the area at the view centre (its country, a large
// country's state; within a radius at sea) while the camera is low, named at
// the top, which the map then shows, outlined, instead of the hotspots' news.
// A section read from a key the server lacks (or whose allowance for the day
// is spent) says which key instead. It
// renders the `feed` view the news layer publishes and acts only through
// `onParams`.
const props = defineProps({
  view: { type: Object, default: null },
  visible: { type: Boolean, default: true },
  onParams: { type: Function, default: () => {} },
});

const filters = computed(() => props.view?.filters ?? {});
const local = computed(() => filters.value.section === 'local');
const sections = computed(() =>
  [
    { id: 'conflicts', label: t('Conflicts') },
    { id: 'local', label: t('Local') },
  ].map((chip) => ({
    ...chip,
    active: (filters.value.section ?? 'conflicts') === chip.id,
  })),
);
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
const windowOptions = computed(() =>
  (props.view?.windowChoices ?? []).map((hours) => ({
    value: String(hours),
    label: lastHours(hours),
  })),
);
// The window offers 1 h, so every hour count is a plural: es «Última 1 h».
function lastHours(hours) {
  return tn(hours, 'Last {hours} h', 'Last {hours} h', {
    hours: formatNumber(hours),
  });
}
// The Filters row, folded, reads what is chosen: the window, the severity
// floor (Conflicts only) and the category.
const chosen = computed(() => {
  const view = props.view;
  if (!view) return '';
  const severity = String(filters.value.minSeverity ?? 2);
  const category = filters.value.category ?? 'all';
  return [
    lastHours(view.windowHours),
    local.value
      ? null
      : severityOptions.value.find((option) => option.value === severity)
          ?.label,
    categoryOptions.value.find((option) => option.value === category)?.label,
  ]
    .filter(Boolean)
    .join(' · ');
});
// The longest choice is the server's whole window, kept as no choice.
const chooseWindow = (hours) =>
  setFilter('hours', hours === props.view?.windowChoices?.[0] ? null : hours);
const selectedId = computed(() => props.view?.selected?.id ?? null);
// What Local reads: the area named, else the radius; neither while the
// first area is being named, so the radius does not flash before it.
const areaHead = computed(() => {
  const inView = props.view?.inView;
  if (!inView?.active) return '';
  if (inView.area) return t('News from {area}', { area: inView.area });
  if (inView.areaLoading) return '';
  return t('Within {km} km of the view centre', { km: inView.radiusKm });
});
// The shown section's list: Local's, else the Conflicts feed.
const list = computed(() => (local.value ? props.view.inView : props.view));
const listKey = computed(() =>
  JSON.stringify([
    filters.value.section,
    filters.value.hotspot,
    filters.value.minSeverity,
    filters.value.category,
    props.view.windowHours,
    local.value ? props.view.inView.area : null,
  ]),
);
const listState = computed(() => {
  const { items, loading, error, key } = list.value;
  if ((local.value && !props.view.inView.active) || key) return 'empty';
  if (items.length) return 'ready';
  return error ? 'failed' : loading ? 'loading' : 'empty';
});
const empty = computed(() => {
  const view = props.view;
  if (local.value && !view.inView.active)
    return { title: t('Zoom in to see local news') };
  if (list.value.key) return list.value.key;
  const hours = { hours: formatNumber(view.windowHours) };
  return {
    title: local.value
      ? tn(
          view.windowHours,
          'Nothing reported near here in the last {hours} h',
          'Nothing reported near here in the last {hours} h',
          hours,
        )
      : tn(
          view.windowHours,
          'No news matches these filters in the last {hours} h',
          'No news matches these filters in the last {hours} h',
          hours,
        ),
  };
});
// A failed first read is the list's own state; a failed next page is here.
const status = computed(() =>
  list.value?.items.length ? list.value.error || '' : '',
);

const setFilter = (name, value) =>
  props.onParams({ filters: { [name]: value } });
function choose(item) {
  if (item.id === selectedId.value) props.onParams({ clear: true });
  else props.onParams({ reportId: item.id, focus: true, fromNewsList: true });
}
const clear = () => props.onParams({ clear: true });
</script>

<template>
  <section
    v-if="view"
    class="news-readout"
    :aria-label="
      tn(
        view.windowHours,
        'News, last {hours} hour',
        'News, last {hours} hours',
        {
          hours: formatNumber(view.windowHours),
        },
      )
    "
  >
    <div
      class="news-readout__sections"
      role="group"
      :aria-label="t('News sections')"
    >
      <RailChips
        :chips="sections"
        :on-select="(chip) => setFilter('section', chip.id)"
      />
    </div>
    <div
      v-if="!local"
      class="news-readout__chips"
      role="group"
      :aria-label="t('Hotspots')"
    >
      <RailChips
        :chips="chips"
        :on-select="(chip) => setFilter('hotspot', chip.id)"
      />
    </div>
    <details class="news-readout__filters">
      <summary class="news-readout__filters-summary">
        <span class="news-readout__filters-label">{{ t('Filters') }}</span>
        <span class="news-readout__chosen ui-mono" :title="chosen">{{
          chosen
        }}</span>
      </summary>
      <div class="news-readout__filter-fields">
        <UiSelect
          v-if="windowOptions.length > 1"
          class="gev-field news-filter news-readout__window-choice"
          :aria-label="t('Time window')"
          :model-value="String(view.windowHours)"
          :options="windowOptions"
          @update:model-value="chooseWindow(Number($event))"
        />
        <UiSelect
          v-if="!local"
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
      </div>
    </details>

    <ContextListCard
      id="news"
      :title="local ? t('Local') : t('Latest', { context: 'news list' })"
      icon="newspaper"
      :tone="list.loading ? 'loading' : list.error ? 'stale' : 'nominal'"
      :query="listKey"
      :items="list.items"
      :state="listState"
      :group-by="(item) => item.category"
      :row-button="false"
      @order="onParams({ listOrder: $event })"
    >
      <template #filter>
        <p
          v-if="local && areaHead"
          class="news-readout__head news-readout__area ui-mono"
        >
          {{ areaHead }}
        </p>
        <NewsCard
          v-if="view.selected && visible"
          :key="selectedId"
          class="news-readout__selected"
          :item="view.selected"
          open
          :on-choose="choose"
          :on-clear="clear"
        />
      </template>
      <template #row="{ item }">
        <NewsCard
          :item="item"
          :selected="item.id === selectedId"
          :on-choose="choose"
          :on-clear="clear"
        />
      </template>
      <template #empty>
        <UiEmpty
          class="news-readout__empty"
          :title="empty.title"
          :hint="empty.hint"
        />
      </template>
      <template #loading>{{ t('Reading the news…') }}</template>
      <template #failed>{{ list.error }}</template>
    </ContextListCard>
    <div v-if="!local || status" class="news-readout__footer">
      <span class="news-readout__status" role="status">{{ status }}</span>
      <UiButton
        v-if="!local && view.hasMore"
        :disabled="view.loading"
        class="data-toggle-chip"
        type="button"
        @click="onParams({ loadMore: true })"
        >{{ t('Load older news') }}</UiButton
      >
    </div>

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
