<script setup>
import { onMounted, ref, useId, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import { vFocusSafeChildren } from '../../rail/focusSafeChildren.js';

const props = defineProps({
  cities: { type: Array, required: true },
  modelValue: { type: String, default: '' },
  label: { type: String, default: '' },
  allSelected: { type: Boolean, default: undefined },
  allDisabled: Boolean,
});
const emit = defineEmits(['update:modelValue']);
const expanded = ref(false);
const strip = ref(null);
const stripId = useId();

function focusAll() {
  strip.value?.querySelector('button')?.focus();
}

function revealSelection() {
  if (expanded.value || !strip.value) return;
  const active = strip.value.ownerDocument.activeElement;
  const pressed = '[aria-pressed="true"]';
  const chip = strip.value.contains(active) && active.matches(pressed)
    ? active
    : (strip.value.querySelector(`[data-city-option]${pressed}`) ??
      strip.value.querySelector(pressed));
  if (!chip) return;
  const viewport = strip.value.getBoundingClientRect();
  const button = chip.getBoundingClientRect();
  if (button.left >= viewport.left && button.right <= viewport.right) return;
  const before = button.left - viewport.left - 4;
  const after = button.right - viewport.right + 4;
  let left = button.left < viewport.left ? before : after;
  if (button.width > viewport.width - 8)
    left = getComputedStyle(strip.value).direction === 'rtl' ? after : before;
  strip.value.scrollBy({ left, behavior: 'instant' });
}

onMounted(revealSelection);
watch([() => props.modelValue, () => props.allSelected, expanded], revealSelection, { flush: 'post' });
</script>

<template>
  <div
    class="city-filter"
    :class="{ 'is-expanded': expanded }"
    role="group"
    :aria-label="label || t('City')"
  >
    <div
      :id="stripId"
      ref="strip"
      v-focus-safe-children="focusAll"
      class="city-filter__strip"
    >
      <UiButton
        class="city-filter__chip"
        :pressed="allSelected ?? modelValue === ''"
        :disabled="allDisabled"
        @click="emit('update:modelValue', '')"
        >{{ t('All') }}</UiButton
      >
      <slot name="before-cities" />
      <UiButton
        v-for="city in cities"
        :key="city"
        class="city-filter__chip"
        data-city-option
        :pressed="modelValue === city"
        @click="emit('update:modelValue', city)"
        >{{ city }}</UiButton
      >
    </div>
    <UiButton
      v-if="cities.length || $slots['before-cities']"
      class="city-filter__toggle"
      :label="expanded ? t('Shrink') : t('Expand')"
      :aria-controls="stripId"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <UiIcon name="arrow_drop_down" />
    </UiButton>
  </div>
</template>

<style scoped>
.city-filter {
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
  min-inline-size: 0;
}

.city-filter__strip {
  display: flex;
  flex: 1;
  gap: 0.3rem;
  min-inline-size: 0;
  padding: 4px;
  overflow-x: auto;
  scrollbar-width: thin;
}

.city-filter__chip,
:slotted(.city-filter__chip),
.city-filter__toggle {
  flex: none;
  min-block-size: 24px;
  color: rgba(225, 236, 242, 0.8);
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.18);
  cursor: pointer;
}

.city-filter__chip,
:slotted(.city-filter__chip) {
  padding-inline: 0.55rem;
  font-family: var(--font-mono);
  font-size: 0.62rem;
  white-space: nowrap;
  border-radius: 999px;
}

.city-filter__chip:hover,
:slotted(.city-filter__chip:hover),
.city-filter__toggle:hover {
  border-color: var(--accent);
}

.city-filter__chip[aria-pressed='true'],
:slotted(.city-filter__chip[aria-pressed='true']) {
  color: #04131a;
  background: var(--accent);
  border-color: var(--accent);
}

.city-filter__toggle {
  display: grid;
  place-items: center;
  min-inline-size: 24px;
  margin-block: 4px;
  padding: 0;
  border-radius: 0.4rem;
}

.is-expanded .city-filter__toggle :deep(.material-symbols-outlined) {
  transform: rotate(180deg);
}

.is-expanded .city-filter__strip {
  flex-wrap: wrap;
  overflow: visible;
}

.is-expanded .city-filter__chip,
.is-expanded :slotted(.city-filter__chip) {
  max-inline-size: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
}

@media (pointer: coarse) {
  .city-filter__chip,
  :slotted(.city-filter__chip),
  .city-filter__toggle {
    min-block-size: 36px;
  }

  .city-filter__toggle {
    min-inline-size: 36px;
  }
}
</style>
