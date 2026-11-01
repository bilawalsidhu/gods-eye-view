import { defineStore } from 'pinia';
import { computed, ref, shallowReactive } from 'vue';
import { createOwners } from './owners.js';

/**
 * The top-center globe actions as their view renders them. The shell
 * publishes whether a clear of the selected data layers is under way and the
 * camera's tilt and heading, and answers the buttons through act().
 */
export const useGlobeActionsStore = defineStore('gev-globe-actions', () => {
  const owners = createOwners();
  // Who answers which action, as the computed state below reads it.
  const ownership = ref(0);
  /** Each clear owner's clear under way, by its token. */
  const busyBy = shallowReactive(new Map());

  /**
   * Whether the clear owner's clear is under way; null until it says. Each
   * owner keeps its own, so the button shows the one that answers it.
   */
  const clearBusy = computed(() => {
    void ownership.value;
    return busyBy.get(owners.ownerOf('clear')) ?? null;
  });

  /**
   * @param {object} token The clear owner's, from connect().
   * @param {boolean} busy
   */
  function publishClearBusy(token, busy) {
    busyBy.set(token, Boolean(busy));
  }

  /**
   * Whether the map reads as tilted and the camera's whole-degree heading;
   * null until the camera controls first say.
   * @type {import('vue').Ref<{ tilted: boolean, heading: number } | null>}
   */
  const camera = ref(null);

  /**
   * Take the camera's state; the same state again changes nothing, so its
   * owner can publish it on every frame the camera draws.
   * @param {{ tilted: boolean, heading: number } | null} state
   */
  function publishCamera(state) {
    const current = camera.value;
    if (!state) {
      camera.value = null;
      return;
    }
    const tilted = Boolean(state.tilted);
    if (current?.tilted === tilted && current.heading === state.heading) return;
    camera.value = { tilted, heading: state.heading };
  }

  /** @param {Record<string, Function>} actions */
  function connect(actions) {
    const token = owners.connect(actions);
    ownership.value += 1;
    return token;
  }

  function detach(token) {
    owners.detach(token);
    busyBy.delete(token);
    ownership.value += 1;
  }

  const { act, owns } = owners;

  return {
    clearBusy,
    publishClearBusy,
    camera,
    publishCamera,
    connect,
    detach,
    act,
    owns,
  };
});
