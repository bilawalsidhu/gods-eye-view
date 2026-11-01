import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Display panel as its view renders it. VisualSettings presents its
 * groups (`_presentDisplay()`), AircraftDisplay the 3D aircraft group, the
 * draw tool its controls and the file import its list, and each publishes
 * here. The Display controls' changes reach their owner (DisplayBindings)
 * through act(); the draw tool and the file import keep their listeners on
 * their controls. VisualSettings also
 * publishes the active style, which the dock and the scene chrome show, and
 * the map source controls publish their chip row beside it.
 */
export const useDisplayStore = defineStore('gev-display', () => {
  /** The presented panel; null until VisualSettings first renders. */
  const view = shallowRef(null);

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  /** The 3D aircraft group; null until AircraftDisplay first renders. */
  const models3d = shallowRef(null);

  /** @param {object} next A fresh presentation of the 3D aircraft group. */
  function publishModels3d(next) {
    models3d.value = markRaw(next);
  }

  /** The Draw controls; null until the draw tool first renders. */
  const draw = shallowRef(null);

  /** @param {object} next A fresh presentation of the Draw controls. */
  function publishDraw(next) {
    draw.value = markRaw(next);
  }

  /** The imported files and hint; null until the file import renders. */
  const geoImport = shallowRef(null);

  /** @param {object} next A fresh presentation of the imported files. */
  function publishGeoImport(next) {
    geoImport.value = markRaw(next);
  }

  /** The active visual style; null until VisualSettings first presents it. */
  const style = shallowRef(null);

  /** @param {{name: string, label: string}} next The active style and its label. */
  function publishStyle(next) {
    style.value = markRaw(next);
  }

  /** The map source chips and status; null until the controls first render. */
  const mapSource = shallowRef(null);

  /** @param {object} next A fresh presentation of the map source row. */
  function publishMapSource(next) {
    mapSource.value = next && markRaw(next);
  }

  /** The map source controls whose `select(id)` a chip calls. */
  const mapSourceControls = shallowRef(null);

  /** @param {?object} controls The map source controls, or null to disconnect. */
  function connectMapSource(controls) {
    mapSourceControls.value = controls && markRaw(controls);
  }

  /** @type {{actions: object}|null} The Display controls' owner. */
  let owner = null;

  /**
   * Answer the Display controls (and the dock's style buttons) with
   * `actions`, replacing any earlier owner.
   * @param {Record<string, Function>} actions
   * @returns {object} Token for detach().
   */
  function connect(actions) {
    owner = { actions };
    return owner;
  }

  /** Stop answering for the owner holding `token`; a later owner stays. */
  function detach(token) {
    if (token === owner) owner = null;
  }

  /**
   * A control's change: call the owner's action, if one is connected.
   * @param {string} name
   * @param {...unknown} args
   */
  function act(name, ...args) {
    owner?.actions[name]?.(...args);
  }

  /** The phone shell's tab bar; null until the shell first presents it. */
  const phoneShell = shallowRef(null);

  /** @param {?{enabled: boolean, sheet: string|null, tabs: object[]}} next The phone shell's tabs, whether it is on and its open sheet. */
  function publishPhoneShell(next) {
    phoneShell.value = next && markRaw(next);
  }

  return {
    view,
    publish,
    models3d,
    publishModels3d,
    draw,
    publishDraw,
    geoImport,
    publishGeoImport,
    style,
    publishStyle,
    phoneShell,
    publishPhoneShell,
    mapSource,
    publishMapSource,
    mapSourceControls,
    connectMapSource,
    connect,
    detach,
    act,
  };
});
