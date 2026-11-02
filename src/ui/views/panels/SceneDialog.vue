<script setup>
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from 'vue';
import { t, tn } from '../../../i18n/index.js';
import { vStatusText } from '../../rail/statusText.js';
import { useSceneSharingStore } from '../../stores/sceneSharing.js';

// One open scene sharing dialog, as src/ui/sceneSharing.js presents it. The
// parent keys this by dialog, so each one opens as a fresh modal.
const props = defineProps({ view: { type: Object, required: true } });
const { controls } = storeToRefs(useSceneSharingStore());

const root = useTemplateRef('root');
onMounted(() => root.value?.showModal?.());
onBeforeUnmount(() => {
  if (root.value?.open) root.value.close();
});

const bodyItems = computed(() => props.view.items.filter((item) => item.place === 'body'));
const footerItems = computed(() => props.view.items.filter((item) => item.place === 'footer'));
// Typing reaches the item before any republish, so a field is rewritten only
// when the owner changes its value, focused or not, as the old code did.
const statusText = computed(() => ({ text: props.view.status, seq: props.view.statusSeq }));

// The browser draws a file input's button and "no file" text in its own
// language. The native input is stretched, transparent, over the whole row
// (so click, focus and drops stay native) and translated text is drawn under.
const focusedFile = shallowRef(null);
const chosenText = (item) => {
  const count = item.files.length;
  // One file shows its name, like the browser's own picker did.
  return count === 1
    ? item.files[0].name
    : count
      ? tn(count, '{count} file selected', '{count} files selected')
      : t('No file chosen');
};
const onFiles = (item, event) => controls.value?.setFiles(item.id, event.target.files ?? []);

const dialogStyle = { background: '#08141e', color: '#e3faff', border: '1px solid #397080', borderRadius: '6px', padding: '20px', width: 'min(720px,calc(100vw - 32px))', boxSizing: 'border-box', position: 'fixed', inset: '0', margin: 'auto', maxHeight: 'calc(100vh - 32px)', overflow: 'auto', font: '14px/1.5 sans-serif' };
const buttonStyle = { background: '#10242e', color: '#e3faff', border: '1px solid #397080', borderRadius: '3px', padding: '7px 11px', margin: '6px 6px 6px 0', cursor: 'pointer', font: 'inherit' };
const fieldStyle = (multiline) => ({ display: 'block', boxSizing: 'border-box', width: '100%', padding: '7px', margin: '6px 0 14px', color: '#e3faff', background: '#10242e', border: '1px solid #397080', font: multiline ? '12px monospace' : 'inherit' });
const fileInputStyle = { ...fieldStyle(false), position: 'absolute', inset: '0', width: '100%', height: '100%', margin: '0', padding: '0', border: '0', opacity: '0', cursor: 'pointer', zIndex: '1' };
const fileRowStyle = { display: 'flex', alignItems: 'center', gap: '10px', margin: '6px 0 14px', padding: '7px', background: '#10242e', border: '1px solid #397080' };
const chooserStyle = (focused) => ({ padding: '3px 9px', border: '1px solid #397080', borderRadius: '3px', background: '#08141e', cursor: 'pointer', outline: focused ? '2px solid #e3faff' : '' });
</script>

<template>
  <dialog ref="root" data-director-dialog class="director-sharing-dialog" :aria-label="view.title" :style="dialogStyle" @cancel.prevent="controls?.cancel()">
    <h2 style="margin-bottom: 12px">{{ view.title }}</h2>
    <div>
      <template v-for="item in bodyItems" :key="item.id">
        <p v-if="item.kind === 'text'" style="margin: 8px 0">{{ item.value }}</p>
        <button v-else-if="item.kind === 'button'" type="button" :style="buttonStyle" :disabled="item.disabled" v-bind="item.hook ? { [item.hook]: '' } : {}" @click="controls?.click(item.id)">{{ item.label }}</button>
        <label v-else-if="item.type === 'file'" :style="{ display: 'block', position: 'relative' }">{{ item.label }}<input type="file" :aria-label="item.label" :multiple="item.multiple" :webkitdirectory="item.directory || undefined" :style="fileInputStyle" @change="onFiles(item, $event)" @focus="focusedFile = item.id" @blur="focusedFile = null" /><span aria-hidden="true" :style="fileRowStyle"><span :style="chooserStyle(focusedFile === item.id)">{{ t('Choose files') }}</span><span>{{ chosenText(item) }}</span></span></label>
        <label v-else style="display: block">{{ item.label }}<textarea v-if="item.multiline" rows="9" dir="ltr" spellcheck="false" :aria-label="item.label" :style="fieldStyle(true)" :value="item.value" @input="controls?.setValue(item.id, $event.target.value)"></textarea><input v-else :type="item.type" :aria-label="item.label" :style="fieldStyle(false)" :value="item.value" @input="controls?.setValue(item.id, $event.target.value)" /></label>
      </template>
    </div>
    <p role="status" v-status-text="statusText"></p>
    <div>
      <button v-for="item in footerItems" :key="item.id" type="button" :style="buttonStyle" :disabled="item.disabled" :autofocus="item.autofocus || undefined" v-bind="item.hook ? { [item.hook]: '' } : {}" @click="controls?.click(item.id)">{{ item.label }}</button>
    </div>
  </dialog>
</template>
