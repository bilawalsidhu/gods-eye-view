/**
 * `v-field-value`: a form field's live value, written only when it differs
 * and the field is not focused, so a render never overwrites what a person
 * is typing, picking or dragging. Focus is read before the render patches
 * the field too, since disabling it drops focus. A null value leaves the
 * field as it is. Unlike a `:value` binding, the value attribute is never
 * rewritten.
 */
const focused = (el) => el.ownerDocument?.activeElement === el;
const apply = (el, { value }) => {
  const held = focused(el) || el.__fieldValueFocused;
  el.__fieldValueFocused = false;
  if (value == null || held) return;
  const next = String(value);
  if (el.value !== next) el.value = next;
};
export const vFieldValue = {
  mounted: apply,
  beforeUpdate(el) {
    el.__fieldValueFocused = focused(el);
  },
  updated: apply,
};
