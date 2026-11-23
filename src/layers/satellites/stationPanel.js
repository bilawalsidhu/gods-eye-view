import { distance } from '../../geo/index.js';
import { findCamera, findFrame } from '../../render/rendererOf.js';
import {
  issCommandCameraOnStation,
  issCommandOffersZoom,
  issCommandZoomOffset,
} from './issCommand.js';

/**
 * The STATION section in Context, for whichever station is selected. A
 * station is described once (`issStation.js` describes the ISS) and this
 * presents it: Automatic, where the joints follow their rules and the panel
 * says where the angles come from (telemetry, or computed when there is
 * none); Manual, where the person moves them with the controls the
 * description lists; and a zoom to the station from far away. Another
 * station plugs in with a description of its own.
 *
 * @typedef {object} StationDescription
 * @property {string} key Short id, e.g. 'iss'.
 * @property {string} title The station's name, as a badge.
 * @property {() => boolean} selected Whether this station is the tracked
 *   subject (also as one of its docked entries).
 * @property {() => string} subjectName The tracked entry's name.
 * @property {() => object|null} articulation The joint driver.
 * @property {() => {state: string, poseAgeMs: number|null,
 *   liveUntilMs: number|null}|null} telemetry Where the angles come from.
 * @property {() => {x: number, y: number, z: number}|null} position The
 *   station's drawn centre (ECEF metres), for the zoom.
 * @property {string} zoomLabel The zoom button's text (a msg key).
 * @property {{live?: string, computed: string}} notes Automatic's note on
 *   what moves the joints (msg keys): `live` while the articulation reports
 *   telemetry, `computed` otherwise (and always, for a station without a
 *   feed).
 * @property {Array<{id: string, label: string, note?: string|null,
 *   kind: 'choices', choices: Array<{id: string, label: string,
 *   isDefault?: boolean, apply: (articulation: object) => void}>}|
 *   {id: string, label: string, kind: 'sliders', resume?: string,
 *   sliders: Array<{id: string, label: string, min: number, max: number,
 *   apply: (articulation: object, value: number) => void}>,
 *   resumeApply?: (articulation: object) => void}>} groups Manual controls.
 * @property {(articulation: object) => void} automatic Hand every joint
 *   back to its rule.
 */

/** How often the status line's age is refreshed while the panel shows. */
export const STATION_PANEL_TICK_MS = 1000;

/**
 * @param {{state: object, parts: object, stations: StationDescription[],
 *   now?: () => number}} context
 */
