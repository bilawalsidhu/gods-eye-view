<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  shallowRef,
  useTemplateRef,
} from 'vue';
import { t } from '../../../i18n/index.js';
import { LOCALES, LOCALE_NAMES } from '../../../i18n/locale.js';
import {
  LOCALE_PICKER_ICONS,
  LOCALE_SEARCH_THRESHOLD,
  createLocalNameReader,
  createLocalePickerModel,
  localeOptionCode,
} from '../../localePicker.js';
import { vClassToggle } from '../../rail/classToggle.js';

// The interface language picker. The model in localePicker.js holds the
// list, search, active option and keyboard rules; this renders it and wires
// the listbox pattern. The shell decides what a choice does.
const props = defineProps({
  current: { type: String, required: true },
  onSelect: { type: Function, required: true },
  /** Focus the button once drawn: the picker is drawn again after a choice. */
  focus: { type: Boolean, default: false },
  locales: { type: Array, default: () => LOCALES },
  nativeNames: { type: Object, default: () => LOCALE_NAMES },
  searchThreshold: { type: Number, default: LOCALE_SEARCH_THRESHOLD },
});

const model = createLocalePickerModel({
  locales: props.locales,
  current: props.current,
  nativeNames: props.nativeNames,
  localName: createLocalNameReader(props.current),
  searchThreshold: props.searchThreshold,
});
const id = 'locale-picker';
const ids = {
  popup: `${id}-popup`,
  heading: `${id}-heading`,
  listbox: `${id}-listbox`,
  option: (code) => `${id}-option-${code}`,
};

