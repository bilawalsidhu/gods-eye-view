<script setup>
// Core's empty state, with a `title` and `hint`. Core's empty states are one
// line, so the title is the text itself rather than a bold heading; a hint
// follows it. Core
// styles it through the classes its callers pass. Not mirrored yet: icon.
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
