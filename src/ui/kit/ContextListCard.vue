<script>
import { reactive } from 'vue';

// The card's per-card memory for the session and the split of its items
// into groups for the bar under its heading.

/** The sizes offered in a card's page-size menu; the first is the default. */
export const LIST_PAGE_SIZES = Object.freeze([5, 10, 15]);

/** How many groups the bar names before "Other". */
export const GROUPS_NAMED = 3;

// Each card's page and page size, by its id, for the session (never saved):
// a card that leaves the page and comes back is where it was.
const memory = reactive({});

/**
 * A card's memory, made on first use.
 * @param {string} id
 * @param {number} size The default page size.
 * @returns {{page: number, size: number}}
 */
export function listCardMemory(id, size = LIST_PAGE_SIZES[0]) {
  if (!memory[id]) memory[id] = { page: 0, size };
  return memory[id];
}

/** For tests: forget every card's page and size. */
export function resetListCardMemory() {
  for (const id of Object.keys(memory)) delete memory[id];
}

/**
 * Items split into groups by `groupBy`, the largest first: the first `named`
 * groups, then the rest together as one `other` part. Groups of the same
 * size keep the order their first item has.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} groupBy
 * @param {number} [named]
 * @returns {{label: string, count: number, share: number, other: boolean}[]}
 */
