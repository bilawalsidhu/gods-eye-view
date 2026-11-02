<script setup>
import { onBeforeUnmount } from 'vue';
import { t } from '../../i18n/index.js';
import { formatScaleRange } from '../unitLabels.js';
import RailCardSetting from './RailCardSetting.vue';
import RailChips from './RailChips.vue';
import RailRowList from './RailRowList.vue';

// Optional, ordered blocks without disclosure state. Every control is keyed.
const props = defineProps({
  blocks: { type: Array, default: () => [] },
  cardId: { type: String, default: undefined },
  onParams: { type: Function, default: () => {} },
});

// Controls of removed blocks dispatch nothing: a detached element keeps its
// last handler, which names a block the owner no longer lists.
let live = true;
onBeforeUnmount(() => {
  live = false;
});

function dispatch(descriptor, block) {
  if (!live || !props.blocks.includes(block)) return;
  if (!descriptor || descriptor.disabled) return;
  if (descriptor.params) props.onParams(props.cardId, descriptor.params);
  else descriptor.onClick?.();
}

const rootTag = (block) =>
  block.type === 'list' ? 'ol' : block.type === 'actions' ? 'footer' : 'div';
const lines = (block) => block.lines || [{ id: block.id, text: block.text }];

function legendView(legend) {
  const colors = (legend?.colors || []).filter((color) =>
    /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color),
  );
  const visible = colors.length >= 2 && colors.length === legend.colors.length;
  const zeroVisible =
    visible &&
    legend.units === '°C' &&
    Number.isInteger(legend.zeroIndex) &&
    legend.zeroIndex >= 0 &&
    legend.zeroIndex < colors.length;
  return {
    colors,
    visible,
    categorical: Boolean(legend?.categorical),
    zeroVisible,
    // Styles are strings so an unchanged legend writes nothing; browsers
    // normalize the colors they read back.
    rampStyle: visible
      ? `background: linear-gradient(to right, ${colors.join(',')})`
      : undefined,
    zeroStyle: zeroVisible
      ? `left: ${(legend.zeroIndex / (colors.length - 1)) * 100}%`
      : undefined,
    scale: visible
      ? formatScaleRange(
          legend.labels[0],
          legend.labels.at(-1),
          legend.units,
          legend.unitsVerbatim === true,
        )
      : '',
    labels: legend?.labels || [],
  };
}
</script>

<template>
  <template v-for="block in blocks" :key="`${block.id}:${block.type}`"
    ><RailRowList
      v-if="block.type === 'list'"
      :list="block.list"
      :block-id="block.id"
      :on-select="(item) => dispatch(item, block)"
    /><component
      :is="rootTag(block)"
      v-else
      :class="`rail-card-${block.type}`"
      :data-block-id="block.id"
      :hidden="
        block.type === 'legend' ? !legendView(block.legend).visible : undefined
      "
      ><RailCardBlocks
        v-if="block.type === 'settings'"
        :blocks="
          (block.settings || []).map((setting) => ({
            ...setting,
            type: 'setting',
          }))
        "
        :card-id="cardId"
        :on-params="onParams"
      /><RailCardSetting
        v-else-if="block.type === 'setting'"
        :setting="block"
        :dispatch="(descriptor) => dispatch(descriptor, block)"
      /><template v-else-if="block.type === 'result'"
        ><div class="rail-card-result-header"
          ><span class="panel-title">{{ block.label }}</span
          ><button
            class="data-toggle-chip"
            type="button"
            data-action-id="clear"
            :aria-label="t('Clear reading')"
            :title="t('Clear reading')"
            :hidden="!block.clear"
            @click="dispatch(block.clear, block)"
            >×</button
          ></div
        ><div class="rail-card-result-lines"
          ><RailCardBlocks
            :blocks="[
              { id: 'result-lines', type: 'lines', lines: block.lines },
            ]"
            :card-id="cardId"
            :on-params="onParams" /></div></template
      ><template v-else-if="block.type === 'legend'"
        ><div
          class="rail-card-ramp"
          :hidden="
            !legendView(block.legend).visible ||
            legendView(block.legend).categorical
          "
          :style="legendView(block.legend).rampStyle"
          ><span
            class="rail-card-zero"
            aria-hidden="true"
            :hidden="!legendView(block.legend).zeroVisible"
            :style="legendView(block.legend).zeroStyle"
          ></span></div
        ><div
          class="rail-card-scale"
          :hidden="legendView(block.legend).categorical"
          >{{ legendView(block.legend).scale }}</div
        ><div
          class="rail-card-legend-entries"
          :hidden="!legendView(block.legend).categorical"
          ><template v-if="legendView(block.legend).categorical"
            ><div
              v-for="(color, index) in legendView(block.legend).colors"
              :key="index"
              class="rail-card-legend-entry"
              :data-color="color"
              ><span
                class="rail-card-legend-swatch"
                :style="`background: ${color}`"
              ></span
              ><span>{{
                legendView(block.legend).labels[index] || ''
              }}</span></div
            ></template
          ></div
        ></template
      ><template v-else-if="block.type === 'actions'"
        ><template
          v-for="action in block.actions || []"
          :key="`${action.id}:${action.href ? 'a' : 'button'}`"
          ><a
            v-if="action.href"
            class="data-toggle-chip"
            :data-action-id="action.id"
            target="_blank"
            rel="noopener"
            :href="action.href"
            :title="action.title || undefined"
            @click="dispatch(action, block)"
            >{{ action.label }}</a
          ><button
            v-else
            :class="[
              'data-toggle-chip',
              { active: action.pressed, 'is-reserved': action.reserved },
            ]"
            type="button"
            :data-action-id="action.id"
            :title="action.title || undefined"
            :disabled="Boolean(action.disabled)"
            :aria-pressed="
              action.pressed === undefined
                ? undefined
                : String(Boolean(action.pressed))
            "
            :aria-hidden="
              action.reserved === undefined
                ? undefined
                : String(Boolean(action.reserved))
            "
            @click="dispatch(action, block)"
            >{{ action.label }}</button
          ><span class="rail-card-action-hint" :hidden="!action.hint">{{
            action.hint || ''
          }}</span></template
        ></template
      ><template v-else
        ><div
          v-for="line in lines(block)"
          :key="line.id"
          :class="`rail-card-line${line.muted ? ' muted' : ''}`"
          :data-line-id="line.id"
          >{{ String(line.text ?? '') }}</div
        ></template
      ></component
    ></template
  >
</template>
