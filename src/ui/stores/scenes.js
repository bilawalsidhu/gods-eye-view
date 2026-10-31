import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * @typedef {object} SceneRowHandlers
 * @property {(shotId: string) => void} select
 * @property {(sceneId: string, shotId: string, title: string) => void} rename
 * @property {(sceneId: string, shotId: string) => void} load
 * @property {(sceneId: string, shotId: string) => void} remove
 */

/**
 * The Scene panel's project list as the panel views render it. SceneControls
 * owns the project presentation: it publishes here and attaches the row
 * actions; the views only render and forward clicks.
 */
export const useSceneStore = defineStore('gev-scenes', () => {
  // Scenes arrive as fresh read-only copies; only replacing them re-renders.
  const scenes = shallowRef(markRaw([]));
  const selectedSceneId = shallowRef(null);
  const selectedShotId = shallowRef(null);
  // The select's choice, updated only when its options are rendered.
  const listedSceneId = shallowRef(null);
  // Counts option renders: each one re-applies the select's choice, which
  // the person may have changed since.
  const listedRevision = shallowRef(0);
  /** Whether an owner presents the project; until then the list is empty. */
  const attached = shallowRef(false);
  /** @type {{handlers: SceneRowHandlers}|null} */
  let owner = null;

  /**
   * Present the project for an owner, replacing any earlier owner.
   * @param {SceneRowHandlers} handlers
   * @returns {object} Token for detach().
   */
  function attach(handlers) {
    owner = { handlers };
    attached.value = true;
    return owner;
  }

  /** Publish the shot list; `scenes` is copied so every publish re-renders. */
  function publish(state) {
    scenes.value = markRaw([...(state.scenes ?? [])]);
    selectedSceneId.value = state.selectedSceneId ?? null;
    selectedShotId.value = state.selectedShotId ?? null;
  }

  /** Publish the project and the select's choice. */
  function publishOptions(state) {
    publish(state);
    listedSceneId.value = state.selectedSceneId ?? null;
    listedRevision.value++;
  }

  /** @param {string|null} id */
  function selectShot(id) {
    selectedShotId.value = id ?? null;
  }

  /**
   * Stop presenting for the owner holding `token`: the list empties and row
   * clicks do nothing. A later owner's presentation is left alone.
   */
  function detach(token) {
    if (token !== owner) return;
    owner = null;
    attached.value = false;
    publishOptions({});
  }

  /**
   * Forward a row action to the owner, if one is attached.
   * @param {keyof SceneRowHandlers} name
   */
  function act(name, ...args) {
    owner?.handlers[name]?.(...args);
  }

  return {
    scenes,
    selectedSceneId,
    selectedShotId,
    listedSceneId,
    listedRevision,
    attached,
    attach,
    publish,
    publishOptions,
    selectShot,
    detach,
    act,
  };
});
