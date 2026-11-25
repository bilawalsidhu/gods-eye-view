import { computed, ref, shallowRef, watch } from 'vue';

const findersByContainer = new WeakMap();

/** Pair the Data Layers row container with its view's Finder for LayerPanel.mount. */
export function bindLayerFinder(container, finder) {
  const binding = { finder };
  findersByContainer.set(container, binding);
  return () => {
    if (findersByContainer.get(container) === binding)
      findersByContainer.delete(container);
  };
}

export function layerFinderFor(container) {
  return findersByContainer.get(container)?.finder;
}

const allLayers = () => ({ query: '', show: 'all', category: '', picked: [] });

/** Shared by a page's finder controls and row presenter, or local to a standalone panel. */
export function createLayerFinder() {
  const selection = shallowRef(allLayers());
  const searching = ref(false);
  const filtering = ref(false);
  const categories = shallowRef([]);
  const shown = ref(0);
  const narrowed = computed(() => {
    const { query, show, category, picked } = selection.value;
    return Boolean(query.trim() || show !== 'all' || category || picked.length);
  });

  function select(patch) {
    selection.value = { ...selection.value, ...patch };
  }
  function pick(ids) {
    searching.value = false;
    selection.value = {
      ...allLayers(),
      picked: [...new Set(ids.filter(Boolean))],
    };
  }
  function clearAll() {
    searching.value = false;
    filtering.value = false;
    selection.value = allLayers();
  }
  function publish(groups, count) {
    shown.value = count;
    if (
      groups.length === categories.value.length &&
      groups.every(
        (group, i) =>
          group.key === categories.value[i].key &&
          group.label === categories.value[i].label,
      )
    )
      return;
    categories.value = groups;
    const selected = selection.value.category;
    if (selected && !groups.some((group) => group.key === selected)) {
      // A paint can remove a group. Finish that paint before applying a new
      // selection, and preserve a choice or group restored in the meantime.
      queueMicrotask(() => {
        if (
          selection.value.category === selected &&
          !categories.value.some((group) => group.key === selected)
        )
          select({ category: '' });
      });
    }
  }
  return {
    selection,
    searching,
    filtering,
    narrowed,
    categories,
    shown,
    select,
    pick,
    clearAll,
    publish,
    inputs: () => selection.value,
    onInputs: (listener) => watch(selection, listener, { flush: 'sync' }),
  };
}

/** Filter the Data Layers list in display order. Other panel lists keep their own rows. */
export function filterLayerRows(rows, { query, show, category, picked }) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = new Set();
  const groups = [];
  let group = '';
  let shown = 0;
  for (const item of rows) {
    if (item.heading) {
      group = item.key;
      groups.push({ key: group, label: item.heading });
      filtered.add(group);
      continue;
    }
    if (
      (category && category !== group) ||
      (picked.length && !picked.includes(item.id)) ||
      (show !== 'all' && (show === 'on') !== item.toggle.classes.active) ||
      (needle &&
        ![item.name, item.englishName]
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle))
    ) {
      filtered.add(item.key);
      continue;
    }
    filtered.delete(group);
    shown++;
  }
  return { filtered, groups, shown };
}
