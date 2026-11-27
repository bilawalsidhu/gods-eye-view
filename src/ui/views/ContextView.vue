<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { placeStreetLevelViewer, registerStreetLevelViewerHome, returnStreetLevelViewerHome } from '../streetLevelViewerPlacement.js';
import StreetLevelPhotoViewer from './panels/StreetLevelPhotoViewer.vue';
import { isContextRailModeCovered } from '../mobileSheets.js';
import { STREET_LEVEL_LAYER } from '../streetLevelEvents.js';
import StreetLevelViewer from './panels/StreetLevelViewer.vue';
import { storeToRefs } from 'pinia';
import { formatNumber, t } from '../../i18n/index.js';
import RailPanel from '../rail/RailPanel.vue';
import { vClassToggle } from '../rail/classToggle.js';
import { useBhoteKoshiPanelStore } from '../stores/bhoteKoshiPanel.js';
import { usePanelChromeStore } from '../stores/panelChrome.js';
import { sayWords, useEntityCardStore } from '../stores/entityCard.js';
import { useSceneStore } from '../stores/scenes.js';
import { usePinnedStore } from '../stores/pinned.js';
import { useCctvStore } from '../stores/cctv.js';
import { useContextStore } from '../stores/context.js';
import { useDisplayStore } from '../stores/display.js';
import { useCockpitStore } from '../stores/cockpit.js';
import BhoteKoshiPanel from './panels/BhoteKoshiPanel.vue';
import EntityCard from './panels/EntityCard.vue';
import ViewContext from './panels/ViewContext.vue';
import PinnedGrid from './panels/PinnedGrid.vue';
import PinUndoNotice from './panels/PinUndoNotice.vue';
import RadioStations from './panels/RadioStations.vue';
import RadioMiniPlayer from './panels/RadioMiniPlayer.vue';
import LocalReceiverPlayer from './panels/LocalReceiverPlayer.vue';
import DockedView from './panels/DockedView.vue';
import CctvTools from './panels/CctvTools.vue';
import { placeCctvTools, registerCctvToolsHome, returnCctvToolsHome } from '../cctvToolsPlacement.js';
import { CAMERA_SETTINGS_EVENT, CONTEXT_MISSIONS_EVENT, CONTEXT_SHOW_VIEW_EVENT, CONTEXT_NEARBY_EVENT, ESCAPE_OWNING_DIALOGS } from '../contextEvents.js';
import { useStreetLevelStore } from '../stores/streetLevel.js';
import { useDockedStore } from '../stores/docked.js';
import { useRadioLayer } from '../radioContext.js';
import { useSpaceMissionsStore } from '../stores/spaceMissions.js';
import {
  CONTEXT_LISTS,
  contextListChoice,
  contextListPresence,
  contextListsActive,
  leaveContextLists,
  listForLayer,
  listsOn,
  showContextList,
  shownList,
} from '../contextLists.js';
import RadioFold from './panels/RadioFold.vue';
import SdrCard from './panels/SdrCard.vue';
import CameraList from './panels/CameraList.vue';
import LivePanel from './panels/LivePanel.vue';
import StationPanel from './panels/StationPanel.vue';
import UiButton from '../kit/UiButton.vue';
import UiIcon from '../kit/UiIcon.vue';
import UiSearchField from '../kit/UiSearchField.vue';
import { closeContextSearch, contextNeedle, contextSearchOpen, contextSearchText } from '../contextSearch.js';

// While the Bhote Koshi event is on, its panel is the rail's only content.
const { visiblePanel: bhotePanel } = storeToRefs(useBhoteKoshiPanelStore());
// The Scene runtime chip SceneControls presents while a scene plays.
const { panel: scenePanel } = storeToRefs(useSceneStore());
const sceneRuntime = computed(() => scenePanel.value?.runtime ?? '');
// Context shows what is picked, led by its hero; with nothing picked, it
// summarises the layers that are on around the view.
const entityCards = useEntityCardStore();
const { card: entityCard } = storeToRefs(entityCards);
const cameraListHost = ref(null);
const cameraListMatches = ref(false);
const radioListMatches = ref(false);
const radioStations = ref(null);
const cameraListHome = ref(null);
const inlineCameraId = computed(() =>
  entityCard.value?.layerId === 'cctv' && !entityCards.fromPin && !entityCards.layerOff('cctv')
    ? entityCard.value.identity?.id ?? null
    : null,
);
const context = useContextStore();
const { phoneShell } = storeToRefs(useDisplayStore());
onMounted(() => {
  const body = globalThis.document?.body;
  if (body && globalThis.MutationObserver) {
    // Keep rail visibility current and undock when phone layout or Cockpit starts.
    bodyWatch = new MutationObserver(() => {
      railCovered.value = isContextRailModeCovered();
      if (docked.value && (body.classList.contains('mobile-shell') || body.classList.contains('cockpit-mode'))) setDocked(false);
    });
    bodyWatch.observe(body, { attributeFilter: ['class'] });
    railCovered.value = isContextRailModeCovered();
  }
  globalThis.document?.addEventListener('visibilitychange', updatePageVisibility);
  updatePageVisibility();
});
onBeforeUnmount(() => {
  bodyWatch?.disconnect();
  globalThis.document?.removeEventListener('visibilitychange', updatePageVisibility);
});
const missions = useSpaceMissionsStore();
// Keep the selected follow alive while Inspect shows Missions. A later pick
// or the end of the follow removes the temporary route back to that card.
const missionFollowGeneration = ref(null);
const missionsOverFollow = computed(() =>
  missions.enabled &&
  missionFollowGeneration.value === entityCards.selectionGeneration(),
);
const viewContextShown = computed(() => !entityCard.value || Boolean(inlineCameraId.value) || missionsOverFollow.value);
watch(missionsOverFollow, (showing) => {
  if (!showing) missionFollowGeneration.value = null;
});
// An explicit mission replay can take the camera. Keep its controls on
// screen once there is no longer a followed card to return to.
watch(() => entityCards.isFollowing(), (following) => {
  if (!following && missionsOverFollow.value) entityCards.clear();
});
// A nonempty grid adds the Pinned tab.
const pinned = usePinnedStore();
const { pins, tab: pinnedTab } = storeToRefs(pinned);
// Weather, News, Recent Imagery add a list while they are on.
// Their bodies stay mounted while another tab shows. Space Missions
// has its roster in Inspect.
const lists = computed(() => listsOn(contextListPresence));
const listShown = computed(() =>
  contextListsActive.value ? shownList(lists.value, contextListChoice.value) : '',
);
// A camera card adds a Camera settings tab while the Cameras layer is on.
const cameraSettingsAvailable = computed(() =>
  entityCard.value?.layerId === 'cctv' && Boolean(entityCard.value.identity?.id) && !entityCards.layerOff('cctv'),
);
const cctvState = useCctvStore();
const { settingsCameraId } = storeToRefs(cctvState);
const cameraSettingsShown = computed(() => cameraSettingsAvailable.value &&
  Boolean(settingsCameraId.value) && settingsCameraId.value === entityCard.value.identity.id &&
  settingsCameraId.value === cctvState.view?.activeCameraId);