export function groupSplit(items, groupBy, named = GROUPS_NAMED) {
  const list = items || [];
  const counts = new Map();
  for (const item of list) {
    const label = groupBy(item);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const part = (label, count, other) => ({
    label,
    count,
    share: count / list.length,
    other,
  });
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const parts = ranked
    .slice(0, named)
    .map(([label, count]) => part(label, count, false));
  const rest = ranked.slice(named).reduce((sum, [, count]) => sum + count, 0);
  if (rest) parts.push(part('', rest, true));
  return parts;
}
</script>

<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onBeforeUpdate,
  onUpdated,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { formatNumber, t } from '../../i18n/index.js';
import UiButton from './UiButton.vue';
import UiCloseButton from './UiCloseButton.vue';
import UiIcon from './UiIcon.vue';
import UiSelect from './UiSelect.js';

// A list card in Context: a layer block's head (feed dot, icon, title and
// how many), an optional bar of what those are made of (the largest groups
// named, the rest as Other), then the items a page at a time, Previous and
// Next beside the current range and page-size menu. A row emits `select`;
// with `selected` set, the item's detail (the `detail` slot) shows in the
// list's place with a return control that emits `back`; Escape does the same.
// Focus follows: onto Back, then back onto the item's row. The card keeps
// its page and page size for the session by `id`, and reports the order it
// lists in (`order`), for a caller that walks it. It knows nothing of what
// it lists: the caller's `sort`, `filter`, `groupBy`, `filter` slot (its
// controls, above the list), `row` and `footer` slots do.
const props = defineProps({
  /** Names the card's memory for the session, and its heading's id. */
  id: { type: String, required: true },
  title: { type: String, required: true },
  /** A Material Symbols name. */
  icon: { type: String, default: '' },
  /** The feed dot: `nominal`, `loading`, `stale`, …, with its words. */
  tone: { type: String, default: 'nominal' },
  toneText: { type: String, default: '' },
  items: { type: Array, default: () => [] },
  pageWindow: { type: Object, default: null },
  pageSize: { type: Number, default: LIST_PAGE_SIZES[0] },
  /** Hold the last settled page while the same catalog query refreshes. */
  stablePage: Boolean,
  /** An item's key, unique in `items`. */
  itemKey: { type: Function, default: (item) => item.id },
  /** The items in list order; their own order when not given. */
  sort: { type: Function, default: null },
  /** Which items show (a search); every one when not given. */
  filter: { type: Function, default: null },
  /** What the filter matches; a change starts the list at page one. */
  query: { type: String, default: '' },
  /** An item's group for the bar; no bar when not given. */
  groupBy: { type: Function, default: null },
  /** The key of the item whose detail shows, or null for the list. */
  selected: { type: [String, Number], default: null },
  /** `ready`, or `loading`, `empty` or `failed` with nothing to list. */
  state: { type: String, default: 'ready' },
  /** Each row a button; false for rows that hold controls of their own,
   * which get `select` in the row slot instead. */
  rowButton: { type: Boolean, default: true },
  /** Close the detail from the header in place of its total. */
  headerClose: Boolean,
  /** A selected camera can move outside the current radius. */
  allowUnlisted: Boolean,
  /** Accessible return-to-list label. */
  backTitle: { type: String, default: '' },
  /** A caller-supplied revision opts into holding row order after a pick. */
  returnRevision: { type: [Number, String], default: null },
});
const emit = defineEmits([
  'select',
  'back',
  'order',
  'row-pointer',
  'row-focus',
  'row-blur',
]);

const headId = computed(() => `context-list-card-${props.id}`);
const memory = listCardMemory(props.id, props.pageSize);

const shown = computed(() =>
  props.filter ? props.items.filter((item) => props.filter(item)) : props.items,
);
// Keep positions by key so a refresh can still update or remove its rows.
const returnOrder = shallowRef(null);
const orderedItems = computed(() => {
  const sorted = props.sort ? props.sort(shown.value) : shown.value;
  const remembered = returnOrder.value?.positions;
  if (!remembered) return sorted;
  const position = (item) =>
    remembered.get(props.itemKey(item)) ?? remembered.size;
  return [...sorted].sort((a, b) => position(a) - position(b));
});
function releaseOrder() {
  if (!returnOrder.value) return;
  returnOrder.value = null;
}
watch(
  [() => props.query, () => props.returnRevision],
  ([query], [previous]) => {
    releaseOrder();
    if (query !== previous) memory.page = 0;
  },
);

const providerGroups = computed(() => {
  if (!props.groupBy && !props.pageWindow?.groups) return [];
  const parts =
    props.pageWindow?.groups ?? groupSplit(orderedItems.value, props.groupBy);
  const other = t('Other');
  const aggregate = parts.some((part) => !part.other && part.label === other)
    ? t('Remaining groups')
    : other;
  return parts.map((part, index) => ({
    ...part,
    key: part.other ? 'aggregate' : `group:${part.label}`,
    label: part.other ? aggregate : part.label,
    tone: part.other ? 4 : index,
  }));
});

const pageView = computed((previous) => {
  const { pageWindow, query, state } = props;
  if (
    props.stablePage &&
    state === 'loading' &&
    previous?.query === query &&
    previous.state === 'ready' &&
    previous.rows.length
  )
    return previous;
  const order = orderedItems.value;
  const total = pageWindow?.total ?? order.length;
  const size = memory.size;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(memory.page, pages - 1);
  const first = page * size;
  return {
    query,
    state,
    hasItems: props.items.length > 0,
    order,
    rows: pageWindow ? order : order.slice(first, first + size),
    groups: state === 'ready' ? providerGroups.value : [],
    total,
    size,
    pages,
    page,
    first,
  };
});
const order = computed(() => pageView.value.order);
watch(
  () => order.value.map((item) => props.itemKey(item)),
  (keys, before) => {
    if (!before || keys.join('\u0000') !== before.join('\u0000'))
      emit('order', keys);
  },
  { immediate: true },
);
const total = computed(() => pageView.value.total);
const first = computed(() => pageView.value.first);
const rows = computed(() => pageView.value.rows);
const groups = computed(() => pageView.value.groups);
const presentationState = computed(() => pageView.value.state);
const atStart = computed(() => pageView.value.page === 0);
const atEnd = computed(() => pageView.value.page === pageView.value.pages - 1);
// Paged: more than the smallest page holds, so the range is a control.
const paged = computed(() => total.value > LIST_PAGE_SIZES[0]);
const rangeText = computed(() =>
  t('{from}–{to} of {total}', {
    from: formatNumber(first.value + 1),
    to: formatNumber(Math.min(first.value + pageView.value.size, total.value)),
    total: formatNumber(total.value),
  }),
);
const sizeOptions = computed(() =>
  LIST_PAGE_SIZES.map((size) => ({
    value: String(size),
    label: formatNumber(size),
  })),
);
function resize(value) {
  const size = Number(value);
  if (!LIST_PAGE_SIZES.includes(size) || size === memory.size) return;
  const firstShown = first.value;
  releaseOrder();
  memory.size = size;
  memory.page = Math.floor(firstShown / size);
}
// At either end its button stays focusable (aria-disabled), so a key held
// on Next never drops focus to the page.
function turn(step) {
  if (step < 0 ? atStart.value : atEnd.value) return;
  const nextPage = pageView.value.page + step;
  releaseOrder();
  memory.page = nextPage;
}

const selectedItem = computed(() =>
  props.selected === null
    ? null
    : (props.items.find((item) => props.itemKey(item) === props.selected) ??
      null),
);
const detailShown = computed(
  () =>
    Boolean(selectedItem.value) ||
    (props.allowUnlisted && props.selected !== null),
);
function select(item, event) {
  if (props.returnRevision !== null) {
    returnOrder.value = {
      positions: new Map(
        order.value.map((row, index) => [props.itemKey(row), index]),
      ),
      key: props.itemKey(item),
      index: rows.value.indexOf(item),
    };
  }
  emit('select', item, event);
}
function back() {
  emit('back');
}
function onDetailKey(event) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing)
    return;
  event.preventDefault();
  back();
}

