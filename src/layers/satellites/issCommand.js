import { onLocaleChange, t } from '../../i18n/index.js';
import { ISS_ARM_JOINTS } from './issArticulation.js';
import { makePanelDraggable } from './issLive.js';
import * as Cesium from 'cesium';
import { ISS_NORAD } from './policy.js';

/**
 * Whether the command panel shows: the ISS selected (tracked), the layer on
 * and the Cockpit not riding it.
 * @param {{enabled: boolean, trackedNorad: number|null, cockpitHeld: boolean}} input
 * @returns {boolean}
 */
export function issCommandShouldShow({ enabled, trackedNorad, cockpitHeld }) {
  return Boolean(enabled) && trackedNorad === ISS_NORAD && !cockpitHeld;
}

const unit = (v) => {
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
};

/**
 * The Sun positions Manual offers, on the model's axes (port, zenith,
 * forward), and whether the station is lit there.
 * @returns {Array<{label: string, sun: number[], sunlit: boolean}>}
 */
export function issCommandSunPoses() {
  return [
    { label: t('Overhead'), sun: [0, 1, 0], sunlit: true },
    { label: t('Ahead'), sun: unit([0, 0.05, 1]), sunlit: true },
    { label: t('Behind'), sun: unit([0, 0.05, -1]), sunlit: true },
    { label: t('Below'), sun: unit([0, -1, 0.05]), sunlit: true },
    { label: t('Port side'), sun: unit([0.8, 0.5, 0.3]), sunlit: true },
    { label: t('Starboard side'), sun: unit([-0.8, 0.5, 0.3]), sunlit: true },
    { label: t('Night (shadow)'), sun: [0, -1, 0], sunlit: false },
  ];
}

/** Where "Zoom to the ISS" stops: the whole 109 m station fills the view. */
export const ISS_COMMAND_ZOOM_RANGE_M = 260;

/**
 * The Automatic mode's status line.
 * @param {boolean|null} sunlit Null while the model has not been placed yet.
 * @returns {string}
 */
export function issCommandStatusText(sunlit) {
  if (sunlit === null) return '';
  return sunlit ? t('Now: in sunlight') : t("Now: in the Earth's shadow");
}

/** Beyond this the camera counts as far, and the zoom button is offered. */
export const ISS_COMMAND_FAR_M = 1000;

/**
 * Whether "Zoom to the ISS" is offered: only from far away, so it goes once
 * the camera is in close (by the button or by hand) and returns on zooming
 * back out.
 * @param {number} distance Meters from the camera to the station.
 * @returns {boolean}
 */
export function issCommandOffersZoom(distance) {
  return distance > ISS_COMMAND_FAR_M;
}

/**
 * One step of the zoom: how far to move in from `distance`, easing out as
 * the target range nears, never past it.
 * @param {number} distance Meters from the camera to the station.
 * @returns {number} Meters to move in; 0 once close enough.
 */
export function issCommandZoomStep(distance) {
  const left = distance - ISS_COMMAND_ZOOM_RANGE_M;
  if (!(left > ISS_COMMAND_ZOOM_RANGE_M * 0.02)) return 0;
  return left * 0.14;
}

/** How long one lap of the "fast orbit" takes, and its share in shadow. */
const FAST_ORBIT_MS = 40_000;

/**
 * The Sun over one accelerated orbit: it circles the truss, a third of the
 * lap in the Earth's shadow.
 * @param {number} elapsedMs
 * @returns {{sun: number[], sunlit: boolean}}
 */
export function issCommandFastOrbit(elapsedMs) {
  const angle = (elapsedMs / FAST_ORBIT_MS) * 2 * Math.PI;
  return {
    sun: unit([0.35, Math.cos(angle), Math.sin(angle)]),
    sunlit: Math.cos(angle) > -0.5,
  };
}