const tab = computed(() =>
  listShown.value ? 'lists' : cameraSettingsShown.value ? 'camera' : pins.value.length ? pinnedTab.value : 'inspect',
);
const showInspect = computed(() => tab.value === 'inspect');
const searchAvailable = computed(() => showInspect.value || tab.value === 'camera');
const searchShown = computed(() => searchAvailable.value && contextSearchOpen.value);
watch(tab, (next) => context.setInspectorTab(next), { immediate: true, flush: 'sync' });
onBeforeUnmount(() => context.setInspectorTab('inspect'));
const tabIds = computed(() => [
  'inspect',
  ...(cameraSettingsAvailable.value ? ['camera'] : []),
  ...(lists.value.length ? ['lists'] : []),
  ...(pins.value.length ? ['pinned'] : []),
]);
// One rule for every list tab: its name and how many it holds, or, with
// nothing to count, why (as a tile says why it holds none).
const listLabel = (list) =>
  list.count !== null
    ? t('{name} · {count}', { name: t(list.label), count: formatNumber(list.count) })
    : list.reason
      ? t('{name} · {reason}', { name: t(list.label), reason: list.reason })
      : t(list.label);
const listTabLabel = computed(() => (lists.value.length > 1 ? t('Lists') : lists.value[0] ? listLabel(lists.value[0]) : ''));
function selectTab(id) {
  if (id === 'camera') return showCameraSettings();
  settingsCameraId.value = null;
  if (id === 'lists') showContextList(shownList(lists.value, contextListChoice.value));
  else pinned.show(id);
}
// The tools act on the active camera, so showing them for a camera card that
// is not the active camera's makes it active first.
async function showCameraSettings() {
  if (!cameraSettingsAvailable.value) return;
  const card = entityCard.value;
  if (cctvState.view?.activeCameraId !== card.identity.id) {
    entityCards.open(card.identity, { fromPin: entityCards.fromPin });
    await nextTick();
    if (!cameraSettingsAvailable.value || entityCard.value.key !== card.key || cctvState.view?.activeCameraId !== card.identity.id) return;
  }
  pinned.show('inspect');
  leaveContextLists();
  settingsCameraId.value = card.identity.id;
}
function revealCameraSettings() {
  if (!cameraSettingsAvailable.value) return;
  // On phones the Context sheet opens the panel as part of its normal reveal.
  chrome.act('reveal', 'global-context-panel');
  openContext();
  return showCameraSettings();
}
watch(cameraSettingsShown, (shown) => { if (!shown) settingsCameraId.value = null; });
onBeforeUnmount(() => { settingsCameraId.value = null; });
// Anything that shows Inspect or Pinned (a new pick, a station, a pin's
// tile) leaves the list tab.
onBeforeUnmount(
  pinned.$onAction(({ name }) => {
    if (name !== 'show') return;
    leaveContextLists();
    settingsCameraId.value = null;
  }),
);
// A list shown (a layer turned on, voice) leaves Camera settings too.
watch(listShown, (shown, previous) => {
  if (shown) settingsCameraId.value = null;
  else if (previous && !lists.value.length) pinned.show('inspect');
});
// A list layer a person turned on directly shows its list; one a link or a
// restore turned on does not take Context over.
const DIRECT_ON_MS = 15_000;
watch(
  () => entityCards.lastDirectOn,
  (direct, _, onCleanup) => {
    const list = listForLayer(direct?.layerId);
    if (!list) return;
    const open = () => {
      if (Date.now() - direct.at < DIRECT_ON_MS) showContextList(list);
    };
    if (contextListPresence[list]) open();
    else onCleanup(watch(() => Boolean(contextListPresence[list]), open, { once: true }));
  },
);
// Any list going while focus is on its sub-tab or in its list hands focus to
// the list that shows then: its sub-tab, or the Lists tab when it is the
// only one left. The Lists tab going is handled with the other tabs below.
watch(
  () => lists.value.map((list) => list.id),
  (ids, before) => {
    const doc = globalThis.document;
    const focused = doc?.activeElement;
    const gone = before.filter((id) => !ids.includes(id));
    const stripGone = ids.length === 1 && before.length > 1 && focused?.closest?.('.context-list-tabs');
    if (!ids.length || !(stripGone || gone.some((id) => focused?.closest?.(`#context-list-tab-${id}, #context-list-${id}`)))) return;
    void nextTick(() =>
      (doc.getElementById(`context-list-tab-${listShown.value}`) ?? doc.getElementById('context-tab-lists'))?.focus({ preventScroll: true }),
    );
  },
);
// A tab that goes while it has focus (Lists, when its last list
// layer goes off; Camera settings, when Cameras go off) hands focus to the
// tab that shows then, else Inspect, else Context's body.
watch(tabIds, (ids, before) => {
  const doc = globalThis.document;
  const gone = before.filter((id) => !ids.includes(id));
  const focused = doc?.activeElement;
  const stripGone = before.length > 1 && ids.length === 1 && focused?.closest('.context-pin-tabs--main');
  const focusLeaving = gone.some((id) => {
    if (focused?.closest(`#context-tab-${id}`)) return true;
    if (id === 'camera') return focused?.closest('#cctv-tools-slot');
    if (id === 'lists') return focused?.closest('#context-lists');
    return false;
  });
  if (!stripGone && !focusLeaving) return;
  void nextTick(() =>
    (doc.getElementById(`context-tab-${tab.value}`) ?? doc.getElementById('context-tab-inspect') ?? contextScroller.value)?.focus({ preventScroll: true }),
  );
});
// Radio: with the layer on, its stations show in Context while nothing is
// picked; the station selected or heard is in the mini player as well,
// whatever Context shows. Tapping a pinned station plays it and leaves
// Radio as it is (pinnedStation.js).
const { module: radioModule, ui: radioUi } = useRadioLayer();
// Whether Context is showing the station list right now.
// On a phone Context is on screen only while its sheet is open; the phone
// shell publishes whether it is on and its open sheet.
const contextOnScreen = computed(() => !phoneShell.value?.enabled || phoneShell.value.sheet === 'context');
const radioListShown = computed(() =>
  Boolean(contextOpen.value && showInspect.value && viewContextShown.value && !inlineCameraId.value && radioUi.value?.enabled && contextOnScreen.value),
);
// Returning to Nearby clears the card and cancels a pending photo.
// A settled photo remains available.
function showNearby() {
  entityCards.clear();
  pinned.show('inspect');
}
// A globe station pick reveals its list only while Cockpit does not own the camera.
function showStations() {
  if (!cockpit.value?.active) showNearby();
}
// Radio turned on only brings Inspect forward: a picked (or followed) item
// stays, and its stations show once it is let go.
const showInspectTab = () => pinned.show('inspect');
function showMissions(event) {
  if (!missions.enabled) return;
  const focusWasOnCard = globalThis.document?.activeElement?.closest('#entity-card');
  // A globe pick has already released the camera; the card's follow report can lag.
  missionFollowGeneration.value = event?.detail?.keepFollow !== false && entityCards.isFollowing()
    ? entityCards.selectionGeneration()
    : null;
  if (!missionsOverFollow.value) entityCards.clear();
  pinned.show('inspect');
  if (missionsOverFollow.value && focusWasOnCard)
    void nextTick(() => contextScroller.value?.querySelector('[data-missions-back]')?.focus());
}
watch(() => missions.enabled, (enabled) => {
  if (enabled || !globalThis.document?.activeElement?.closest('.nearby-missions, [data-missions-back]')) return;
  void nextTick(() => {
    const scroller = contextScroller.value;
    const target = scroller?.querySelector('.entity-card__close') ?? scroller?.querySelector('#context-tab-inspect') ?? scroller;
    target?.focus({ preventScroll: true });
  });
});
function returnToFollowedCard() {
  missionFollowGeneration.value = null;
  // A mission picked over the follow goes with the list: once the followed
  // card is back, its replay and isolation would have no controls. The
  // layer keeps the follow (selection.js releases the camera only when
  // nothing is followed).
  if (missions.mission) missions.layer?.deselectMission?.();
  void nextTick(() => contextScroller.value?.querySelector('.entity-card__close')?.focus());
}
onMounted(() => {
  globalThis.document?.addEventListener('gev:radio-selected', showStations);
  globalThis.document?.addEventListener('gev:radio-show-stations', showInspectTab);
  globalThis.document?.addEventListener(CONTEXT_NEARBY_EVENT, showNearby);
  globalThis.document?.addEventListener(CONTEXT_MISSIONS_EVENT, showMissions);
  globalThis.document?.addEventListener(CAMERA_SETTINGS_EVENT, revealCameraSettings);
});
onBeforeUnmount(() => {
  globalThis.document?.removeEventListener('gev:radio-selected', showStations);
  globalThis.document?.removeEventListener('gev:radio-show-stations', showInspectTab);
  globalThis.document?.removeEventListener(CONTEXT_NEARBY_EVENT, showNearby);
  globalThis.document?.removeEventListener(CONTEXT_MISSIONS_EVENT, showMissions);
  globalThis.document?.removeEventListener(CAMERA_SETTINGS_EVENT, revealCameraSettings);
});
// Arrow keys move between the tabs, as on any tab list: the next or the
// previous one, without wrapping; Home and End go to the first and the last.
function stepTab(event, ids, current) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return null;
  event.preventDefault();
  // The first tab comes first in reading order: left in left-to-right, right in RTL.
  const rtl = globalThis.getComputedStyle?.(event.currentTarget)?.direction === 'rtl';
  if (event.key === 'Home') return ids[0];
  if (event.key === 'End') return ids.at(-1);
  const step = event.key === (rtl ? 'ArrowRight' : 'ArrowLeft') ? -1 : 1;
  const at = Math.max(0, ids.indexOf(current));
  return ids[Math.min(ids.length - 1, Math.max(0, at + step))];
}
// The scrolling part of the tab row: its end fades while tabs are out of
// view there, and the selected tab is scrolled into view.
const tabStrip = ref(null);
const tabsClipped = ref(false);
function measureTabStrip() {
  const strip = tabStrip.value;
  // Right to left, scrollLeft runs from 0 down to negative values.
  tabsClipped.value = Boolean(strip && Math.abs(strip.scrollLeft) + strip.clientWidth < strip.scrollWidth - 1);
}
function onTabKey(event) {
  const next = stepTab(event, tabIds.value, tab.value);
  if (!next) return;
  selectTab(next);
  void nextTick(() => globalThis.document?.getElementById(`context-tab-${next}`)?.focus());
}
function onListKey(event) {
  const next = stepTab(event, lists.value.map((list) => list.id), listShown.value);
  if (!next) return;
  showContextList(next);
  void nextTick(() => globalThis.document?.getElementById(`context-list-tab-${next}`)?.focus());
}

