import { computed, ref } from 'vue';

// The Context panel's own search: one field in its header that narrows what
// the panel is showing (the selected item's details, and every list of what
// is nearby or in view) to what holds the typed text.

/** Whether the search field is showing. */
export const contextSearchOpen = ref(false);
/** The text as typed. */
export const contextSearchText = ref('');
/** The text to match against: trimmed, lower case, '' when not searching. */
export const contextNeedle = computed(() =>
  contextSearchOpen.value ? contextSearchText.value.trim().toLowerCase() : '',
);

/** Whether any of the given strings holds the searched text (true when not searching). */
export function matchesContextSearch(...parts) {
  const needle = contextNeedle.value;
  if (!needle) return true;
  return parts.some(
    (part) =>
      part !== null &&
      part !== undefined &&
      String(part).toLowerCase().includes(needle),
  );
}

/** Match the compact roster label, full launch and mission names, or operator. */
export function matchesMissionSearch(entry) {
  return matchesContextSearch(
    entry.label,
    entry.name,
    entry.missionName,
    entry.provider,
  );
}

/** Close the field. The text is kept for the next time it opens. */
export function closeContextSearch() {
  contextSearchOpen.value = false;
}
