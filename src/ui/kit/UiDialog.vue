<script setup>
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue';

// Core's modal dialog: a native `<dialog>` the owner opens and closes with
// `open`. True opens it with showModal() (once mounted, so a dialog mounted
// open opens straight away), false closes it, and unmounting closes it.
// Each change is applied after the content has rendered and is then emitted
// (`opened`, `closed`), so the owner can move focus into the content it
// shows or back to the control that opened it. Escape's `cancel` is
// prevented and emitted as `dismiss`, so the owner decides; with
// `backdropDismiss`, a click on the backdrop (the dialog element itself,
// outside its content) is a `dismiss` too. When the browser closes the
// dialog on its own while `open` is still true (an Escape it does not let
// the page cancel), `browserClose` tells the owner. A DOM without
// showModal() (a test's) leaves the dialog closed rather than failing.
// Attributes, classes, styles and listeners pass through to the dialog; the
// content is the default slot. `element` is the dialog element.
const props = defineProps({
  open: { type: Boolean, default: false },
  backdropDismiss: { type: Boolean, default: false },
});
const emit = defineEmits(['dismiss', 'browserClose', 'opened', 'closed']);
const element = useTemplateRef('element');
let unmounting = false;

function show() {
  const dialog = element.value;
  if (!dialog) return;
  if (!dialog.open) dialog.showModal?.();
  emit('opened');
}

onMounted(() => {
  if (props.open) show();
});
watch(
  () => props.open,
  (open) => {
    if (open) return show();
    const dialog = element.value;
    if (!dialog) return;
    // The browser may already have closed it.
    if (dialog.open) dialog.close();
    emit('closed');
  },
  { flush: 'post' },
);
onBeforeUnmount(() => {
  unmounting = true;
  if (element.value?.open) element.value.close();
});

function onCancel(event) {
  event.preventDefault();
  emit('dismiss');
}
// The browser queues its close event, so one from an earlier close can land
// after the dialog has been opened again; only a dialog still shut reports it.
function onClose() {
  if (!unmounting && props.open && !element.value?.open) emit('browserClose');
}
function onClick(event) {
  if (props.backdropDismiss && event.target === event.currentTarget)
    emit('dismiss');
}

defineExpose({ element });
</script>

<template>
  <dialog ref="element" @cancel="onCancel" @close="onClose" @click="onClick">
    <slot />
  </dialog>
</template>