// Desktop Esc clears the Inspect pick, then closes search, then reaches the
// panel's collapse handler. Each press handles one step.
const contextScroller = ref(null);
// On a phone the search field's own Esc closes the search: the field stops
// the key, so the sheet never sees it.
function onSearchEscape() {
  if (!globalThis.document?.body?.classList.contains('mobile-shell')) return;
  closeContextSearch();
  contextScroller.value?.focus({ preventScroll: true });
}
function onEscape(event) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  if (!event.target?.closest?.('#global-context-panel')) return;
  // Folded, Context shows no pick and no search: Esc leaves them.
  if (!contextOpen.value) return;
  // Capture runs before the tuner or a control with its own Escape handler.
  if (event.target.closest('.radio-tuner, [data-owns-escape]')) return;
  // A full-screen street-level photo shrinks first (StreetLevelControls).
  if (streetLevel.expanded) return;
  // An open dialog keeps its Esc. A camera's enlarged view (CctvPreview)
  // takes it at the document, before this handler, and stops it; one still
  // open here is left alone all the same.
  if (globalThis.document?.querySelector(ESCAPE_OWNING_DIALOGS)) return;
  // On a phone, Esc (back) closes the sheet first, as every sheet does.
  if (globalThis.document?.body?.classList.contains('mobile-shell')) return;
  // Focus inside the card or the search goes with them; it moves to the
  // panel first, so the next Esc still reaches Context.
  if (showInspect.value && missionsOverFollow.value) {
    event.preventDefault();
    returnToFollowedCard();
    return;
  }
  const leaving = event.target.closest('#entity-card, .context-search');
  if (entityCard.value && showInspect.value) entityCards.clear();
  else if (searchShown.value) closeContextSearch();
  else return;
  event.preventDefault();
  if (leaving || !event.target.isConnected) contextScroller.value?.focus({ preventScroll: true });
}

