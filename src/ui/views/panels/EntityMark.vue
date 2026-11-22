<script setup>
import { computed } from 'vue';
import { markGlyph, markSprite, markStyle, spriteKind } from '../../entityMark.js';
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
  /** The glyph without a sprite; the layer's own when empty. */
  icon: { type: String, default: '' },
  /** Size in pixels; null leaves it to the font size around it. */
  size: { type: Number, default: null },
});

const sprite = computed(() => markSprite(props.layer, props.kind));
const style = computed(() => markStyle(sprite.value, props.size));
const glyph = computed(() => props.icon || markGlyph(props.layer));
</script>

<template>
  <span v-if="sprite" class="entity-mark" :data-mark="spriteKind(layer, kind)" :style="style" aria-hidden="true"></span>
  <UiIcon v-else class="entity-mark entity-mark--glyph" :name="glyph" :size="size" />
</template>
