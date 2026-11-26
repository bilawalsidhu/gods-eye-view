<script setup>
// Core's empty state, with a `title` and `hint`. Core's empty states are one
// line, so the title is the text itself rather than a bold heading; a hint
// follows it on a line of its own. It wears Core's empty line
// (empty-state.css: dim 10px mono text); feature classes the caller passes
// restyle it. Not mirrored yet: icon.
defineProps({
  title: { type: String, required: true },
  hint: { type: String, default: undefined },
});
</script>

<template>
  <div class="ui-empty">
    {{ title }}<span v-if="hint" class="ui-empty__hint">{{ hint }}</span>
  </div>
</template>