// A new pick starts at the top of the panel, not wherever the last one was
// scrolled to, and shows on Inspect.
watch(
  [() => entityCard.value?.key, () => entityCards.selectionGeneration()],
  async ([key, generation], [previous, previousGeneration]) => {
    if (!key || generation === previousGeneration) return;
    pinned.show('inspect');
    if (key === previous) return;
    await nextTick();
    const card = globalThis.document?.getElementById('entity-card');
    const sheet = card?.closest('body.mobile-shell #right-context-rail');
    const scroller = sheet ?? card?.closest('.global-context-panel-inner');
    scroller?.scrollTo({ top: 0, behavior: sheet ? 'instant' : 'smooth' });
  },
);

// Search in the header: a field that narrows what Context is showing, the
// selected item's details and every list of what is nearby or in view.
const searchInput = ref(null);
watch(searchAvailable, (available) => {
  const doc = globalThis.document;
  const focused = doc?.activeElement;
  if (available || !focused?.closest('#global-context-panel :is(.context-search, .context-search-toggle)')) return;
  void nextTick(() => {
    if (searchAvailable.value || (doc.activeElement !== focused && doc.activeElement !== doc.body)) return;
    (doc.getElementById(`context-tab-${tab.value}`) ?? contextScroller.value)?.focus({ preventScroll: true });
  });
});
function toggleSearch() {
  if (contextSearchOpen.value) return closeContextSearch();
  contextSearchOpen.value = true;
  void nextTick(() => searchInput.value?.focus());
}
const searchHint = computed(() =>
  entityCard.value && !missionsOverFollow.value && (!inlineCameraId.value || showInspect.value) ? t('Search {name} and nearby', { name: sayWords(entityCard.value.titleWords, entityCard.value.title) }) : t('Search what is in view'),
);

// Expanded, Context becomes a full-height column over the right edge of the
// screen, with the globe left as it is underneath. It shrinks back when the
// panel closes.
const docked = ref(false);
const dockedViews = useDockedStore();
const chrome = usePanelChromeStore();
const { panels: chromePanels } = storeToRefs(chrome);
let bodyWatch = null;
function setDocked(next) {
  docked.value = next;
  // The column covers the corner: the docked view hides and pauses meanwhile.
  dockedViews.setStowed(next);
  const body = globalThis.document?.body;
  body?.classList.toggle('context-docked', next);
}
const railCovered = ref(isContextRailModeCovered());
const pageVisible = ref(globalThis.document?.visibilityState !== 'hidden');
function showView(event) {
  if (event?.detail?.list === 'news') {
    showContextList('news');
    if (chromePanels.value['global-context-panel']?.collapsed) chrome.act('toggle', 'global-context-panel');
    chrome.act('reveal', 'global-context-panel');
  } else if (event?.detail?.inspect === true) selectTab('inspect');
}
onMounted(() => globalThis.addEventListener?.(CONTEXT_SHOW_VIEW_EVENT, showView));
onBeforeUnmount(() => globalThis.removeEventListener?.(CONTEXT_SHOW_VIEW_EVENT, showView));
function updatePageVisibility() {
  pageVisible.value = globalThis.document?.visibilityState !== 'hidden';
}
// A reply can arrive before the observer or visibility event updates Vue.
const readInspectorVisibility = () =>
  !isContextRailModeCovered() && !bhotePanel.value && globalThis.document?.visibilityState !== 'hidden';
// Only an open panel reads what is picked and in view; closed, it does no work.
const contextOpen = computed(() => chromePanels.value['global-context-panel']?.collapsed === false);
const { presence: cockpit } = storeToRefs(useCockpitStore());
const inspectorMount = ref(null);
const viewContextPresent = computed(() => showInspect.value && viewContextShown.value);
const contextSurfaceShown = computed(() =>
  contextOpen.value &&
  pageVisible.value &&
  !railCovered.value &&
  !bhotePanel.value &&
  contextOnScreen.value &&
  !cockpit.value?.active,
);
const contextViewShown = computed(() => contextSurfaceShown.value && showInspect.value);
provide('contextViewShown', contextViewShown);
const inspectorShown = computed(() =>
  inspectorMount.value !== null && viewContextPresent.value && contextViewShown.value,
);
const inspectorTab = ref(null);
let keyboardOrigin = null;
// Keep keyboard focus with the selected card, then return it to the originating row.
async function focusKeyboardSelection(rowKey) {
  const generation = entityCards.selectionGeneration();
  await nextTick();
  const cardKey = entityCard.value?.key;
  const close = inspectorTab.value?.querySelector('.entity-card__close');
  if (!cardKey || entityCards.selectionGeneration() !== generation || !close) return;
  keyboardOrigin = { rowKey, cardKey, generation };
  close.focus();
}
watch(() => entityCard.value?.key, async (key, previous) => {
  const origin = keyboardOrigin;
  if (!origin || key === origin.cardKey) return;
  if (key && origin.generation === entityCards.selectionGeneration()) {
    origin.cardKey = key;
    return;
  }
  keyboardOrigin = null;
  if (key || previous !== origin.cardKey || !inspectorTab.value?.contains(document.activeElement)) return;
  await nextTick();
  if (!inspectorShown.value || entityCard.value) return;
  const inspector = inspectorTab.value?.querySelector('.view-context');
  const row = [...(inspector?.querySelectorAll('[data-row-key]') || [])]
    .find((candidate) => candidate.dataset.rowKey === origin.rowKey);
  (row || inspector)?.focus();
});
watch(
  [inspectorShown, inspectorMount],
  ([shown, mountId]) => entityCards.setViewContextShown(shown, mountId, readInspectorVisibility),
  { immediate: true, flush: 'sync' },
);
// A later mount starts as the button says: not expanded.
onBeforeUnmount(() => setDocked(false));
onBeforeUnmount(() => entityCards.setViewContextShown(false, null));
const panelChrome = usePanelChromeStore();
// The folded name goes as the panel opens: opened from the keyboard, focus
// moves to the expanded header's fold button.
function openContext(event) {
  if (contextOpen.value) return;
  panelChrome.act('toggle', 'global-context-panel');
  if (event?.detail !== 0 || !contextOpen.value) return;
  void nextTick(() => globalThis.document?.querySelector('#global-context-panel .panel-collapse-btn')?.focus({ preventScroll: true }));
}
// Keyboard Close returns to Context when visible, or to the phone tab bar.
function onMiniPlayerClosed(event) {
  if (event?.detail !== 0) return;
  void nextTick(() => {
    const doc = globalThis.document;
    if (!contextOnScreen.value) {
      const tabs = doc?.getElementById('mobile-tab-bar');
      (tabs?.querySelector('button[aria-expanded="true"]') ?? tabs?.querySelector('button'))?.focus({ preventScroll: true });
      return;
    }
    (contextOpen.value ? contextScroller.value : doc?.querySelector('#global-context-panel .context-title-open'))?.focus({ preventScroll: true });
  });
}
watch(
  () => chromePanels.value['global-context-panel']?.collapsed,
  (collapsed) => {
    if (collapsed && docked.value) setDocked(false);
  },
);
const radioFoldHome = ref(null);

