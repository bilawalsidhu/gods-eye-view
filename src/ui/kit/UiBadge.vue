<script setup>
// Core's read-only badge, with @halfpixel/ui-vue UiBadge's `tone` and classes
// so the two kits can merge. It carries Core's `gev-status-badge` class, and
// callers add its density variants (`gev-status-badge--box`, `--plain`) and
// the feature classes that colour it; the kit classes carry no Core styles
// yet. Not mirrored yet: pulse, busy, the tone glyphs and the clipped title.
defineProps({
  tone: { type: String, default: 'neutral' },
});
</script>

<template>
  <span class="ui-badge gev-status-badge" :class="`ui-badge--${tone}`"
    ><slot
  /></span>
</template>
