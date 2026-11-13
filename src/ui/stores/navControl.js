import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import { createOwners } from './owners.js';

/**
 * The on-screen navigation control as its view renders it. The navigation
 * owner (src/ui/navControl/navControl.js) publishes the camera's heading,
 * the tilt, whether a followed entity holds the camera and whether the
 * compass ring is being dragged; the view calls the owner's actions back
 * through act(). Until an owner connects there is no control to show.
 */
export const useNavControlStore = defineStore('gev-nav-control', () => {
  const owners = createOwners();

  /**
   * `{heading, tilt, following, dragging}`: the whole-degree heading, the
   * tilt in degrees from top-down, and the two states; null until published.
   * @type {import('vue').ShallowRef<?{heading: number, tilt: number, following: boolean, dragging: boolean}>}
   */
  const view = shallowRef(null);

  /**
   * Answer the control's actions. A newer owner replaces an older one.
   * @param {Record<string, Function>} actions
   * @returns {object} Token for publish() and detach().
   */
  function connect(actions) {
    return owners.connect(actions);
  }

  /**
   * Show the owner's fresh view; an owner replaced by a newer one is ignored.
   * @param {object} token From connect().
   * @param {{heading: number, tilt: number, following: boolean, dragging: boolean}} next
   */
  function publish(token, next) {
    if (!owners.owns(token, 'press')) return;
    view.value = Object.freeze({ ...next });
  }

  /** Stop answering for `token`; the control goes when no owner is left. */
  function detach(token) {
    owners.detach(token);
    if (!owners.ownerOf('press')) view.value = null;
  }

  const { act } = owners;

  return { view, connect, publish, detach, act };
});