// The camera tools move into the Camera settings slot when it mounts and
// back home before it unmounts (its vnode hooks in the template). A post
// watcher cannot do it: any render() of another root inside the same flush
// (the Québec overlay's repaint) runs post watchers before this panel has
// rendered.
const cctvToolsHome = ref(null);
onMounted(() => registerCctvToolsHome(cctvToolsHome.value));
const cctvToolsSlotShown = computed(() => contextOpen.value && contextOnScreen.value && tab.value === 'camera' && !contextNeedle.value);
watch(() => cctvToolsSlotShown.value && contextSurfaceShown.value, (shown) => {
  cctvState.settingsVisible = shown;
}, { immediate: true });
onBeforeUnmount(() => { cctvState.settingsVisible = false; });
watch(cctvToolsSlotShown, (shown) => {
  if (shown) return;
  const doc = globalThis.document;
  const restore = contextOnScreen.value && tab.value !== 'camera' && doc?.activeElement?.closest('#cctv-tools-slot');
  returnCctvToolsHome();
  if (restore) void nextTick(() =>
    (doc.getElementById(`context-tab-${tab.value}`) ?? contextScroller.value)?.focus({ preventScroll: true }),
  );
}, { flush: 'pre' });
onBeforeUnmount(() => {
  returnCctvToolsHome();
  registerCctvToolsHome(null);
});

