import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';
import { createOwners } from './owners.js';

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

  /**
   * The groups added under Effects, in the order first
   * published: each `{id, rows}`. A row is a `toggle` (`{kind, id, label,
   * icon?, title?, checked, onChange(checked)}`), a `slider` (`{kind, id,
   * label, min, max, value, onChange(value)}`, its value shown in percent)
   * or a `note` (`{kind, id, text}`).
   */
  const groups = shallowRef([]);

  /**
   * Show the group `id` as `group` describes it, in place where it is shown
   * already; null takes it away.
   * @param {string} id
   * @param {?{rows: object[]}} group
   */
  function publishGroup(id, group) {
    const at = groups.value.findIndex((g) => g.id === id);
    const next = [...groups.value];
    if (!group) {
      if (at < 0) return;
      next.splice(at, 1);
    } else {
      const shown = markRaw({ id, rows: [...(group.rows ?? [])] });
      if (at < 0) next.push(shown);
      else next[at] = shown;
    }
    groups.value = next;
  }

  /**
   * The Sky group, `{switches, milkyWay}` (switches by name, the Milky Way
   * in percent); null where the renderer has no sky to set.
   */
  const sky = shallowRef(null);

  /** @param {?object} next A fresh presentation of the Sky group. */
  function publishSky(next) {
    sky.value = next && markRaw(next);
  }

  /**
   * The Frame rate row, `{fps, stop, min, max, step}`: the rate (0 for
   * unlimited) and the slider's stop for it, the last stop being unlimited;
   * null until the controls first present it.
   */
  const frameRate = shallowRef(null);

  /** @param {?object} next A fresh presentation of the Frame rate row. */
  function publishFrameRate(next) {
    frameRate.value = next && markRaw(next);
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

  /** Rows added under Map Source, in the order first shown. */
  const mapLayers = shallowRef([]);

  /** @param {string} id @param {?object} row The row, or null to remove it. */
  function publishMapLayer(id, row) {
    const next = mapLayers.value.slice();
    const at = next.findIndex((entry) => entry.id === id);
    if (!row) {
      if (at >= 0) next.splice(at, 1);
    } else if (at >= 0) next[at] = markRaw({ ...row, id });
    else next.push(markRaw({ ...row, id }));
    mapLayers.value = next;
  }

  /** The map source controls whose `select(id)` a chip calls. */
  const mapSourceControls = shallowRef(null);

  /** @param {?object} controls The map source controls, or null to disconnect. */
  function connectMapSource(controls) {
    mapSourceControls.value = controls && markRaw(controls);
  }

  // DisplayBindings answers the Display controls and the dock's style
  // buttons, the draw tool and the file import their own.
  const { connect, detach, act } = createOwners();

  /**
   * The active style's parameter rows, `{style, rows}`; null while the style
   * has none. Each row's change calls act('setStyleParameter', name, value).
   */
  const parameters = shallowRef(null);

  /** @param {?{style: string, rows: object[]}} next */
  function publishParameters(next) {
    parameters.value = next && markRaw(next);
  }

  /**
   * The Cockpit's Display popover slots while Cockpit shows the Display
   * controls, `{hud, detection, parameters, models3d}` (elements); null while
   * they stay in the Display panel. The panel teleports its groups there.
   */
  const cockpitPortal = shallowRef(null);

  /** @param {?object} next The slots, or null to bring the groups home. */
  function publishCockpitPortal(next) {
    cockpitPortal.value = next && markRaw(next);
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
    groups,
    publishGroup,
    sky,
    publishSky,
    frameRate,
    publishFrameRate,
    draw,
    publishDraw,
    geoImport,
    publishGeoImport,
    style,
    publishStyle,
    parameters,
    publishParameters,
    cockpitPortal,
    publishCockpitPortal,
    phoneShell,
    publishPhoneShell,
    mapSource,
    publishMapSource,
    mapSourceControls,
    connectMapSource,
    mapLayers,
    publishMapLayer,
    connect,
    detach,
    act,
  };
});
