<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import RailPanel from '../rail/RailPanel.vue';
import { vClassToggle } from '../rail/classToggle.js';
import { useCockpitStore } from '../stores/cockpit.js';
import { useBhoteKoshiPanelStore } from '../stores/bhoteKoshiPanel.js';
import { useContextStore } from '../stores/context.js';
import { usePanelChromeStore } from '../stores/panelChrome.js';
import { useEntityCardStore } from '../stores/entityCard.js';
import { useSceneStore } from '../stores/scenes.js';
import AwarenessPanel from './panels/AwarenessPanel.vue';
import BhoteKoshiPanel from './panels/BhoteKoshiPanel.vue';
import EntityCard from './panels/EntityCard.vue';
import ViewContext from './panels/ViewContext.vue';
import SpaceMissionsPanel from './panels/SpaceMissionsPanel.vue';
import RadioPanel from './panels/RadioPanel.vue';
import UiButton from '../kit/UiButton.vue';
import UiIcon from '../kit/UiIcon.vue';
import UiSearchField from '../kit/UiSearchField.vue';
import { cockpitEntryFace } from '../cockpitPresentation.js';
import { LAYER_TABS, TAB_AFFECTS, activeTab, availableTabs, contextReady, enabledLayerIds, setEnabledLayers, tabTarget } from '../contextLayerTabs.js';
import { shownLayerName } from '../layerNames.js';
import { closeContextSearch, contextSearchOpen, contextSearchText } from '../contextSearch.js';

// ContextControls presents the mode switch and the nearby sites search and
// publishes them; until it does, the panel shows its initial markup.
const { view: ctx, awareness } = storeToRefs(useContextStore());
const { presence: cockpit } = storeToRefs(useCockpitStore());
// The entry names the subject it would ride (cockpitEntryFace).
const entry = computed(() =>
  cockpitEntryFace(cockpit.value?.entryKind, cockpit.value?.entryFace),
);
// While the Bhote Koshi event is on, its panel is the rail's only content.
const { panel: bhotePanel } = storeToRefs(useBhoteKoshiPanelStore());
// The Scene runtime chip SceneControls presents while a scene plays.
const { panel: scenePanel } = storeToRefs(useSceneStore());
const sceneRuntime = computed(() => scenePanel.value?.runtime ?? '');
// Context is one card for whatever was picked; until something is, it says how.
const entityCards = useEntityCardStore();
const { card: entityCard } = storeToRefs(entityCards);
const contactsSubject = computed(() =>
  ctx.value?.flightsActive ? awareness.value?.subjectIdentity : null,
);
const contactsMatchCard = computed(() => {
  const card = entityCard.value;
  const subject = contactsSubject.value;
  return Boolean(
    card?.kind === 'aircraft' &&
      subject?.layerId === card.layerId &&
      String(subject.id) === String(card.identity.id),
  );
});
watch(
  [() => contactsSubject.value?.layerId, () => contactsSubject.value?.id],
  ([layerId, id]) => {
    if (!['flights', 'military'].includes(layerId) || !id || contactsMatchCard.value) return;
    // Contacts has already picked whom to follow. Only update the Inspector.
    entityCards.select({ layerId, id, label: awareness.value?.subjectLabel }, { follow: false });
  },
);

// Layer tabs: settings for the layers that are on, beside the card.
let layerTimer = null;
const readLayers = () => {
  const rows = entityCards.liveLayers();
  layerNames.value = Object.fromEntries(rows.map((row) => [row.id, shownLayerName(row.name, row.id)]));
  setEnabledLayers(rows.map((row) => row.id));
};
const paneRefs = {};
const setPane = (id) => (el) => {
  if (el) {
    paneRefs[id] = el;
    const target = tabTarget(id);
    if (target instanceof HTMLElement && target.parentElement !== el) el.appendChild(target);
  }
};
// Turning on Radio reveals the Inspector.
const showView = () => (activeTab.value = 'view');
onMounted(() => {
  globalThis.addEventListener?.('gev:context-show-view', showView);
  contextReady.value = true;
  readLayers();
  layerTimer = setInterval(readLayers, 1500);
});
onBeforeUnmount(() => {
  globalThis.removeEventListener?.('gev:context-show-view', showView);
  clearInterval(layerTimer);
  contextReady.value = false;
  // A later mount starts as the button says: not expanded, no tab classes.
  setDocked(false);
  for (const tab of LAYER_TABS) globalThis.document?.body.classList.remove(`ctx-tab-${tab.id}`);
});
watch(availableTabs, (tabs) => {
  for (const tab of LAYER_TABS)
    globalThis.document?.body.classList.toggle(`ctx-tab-${tab.id}`, tabs.some((x) => x.id === tab.id));
  if (activeTab.value === 'props' && !tabs.length) activeTab.value = 'view';
});
// Picking something shows its card.
watch(entityCard, (next, prev) => {
  if (next && next?.key !== prev?.key) activeTab.value = 'view';
});
// The two tabs swap with the arrow keys, and focus follows (tabs pattern).
function switchTab() {
  activeTab.value = activeTab.value === 'view' ? 'props' : 'view';
  void nextTick(() => globalThis.document?.getElementById(`context-tab-btn-${activeTab.value}`)?.focus());
}
const isShown = (id) => availableTabs.value.some((tab) => tab.id === id);
// The names of the layers a section's settings act on.
const layerNames = ref({});
// Each layer gets a steady colour of its own for its dot.
const DOT_COLORS = ['#36dcff', '#4be3a0', '#ffb547', '#c792ff', '#ff7a45', '#ff6b9a', '#9ad7ff', '#e6e36b'];
const dotColor = (layer) => {
  let h = 0;
  for (const ch of layer) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DOT_COLORS[h % DOT_COLORS.length];
};
const affects = (id) => {
  void enabledLayerIds.value;
  const ids = TAB_AFFECTS[id]?.(enabledLayerIds.value) ?? [];
  return ids.map((layer) => ({ id: layer, name: layerNames.value[layer] || layer, color: dotColor(layer) }));
};

