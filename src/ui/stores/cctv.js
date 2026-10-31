import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The CCTV panel's buttons, CAL chip, meta line and calibration readout as
 * its view renders them. CctvControls presents them (`presentCctvPanel()`)
 * and publishes here; it keeps its listeners on the buttons and paints the
 * picker, frame, source badge and summary itself.
 */
export const useCctvStore = defineStore('gev-cctv', () => {
  /** The presented panel; null until the controls first render. */
  const view = shallowRef(null);

  /**
   * The pose value being typed: `{field, label, ariaLabel, step, value,
   * finish(commit, typedText)}`, or null.
   */
  const calEdit = shallowRef(null);

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  let editCount = 0;

  /** @param {object|null} edit Each edit gets its own `id`, and input. */
  function setCalEdit(edit) {
    calEdit.value = edit ? markRaw({ ...edit, id: ++editCount }) : null;
  }

  return { view, calEdit, publish, setCalEdit };
});
