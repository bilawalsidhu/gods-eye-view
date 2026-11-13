<script setup>
import { storeToRefs } from 'pinia';
import { computed, nextTick, ref } from 'vue';
import { t } from '../../../i18n/index.js';
import { DRAW_COLOR_CSS } from '../../../annotations/drawMarks.js';
import { vFieldValue } from '../../rail/fieldValue.js';
import { vFocusSafeChildren } from '../../rail/focusSafeChildren.js';
import DrawSwatches from './DrawSwatches.vue';
import { useDisplayStore } from '../../stores/display.js';

// UTILITIES ▸ Draw's shapes, one row each like Import's files: the colour
// swatch (it opens the five colours in the row), the name typed in place,
// and show/hide, the application's own row actions, fly to and remove. The
// draw tool publishes the rows and answers the controls. Rows are keyed, so a
// board change elsewhere updates a row in place and never takes the button
// under a click or the field being typed in. The list's template is one
// line: templates keep whitespace.
const display = useDisplayStore();
const { draw } = storeToRefs(display);
const rows = computed(() => draw.value?.marks ?? []);
// No `>` in the template: the catalog reads its tags with a regex.
const listed = computed(() => rows.value.length > 0);
const picking = ref(null);
// The name field (v-field-value) shows the saved name except while it is
// being typed in: that text is the draft until Enter or leaving saves it.

const rowOf = (id) => rows.value.find((row) => row.id === id);
// The name last sent for each row, so Enter and the blur after it save once
// even before the tool publishes the new name.
const sent = new Map();

/** Save a typed name; an unchanged one costs nothing. */
function commit(row, input) {
  const next = input.value.trim();
  input.value = next;
  const saved = rowOf(row.id)?.name ?? row.name;
  if (next === saved || next === sent.get(row.id)) return;
  sent.set(row.id, next);
  display.act('renameDrawMark', row.id, next);
}

function onNameKey(row, event) {
  const input = event.currentTarget;
  if (event.key === 'Enter') {
    event.preventDefault();
    // Saved, and focus stays here: blurring would drop it to the page.
    commit(row, input);
    input.select();
  } else if (event.key === 'Escape') {
    // Escape drops the draft before anything else, an open colour picker
    // included, and stays in the list: it must not leave Draw.
    event.preventDefault();
    event.stopPropagation();
    input.value = rowOf(row.id)?.name ?? row.name;
    input.select();
  }
}

async function closePicker(id) {
  picking.value = null;
  await nextTick();
  document
    .querySelector(`#draw-mark-list [data-mark-id="${id}"] .draw-mark-swatch`)
    ?.focus();
}

function onRowKey(row, event) {
  // Escape in an open picker closes it and gives focus back to its swatch.
  if (event.key !== 'Escape' || picking.value !== row.id) return;
  event.preventDefault();
  event.stopPropagation();
  void closePicker(row.id);
}

/** A colour from the row's picker: the arrows try it, a click also closes. */
function recolor(row, color) {
  if (color !== row.color) display.act('recolorDrawMark', row.id, color);
}

// Before the row holding keyboard focus goes, focus moves to the next row's
// same control, else the previous row's, else the Draw button.
function leave() {
  const active = document.activeElement;
  const row = active?.closest('[data-mark-id]');
  const control = active?.dataset.control;
  const others = [];
  for (let next = row?.nextElementSibling; next; next = next.nextElementSibling)
    others.push(next);
  for (let prev = row?.previousElementSibling; prev; prev = prev.previousElementSibling)
    others.push(prev);
  for (const other of others) {
    const target =
      other.querySelector(`[data-control="${control}"]`) ||
      other.querySelector('button');
    if (target) return target.focus();
  }
  document.getElementById('draw-toggle')?.focus();
}
</script>

<template>
  <ul class="geo-import-list draw-mark-list" :class="{ visible: listed }" id="draw-mark-list" v-focus-safe-children="leave" :aria-label="t('Drawn shapes')"><li v-for="row in rows" :key="row.id" class="geo-import-row draw-mark-row" :class="{ 'hidden-mark': row.hidden }" :data-mark-id="row.id" @keydown="onRowKey(row, $event)"><button type="button" class="geo-import-swatch draw-mark-swatch" data-control="swatch" :style="{ background: DRAW_COLOR_CSS[row.color] }" :title="row.labels.swatch" :aria-label="row.labels.swatch" :aria-expanded="String(picking === row.id)" :aria-controls="`draw-mark-colors-${row.id}`" @click="picking = picking === row.id ? null : row.id"></button><DrawSwatches v-if="picking === row.id" :id="`draw-mark-colors-${row.id}`" class="draw-mark-colors" data-control="picker" autofocus :label="row.labels.colors" :model-value="row.color" @update:model-value="recolor(row, $event)" @choose="closePicker(row.id)" /><input type="text" class="geo-import-name draw-mark-name" data-control="name" maxlength="120" autocomplete="off" spellcheck="false" v-field-value="row.name" :placeholder="row.placeholder" :aria-label="row.labels.name" @keydown="onNameKey(row, $event)" @focusout="commit(row, $event.currentTarget)"><button type="button" class="geo-import-action" data-control="toggle" :title="row.labels.toggle" :aria-label="row.labels.toggle" @click="display.act('toggleDrawMark', row.id)"><span class="material-symbols-outlined" aria-hidden="true">{{ row.hidden ? 'visibility_off' : 'visibility' }}</span></button><button v-for="action in row.actions" :key="action.id" type="button" class="geo-import-action draw-mark-action" :data-control="`action-${action.id}`" :data-action="action.id" :title="action.label" :aria-label="action.label" :aria-disabled="String(row.busy)" @click="display.act('runDrawMarkAction', row.id, action.id)"><span class="material-symbols-outlined" aria-hidden="true">{{ action.icon }}</span></button><button type="button" class="geo-import-action" data-control="fly" :title="row.labels.fly" :aria-label="row.labels.fly" @click="display.act('flyToDrawMark', row.id)"><span class="material-symbols-outlined" aria-hidden="true">my_location</span></button><button type="button" class="geo-import-action" data-control="remove" :title="row.labels.remove" :aria-label="row.labels.remove" @click="display.act('removeDrawMark', row.id)"><span class="material-symbols-outlined" aria-hidden="true">close</span></button><span v-if="row.actions.length" class="draw-mark-note" role="status" :aria-busy="String(row.busy)">{{ row.busy ? '…' : row.note }}</span></li></ul>
</template>
