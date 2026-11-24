<script setup>
import { computed } from 'vue';
import { markSprite } from '../../entityMark.js';
import UiIcon from '../../kit/UiIcon.vue';

// An item's mark beside its name: the sprite the map draws it with (an
// aircraft's class, a vessel's type), tinted with the text colour, or its
// layer's glyph where the map draws no sprite per kind. Decorative: the row
// or card around it names the item.
const props = defineProps({
  /** The item's layer id. */
  layer: { type: String, required: true },
  /** Its sprite kind (`markKind` in entityMark.js); '' for the layer's default. */
  kind: { type: String, default: '' },
  /** The glyph to show when the layer has no sprite. */
  icon: { type: String, required: true },
  /** Size in pixels; null leaves it to the font size around it. */
  size: { type: Number, default: null },
});

const sprite = computed(() => markSprite(props.layer, props.kind));
const style = computed(() => ({
  '--mark': `url("${sprite.value}")`,
  fontSize: props.size == null ? undefined : `${props.size}px`,
}));
</script>

<template>
  <span v-if="sprite" class="entity-mark entity-mark--sprite" :style="style" aria-hidden="true"></span>
  <UiIcon v-else class="entity-mark entity-mark--glyph" :name="icon" :size="size" />
</template>

<style scoped>
.entity-mark--sprite {
  display: inline-block;
  flex: none;
  width: 1em;
  height: 1em;
  vertical-align: middle;
  background-color: currentColor;
  -webkit-mask: var(--mark) center / contain no-repeat;
  mask: var(--mark) center / contain no-repeat;
}
</style>