// Search in the header: a field that narrows what Context is showing, the
// selected item's details and every list of what is nearby or in view.
const searchInput = ref(null);
function toggleSearch() {
  if (contextSearchOpen.value) return closeContextSearch();
  contextSearchOpen.value = true;
  activeTab.value = 'view';
  void nextTick(() => searchInput.value?.focus());
}
const searchHint = computed(() =>
  entityCard.value ? t('Search {name} and nearby', { name: entityCard.value.title }) : t('Search what is in view'),
);

// Expanded, Context becomes a full-height column over the right edge of the
// screen, with the globe left as it is underneath. It shrinks back when the
// panel closes.
const docked = ref(false);
const { panels: chromePanels } = storeToRefs(usePanelChromeStore());
// The phone layout and Cockpit have no room for the column: either one
// arriving lets it go.
let bodyWatch = null;
function setDocked(next) {
  docked.value = next;
  const body = globalThis.document?.body;
  body?.classList.toggle('context-docked', next);
  bodyWatch?.disconnect();
  bodyWatch = null;
  if (next && body && globalThis.MutationObserver) {
    bodyWatch = new MutationObserver(() => {
      if (body.classList.contains('mobile-shell') || body.classList.contains('cockpit-mode')) setDocked(false);
    });
    bodyWatch.observe(body, { attributes: true, attributeFilter: ['class'] });
  }
}
// Only an open panel reads what is picked and in view; closed, it does no work.
const contextOpen = computed(() => chromePanels.value['global-context-panel']?.collapsed === false);
watch(
  () => chromePanels.value['global-context-panel']?.collapsed,
  (collapsed) => {
    if (collapsed && docked.value) setDocked(false);
  },
);
</script>

