<script setup>
import UiButton from './kit/UiButton.vue';
import {
  UiPopover,
  UiPopoverTrigger,
  UiPopoverContent,
  UiCommand,
  UiCommandInput,
  UiCommandList,
  UiCommandGroup,
  UiCommandItem,
} from './kit/UiPrimitives.js';
import { nextTick, onBeforeUnmount, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../i18n/index.js';
import UiIcon from './kit/UiIcon.vue';
import { useCommandSearchStore } from './stores/commandSearch.js';
import { useLocationStore } from './stores/location.js';

const props = defineProps({
  panels: { type: Array, required: true },
  onPanel: { type: Function, required: true },
});
const search = useCommandSearchStore();
const location = useLocationStore();
const { query, opened, error, results } = storeToRefs(search);
const disconnect = search.connect({
  getPanels: () => props.panels,
  onPanel: (id) => props.onPanel(id),
});
const hiddenModes =
  '.mobile-shell, .cockpit-mode, .ui-clean-view, .recording-mode, .scene-playback-mode';
let modeObserver;
function syncVisibility() {
  if (document.body.matches(hiddenModes)) opened.value = false;
}
function keydown(event) {
  if (
    event.defaultPrevented ||
    document.querySelector('#key-setup:not([hidden])') ||
    document.body.matches(hiddenModes)
  )
    return;
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
  disconnect();
  modeObserver?.disconnect();
  document.removeEventListener('keydown', keydown);
});
</script>

<template>
  <UiPopover v-model:open="opened">
    <UiPopoverTrigger as-child>
      <UiButton
        class="console-search-trigger"
        type="button"
        :aria-label="t('Search places, layers and commands')"
      >
        <UiIcon name="search" :size="16" /><span>{{
          t('Search or run a command')
        }}</span
        ><kbd>⌘K</kbd>
      </UiButton>
    </UiPopoverTrigger>
    <UiPopoverContent
      class="w-96 p-0 console-search-content"
      align="end"
      :side-offset="8"
      :collision-padding="12"
    >
      <UiCommand :should-filter="false">
        <UiCommandInput
          id="minimal-universal-search"
          :model-value="query"
          :placeholder="t('Search places, layers and commands')"
          :aria-label="t('Search places, layers and commands')"
          :aria-busy="Boolean(location.view?.searching)"
          @update:model-value="search.edit($event)"
        />
        <p v-if="error" class="console-search-error" role="alert">{{
          t(error)
        }}</p>
        <UiCommandList
          id="minimal-search-results"
          :aria-label="t('Search results')"
        >
          <UiCommandGroup>
            <UiCommandItem
              v-for="result in results"
              :id="`minimal-search-${result.id}`"
              :key="result.id"
              :value="result.id"
              :data-result-id="result.id"
              @select.prevent="search.run(result.id)"
            >
              <UiIcon :name="result.icon" :size="16" /><span>{{
                t(result.label, {
                  ...result.params,
                  action: result.action ? t(result.action) : undefined,
                })
              }}</span
              ><small class="ml-auto text-xs text-muted-foreground">{{
                t(result.hint)
              }}</small>
            </UiCommandItem>
          </UiCommandGroup>
        </UiCommandList>
      </UiCommand>
    </UiPopoverContent>
  </UiPopover>
</template>
