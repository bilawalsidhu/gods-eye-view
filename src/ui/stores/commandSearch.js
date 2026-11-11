import { defineStore } from 'pinia';
import { computed, markRaw, nextTick, ref, shallowRef, watch } from 'vue';
import { msg, t } from '../../i18n/index.js';
import { useLocaleStore } from './locale.js';
import { useLocationStore } from './location.js';
import { useProviderSettingsStore } from './providerSettings.js';
import { layerSearchCatalog } from '../layerSearchCatalog.js';

/** Command-search presentation and dispatch through the existing UI owners. */
export const useCommandSearchStore = defineStore('gev-command-search', () => {
  const location = useLocationStore();
  const providers = useProviderSettingsStore();
  const locale = useLocaleStore();
  const query = ref('');
  const opened = ref(false);
  const error = ref('');
  const panelOwner = shallowRef(null);
  let revision = 0;
  watch(opened, (isOpen) => {
    if (!isOpen) {
      revision++;
      query.value = '';
      error.value = '';
    }
  });
  const settingsCommands = () => [
    {
      id: 'settings',
      icon: 'settings',
      label: msg('Settings'),
      hint: msg('Preferences'),
      execute: () => providers.openMenu(),
    },
    {
      id: 'keys',
      icon: 'key',
      label: msg('API keys'),
      hint: msg('Settings'),
      execute: () => providers.controls?.open(),
    },
  ];
  const panelCommand = (panel) => ({
    id: `panel-${panel.id}`,
    icon: 'tune',
    label: panel.label,
    hint: msg('Panel'),
    execute: () => panelOwner.value?.onPanel(panel.id),
  });
  const results = computed(() => {
    const panels = panelOwner.value?.getPanels() ?? [];
    const text = query.value.trim();
    if (!text)
      return [settingsCommands()[0], ...panels.slice(0, 4).map(panelCommand)];
    const normalized = text
      .toLocaleLowerCase(locale.picker?.current)
      .replace(/^(enable|disable|show|hide|toggle)\s+/, '');
    const wanted = /^(enable|show)\s+/i.test(text)
      ? true
      : /^(disable|hide)\s+/i.test(text)
        ? false
        : undefined;
    const matches = (value) =>
      String(value)
        .toLocaleLowerCase(locale.picker?.current)
        .includes(normalized);
    const layers = layerSearchCatalog.value
      .filter((layer) => matches(layer.name))
      .slice(0, 4)
      .map((layer) => ({
        id: `layer-${layer.id}`,
        icon: 'layers',
        label: msg('{action} {name}'),
        action: (wanted ?? !layer.enabled) ? msg('Enable') : msg('Disable'),
        params: { name: layer.name },
        hint: msg('Layers'),
        execute: () => {
          if (wanted === undefined || wanted !== layer.enabled) layer.toggle();
        },
      }));
    const panelResults = panels
      .filter((panel) => matches(panel.label))
      .slice(0, 3)
      .map(panelCommand);
    const cities = (location.view?.cities ?? [])
      .filter((city) => matches(city.label))
      .slice(0, 3)
      .map((city) => ({
        id: `city-${city.id}`,
        icon: 'place',
        label: city.label,
        hint: msg('Location'),
        execute: () => location.controls?.chooseCity(city.id),
      }));
    return [
      ...layers,
      ...panelResults,
      ...cities,
      ...settingsCommands().filter(
        (item) => matches(item.label) || matches(t(item.label)),
      ),
    ]
      .slice(0, 7)
      .concat({
        id: 'place',
        icon: 'search',
        label: msg('Search for {query}'),
        params: { query: text },
        hint: msg('Place or coordinates'),
        place: true,
      });
  });
  /** Connect the offered panels and their disclosure owner; cleanup is owner-safe. */
  function connect(owner) {
    panelOwner.value = markRaw(owner);
    return () => {
      if (panelOwner.value !== owner) return;
      revision++;
      opened.value = false;
      query.value = '';
      error.value = '';
      panelOwner.value = null;
    };
  }
  /** Query edits never ask a provider for data. */
  function edit(value) {
    revision++;
    query.value = value;
    opened.value = true;
    error.value = '';
    location.controls?.editSearch?.();
  }
  /** Select one presented command, with stale async results ignored. */
  async function run(id) {
    const result = results.value.find((item) => item.id === id);
    if (!result || location.view?.searching) return;
    const current = ++revision;
    const text = query.value.trim();
    error.value = '';
    try {
      if (result.place) {
        if (!location.controls?.search)
          throw new Error('Location search unavailable');
        await location.controls.search(text);
        if (current !== revision) return;
        if (location.view?.searchError) {
          error.value = location.view.searchError;
          return;
        }
      } else {
        opened.value = false;
        await nextTick();
        await result.execute();
      }
      if (current === revision) {
        query.value = '';
        opened.value = false;
      }
    } catch {
      if (current === revision) {
        error.value = msg('Search failed. Please try again.');
        opened.value = true;
      }
    }
  }
  return { query, opened, error, results, connect, edit, run };
});