const streetLevel = useStreetLevelStore();
// Card maps use non-Google imagery. Keep other previews and pin controls
// available while a Google panorama can be seen alongside them.
const contextMapsAllowed = computed(() => {
  const street = streetLevel.view;
  const viewer = street?.viewer;
  const owner = dockedViews.view;
  const dockVisible = owner?.kind === 'street' && !dockedViews.stowed;
  const lifted = streetLevel.expanded || streetLevel.embedOverlay;
  if (!dockVisible && !lifted) return true;
  if (street?.dockPhotoLoading && dockVisible &&
    (viewer?.openingPaidPhoto || owner.identity.id.startsWith('google:'))) return false;
  const photo = viewer?.photo;
  return !(viewer?.open && photo?.id?.startsWith('google:') &&
    (lifted || (!street.dockPhotoUnavailable && owner.identity.id === photo.id)));
});
provide('contextMapsAllowed', contextMapsAllowed);
watch(
  [() => entityCard.value?.key, tab, contextOpen, () => streetLevel.expanded, () => streetLevel.view?.viewer?.openingPaidPhoto],
  placeStreetLevelViewer,
  { flush: 'post' },
);
// Picking a different item (not another photo's card) closes the photo,
// whether it shows on a card, waits in its home with no card, or is still
// loading, so a late load cannot open after the pick. It runs inside the
// pick, before anything else reacts to it.
const pickClosesPhoto = (card) => card != null && card.layerId !== STREET_LEVEL_LAYER;
watch(
  [() => entityCard.value?.key, () => Boolean(streetLevel.expanded || streetLevel.embedOverlay)],
  ([key, lifted], [previousKey]) => {
    if (!pickClosesPhoto(entityCard.value)) return;
    if (dockedViews.view?.kind === 'street') return;
    const photo = streetLevel.view?.viewer.photo;
    if (photo && pinned.isPinned(`street-level:${photo.id}`)) {
      const street = entityCards.layerModule(STREET_LEVEL_LAYER)?.getUIState?.()?.street;
      if (!street?.loading && !street?.opening) {
        // Keep the accepted photo available, but pause its offscreen sequence.
        if (!lifted) streetLevel.act('stopPlayback');
        return;
      }
    }
    if (key !== previousKey) streetLevel.act('withdrawPhoto');
  },
  { flush: 'sync' },
);
// The photo card's × closes the photo. Another photo's card, a click on open
// ground or map Escape cancels only a photo still loading for that card; a
// photo already showing goes back to its offscreen home and stays open.
watch(entityCard, (next, previous) => {
  if (previous?.layerId !== STREET_LEVEL_LAYER || next?.key === previous.key || pickClosesPhoto(next)) return;
  const dismissed = entityCards.wasDismissed(previous.key);
  if (dockedViews.isDocked(previous.key)) {
    if (dismissed) dockedViews.close();
    return;
  }
  streetLevel.act('closePhoto', previous.identity?.id, { pendingOnly: !dismissed });
  // Escape or open ground leaves the photo open in its offscreen home: its
  // sequence stops there. A photo still visible (EXPAND, the embed overlay)
  // or a street dock (the one viewer is the dock's) plays on; × already closed it.
  if (!next && !dismissed && !streetLevel.expanded && !streetLevel.embedOverlay &&
      dockedViews.view?.kind !== 'street') streetLevel.act('stopPlayback');
});
// The docked view and the radio mini player are part of the right column:
// at its foot under an open Context, with the panel's edges and width; the
// column's layout keeps room for them (data-corner-reserve,
// rightPanelRail.js), so Context gives up that height and the whole column
// stays clear of the corner buttons and the HUD readouts. Folded, they sit
// under Context's tab, across the column.
const contextCorner = ref(null);
let cornerObserver = null;
/** The longest the dock and the mini player wait unseen for room. */
const SETTLING_MAX_MS = 600;
let settlingTimer = 0;
let liftFrame = 0;
function setCornerReserve(stack, pixels = 0) {
  if (!stack) return;
  if (!pixels) {
    if (stack.dataset.cornerReserve !== undefined) delete stack.dataset.cornerReserve;
  } else if (stack.dataset.cornerReserve !== String(pixels)) {
    stack.dataset.cornerReserve = String(pixels);
  }
}
function clearColumn(corner, stack) {
  corner.classList.remove('context-corner--column', 'context-corner--mini-first', 'context-corner--settling');
  for (const prop of ['inset-inline-end', 'width', 'top', 'bottom']) corner.style.removeProperty(prop);
  setCornerReserve(stack);
}
function placeInColumn(corner, stack, across) {
  const gap = parseFloat(globalThis.getComputedStyle?.(stack)?.rowGap) || 8;
  const rtl = globalThis.getComputedStyle?.(corner)?.direction === 'rtl';
  const end = rtl ? across.left : globalThis.innerWidth - across.right;
  corner.classList.add('context-corner--column');
  corner.style.setProperty('inset-inline-end', `${Math.round(end)}px`);
  corner.style.setProperty('width', `${Math.round(across.width)}px`);
  return gap;
}
// With Context closed and no docked view, the radio mini player stands in
// the clear space above the bottom-right HUD readout: the column's width
// and right edge, one gap above the readout, so it covers neither the
// readout nor the corner buttons below it. False when there is no readout
// to stand on.
function aboveHudReadout(corner, stack) {
  const hud = globalThis.document.querySelector('#intel-hud .hud-bottom-right')?.getBoundingClientRect();
  const across = stack.getBoundingClientRect();
  if (!hud?.height || !across.width) return false;
  const gap = placeInColumn(corner, stack, across);
  corner.style.setProperty('top', 'auto');
  corner.style.setProperty('bottom', `${Math.round(globalThis.innerHeight - hud.top + gap)}px`);
  setCornerReserve(stack);
  return true;
}
// With Context closed and a docked view, the dock keeps its own place (the
// corner's usual spot) and the mini player fits around it, the same width,
// one gap away: under the dock while that leaves it clear of the HUD
// readout, otherwise above the dock.
function besideDock(corner, dock, mini) {
  const style = globalThis.getComputedStyle?.(corner);
  const gap = parseFloat(style?.rowGap) || 6;
  const dockBottom = globalThis.innerHeight - (parseFloat(style?.bottom) || 0);
  const dockTop = dockBottom - dock.offsetHeight;
  const hud = globalThis.document.querySelector('#intel-hud .hud-bottom-right')?.getBoundingClientRect();
  const limit = hud?.height ? hud.top - gap : globalThis.innerHeight;
  if (dockBottom + gap + mini.offsetHeight <= limit) {
    corner.style.setProperty('top', `${Math.round(dockTop)}px`);
    corner.style.setProperty('bottom', 'auto');
  } else corner.classList.add('context-corner--mini-first');
}
function alignCorner() {
  const doc = globalThis.document;
  const corner = contextCorner.value;
  if (!corner || !doc) return;
  const panel = doc.getElementById('global-context-panel');
  const stack = doc.getElementById('right-context-rail');
  // A phone: a smaller tile just above the voice bar and the tab bar
  // (entity-card.css reads --phone-dock-bottom), clear of the rail and the
  // timeline.
  if (doc.body.classList.contains('mobile-shell')) {
    clearColumn(corner, stack);
    const bar = doc.getElementById('command-dock')?.getBoundingClientRect();
    if (bar?.height) corner.style.setProperty('--phone-dock-bottom', `${Math.round(globalThis.innerHeight - bar.top + 8)}px`);
    else corner.style.removeProperty('--phone-dock-bottom');
    return;
  }
  const panelBox = panel?.getBoundingClientRect();
  const open = Boolean(panelBox?.height) && !panel.classList.contains('collapsed');
  const mini = corner.querySelector('.radio-mini');
  const dock = corner.querySelector('.docked-view');
  if (stack && !open && mini) {
    if (!dock && aboveHudReadout(corner, stack)) return;
    if (dock) {
      clearColumn(corner, stack);
      return besideDock(corner, dock, mini);
    }
  }
  if (!stack || !panelBox?.height) return clearColumn(corner, stack);
  corner.classList.remove('context-corner--mini-first');
  const across = open ? panelBox : stack.getBoundingClientRect();
  const gap = placeInColumn(corner, stack, across);
  // The dock and mini player sit at the column's foot. The open panel
  // reserves their measured height in one layout pass.
  const foot = parseFloat(stack.dataset.columnBottom);
  if (open && !docked.value && Number.isFinite(foot)) {
    corner.style.setProperty('top', 'auto');
    corner.style.setProperty('bottom', `${Math.round(globalThis.innerHeight - foot)}px`);
  } else {
    corner.style.setProperty('top', `${Math.round(panelBox.bottom + gap)}px`);
    corner.style.setProperty('bottom', 'auto');
  }
  const reserve = open && corner.offsetHeight ? Math.round(corner.offsetHeight + gap) : 0;
  // Until the column has given up their room, the panel still runs down
  // over them: they wait unseen for that one layout instead of showing over
  // the panel's last rows (the column's style change measures again).
  // A panel that cannot shrink that far (a very short window) shows them
  // anyway after a moment, so they never stay hidden.
  const over = open && corner.offsetHeight && panelBox.bottom > corner.getBoundingClientRect().top;
  if (!over) {
    clearTimeout(settlingTimer);
    settlingTimer = 0;
    corner.classList.remove('context-corner--settling');
  } else if (!settlingTimer) {
    corner.classList.add('context-corner--settling');
    settlingTimer = setTimeout(() => contextCorner.value?.classList.remove('context-corner--settling'), SETTLING_MAX_MS);
  }
  setCornerReserve(stack, reserve);
}
function liftHudCorner() {
  liftFrame = 0;
  alignCorner();
}
// After the layout settles; a timer, not a frame, so a background tab
// measures too.
// Measured once more after the column's top has eased into place, so the
// dock follows a move that settles after the first look.
const SETTLE_MS = 400;
let settleTimer = 0;
const queueLift = () => {
  liftFrame ||= setTimeout(liftHudCorner, 0);
  clearTimeout(settleTimer);
  settleTimer = setTimeout(liftHudCorner, SETTLE_MS);
};
// Docking, undocking and the mini player coming or going re-measure at once.
watch([() => dockedViews.view?.key, () => radioUi.value?.selected?.id, () => radioUi.value?.audioState, radioListShown, contextOpen, docked], () => nextTick(queueLift));
// A HUD style or a layout change (cockpit, a timeline, a narrower window)
// moves the readouts without resizing anything: the body's and the HUD's
// attributes are watched too.
let layoutObserver = null;
onMounted(() => {
  queueLift();
  globalThis.addEventListener?.('resize', queueLift);
  if (typeof ResizeObserver === 'function' && contextCorner.value) {
    cornerObserver = new ResizeObserver(queueLift);
    cornerObserver.observe(contextCorner.value);
    const hud = globalThis.document?.querySelector('#intel-hud .hud-bottom-right');
    if (hud) cornerObserver.observe(hud);
    const panel = globalThis.document?.getElementById('global-context-panel');
    if (panel) cornerObserver.observe(panel);
    const voiceBar = globalThis.document?.getElementById('command-dock');
    if (voiceBar) cornerObserver.observe(voiceBar);
  }
  if (typeof MutationObserver === 'function' && globalThis.document?.body) {
    layoutObserver = new MutationObserver(queueLift);
    layoutObserver.observe(globalThis.document.body, { attributes: true, attributeFilter: ['class'] });
    const hudRoot = globalThis.document.getElementById('intel-hud');
    if (hudRoot) layoutObserver.observe(hudRoot, { attributes: true });
    // The column moves Context without resizing it (its top rises or
    // settles): its own style changes say so, and the dock follows.
    const column = globalThis.document.getElementById('right-context-rail');
    if (column) {
      layoutObserver.observe(column, { attributes: true, attributeFilter: ['style', 'class'] });
      // Its top eases into place: measure again once it has arrived.
      column.addEventListener('transitionend', queueLift);
    }
  }
});
onBeforeUnmount(() => {
  cornerObserver?.disconnect();
  layoutObserver?.disconnect();
  globalThis.document?.getElementById('right-context-rail')?.removeEventListener('transitionend', queueLift);
  globalThis.removeEventListener?.('resize', queueLift);
  clearTimeout(liftFrame);
  clearTimeout(settleTimer);
  clearTimeout(settlingTimer);
  if (contextCorner.value) clearColumn(contextCorner.value, globalThis.document?.getElementById('right-context-rail'));
});

