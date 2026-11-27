import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

function updatePreviewIds(ids, cameraId, shown) {
  if (shown) return [...ids, cameraId];
  const index = ids.indexOf(cameraId);
  return index < 0 ? ids : ids.filter((_, i) => i !== index);
}

/**
 * A camera as its card and Camera tools render it. CctvControls presents the
 * tools' buttons, CAL chip, meta line and calibration readout
 * (`presentCctvPanel()`), runs the frame preview, source badge and typed
 * summary, and publishes them here; it keeps its listeners on the tools'
 * controls.
 */
export const useCctvStore = defineStore('gev-cctv', () => {
  /** The presented panel; null until the controls first render. */
  const view = shallowRef(null);

  /**
   * The pose value being typed: `{field, label, ariaLabel, step, value,
   * finish(commit, typedText)}`, or null.
   */
  const calEdit = shallowRef(null);

  /**
   * The preview: requested and shown frame, loading and error state, and the
   * time its source gave the shown frame (`timeMs`, `timeLabel`, `timeIso`).
   */
  const frame = shallowRef(null);
  /** Camera IDs with a visible card preview or an open bigger view. */
  const previewCards = shallowRef([]);
  const previewPopups = shallowRef([]);
  /** Camera whose Context settings currently own calibration. */
  const settingsCameraId = shallowRef(null);
  const settingsVisible = shallowRef(false);
  /** Whether the live video surface replaces the still frame. */
  const live = shallowRef(false);
  /**
   * What the card's live video shows: '' while no card paints it, 'waiting'
   * before its first frame, 'playing', or 'stalled' (its last frame held).
   */
  const liveState = shallowRef('');
  /** `{label, state}` for the source badge; null until first synced. */
  const sourceBadge = shallowRef(null);
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

  function showPreviewCard(cameraId, shown) {
    previewCards.value = updatePreviewIds(previewCards.value, cameraId, shown);
  }

  function showPreviewPopup(cameraId, shown) {
    previewPopups.value = updatePreviewIds(
      previewPopups.value,
      cameraId,
      shown,
    );
  }

  /** @param {boolean} on */
  function setLive(on) {
    live.value = Boolean(on);
  }

  /** @param {''|'waiting'|'playing'|'stalled'} next */
  function setLiveState(next) {
    liveState.value = next || '';
  }

  /** @param {{label: string, state: string}} next */
  function setSourceBadge(next) {
    sourceBadge.value = markRaw(next);
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
    settingsCameraId,
    settingsVisible,
    live,
    liveState,
    sourceBadge,
    summary,
    publish,
    setCalEdit,
    setFrame,
    showPreviewCard,
    showPreviewPopup,
    setLive,
    setLiveState,
    setSourceBadge,
    setSummary,
  };
});