<template>
  <!-- Global Context is deliberately independent from the left layer accordion. -->
  <aside id="right-context-rail" class="ui-scroll" v-class-toggle="{ 'bhote-event-active': !!bhotePanel }">
    <RailPanel id="weather-panel" hidden :title="t('WEATHER')" sideways rail-scroller>
      <template #badge><span id="weather-panel-count" :aria-label="t('Active weather products')">0</span></template>
      <div id="weather-panel-body" class="ui-scroll" data-rail-scroller></div>
    </RailPanel>
    <RailPanel id="news-panel" hidden :title="t('NEWS')" sideways rail-scroller>
      <template #badge><span id="news-panel-count" :aria-label="t('News items in the feed')">0</span></template>
      <div id="news-panel-body" class="ui-scroll" data-rail-scroller></div>
    </RailPanel>
    <RailPanel id="recent-imagery-panel" hidden :title="t('RECENT IMAGERY')" sideways rail-scroller>
      <template #badge><span id="recent-imagery-panel-count" :aria-label="t('Imagery days in the box')"></span></template>
      <div id="recent-imagery-panel-body" class="ui-scroll" data-rail-scroller></div>
    </RailPanel>
    <RailPanel id="global-context-panel" start-collapsed v-class-toggle="{ ...(ctx && { 'context-enabled': ctx.enabled }) }" :data-context-mode="ctx?.mode" :data-context-tab="activeTab" :title="t('CONTEXT')" sideways scroll rail-scroller>
        <template #actions>
          <UiButton class="context-dock-btn" :pressed="Boolean(contextSearchOpen)" :aria-label="contextSearchOpen ? t('Close Context search') : t('Search in Context')" :title="contextSearchOpen ? t('Close search') : t('Search in Context')" @click="toggleSearch">
            <UiIcon name="search" :size="null" />
          </UiButton>
          <UiButton class="context-dock-btn" :pressed="docked" :aria-label="docked ? t('Shrink Context back to a panel') : t('Expand Context to a full-height column')" :title="docked ? t('Shrink') : t('Expand')" @click="setDocked(!docked)">
            <UiIcon :name="docked ? 'close_fullscreen' : 'open_in_full'" :size="null" />
          </UiButton>
        </template>
        <div class="cyber-panel-body ui-scroll" data-rail-scroller>
        <UiSearchField v-if="contextSearchOpen" ref="searchInput" v-model="contextSearchText" class="context-search" role="search" input-class="context-search__input" :label="searchHint" :placeholder="searchHint" autocomplete="off" spellcheck="false" :clear-label="t('Clear search')" clear-class="context-search__clear" @escape="closeContextSearch" />
        <div v-if="availableTabs.length" class="context-tabs" role="tablist" :aria-label="t('Context tabs')">
          <UiButton id="context-tab-btn-view" role="tab" class="context-tabs__tab" :class="{ active: activeTab === 'view' }" :aria-selected="String(activeTab === 'view')" aria-controls="context-tab-view" :tabindex="activeTab === 'view' ? 0 : -1" @click="activeTab = 'view'" @keydown.left.prevent="switchTab" @keydown.right.prevent="switchTab">
            <UiIcon name="visibility" :size="null" /><span class="context-tabs__label">{{ t('Inspector') }}</span>
          </UiButton>
          <UiButton id="context-tab-btn-props" role="tab" class="context-tabs__tab" :class="{ active: activeTab === 'props' }" :aria-selected="String(activeTab === 'props')" aria-controls="context-tab-props" :tabindex="activeTab === 'props' ? 0 : -1" @click="activeTab = 'props'" @keydown.left.prevent="switchTab" @keydown.right.prevent="switchTab">
            <UiIcon name="tune" :size="null" /><span class="context-tabs__label">{{ t('Properties') }}</span>
          </UiButton>
        </div>
        <!-- Properties: settings of the layers that are on, one section each. -->
        <div id="context-tab-props" class="context-props" :hidden="activeTab !== 'props'" role="tabpanel" aria-labelledby="context-tab-btn-props">
          <section v-for="tab in LAYER_TABS" v-show="isShown(tab.id)" :key="tab.id" class="context-props__section">
            <h4 class="context-props__heading"><UiIcon :name="tab.icon" :size="null" />{{ t(tab.label) }}</h4>
            <ul v-if="affects(tab.id).length" class="context-props__layers">
              <li v-for="layer in affects(tab.id)" :key="layer.id"><i :style="{ background: layer.color }" aria-hidden="true"></i>{{ layer.name }}</li>
            </ul>
            <div :id="`context-tab-${tab.id}`" :ref="setPane(tab.id)" class="context-tab-pane"></div>
          </section>
        </div>
        <RadioPanel />
        <div class="global-context-modes" role="tablist" :aria-label="t('Context mode')">
          <UiButton id="global-context-flights-btn" class="context-mode-button" v-class-toggle="{ active: ctx?.flightsActive }" role="tab" tabindex="0" :aria-selected="String(ctx?.flightsActive ?? false)" :aria-disabled="ctx && String(ctx.busy)" :aria-busy="ctx && String(ctx.busy)" aria-controls="context-flights-view" :aria-label="t('CONTACTS')" :title="t('Cycles the nearest contacts of whatever type you select — planes, vessels, installations. Satellites track independently.')">
            <UiIcon name="radar" :size="null" />
            <span>{{ t('CONTACTS') }}</span>
          </UiButton>
        </div>
        <div id="context-mode-standby" class="context-mode-standby" :hidden="ctx?.enabled">
          <strong>{{ t('SELECT CONTEXT') }}</strong>
          <span>{{ t('CONTACTS — nearest planes · vessels · sites') }}</span>
        </div>
        <section id="context-flights-view" class="context-mode-view" role="tabpanel" aria-labelledby="global-context-flights-btn" :hidden="!ctx?.flightsActive">
          <div class="global-context-actions" :aria-label="t('Contact Context actions')">
            <UiButton id="cockpit-entry" :hidden="!cockpit?.entryAvailable">
              <UiIcon :name="entry.icon" :size="null" />
              <span>{{ entry.label }}</span>
            </UiButton>
            <UiButton id="installations-search-btn" class="panel-layer-toggle" :aria-disabled="ctx && String(ctx.installationsBusy)" :aria-busy="ctx && String(ctx.installationsBusy)">{{ t('SEARCH NEARBY SITES') }}</UiButton>
            <UiButton id="tr3b-toggle" class="tr3b-toggle" :pressed="!!cockpit?.tr3b?.converted" :hidden="!cockpit?.tr3b" :aria-label="t('Reclassify tracked contact as TR-3B')" :title="cockpit?.tr3b?.converted ? t('Restore real aircraft') : t('Reclassify as TR-3B')">🛸</UiButton>
          </div>
          <AwarenessPanel v-if="!contactsMatchCard" />
        </section>
        <div v-if="contextOpen" v-show="activeTab === 'view'" id="context-tab-view" role="tabpanel" aria-labelledby="context-tab-btn-view" :class="{ 'context-searching': contextSearchOpen && contextSearchText.trim() }">
          <EntityCard :with-contacts="contactsMatchCard">
            <AwarenessPanel v-if="contactsMatchCard" compact />
          </EntityCard>
          <ViewContext v-if="!entityCard" />
        </div>
        </div>
    </RailPanel>
    <SpaceMissionsPanel />
    <BhoteKoshiPanel />
  </aside>

  <div id="scene-runtime" :class="{ active: !!sceneRuntime }">{{ sceneRuntime }}</div>
</template>