/**
 * The ISS command panel: shown collapsed while the ISS is selected. Automatic
 * (the default) leaves the model to its own rules: arrays and radiators by the
 * Sun, dishes at the relay satellites, arms swaying. Manual opens the
 * controls and hands the joints to the viewer; going back to Automatic
 * returns every joint to its rule.
 */
export function createIssCommand({ state: layerState, parts }) {
  let panel = null;
  let renderTimer = null;
  let renderUntil = 0;

  const joints = () => parts.issModel?._issArticulation ?? null;

  /** Keep frames coming while a joint is on its way to a new pose. */
  function _renderFor(ms) {
    renderUntil = Math.max(renderUntil, Date.now() + ms);
    if (renderTimer) return;
    renderTimer = setInterval(() => {
      layerState._viewer?.scene?.requestRender?.();
      if (Date.now() > renderUntil) _stopRendering();
    }, 33);
  }

  function _stopRendering() {
    if (renderTimer) clearInterval(renderTimer);
    renderTimer = null;
    renderUntil = 0;
  }

  let zoomTimer = null;
  let zoomButton = null;
  /** Stops listening for language changes; set while the panel is open. */
  let stopLocale = null;
  let statusLine = null;
  /** The lit/shadow state the status line last showed. */
  let shownSunlit;

  /** Say whether the station is in sunlight right now, when that changes. */
  function _syncStatus() {
    if (!statusLine) return;
    const sunlit = joints()?.isSunlit() ?? null;
    if (sunlit === shownSunlit) return;
    shownSunlit = sunlit;
    statusLine.textContent = issCommandStatusText(sunlit);
  }

  /** Meters from the camera to the station, or null when unknown. */
  function _stationDistance() {
    const viewer = layerState._viewer;
    const target =
      parts.issModel?._issVisualPosition?.() ??
      layerState._trackedFrameCartesian ??
      layerState._points.get(ISS_NORAD)?.position;
    if (!viewer || !target) return null;
    return Cesium.Cartesian3.distance(viewer.camera.positionWC, target);
  }

  function _syncZoomButton() {
    if (!zoomButton) return;
    const distance = _stationDistance();
    const offered = distance !== null && issCommandOffersZoom(distance);
    if (zoomButton.hidden === offered) zoomButton.hidden = !offered;
  }

  function _stopZoom() {
    if (zoomTimer) clearInterval(zoomTimer);
    zoomTimer = null;
  }

  /**
   * Bring the follow camera in to the station. The camera already tracks the
   * ISS, so this only shortens its range, a step per frame.
   */
  function _zoomToStation() {
    _stopZoom();
    let steps = 0;
    zoomTimer = setInterval(() => {
      const viewer = layerState._viewer;
      const target =
        parts.issModel?._issVisualPosition?.() ??
        layerState._trackedFrameCartesian ??
        layerState._points.get(ISS_NORAD)?.position;
      steps += 1;
      if (
        !viewer ||
        !target ||
        layerState._trackedNorad !== ISS_NORAD ||
        steps > 400
      ) {
        _stopZoom();
        return;
      }
      const step = issCommandZoomStep(
        Cesium.Cartesian3.distance(viewer.camera.positionWC, target),
      );
      if (!step) {
        _stopZoom();
        return;
      }
      viewer.camera.zoomIn(step);
      viewer.scene.requestRender?.();
    }, 16);
  }

  /** Every joint back to its own rule. */
  function _automatic() {
    const articulation = joints();
    if (!articulation) return;
    articulation.setOverride(null);
    articulation.setDishOverride(null);
    articulation.setDeploy(true);
    articulation.setRadiatorDeploy(true);
    articulation.resumeArm();
    _renderFor(20_000);
  }

  function _build(documentRef) {
    const el = (tag, className, text) => {
      const node = documentRef.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const root = el('section', 'qci-panel iss-command-panel');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', t('ISS command panel'));

    const header = el('header', 'qci-header');
    const title = el('strong', 'iss-command-title', t('ISS · COMMAND PANEL'));
    const toggle = el('button', 'iss-command-toggle');
    toggle.type = 'button';
    header.append(title, toggle);

    const body = el('div', 'iss-command-body');
    body.hidden = true;
    const setCollapsed = (collapsed) => {
      body.hidden = collapsed;
      toggle.textContent = collapsed ? '▸' : '▾';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute(
        'aria-label',
        collapsed ? t('Expand command panel') : t('Collapse command panel'),
      );
    };
    toggle.addEventListener('click', () => setCollapsed(!body.hidden));
    setCollapsed(true);

    // Mode
    const modes = el('div', 'iss-command-modes');
    modes.setAttribute('role', 'radiogroup');
    const autoButton = el('button', 'iss-command-mode', t('Automatic'));
    const manualButton = el('button', 'iss-command-mode', t('Manual'));
    const status = el('p', 'iss-command-status');
    statusLine = status;
    const autoNote = el(
      'p',
      'qci-note',
      t(
        'Arrays and radiators follow the Sun, the dishes aim at relay satellites and the arms sway for illustration. Computed, not live telemetry.',
      ),
    );
    const manual = el('div', 'iss-command-manual');
    manual.hidden = true;
    const setMode = (isManual) => {
      for (const [button, on] of [
        [autoButton, !isManual],
        [manualButton, isManual],
      ]) {
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(on));
        button.classList.toggle('is-active', on);
      }
      manual.hidden = !isManual;
      autoNote.hidden = isManual;
      status.hidden = isManual;
    };
    const resetControls = () => {
      manual
        .querySelectorAll('input[type="range"]')
        .forEach((slider) => (slider.value = '0'));
      // Back to what Automatic does: each row's own default lit.
      manual
        .querySelectorAll('.iss-command-button')
        .forEach((button) =>
          button.classList.toggle('is-active', button.dataset.default === '1'),
        );
    };
    autoButton.addEventListener('click', () => {
      setMode(false);
      resetControls();
      _automatic();
    });
    manualButton.addEventListener('click', () => setMode(true));
    modes.append(autoButton, manualButton);
    setMode(false);

    // Manual controls
    const group = (label, note) => {
      const box = el('div', 'iss-command-group');
      box.append(el('div', 'iss-command-label', label));
      const row = el('div', 'iss-command-row');
      box.append(row);
      if (note) box.append(el('p', 'qci-note', note));
      manual.append(box);
      return row;
    };
    /** A row of buttons where the last one pressed stays lit. */
    const choices = (row, entries) => {
      for (const [label, action, isDefault] of entries) {
        const button = el('button', 'iss-command-button', label);
        button.type = 'button';
        // What Automatic is doing starts lit, so the row shows what holds.
        if (isDefault) {
          button.dataset.default = '1';
          button.classList.add('is-active');
        }
        button.addEventListener('click', () => {
          row
            .querySelectorAll('.is-active')
            .forEach((other) => other.classList.remove('is-active'));
          button.classList.add('is-active');
          const articulation = joints();
          if (!articulation) return;
          action(articulation);
          _renderFor(20_000);
        });
        row.append(button);
      }
    };

    choices(group(t('Sun position')), [
      [t('Follow the Sun'), (a) => a.setOverride(null), true],
      ...issCommandSunPoses().map(({ label, sun, sunlit }) => [
        label,
        (a) => {
          const fixed = { sun, sunlit };
          a.setOverride(() => fixed);
        },
      ]),
      [
        t('Fast orbit (40 s)'),
        (a) => {
          const start = Date.now();
          a.setOverride((nowMs) => issCommandFastOrbit(nowMs - start));
          _renderFor(10 * 60_000);
        },
      ],
    ]);
    choices(
      group(
        t('Solar arrays'),
        t('Demonstration: the real arrays stay extended.'),
      ),
      [
        [t('Retract'), (a) => a.setDeploy(false)],
        [t('Extend'), (a) => a.setDeploy(true), true],
      ],
    );
    choices(
      group(
        t('Radiators'),
        t('Demonstration: the real radiators can fold but stay extended.'),
      ),
      [
        [t('Retract'), (a) => a.setRadiatorDeploy(false)],
        [t('Extend'), (a) => a.setRadiatorDeploy(true), true],
      ],
    );
    choices(group(t('Dishes')), [
      [t('Relay satellites'), (a) => a.setDishOverride(null), true],
      [t('Up'), (a) => a.setDishOverride([0, 1, 0])],
      [t('Forward'), (a) => a.setDishOverride(unit([0, 0.35, 0.94]))],
      [t('Sideways'), (a) => a.setDishOverride(unit([0.94, 0.35, 0]))],
    ]);

    const armLabels = [
      t('Shoulder roll'),
      t('Shoulder yaw'),
      t('Shoulder pitch'),
      t('Elbow'),
      t('Wrist pitch'),
      t('Wrist yaw'),
      t('Wrist roll'),
    ];
    const arm = group(t('Canadarm2 (degrees)'));
    arm.classList.add('iss-command-sliders');
    ISS_ARM_JOINTS.forEach((joint, i) => {
      const row = el('label', 'iss-command-slider');
      const slider = el('input');
      slider.type = 'range';
      slider.min = '-120';
      slider.max = '120';
      slider.value = '0';
      slider.addEventListener('input', () => {
        joints()?.setJoint(
          joint.node,
          joint.pivot,
          joint.axis,
          (Number(slider.value) * Math.PI) / 180,
        );
        _renderFor(2000);
      });
      row.append(el('span', '', armLabels[i]), slider);
      arm.append(row);
    });
    const resume = el('button', 'iss-command-button', t('Resume sway'));
    resume.type = 'button';
    resume.addEventListener('click', () => {
      arm
        .querySelectorAll('input[type="range"]')
        .forEach((slider) => (slider.value = '0'));
      joints()?.resumeArm();
      _renderFor(20_000);
    });
    arm.append(resume);

    const zoom = el('button', 'iss-command-button iss-command-zoom');
    zoom.type = 'button';
    zoom.textContent = t('Zoom to the ISS');
    zoom.addEventListener('click', _zoomToStation);
    zoomButton = zoom;
    body.append(zoom, modes, status, autoNote, manual);
    root.append(header, body);
    makePanelDraggable(root, header);
    return root;
  }

  /**
   * Show or hide the panel for the current selection. Cheap when nothing
   * changed, so the tracking and Cockpit paths can call it freely.
   * @returns {void}
   */
  function _syncIssCommand() {
    const show = issCommandShouldShow({
      enabled: layerState._enabled,
      trackedNorad: layerState._trackedNorad,
      cockpitHeld: Boolean(parts.cockpit?._cockpitHeld()),
    });
    if (!show) {
      _removePanel();
      return;
    }
    if (panel) {
      _syncZoomButton();
      _syncStatus();
      return;
    }
    const documentRef = globalThis.document;
    if (!documentRef?.body) return;
    panel = _build(documentRef);
    documentRef.body.append(panel);
    stopLocale = onLocaleChange(_onLocaleChange);
    _syncZoomButton();
    _syncStatus();
  }

  /** Closing the panel hands the joints back, so no manual pose lingers. */
  function _removePanel() {
    if (!panel) return;
    panel.remove();
    panel = null;
    zoomButton = null;
    stopLocale?.();
    stopLocale = null;
    statusLine = null;
    shownSunlit = undefined;
    _stopZoom();
    _automatic();
    _stopRendering();
  }

  // A language change rebuilds the panel in the new language. It comes back
  // collapsed and on Automatic, as on a fresh selection.
  function _onLocaleChange() {
    if (!panel) return;
    _removePanel();
    _syncIssCommand();
  }

  function _destroyIssCommand() {
    _removePanel();
  }

  return { _syncIssCommand, _destroyIssCommand };
}