export function createStationPanel({
  state: layerState,
  parts,
  stations,
  now = Date.now,
}) {
  const listeners = new Set();
  let view = null;
  /** The station shown, its mode, its Manual choices and slider values. */
  let current = null;
  let mode = 'automatic';
  let choices = new Map();
  let sliders = new Map();
  let ticker = null;
  let zoomTimer = null;
  /** The frame pump while a joint glides, and when it stops. */
  let pump = null;
  let pumpUntil = 0;
  /** The last view published, as text: an unchanged view is not republished. */
  let publishedKey = null;

  function _stationShown() {
    if (!layerState._enabled) return null;
    // The right rail is hidden while the Cockpit rides; nothing to show.
    if (parts.cockpit?._cockpitHeld()) return null;
    return stations.find((station) => station.selected()) ?? null;
  }

  function _resetManual(station) {
    choices = new Map();
    sliders = new Map();
    for (const group of station?.groups ?? []) {
      if (group.kind === 'choices') {
        const chosen = group.choices.find((choice) => choice.isDefault);
        if (chosen) choices.set(group.id, chosen.id);
      } else for (const slider of group.sliders) sliders.set(slider.id, 0);
    }
  }

  /**
   * The telemetry status with its ages in whole seconds: the section words
   * them so, and an age in ms would make every frame a change.
   */
  function wholeSeconds(status) {
    if (!status) return status;
    const second = (ms) =>
      Number.isFinite(ms) ? Math.floor(ms / 1000) * 1000 : ms;
    return { ...status, poseAgeMs: second(status.poseAgeMs) };
  }

  function _publish() {
    const station = current;
    if (!station) {
      if (view !== null) {
        view = null;
        publishedKey = null;
        for (const listener of listeners) listener(null);
      }
      return;
    }
    const articulation = station.articulation();
    const position = station.position();
    const eye = position
      ? (findCamera(layerState._viewer)?.pose?.()?.position ?? null)
      : null;
    const range = position && eye ? distance(eye, position) : null;
    const next = {
      key: station.key,
      title: station.title,
      subject: station.subjectName(),
      mode,
      telemetry: wholeSeconds(station.telemetry()),
      sunlit: mode === 'manual' ? null : (articulation?.isSunlit?.() ?? null),
      note:
        (articulation?.isLive?.() ? station.notes?.live : null) ??
        station.notes?.computed ??
        '',
      groups: station.groups.map((group) =>
        group.kind === 'choices'
          ? {
              id: group.id,
              label: group.label,
              note: group.note ?? null,
              kind: 'choices',
              choices: group.choices.map((choice) => ({
                id: choice.id,
                label: choice.label,
                active: choices.get(group.id) === choice.id,
              })),
            }
          : {
              id: group.id,
              label: group.label,
              note: group.note ?? null,
              kind: 'sliders',
              resume: group.resume ?? null,
              sliders: group.sliders.map((slider) => ({
                id: slider.id,
                label: slider.label,
                min: slider.min,
                max: slider.max,
                value: sliders.get(slider.id) ?? 0,
              })),
            },
      ),
      zoom: {
        offered:
          range !== null && issCommandOffersZoom(range) && _cameraOnStation(),
        label: station.zoomLabel,
      },
    };
    // Called every frame from the tick: the section re-renders only on a
    // change (the age line moves once a second, the rest on an action).
    const key = JSON.stringify(next);
    if (key === publishedKey) return;
    publishedKey = key;
    view = next;
    for (const listener of listeners) listener(view);
  }

  function _tick() {
    if (ticker) return;
    ticker = setInterval(() => {
      if (!current) {
        clearInterval(ticker);
        ticker = null;
        return;
      }
      _publish();
      _requestRender();
    }, STATION_PANEL_TICK_MS);
    ticker.unref?.();
  }

  /** Ask the renderer for a frame, through the frame port. */
  function _requestRender() {
    findFrame(layerState._viewer)?.requestRender('station-panel');
  }

  /**
   * Keep frames coming while a joint glides to a new pose: one pump, run
   * until the latest ask (a slider drag asks many times a second).
   */
  function _renderFor(ms) {
    if (!findFrame(layerState._viewer)) return;
    pumpUntil = Math.max(pumpUntil, now() + ms);
    if (pump) return;
    pump = setInterval(() => {
      _requestRender();
      if (now() > pumpUntil) _stopPump();
    }, 33);
    pump.unref?.();
  }

  function _stopPump() {
    if (pump) clearInterval(pump);
    pump = null;
    pumpUntil = 0;
  }

  function _stopZoom() {
    if (zoomTimer) clearInterval(zoomTimer);
    zoomTimer = null;
  }

  /**
   * Whether the camera follows the layer's follow target, framed (see
   * issCommand.js): the tracked satellite is the station, or docked to it.
   */
  function _cameraOnStation() {
    return issCommandCameraOnStation(
      findCamera(layerState._viewer),
      layerState._followTarget,
    );
  }

  /**
   * Bring the follow camera in to the station, a step per frame. Only while
   * the follow camera is on it: from any other camera the steps would lead
   * away, and a zoom pressed during the flight to the station would do so.
   */
  function _zoom() {
    _stopZoom();
    if (!_cameraOnStation()) return false;
    let steps = 0;
    zoomTimer = setInterval(() => {
      const camera = findCamera(layerState._viewer);
      steps += 1;
      if (
        !camera ||
        !current?.position() ||
        !current?.selected() ||
        !_cameraOnStation() ||
        steps > 400
      ) {
        _stopZoom();
        return;
      }
      // While the camera follows the station, its follow offset is the eye's
      // offset from it: shorten that, never move along the view. The port
      // asks for the frame itself.
      const next = issCommandZoomOffset(camera.followOffset.get());
      if (!next) {
        _stopZoom();
        return;
      }
      camera.followOffset.set(next);
    }, 16);
    return true;
  }

  const actions = {
    setStationMode(next) {
      const articulation = current?.articulation();
      if (!current || !articulation) return false;
      const wanted = next === 'manual' ? 'manual' : 'automatic';
      if (wanted === mode) return true;
      mode = wanted;
      if (mode === 'manual') articulation.setTelemetryAllowed?.(false);
      else {
        _resetManual(current);
        current.automatic(articulation);
      }
      _renderFor(20_000);
      _publish();
      return true;
    },
    chooseStation(groupId, choiceId) {
      const articulation = current?.articulation();
      const group = current?.groups.find((g) => g.id === groupId);
      const choice = group?.choices?.find((c) => c.id === choiceId);
      if (!articulation || !choice) return false;
      choices.set(groupId, choiceId);
      choice.apply(articulation);
      _renderFor(20_000);
      _publish();
      return true;
    },
    slideStation(sliderId, value) {
      const articulation = current?.articulation();
      const group = current?.groups.find((g) =>
        g.sliders?.some((s) => s.id === sliderId),
      );
      const slider = group?.sliders.find((s) => s.id === sliderId);
      const number = Number(value);
      if (!articulation || !slider || !Number.isFinite(number)) return false;
      const clamped = Math.min(slider.max, Math.max(slider.min, number));
      sliders.set(sliderId, clamped);
      slider.apply(articulation, clamped);
      _renderFor(2000);
      _publish();
      return true;
    },
    resumeStationArm(groupId) {
      const articulation = current?.articulation();
      const group = current?.groups.find((g) => g.id === groupId);
      if (!articulation || !group?.resumeApply) return false;
      for (const slider of group.sliders) sliders.set(slider.id, 0);
      group.resumeApply(articulation);
      _renderFor(20_000);
      _publish();
      return true;
    },
    zoomStation() {
      if (!current) return false;
      return _zoom();
    },
  };

  /**
   * Per tick and on tracking changes: show the selected station's panel,
   * or take it down. Leaving a station hands its joints back to Automatic,
   * so no manual pose lingers.
   */
  function _syncStationPanel() {
    const station = _stationShown();
    if (station !== current) {
      if (current && mode === 'manual') {
        const articulation = current.articulation();
        if (articulation) current.automatic(articulation);
      }
      _stopZoom();
      current = station;
      mode = 'automatic';
      _resetManual(station);
      if (station) _tick();
    }
    _publish();
  }

  function _destroyStationPanel() {
    // The joints go back to Automatic with the panel, as on leaving a station.
    if (current && mode === 'manual') {
      const articulation = current.articulation();
      if (articulation) current.automatic(articulation);
    }
    _stopZoom();
    _stopPump();
    if (ticker) clearInterval(ticker);
    ticker = null;
    current = null;
    mode = 'automatic';
    _publish();
  }

  const methods = {
    /**
     * Receive the STATION section's view: the current one at once, then
     * each change; null while no station is selected.
     * @param {(view: object|null) => void} listener
     * @returns {() => void} Stops listening.
     */
    subscribeStationPanel(listener) {
      listeners.add(listener);
      listener(view);
      return () => listeners.delete(listener);
    },
    /** The actions the section's controls call (the store's owners). */
    getStationActions() {
      return actions;
    },
  };

  return { _syncStationPanel, _destroyStationPanel, methods };
}
