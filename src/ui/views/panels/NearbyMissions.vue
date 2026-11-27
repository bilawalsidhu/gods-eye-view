<script setup>
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, watch } from 'vue';
import { useNow } from '../../useNow.js';
import { t } from '../../../i18n/index.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { useSpaceMissionsStore } from '../../stores/spaceMissions.js';
import { contextNeedle, contextSearchText, matchesMissionSearch } from '../../contextSearch.js';
import { missionIsUpcoming, missionsByTime } from '../../../data/missionsByTime.js';
import ContextListCard from '../../kit/ContextListCard.vue';
import UiBadge from '../../kit/UiBadge.vue';
import EntityMark from './EntityMark.vue';
import MissionDetail from './MissionDetail.vue';

// Space Missions can occupy Inspect over an existing follow. Its roster
// uses a list card (ContextListCard.vue), sorted by launch time rather
// than distance. The Launch Library feed covers the past 30 days, so its
// newest missions come first. The list is split by launch provider,
// narrowed by the Context search. A row selects its mission as the globe
// does, and the mission's card shows in the list's place. The header close
// button returns to the roster. Hovering or focusing a row previews the
// mission on the globe through the layer's roster preview.
const props = defineProps({ feed: { type: Object, default: null } });
const cards = useEntityCardStore();
const { enabled, roster, mission, layer } = storeToRefs(useSpaceMissionsStore());

const entries = computed(() => (enabled.value && roster.value?.entries) || []);
const troubled = computed(() => props.feed && !['nominal', 'loading'].includes(props.feed.tone));
const state = computed(() => {
  if (entries.value.length) return 'ready';
  if (troubled.value) return 'failed';
  return roster.value ? 'empty' : 'loading';
});

const now = useNow(60_000, () => entries.value.length > 0);
onBeforeUnmount(() => layer.value?.rosterReset?.());

// A new roster drops the layer's preview. A row that kept focus through the
// refresh gets no new focus event, so its preview is asked for again here.
watch(
  roster,
  () => {
    const row = globalThis.document?.activeElement?.closest?.('.nearby-missions [data-list-key]');
    if (!row) return;
    const entry = entries.value.find((item) => String(item.id) === row.dataset.listKey);
    if (entry) layer.value?.rosterFocus(entry.index);
  },
  { flush: 'post' },
);

const byTime = (items) => missionsByTime(items, now.value).map(({ entry }) => entry);
const provider = (entry) => entry.provider || t('UNSPECIFIED OPERATOR');
const upcoming = (entry) => missionIsUpcoming(entry, now.value);
</script>

<template>
  <ContextListCard
    v-if="enabled"
    id="space-missions"
    header-close
    class="nearby-missions"
    :title="t('Space Missions')"
    icon="rocket_launch"
    :tone="troubled ? feed.tone : state === 'loading' ? 'loading' : 'nominal'"
    :tone-text="troubled ? feed.toneText : state === 'loading' ? t('Loading') : t('Live')"
    :items="entries"
    :item-key="(entry) => entry.id"
    :sort="byTime"
    :filter="matchesMissionSearch"
    :query="contextNeedle"
    :return-revision="`${cards.view?.manualInputCount ?? 0}:${cards.viewCommandRevision}`"
    :group-by="provider"
    :selected="mission?.id ?? null"
    :state="state"
    :back-title="t('Show all missions')"
    @select="(entry) => layer?.selectMissionAt(entry.index, { keepFollow: true })"
    @back="layer?.deselectMission()"
    @row-pointer="(entry) => (entry ? layer?.rosterPointerEnter(entry.index) : layer?.rosterPointerLeave())"
    @row-focus="(entry) => layer?.rosterFocus(entry.index)"
    @row-blur="(entry) => layer?.rosterBlur(entry ? entry.index : null)"
  >
    <template #row="{ item }">
      <EntityMark class="nearby-lists__mark" layer="rocket-launches" icon="rocket_launch" :size="16" />
      <span class="nearby-lists__name" :title="item.label">{{ item.label }}</span>
      <UiBadge v-if="upcoming(item)" class="nearby-lists__badge">{{ t('Upcoming') }}</UiBadge>
      <span class="nearby-lists__meta" dir="ltr">{{ item.date }}</span>
    </template>
    <template #detail><MissionDetail /></template>
    <template #loading>{{ t('LOADING 30-DAY MISSION INDEX') }}</template>
    <template #empty>{{ roster?.empty }}</template>
    <template #no-matches>{{ t('Nothing matches “{text}”.', { text: contextSearchText.trim() }) }}</template>
  </ContextListCard>
</template>
