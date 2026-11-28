/**
 * `v-owned-value`: writes `value.text` on mount and afterwards only when
 * `value.revision` changes, so a field keeps what the person types until its
 * owner replaces it.
 */
export const vOwnedValue = {
  mounted(el, { value }) {
    el.value = value.text;
  },
  updated(el, { value, oldValue }) {
    if (value.revision !== oldValue?.revision && el.value !== value.text)
      el.value = value.text;
  },
};