// The model is plain state; each change bumps this so the template rereads it.
const revision = shallowRef(0);
const view = computed(() => {
  void revision.value;
  return {
    open: model.open,
    visible: model.visible,
    active: model.activeOption?.code ?? null,
  };
});
// Each render keeps the active option in view, as the list opens too.
const render = () => {
  revision.value += 1;
  nextTick(() => {
    const code = model.open ? model.activeOption?.code : null;
    if (!code) return;
    root.value
      ?.querySelector(`#${CSS.escape(ids.option(code))}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  });
};

const root = useTemplateRef('root');
const button = useTemplateRef('button');
const listbox = useTemplateRef('listbox');
const search = useTemplateRef('search');
const focusTarget = () => search.value || listbox.value;
const activeDescendant = computed(() =>
  view.value.active ? ids.option(view.value.active) : undefined,
);
const buttonLabel = computed(() =>
  t('Language: {language}', {
    language: props.nativeNames[props.current] || props.current,
  }),
);

let swallowSpaceKeyup = false;

function close({ restoreFocus = false } = {}) {
  if (!model.open) return;
  model.closeList();
  render();
  globalThis.removeEventListener('keydown', onWindowKeyDown, true);
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  if (restoreFocus) button.value?.focus({ preventScroll: true });
}

// The list is closed on screen before the shell switches.
async function choose(code) {
  close({ restoreFocus: true });
  if (code === props.current) return;
  await nextTick();
  props.onSelect(code);
}

async function open() {
  if (model.open) return;
  model.openList();
  if (search.value) search.value.value = '';
  render();
  // Window capture runs before the document-level shortcut handlers
  // (cockpit, hotkeys, push-to-talk), so keys typed in the list stay here.
  globalThis.addEventListener('keydown', onWindowKeyDown, true);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  // The popup shows when Vue renders it; focus it after.
  await nextTick();
  if (model.open) focusTarget()?.focus({ preventScroll: true });
}

function onWindowKeyDown(event) {
  if (!model.open || event.isComposing) return;
  const inside = root.value?.contains(event.target);
  if (!inside && event.key !== 'Escape') return;
  const result = model.keydown(event);
  if (!result.handled) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (result.close) close({ restoreFocus: true });
  else if (result.choose) {
    if (event.key === ' ') swallowSpaceKeyup = true;
    choose(result.choose);
  } else render();
}

function onDocumentPointerDown(event) {
  if (!root.value?.contains(event.target)) close();
}

function onButtonClick() {
  if (model.open) close({ restoreFocus: true });
  else open();
}

function onButtonKeyDown(event) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  event.stopPropagation();
  open();
}

// Space chose an option and moved focus here; its keyup must not click.
function onButtonKeyUp(event) {
  if (event.key !== ' ' || !swallowSpaceKeyup) return;
  swallowSpaceKeyup = false;
  event.preventDefault();
}

const optionFromEvent = (event) =>
  event.target?.closest?.('[role="option"]')?.dataset.locale || null;

function onListClick(event) {
  const code = optionFromEvent(event);
  if (code) choose(code);
}

function onListPointerMove(event) {
  const code = optionFromEvent(event);
  if (!code || model.activeOption?.code === code) return;
  model.setActive(model.visible.findIndex((option) => option.code === code));
  render();
}

function onSearchInput(event) {
  model.setQuery(event.target.value);
  render();
}

function onFocusOut(event) {
  const next = event.relatedTarget;
  if (model.open && next && !root.value?.contains(next)) close();
}

onMounted(() => {
  if (props.focus) button.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => close());

defineExpose({ open, close, isOpen: () => model.open });
</script>

<template>
  <div id="locale-picker" ref="root" class="locale-picker" v-class-toggle="{ 'is-open': view.open }" @focusout="onFocusOut">
    <button ref="button" class="locale-picker-button" type="button" aria-haspopup="listbox" :aria-expanded="String(view.open)" :aria-controls="ids.popup" :aria-label="buttonLabel" :title="t('Change the interface language')" @click="onButtonClick" @keydown="onButtonKeyDown" @keyup="onButtonKeyUp">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="locale-picker-globe"><path v-for="d in LOCALE_PICKER_ICONS.globe.stroke" :key="d" :d="d" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <span class="locale-picker-code" translate="no" aria-hidden="true">{{ current.toUpperCase() }}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="locale-picker-caret"><path v-for="d in LOCALE_PICKER_ICONS.caret.fill" :key="d" :d="d" fill="currentColor" /></svg>
    </button>
    <div :id="ids.popup" class="locale-picker-popup" :hidden="!view.open">
      <div :id="ids.heading" class="locale-picker-heading">{{ t('Interface language') }}</div>
      <input v-if="model.searchable" ref="search" class="locale-picker-search" type="search" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="true" :aria-controls="ids.listbox" :aria-label="t('Search languages')" :placeholder="t('Search languages')" :aria-activedescendant="activeDescendant" @input="onSearchInput" />
      <ul ref="listbox" :id="ids.listbox" class="locale-picker-list ui-scroll" role="listbox" :aria-labelledby="ids.heading" tabindex="-1" :aria-activedescendant="model.searchable ? undefined : activeDescendant" @click="onListClick" @pointermove="onListPointerMove">
        <li v-for="option in view.visible" :key="option.code" :id="ids.option(option.code)" class="locale-picker-option" v-class-toggle="{ 'is-active': view.active === option.code }" role="option" :aria-selected="String(option.selected)" :lang="option.code" :data-locale="option.code">
          <span class="locale-picker-text"><span class="locale-picker-native">{{ option.nativeName }}</span><span class="locale-picker-meta"><span class="locale-picker-option-code" translate="no" :lang="localeOptionCode(option.code).lang">{{ localeOptionCode(option.code).text }}</span></span></span>
          <svg v-if="option.selected" viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="locale-picker-check"><path v-for="d in LOCALE_PICKER_ICONS.check.stroke" :key="d" :d="d" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </li>
      </ul>
      <p class="locale-picker-empty" role="status" :hidden="view.visible.length > 0">{{ t('No matching languages') }}</p>
    </div>
  </div>
</template>
