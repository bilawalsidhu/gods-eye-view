<script setup>
// Core's read-only badge, with a `tone` and the kit's classes. `ui-badge`
// wears Core's badge (status-badge.css) beside Core's `gev-status-badge`
// class; callers add its density variants (`gev-status-badge--box`,
// `--plain`) and the feature classes that colour it. The tone classes carry
// no style yet. Not mirrored yet: pulse, busy, the tone glyphs and the
// clipped title.
defineProps({
  tone: { type: String, default: 'neutral' },
});
</script>

<template>
  <span class="ui-badge gev-status-badge" :class="`ui-badge--${tone}`"
    ><slot
  /></span>
</template>