// Row events for a caller's preview: the pointer on a row (once more on the
// first movement after the rows change, as a refresh resets a preview), and
// keyboard focus.
const root = ref(null);
const itemOf = (element) => {
  const key = element?.closest?.('[data-list-key]')?.dataset.listKey;
  return key === undefined || !root.value?.contains(element)
    ? null
    : (rows.value.find((item) => String(props.itemKey(item)) === key) ?? null);
};
let pointerStale = false;
function pointerEnter(item) {
  pointerStale = false;
  emit('row-pointer', item);
}
function pointerMove(item) {
  if (!pointerStale) return;
  pointerStale = false;
  emit('row-pointer', item);
}

// Focus is never sent back to the page. Opening a detail moves it onto Back
// and Back moves it onto the item's row (else the heading), when it was in
// the card. A focused row that the rows leave (or move) hands it to the
// same item's row, else the row now in its place, else the pager or the
// heading; any other control that goes hands it to the last row. A card
// leaving the page hands it to the panel's body.
const scrollerOf = () => root.value?.closest('[data-rail-scroller]') ?? null;
const focusInCard = () => {
  const active = globalThis.document?.activeElement;
  return Boolean(
    active &&
    (root.value?.contains(active) || active === globalThis.document.body),
  );
};
const rowOf = (key) =>
  [...(root.value?.querySelectorAll('[data-list-key]') ?? [])].find(
    (button) => button.dataset.listKey === String(key),
  );
const rowFocusTarget = (row) =>
  row?.querySelector('[data-list-primary]') ?? row;
watch(
  () => (detailShown.value ? props.selected : null),
  async (key, before) => {
    if (!focusInCard()) return;
    await nextTick();
    const returned = returnOrder.value;
    const buttons = root.value?.querySelectorAll('[data-list-key]');
    const rowIndex = returned?.index ?? -1;
    const neighbor =
      rowIndex >= 0 && buttons?.length
        ? buttons[Math.min(rowIndex, buttons.length - 1)]
        : null;
    const target =
      key !== null
        ? root.value?.querySelector('[data-list-back]')
        : (rowFocusTarget(
            rowOf(before) ??
              (returned ? rowOf(returned.key) : null) ??
              neighbor,
          ) ?? root.value?.querySelector(`#${headId.value}`));
    // Focus without the browser's own scroll, then only as far as it takes
    // to bring the control into view in its scroller.
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  },
);
let held = null;
onBeforeUpdate(() => {
  const active = globalThis.document?.activeElement;
  if (!active || !root.value?.contains(active)) {
    held = null;
    return;
  }
  const row = active.closest('[data-list-key]');
  held = {
    key: row?.dataset.listKey ?? null,
    index: row ? Number(row.dataset.listIndex) : Infinity,
  };
});
onUpdated(() => {
  pointerStale = true;
  const was = held;
  held = null;
  if (!was) return;
  const active = globalThis.document?.activeElement;
  if (active && active !== globalThis.document.body) return;
  const card = root.value;
  const buttons = [...(card?.querySelectorAll('[data-list-key]') ?? [])];
  const row =
    (was.key !== null &&
      buttons.find((button) => button.dataset.listKey === was.key)) ||
    buttons[Math.min(was.index, buttons.length - 1)];
  const next =
    rowFocusTarget(row) ||
    card?.querySelector('.context-list-card__pager button') ||
    card?.querySelector(`#${headId.value}`);
  next?.focus({ preventScroll: true });
});
onBeforeUnmount(() => {
  const active = globalThis.document?.activeElement;
  if (!active || !root.value?.contains(active)) return;
  const scroller = scrollerOf();
  void nextTick(() => {
    const now = globalThis.document?.activeElement;
    if (scroller?.isConnected && (!now || now === globalThis.document.body))
      scroller.focus({ preventScroll: true });
  });
});
</script>

