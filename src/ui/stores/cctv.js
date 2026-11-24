import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The CCTV panel as its view renders it. CctvControls presents the buttons,
 * CAL chip, meta line and calibration readout (`presentCctvPanel()`), runs
 * the frame preview, source badge and typed summary, and publishes them
 * here, with the camera picker's options; it keeps its listeners on the
 * panel's controls.
 */
export const useCctvStore = defineStore('gev-cctv', () => {
  /** The presented panel; null until the controls first render. */
  const view = shallowRef(null);

  /**
   * The pose value being typed: `{field, label, ariaLabel, step, value,
   * finish(commit, typedText)}`, or null.
   */
  const calEdit = shallowRef(null);

  /** The preview: requested and shown frame, loading and error state. */
  const frame = shallowRef(null);
  /** Number of camera cards outside the panel showing its preview, including Context's card. */
  const previewCards = shallowRef(0);
  /** Number of open bigger views of a camera card (popups over the map). */
  const previewPopups = shallowRef(0);
  /** Whether the live video surface replaces the still frame. */
  const live = shallowRef(false);
  /** `{label, state}` for the source badge; null until first synced. */
  const sourceBadge = shallowRef(null);
  /**
   * The camera picker: `{options: [{value, label}], note, disabled,
   * selection: {value}|{index}|null}`; null until first rendered.
   */
  const picker = shallowRef(null);
  /** The scene summary as typed so far; null until the first one. */
  const summary = shallowRef(null);

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  let editCount = 0;

  /** @param {object|null} edit Each edit gets its own `id`, and input. */
  function setCalEdit(edit) {
    calEdit.value = edit ? markRaw({ ...edit, id: ++editCount }) : null;
  }

  /** @param {object} next */
  function setFrame(next) {
    frame.value = markRaw(next);
  }

  /** @param {boolean} shown */
  function showPreviewCard(shown) {
    previewCards.value = Math.max(0, previewCards.value + (shown ? 1 : -1));
  }

  /** @param {boolean} shown */
  function showPreviewPopup(shown) {
    previewPopups.value = Math.max(0, previewPopups.value + (shown ? 1 : -1));
  }

  /** @param {boolean} on */
  function setLive(on) {
    live.value = Boolean(on);
  }

  /** @param {{label: string, state: string}} next */
  function setSourceBadge(next) {
    sourceBadge.value = markRaw(next);
  }

  /** @param {object} next */
  function setPicker(next) {
    picker.value = markRaw(next);
  }

  /** @param {string} text */
  function setSummary(text) {
    summary.value = text;
  }

  return {
    view,
    calEdit,
    frame,
    previewCards,
    previewPopups,
    live,
    sourceBadge,
    summary,
    picker,
    publish,
    setCalEdit,
    setFrame,
    showPreviewCard,
    showPreviewPopup,
    setLive,
    setSourceBadge,
    setSummary,
    setPicker,
  };
});
