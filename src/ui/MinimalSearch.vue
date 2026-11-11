<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { t } from '../i18n/index.js';
import UiIcon from './kit/UiIcon.vue';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from './shadcn/popover/index.ts';
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
} from './shadcn/command/index.ts';
import { useLocationStore } from './stores/location.js';
import { useProviderSettingsStore } from './stores/providerSettings.js';
import { layerSearchCatalog } from './layerSearchCatalog.js';

const props = defineProps({
  panels: { type: Array, required: true },
  onPanel: { type: Function, required: true },
});
const location = useLocationStore();
const providers = useProviderSettingsStore();
const query = ref(''),
  opened = ref(false),
  error = ref('');
let revision = 0;
// Portalled search must follow the visibility of the rest of the console.
const hiddenModes =
  '.mobile-shell, .cockpit-mode, .ui-clean-view, .recording-mode, .scene-playback-mode';
let modeObserver;
function syncVisibility() {
  if (document.body.matches(hiddenModes)) opened.value = false;
}
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
    label: t('Settings'),
    hint: t('Preferences'),
    run: () => document.getElementById('minimal-settings-trigger')?.click(),
  },
  {
    id: 'keys',
    icon: 'key',
    label: t('API keys'),
    hint: t('Settings'),
    run: () => providers.controls?.open(),
  },
];
const panelCommand = (panel) => ({
  id: `panel-${panel.id}`,
  icon: 'tune',
  label: panel.label,
  hint: t('Panel'),
  run: () => props.onPanel(panel.id),
});
const results = computed(() => {
  const text = query.value.trim();
  if (!text)
    return [
      settingsCommands()[0],
      ...props.panels.slice(0, 4).map(panelCommand),
    ];
  const normalized = text
    .toLocaleLowerCase()
    .replace(/^(enable|disable|show|hide|toggle)\s+/, '');
  const wanted = /^(enable|show)\s+/i.test(text)
    ? true
    : /^(disable|hide)\s+/i.test(text)
      ? false
      : undefined;
  const matches = (value) =>
    String(value).toLocaleLowerCase().includes(normalized);
  const layers = layerSearchCatalog.value
    .filter((layer) => matches(layer.name))
    .slice(0, 4)
    .map((layer) => ({
      id: `layer-${layer.id}`,
      icon: 'layers',
      label: t('{action} {name}', {
        action: t((wanted ?? !layer.enabled) ? 'Enable' : 'Disable'),
        name: layer.name,
      }),
      hint: t('Layers'),
      run: () => {
        if (wanted === undefined || wanted !== layer.enabled) layer.toggle();
      },
    }));
  const panels = props.panels
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
      hint: t('Location'),
      run: () => location.controls?.chooseCity(city.id),
    }));
  const settings = settingsCommands().filter((item) => matches(item.label));
  return [...layers, ...panels, ...cities, ...settings].slice(0, 7).concat({
    id: 'place',
    icon: 'search',
    label: t('Search for {query}', { query: text }),
    hint: t('Place or coordinates'),
    place: true,
  });
});
function edit() {
  revision++;
  opened.value = true;
  error.value = '';
  location.controls?.editSearch?.();
}
async function run(result) {
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
        opened.value = true;
        return;
      }
    } else {
      opened.value = false;
      await nextTick();
      await result.run();
    }
    if (current === revision) {
      query.value = '';
      opened.value = false;
    }
  } catch {
    if (current === revision) {
      error.value = t('Search failed. Please try again.');
      opened.value = true;
    }
  }
}
function keydown(event) {
  if (
    event.defaultPrevented ||
    document.querySelector('#key-setup:not([hidden])')
  )
    return;
  if (document.body.matches(hiddenModes)) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    opened.value = true;
    nextTick(() => {
      const input = document.getElementById('minimal-universal-search');
      input?.focus();
      input?.select();
    });
  }
}
onMounted(() => {
  document.addEventListener('keydown', keydown);
  modeObserver = new MutationObserver(syncVisibility);
  modeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
});
onBeforeUnmount(() => {
  revision++;
  modeObserver?.disconnect();
  document.removeEventListener('keydown', keydown);
});
</script>

<template>
  <Popover v-model:open="opened">
    <PopoverTrigger as-child>
      <button
        class="console-search-trigger"
        type="button"
        :aria-label="t('Search places, layers and commands')"
      >
        <UiIcon name="search" :size="16" /><span>{{
          t('Search or run a command')
        }}</span
        ><kbd>⌘K</kbd>
      </button>
    </PopoverTrigger>
    <PopoverContent
      class="w-96 p-0 console-search-content"
      align="end"
      :side-offset="8"
      :collision-padding="12"
    >
      <Command :should-filter="false">
        <CommandInput
          id="minimal-universal-search"
          :model-value="query"
          :placeholder="t('Search places, layers and commands')"
          :aria-label="t('Search places, layers and commands')"
          :aria-busy="Boolean(location.view?.searching)"
          @update:model-value="
            query = $event;
            edit();
          "
        />
        <p v-if="error" class="console-search-error" role="alert">{{
          error
        }}</p>
        <CommandList
          id="minimal-search-results"
          :aria-label="t('Search results')"
        >
          <CommandGroup>
            <CommandItem
              v-for="result in results"
              :id="`minimal-search-${result.id}`"
              :key="result.id"
              :value="result.id"
              :data-result-id="result.id"
              @select.prevent="run(result)"
            >
              <UiIcon :name="result.icon" :size="16" /><span>{{
                result.label
              }}</span
              ><small class="ml-auto text-xs text-muted-foreground">{{
                result.hint
              }}</small>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