<template>
  <section
    ref="root"
    class="view-context__block nearby-lists context-list-card"
    :data-list-card="id"
    :aria-labelledby="headId"
  >
    <h4
      :id="headId"
      class="view-context__block-head context-list-card__head"
      tabindex="-1"
    >
      <i
        class="view-context__dot"
        :class="`view-context__dot--${tone}`"
        :role="toneText ? 'img' : undefined"
        :aria-hidden="toneText ? undefined : true"
        :aria-label="toneText || undefined"
        :title="toneText || undefined"
      ></i>
      <UiIcon
        v-if="icon"
        class="entity-mark entity-mark--glyph"
        :name="icon"
        :size="null"
      />
      <span class="view-context__block-name">{{ title }}</span>
      <UiCloseButton
        v-if="headerClose && detailShown"
        class="context-list-card__close"
        data-list-back
        data-owns-escape
        :label="backTitle || t('Close card')"
        :title="backTitle || t('Close card')"
        @keydown="onDetailKey"
        @click="back"
      />
      <strong v-else-if="presentationState === 'ready'">{{
        formatNumber(total)
      }}</strong>
    </h4>
    <!-- The detail in the list's place: Esc here is the card's (Back). -->
    <div
      v-if="detailShown"
      class="context-list-card__detail"
      data-owns-escape
      @keydown="onDetailKey"
    >
      <UiButton
        v-if="!headerClose"
        class="context-list-card__back"
        data-list-back
        :title="backTitle || undefined"
        @click="back"
        ><span aria-hidden="true">‹</span> {{ t('Back') }}</UiButton
      >
      <slot name="detail" :item="selectedItem" />
    </div>
    <template v-else>
      <slot
        name="filter"
        :page-items="presentationState === 'ready' ? rows : []"
      />
      <p
        v-if="presentationState === 'loading'"
        class="context-list-card__state"
      >
        <slot name="loading">{{ t('Loading') }}</slot>
      </p>
      <p
        v-else-if="presentationState === 'failed'"
        class="context-list-card__state"
      >
        <slot name="failed">{{ t('Unavailable') }}</slot>
      </p>
      <div
        v-else-if="presentationState === 'empty' || !pageView.hasItems"
        class="context-list-card__state"
      >
        <slot name="empty" />
      </div>
      <p v-else-if="!order.length" class="context-list-card__state">
        <slot name="no-matches" />
      </p>
      <template v-else>
        <template v-if="groups.length">
          <!-- What the count is made of; its legend says it in words. -->
          <div class="view-context__bar" aria-hidden="true">
            <span
              v-for="part in groups"
              :key="part.key"
              :data-tone="part.tone"
              :style="{ flexGrow: part.share }"
            ></span>
          </div>
          <p class="view-context__bar-key">
            <span v-for="part in groups" :key="part.key" :data-tone="part.tone"
              >{{ part.label }} {{ formatNumber(part.count) }}</span
            >
          </p>
        </template>
        <div class="nearby-lists__layer">
          <ul>
            <li v-for="(item, index) in rows" :key="itemKey(item)">
              <div
                v-if="!rowButton"
                class="context-list-card__row"
                :data-list-key="itemKey(item)"
                :data-list-index="index"
                tabindex="-1"
              >
                <slot
                  name="row"
                  :item="item"
                  :index="first + index"
                  :select="() => select(item)"
                />
              </div>
              <UiButton
                v-else
                :data-list-key="itemKey(item)"
                :data-list-index="index"
                @click="select(item, $event)"
                @mouseenter="pointerEnter(item)"
                @mousemove="pointerMove(item)"
                @mouseleave="emit('row-pointer', null)"
                @focus="emit('row-focus', item)"
                @blur="emit('row-blur', itemOf($event.relatedTarget))"
              >
                <slot name="row" :item="item" :index="first + index" />
              </UiButton>
            </li>
          </ul>
          <!-- Previous, where the page is, Next. Each option shows its
               size and the range it would display. -->
          <nav
            class="context-list-card__pager"
            :class="{ 'context-list-card__pager--paged': paged }"
            :aria-label="t('Pages')"
          >
            <UiButton
              v-if="paged"
              class="context-list-card__page-button"
              data-list-previous
              :aria-disabled="String(atStart)"
              @click="turn(-1)"
              ><span aria-hidden="true">‹</span> {{ t('Previous') }}</UiButton
            >
            <span class="context-list-card__range" data-list-range>{{
              rangeText
            }}</span>
            <UiSelect
              v-if="paged"
              class="context-list-card__range"
              data-list-size
              :model-value="String(pageView.size)"
              :options="sizeOptions"
              :aria-label="
                t('{name} per page, showing {range}', {
                  name: title,
                  range: rangeText,
                })
              "
              @update:model-value="resize"
            />
            <UiButton
              v-if="paged"
              class="context-list-card__page-button"
              data-list-next
              :aria-disabled="String(atEnd)"
              @click="turn(1)"
              >{{ t('Next') }} <span aria-hidden="true">›</span></UiButton
            >
          </nav>
        </div>
      </template>
      <slot name="footer" />
    </template>
  </section>
</template>
