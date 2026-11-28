import { markRaw, shallowRef } from 'vue';

/** A presentation slot: a shallow ref holding the newest raw presentation, and its publisher. */
export function presented() {
  const value = shallowRef(null);
  return [
    value,
    (next) => {
      value.value = next && markRaw(next);
    },
  ];
}
