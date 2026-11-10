/**
 * Write a live region's message, even a repeated one, so a screen reader
 * announces it again. The value is `{text, seq}`; the owner bumps `seq` for
 * every message it says.
 */
export const vStatusText = {
  mounted(el, { value }) {
    el.textContent = value.text;
  },
  updated(el, { value, oldValue }) {
    if (value.seq !== oldValue?.seq || value.text !== oldValue?.text)
      el.textContent = value.text;
  },
};
