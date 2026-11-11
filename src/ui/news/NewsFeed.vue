<script setup>
import { computed } from 'vue';
import { t } from '../../i18n/index.js';
import UiButton from '../kit/UiButton.vue';
import UiEmpty from '../kit/UiEmpty.vue';
import UiSelect from '../kit/UiSelect.js';
import RailChips from '../rail/RailChips.vue';
import NewsCard from './NewsCard.vue';

// The News panel: the window the server serves only (the last 24 hours, or
// fewer where the host serves less), or a shorter one chosen at the
// top (24/12/6/3/1 h), and two sections. Conflicts: hotspot chips, the
// severity floor, the chosen event and a continuous feed, newest first.
// Local: every report in the area at the view centre (its country, a large
// country's state; within a radius at sea) while the camera is low, named at
// the top, which the map then shows, outlined, instead of the hotspots' news.
// A section read from a key the server lacks (or whose allowance for the day
// is spent) says which key instead. It
// renders the `feed` view the news layer publishes and acts only through
// `onParams`.
const props = defineProps({
  view: { type: Object, default: null },
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
    label: t('Last {hours} h', { hours }),
  })),
);
// The longest choice is the server's whole window, kept as no choice.
const chooseWindow = (hours) =>
  setFilter('hours', hours === props.view?.windowChoices?.[0] ? null : hours);
const selectedId = computed(() => props.view?.selected?.id ?? null);
// The chosen event leads the panel unless the feed already shows it open.
const selectedApart = computed(() => {
  const chosen = props.view?.selected;
  if (!chosen) return null;
  const listed = local.value
    ? props.view.inView.items.some((item) => item.id === chosen.id)
    : props.view.items.some((item) => item.id === chosen.id);
  return listed ? null : chosen;
});
// What Local reads: the area named, else the radius; neither while the
// first area is being named, so the radius does not flash before it.
const areaHead = computed(() => {
  const inView = props.view?.inView;
  if (!inView?.active) return '';
  if (inView.area) return t('News from {area}', { area: inView.area });
  if (inView.areaLoading) return '';
  return t('Within {km} km of the view centre', { km: inView.radiusKm });
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
    :aria-label="t('News, last {hours} hours', { hours: view.windowHours })"
  >
    <UiSelect
      v-if="windowOptions.length > 1"
      class="gev-field news-filter news-readout__window-choice"
      :aria-label="t('Time window')"
      :model-value="String(view.windowHours)"
      :options="windowOptions"
      @update:model-value="chooseWindow(Number($event))"
    />
    <p v-else class="news-readout__window ui-mono">{{
      t('Last {hours} h', { hours: view.windowHours })
    }}</p>
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
    <div class="news-readout__filters">
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

    <NewsCard
      v-if="selectedApart"
      class="news-readout__selected"
      :item="selectedApart"
      open
      :on-choose="choose"
      :on-clear="clear"
    />

    <section
      v-if="local"
      class="news-readout__section"
      :aria-label="t('Local')"
    >
      <p v-if="areaHead" class="news-readout__head news-readout__area ui-mono">
        {{ areaHead }}
      </p>
      <UiEmpty
        v-if="!view.inView.active"
        class="news-readout__empty"
        :title="t('Zoom in to see local news')"
      />
      <UiEmpty
        v-else-if="view.inView.key"
        class="news-readout__empty"
        :title="view.inView.key.title"
        :hint="view.inView.key.hint"
      />
      <p v-else-if="view.inView.error" class="news-readout__status">
        {{ view.inView.error }}
      </p>
      <UiEmpty
        v-else-if="!view.inView.items.length && !view.inView.loading"
        class="news-readout__empty"
        :title="
          t('Nothing reported near here in the last {hours} h', {
            hours: view.windowHours,
          })
        "
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

    <section
      v-else
      class="news-readout__section"
      :aria-label="t('Latest news')"
    >
      <h3 class="news-readout__head ui-mono">{{ t('Latest') }}</h3>
      <UiEmpty
        v-if="view.key"
        class="news-readout__empty"
        :title="view.key.title"
        :hint="view.key.hint"
      />
      <ol
        v-else-if="view.items.length"
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
        :title="
          t('No news matches these filters in the last {hours} h', {
            hours: view.windowHours,
          })
        "
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
