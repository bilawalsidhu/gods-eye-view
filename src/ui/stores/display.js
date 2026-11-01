import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Display panel as its view renders it. VisualSettings presents its
 * groups (`_presentDisplay()`), AircraftDisplay the 3D aircraft group, the
 * draw tool its controls and the file import its list, and each publishes
 * here. The controls' changes reach their owners (DisplayBindings, the draw
 * tool and the file import) through act(). VisualSettings also
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

  /**
   * The owners answering the panel's controls, oldest first: DisplayBindings
   * the Display controls and the dock's style buttons, the draw tool and the
   * file import their own.
   * @type {Array<{actions: object}>}
   */
  const owners = [];

  /**
   * Answer the actions named in `actions`; for those names this owner
   * replaces any earlier one.
   * @param {Record<string, Function>} actions
   * @returns {object} Token for detach().
   */
  function connect(actions) {
    const token = { actions };
    owners.push(token);
    return token;
  }

  /** Stop answering for the owner holding `token`; the others stay. */
  function detach(token) {
    const index = owners.indexOf(token);
    if (index >= 0) owners.splice(index, 1);
  }

  /**
   * A control's change: call the newest connected owner's action of that
   * name, if any.
   * @param {string} name
   * @param {...unknown} args
   */
  function act(name, ...args) {
    for (let index = owners.length - 1; index >= 0; index -= 1) {
      const action = owners[index].actions[name];
      if (action) return void action(...args);
    }
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