// The selected tab is scrolled into view, and the row's fade measured again,
// whenever the tabs or the panel change.
watch([tab, () => tabIds.value.length, contextOpen], async () => {
  await nextTick();
  const selected = globalThis.document?.getElementById(`context-tab-${tab.value}`);
  if (selected && tabStrip.value?.contains(selected)) selected.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  measureTabStrip();
});

// A notice held under the pointer or focus is let go when Context closes.
watch(contextOpen, (open) => open || pinned.releaseNotice());
</script>

<template>
  <!-- Global Context is deliberately independent from the left layer accordion. -->
  <aside id="right-context-rail" class="ui-scroll" v-class-toggle="{ 'bhote-event-active': !!bhotePanel }" @keydown.capture="onEscape">
    <RailPanel id="global-context-panel" start-collapsed :title="t('CONTEXT')" sideways scroll rail-scroller>
        <!-- Folded, the name opens the panel too, not only the ◀ button. -->
        <template #title>
          <UiButton v-if="!contextOpen" class="ui-panel__title panel-title context-title-open" :label="t('Expand {name}', { name: t('CONTEXT') })" :native-title="false" @click="openContext">{{ t('CONTEXT') }}</UiButton>
          <span v-else class="ui-panel__title panel-title">{{ t('CONTEXT') }}</span>
        </template>
        <template #actions>
          <UiButton v-if="searchAvailable" class="context-dock-btn context-search-toggle" :pressed="searchShown" :aria-label="t('Search in Context')" :title="contextSearchOpen ? t('Close search') : t('Search in Context')" @click="toggleSearch">
            <UiIcon name="search" :size="null" />
          </UiButton>
          <UiButton class="context-dock-btn" :pressed="Boolean(docked)" :aria-label="t('Expand Context to a full-height column')" :title="docked ? t('Shrink') : t('Expand')" @click="setDocked(!docked)">
            <UiIcon :name="docked ? 'close_fullscreen' : 'open_in_full'" :size="null" />
          </UiButton>
        </template>
        <div ref="contextScroller" class="cyber-panel-body ui-scroll" data-rail-scroller tabindex="-1">
        <UiSearchField v-if="searchShown" ref="searchInput" v-model="contextSearchText" class="context-search" @escape="onSearchEscape" role="search" input-class="context-search__input" :label="searchHint" :placeholder="searchHint" autocomplete="off" spellcheck="false" :clear-label="t('Clear search')" clear-class="context-search__clear" />
        <div v-if="contextOpen" id="context-body" ref="inspectorTab" :class="{ 'context-searching': searchShown && contextSearchText.trim() }">
          <div v-if="tabIds.length > 1" class="context-pin-tabs context-pin-tabs--main" role="tablist" :aria-label="t('Context')" @keydown="onTabKey">
            <!-- Inspect holds the start of the row; the other tabs scroll
                 beside it on one line, the row's end fading while more are
                 out of view. -->
            <UiButton id="context-tab-inspect" role="tab" :aria-selected="String(tab === 'inspect')" :tabindex="tab === 'inspect' ? 0 : -1" aria-controls="context-tab-panel" @click="selectTab('inspect')">{{ t('Inspect') }}</UiButton>
            <div ref="tabStrip" class="context-pin-tabs__strip" :class="{ 'is-clipped': tabsClipped }" role="presentation" @scroll.passive="measureTabStrip">
            <UiButton v-if="cameraSettingsAvailable" id="context-tab-camera" role="tab" :aria-selected="String(tab === 'camera')" :tabindex="tab === 'camera' ? 0 : -1" aria-controls="context-tab-panel" @click="selectTab('camera')">{{ t('Camera settings') }}</UiButton>
            <UiButton v-if="lists.length" id="context-tab-lists" role="tab" :aria-selected="String(tab === 'lists')" :tabindex="tab === 'lists' ? 0 : -1" aria-controls="context-lists" @click="selectTab('lists')">{{ listTabLabel }}</UiButton>
            <UiButton v-if="pins.length" id="context-tab-pinned" role="tab" :aria-selected="String(tab === 'pinned')" :tabindex="tab === 'pinned' ? 0 : -1" aria-controls="context-tab-panel" @click="selectTab('pinned')">
              {{ t('Pinned · {n}', { n: formatNumber(pins.length) }) }}
            </UiButton>
            </div>
          </div>
          <!-- Unpinning offers Undo here, above the tabs, so it stays when the
               last pin (and the Pinned tab) goes. -->
          <PinUndoNotice />
          <!-- Kept in the page, hidden, while a list shows: the other tabs
               control it. -->
          <div id="context-tab-panel" :hidden="tab === 'lists'" :role="tabIds.length > 1 ? 'tabpanel' : undefined" :aria-labelledby="tabIds.length > 1 ? `context-tab-${tab === 'lists' ? 'inspect' : tab}` : undefined">
            <template v-if="tab === 'lists'"></template>
            <div v-else-if="showInspect" id="context-tab-view">
              <!-- Keep the viewer attached until placement can move it to the accepted card. -->
              <div
                v-show="streetLevel.view?.viewer?.openingPaidPhoto"
                id="sl-viewer-loading-slot"
                class="sl-hero__slot"
                @vue:before-unmount="returnStreetLevelViewerHome('sl-viewer-loading-slot')"
              ></div>
              <UiButton v-if="entityCard && missionsOverFollow" data-missions-back variant="action" size="compact" @click="returnToFollowedCard">
                <UiIcon name="chevron_left" :size="null" />{{ t('Back to {name}', { name: entityCard.title }) }}
              </UiButton>
              <EntityCard v-else-if="!inlineCameraId" />
              <ViewContext v-if="viewContextPresent" :inline-camera="Boolean(inlineCameraId)" :inline-spatial-card="Boolean(inlineCameraId && !missionsOverFollow && Number.isFinite(entityCard?.lat) && Number.isFinite(entityCard?.lon))" :list-search-matches="cameraListMatches || (radioListShown && radioListMatches)" @vue:mounted="inspectorMount = Symbol()" @vue:before-unmount="inspectorMount = null" @keyboard-selection="focusKeyboardSelection">
                <!-- Radio shows only the source chosen on its row: the
                     internet stations, or the local receiver. -->
                <template #cameras><div ref="cameraListHost"></div></template>
                <template #lead><RadioStations ref="radioStations" :module="radioModule" :ui="radioUi" @has-matches="radioListMatches = $event" /><LocalReceiverPlayer v-if="radioUi?.localReceiver" /></template>
              </ViewContext>
            </div>
            <!-- The camera's tools, moved in while this tab shows. -->
            <div v-else-if="tab === 'camera'" class="context-camera-settings">
              <div v-if="cctvToolsSlotShown" id="cctv-tools-slot" @vue:mounted="({ el }) => placeCctvTools(el)" @vue:before-unmount="returnCctvToolsHome"></div>
              <p v-else class="context-camera-settings__hint">{{ t('Clear the search to see the camera tools.') }}</p>
            </div>
            <PinnedGrid v-else :radio-on="Boolean(radioUi?.enabled)" />
          </div>
        </div>
        <!-- The lists stay in the page while Context is closed or on another
             tab: each readout renders into its own body. -->
        <div v-show="contextOpen && tab === 'lists'" id="context-lists" role="tabpanel" aria-labelledby="context-tab-lists">
          <div v-if="lists.length > 1" class="context-pin-tabs context-list-tabs" role="tablist" :aria-label="t('Lists')" @keydown="onListKey">
            <UiButton v-for="list in lists" :id="`context-list-tab-${list.id}`" :key="list.id" role="tab" :aria-selected="String(listShown === list.id)" :tabindex="listShown === list.id ? 0 : -1" :aria-controls="`context-list-${list.id}`" @click="showContextList(list.id)">{{ listLabel(list) }}</UiButton>
          </div>
          <div v-for="{ id } in CONTEXT_LISTS" :key="id" v-show="listShown === id" :id="`context-list-${id}`" class="context-list" :role="lists.length > 1 ? 'tabpanel' : undefined" :aria-labelledby="lists.length > 1 ? `context-list-tab-${id}` : undefined">
            <div :id="`${id}-panel-body`" class="context-list__body ui-scroll" :data-news-hidden="id === 'news' && !(listShown === id && contextSurfaceShown) ? '' : null"></div>
          </div>
        </div>
        <!-- Keep these sections registered with PanelChrome while Inspect is hidden. -->
        <StationPanel :shown="showInspect" />
        <LivePanel :shown="showInspect" />
        </div>
        <!-- Expanded, the radio mini player stands here, at the column's
             foot, while what is above it scrolls. -->
        <div v-show="docked" id="context-mini-foot" class="context-mini-foot"></div>
    </RailPanel>
    <BhoteKoshiPanel />
  </aside>

  <div :ref="registerStreetLevelViewerHome" class="sl-viewer-home" aria-hidden="true" inert>
    <StreetLevelViewer />
    <StreetLevelPhotoViewer />
  </div>

  <!-- alignCorner places the dock and mini player around the panel and HUD. -->
  <div ref="contextCorner" class="context-corner">
    <DockedView />
    <Teleport to="#context-mini-foot" :disabled="!docked" defer>
      <RadioMiniPlayer :module="radioModule" :ui="radioUi" :list-stations="radioListShown ? radioStations?.stations : null" @closed="onMiniPlayerClosed" />
    </Teleport>
  </div>
  <!-- Radio's own controls are always in the page (RadioControls reads their
       elements once); they move under the station list while it shows. -->
  <div ref="radioFoldHome" class="radio-fold-home" hidden>
    <Teleport :to="(radioListShown && radioStations?.foldSlot) || radioFoldHome || '.radio-fold-home'" :disabled="!radioFoldHome">
      <RadioFold />
    </Teleport>
  </div>
  <!-- The local receiver's card likewise (LocalSdrControls reads it once);
       Radio's Data Layers row borrows it while the local receiver is chosen
       (RowPanel.vue). -->
  <div class="sdr-card-home" hidden>
    <SdrCard />
  </div>
  <!-- The camera tools likewise (CctvControls reads their elements once);
       they move into the Camera settings tab while it shows. -->
  <div ref="cctvToolsHome" class="cctv-tools-home" hidden>
    <CctvTools />
  </div>
  <div id="scene-runtime" :class="{ active: !!sceneRuntime }">{{ sceneRuntime }}</div>
  <!-- Keep the camera walk connected and release the previous Inspector host. -->
  <div ref="cameraListHome" hidden>
    <Teleport :to="cameraListHost ?? cameraListHome" :disabled="!cameraListHome">
      <CameraList :shown="Boolean(cameraListHost && inspectorShown)" :selected="inlineCameraId" @has-matches="cameraListMatches = $event" />
    </Teleport>
  </div>
</template>
