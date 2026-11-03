/**
 * `v-range-value`: a range input's (or a select's or text field's) live
 * value, written only when it differs.
 * A `:value` binding would also rewrite the value attribute on every patch;
 * the directive runs after the element's min, max and step are patched, so
 * the value is never clamped to a stale range.
 */
const apply = (el, { value }) => {
  const next = String(value);
  if (el.value !== next) el.value = next;
};
export const vRangeValue = { mounted: apply, updated: apply };
