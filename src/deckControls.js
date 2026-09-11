/**
 * Steam Deck / gamepad controls for God's Eye View.
 *
 * Left stick   — move (forward / back / strafe)
 * Right stick  — look (rotate / tilt), sensitivity scales down when zoomed in
 * L2 / R2      — zoom out / in
 * L1           — toggle HUD
 * R1           — toggle data panel
 * A            — select target at screen center
 * B            — back / clear tracking (Escape)
 * X            — toggle CCTV layer
 * Y            — reset globe
 * D-pad up/down — cycle visual style
 * D-pad left   — toggle orbit
 * D-pad right  — toggle clean view
 * Select       — cycle detection overlay
 * Start (hold) — push-to-talk voice
 * R3           — toggle controls help overlay
 * L3 (stick click) — toggle cockpit (when aircraft tracked)
 */

import * as Cesium from 'cesium';
import { interruptCameraMotion } from './cameraVerbs.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from './renderGovernor.js';

const DEADZONE = 0.18;
const STYLES = ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow'];

/** localStorage key for the DISPLAY → Gamepad slider. */
export const DECK_CONTROLS_STORAGE_KEY = 'gev-deck-controls';

export function readDeckControlsEnabled(storage = globalThis.localStorage, envFlag = import.meta.env?.GEV_DECK_CONTROLS) {
  try {
    const stored = storage?.getItem?.(DECK_CONTROLS_STORAGE_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    // private mode / missing storage
  }
  return envFlag !== '0';
}

export function writeDeckControlsEnabled(enabled, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(DECK_CONTROLS_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore quota / privacy errors
  }
}

/** Camera altitude (m) below which look input is heavily damped. */
export const DECK_LOOK_MIN_ALTITUDE_M = 400;
/** Camera altitude (m) above which look input reaches full strength. */
export const DECK_LOOK_FULL_ALTITUDE_M = 120_000;
/** Look sensitivity at low altitude as a fraction of the global baseline. */
export const DECK_LOOK_MIN_SCALE = 0.06;
/** Baseline right-stick turn rate (radians/sec at full deflection). */
export const DECK_LOOK_BASE_RATE = 1.35;
/** Baseline mouse-look scale when pointer lock is active. */
export const DECK_MOUSE_LOOK_BASE_SCALE = 0.0032;

const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
};

/**
 * Scale look sensitivity by camera altitude so street-level views stay controllable.
 * @param {number} heightM
 * @returns {number} Multiplier in [DECK_LOOK_MIN_SCALE, 1].
 */
export function deckLookSensitivityScale(heightM) {
  const height = Math.max(DECK_LOOK_MIN_ALTITUDE_M, Number(heightM) || DECK_LOOK_MIN_ALTITUDE_M);
  if (height >= DECK_LOOK_FULL_ALTITUDE_M) return 1;
  const minLog = Math.log(DECK_LOOK_MIN_ALTITUDE_M);
  const fullLog = Math.log(DECK_LOOK_FULL_ALTITUDE_M);
  const progress = (Math.log(height) - minLog) / (fullLog - minLog);
  const clamped = Math.max(0, Math.min(1, progress));
  return DECK_LOOK_MIN_SCALE + (1 - DECK_LOOK_MIN_SCALE) * clamped;
}

function applyDeadzone(value) {
  const v = Number(value) || 0;
  if (Math.abs(v) < DEADZONE) return 0;
  const sign = Math.sign(v);
  return sign * ((Math.abs(v) - DEADZONE) / (1 - DEADZONE));
}

function triggerValue(buttons, index) {
  const btn = buttons[index];
  if (!btn) return 0;
  if (typeof btn.value === 'number' && btn.value > 0) return btn.value;
  return btn.pressed ? 1 : 0;
}

function buttonPressed(index, buttons, prevButtons) {
  return Boolean(buttons[index]?.pressed && !prevButtons[index]?.pressed);
}

function buttonReleased(index, buttons, prevButtons) {
  return Boolean(!buttons[index]?.pressed && prevButtons[index]?.pressed);
}

function dispatchKey(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  }));
}

function simulateCenterClick(viewer) {
  const canvas = viewer.scene.canvas;
  const rect = canvas.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const base = {
    clientX,
    clientY,
    pointerId: 9001,
    pointerType: 'mouse',
    bubbles: true,
    cancelable: true,
    button: 0,
    view: window,
  };
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
}

function canControlCamera(viewer, styleManager) {
  const controller = viewer.scene.screenSpaceCameraController;
  if (!controller?.enableInputs) return false;
  if (document.body.classList.contains('cockpit-mode')) return false;
  if (styleManager?.cockpitView?.active) return false;
  return true;
}

function isPointerLockedToCanvas(canvas) {
  return document.pointerLockElement === canvas;
}

/**
 * Steam Deck desktop profiles often expose L2/R2 as gamepad buttons but route
 * the right stick through the mouse cursor instead of axes 2/3. Pointer lock
 * turns those mouse deltas back into camera look input.
 */
function bindPointerLookFallback(canvas, getActive, onDelta) {
  const onMouseMove = (event) => {
    if (!getActive() || !isPointerLockedToCanvas(canvas)) return;
    const dx = Number(event.movementX) || 0;
    const dy = Number(event.movementY) || 0;
    if (dx || dy) onDelta(dx, dy);
  };
  canvas.addEventListener('mousemove', onMouseMove);
  return () => canvas.removeEventListener('mousemove', onMouseMove);
}

function requestCanvasPointerLock(canvas) {
  if (isPointerLockedToCanvas(canvas)) return;
  canvas.requestPointerLock?.().catch(() => {
    // Steam/Chromium may reject until a fresh user gesture; we'll retry on input.
  });
}

function createReticle() {
  const el = document.createElement('div');
  el.id = 'deck-reticle';
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<span class="deck-reticle-h"></span><span class="deck-reticle-v"></span>';
  document.body.appendChild(el);
  return el;
}

function createHelpPanel() {
  const el = document.createElement('div');
  el.id = 'deck-controls-help';
  el.hidden = true;
  el.setAttribute('aria-label', 'Gamepad controls');
  el.innerHTML = `
    <div class="deck-controls-title">DECK CONTROLS</div>
    <div class="deck-controls-row"><span>L Stick</span><span>Move</span></div>
    <div class="deck-controls-row"><span>R Stick</span><span>Look</span></div>
    <div class="deck-controls-row"><span>L2 / R2</span><span>Zoom</span></div>
    <div class="deck-controls-row"><span>A</span><span>Select</span></div>
    <div class="deck-controls-row"><span>B</span><span>Back</span></div>
    <div class="deck-controls-row"><span>Y</span><span>Reset globe</span></div>
    <div class="deck-controls-row"><span>D-pad</span><span>Style / orbit / clean</span></div>
    <div class="deck-controls-row"><span>L3</span><span>Cockpit</span></div>
    <div class="deck-controls-row"><span>L1 / R1</span><span>HUD / panel</span></div>
    <div class="deck-controls-row"><span>Start (hold)</span><span>Push to talk</span></div>
    <div class="deck-controls-row"><span>R3</span><span>Hide this help</span></div>
    <div class="deck-controls-row deck-controls-note">DISPLAY → Gamepad slider turns this scheme on or off.</div>
  `;
  document.body.appendChild(el);
  return el;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {import('./ui.js').StyleManager} styleManager
 */
export function initDeckControls(viewer, styleManager) {
  const canvas = viewer.scene.canvas;
  const reticle = createReticle();
  const helpPanel = createHelpPanel();
  let connected = false;
  let enabled = readDeckControlsEnabled();
  let helpVisible = true;
  let prevButtons = [];
  let styleIndex = 0;
  let cameraActive = false;
  let lastFrameMs = performance.now();
  let rafId = 0;
  let lookMouseDX = 0;
  let lookMouseDY = 0;

  const releasePointerLook = bindPointerLookFallback(
    canvas,
    () => enabled && connected && canControlCamera(viewer, styleManager),
    (dx, dy) => {
      lookMouseDX += dx;
      lookMouseDY += dy;
    },
  );

  const syncHelpVisibility = () => {
    helpPanel.hidden = !enabled || !connected || !helpVisible;
    document.body.classList.toggle('deck-help-hidden', connected && enabled && !helpVisible);
  };

  const setConnected = (active) => {
    connected = active && enabled;
    document.body.classList.toggle('deck-controls-active', connected);
    reticle.hidden = !connected;
    syncHelpVisibility();
  };

  const syncToggleUi = () => {
    const toggleBtn = document.getElementById('deck-controls-toggle');
    const switchEl = document.getElementById('deck-controls-switch');
    toggleBtn?.classList.toggle('active', enabled);
    if (toggleBtn) toggleBtn.setAttribute('aria-pressed', String(enabled));
    if (switchEl) switchEl.checked = enabled;
  };

  const setEnabled = (next) => {
    enabled = Boolean(next);
    writeDeckControlsEnabled(enabled);
    syncToggleUi();
    if (!enabled) {
      endPushToTalk();
      setConnected(false);
      prevButtons = [];
      if (cameraActive) {
        releaseContinuousRender('deck-controls');
        cameraActive = false;
      }
      if (document.pointerLockElement === canvas) document.exitPointerLock?.();
    } else {
      const pads = navigator.getGamepads?.() || [];
      if (pads.some((pad) => pad?.connected)) {
        syncStyleIndex();
        setConnected(true);
      }
    }
  };

  const syncStyleIndex = () => {
    const current = styleManager?.activeStyle || 'normal';
    const idx = STYLES.indexOf(current);
    if (idx >= 0) styleIndex = idx;
  };

  const cycleStyle = (delta) => {
    styleIndex = (styleIndex + delta + STYLES.length) % STYLES.length;
    styleManager?.setStyle?.(STYLES[styleIndex]);
  };

  const toggleHelpPanel = () => {
    helpVisible = !helpVisible;
    syncHelpVisibility();
  };

  const beginPushToTalk = () => {
    window.__gevVoiceCommands?.beginPushToTalk?.();
  };

  const endPushToTalk = () => {
    window.__gevVoiceCommands?.endPushToTalk?.();
  };

  const toggleHud = () => {
    styleManager?.shareLinkManager?.claimRestoreLane?.('visual');
    styleManager?.hud?.toggle?.();
    styleManager?._updateHudButtonState?.();
    styleManager?._syncShareState?.();
  };

  const updateCamera = (gamepad, dt) => {
    if (!canControlCamera(viewer, styleManager)) {
      if (cameraActive) {
        releaseContinuousRender('deck-controls');
        cameraActive = false;
      }
      return;
    }

    const camera = viewer.camera;
    const height = Math.max(100, camera.positionCartographic?.height ?? 1000);
    const lookScale = deckLookSensitivityScale(height);
    const moveRate = Math.max(80, Math.min(height * 0.35, 400000)) * dt;
    const rotateRate = DECK_LOOK_BASE_RATE * lookScale * dt;
    const mouseLookScale = DECK_MOUSE_LOOK_BASE_SCALE * lookScale;
    const zoomRate = height * 0.9 * dt;

    const lx = applyDeadzone(gamepad.axes[0]);
    const ly = applyDeadzone(-gamepad.axes[1]);
    const rx = applyDeadzone(gamepad.axes[2]);
    const ry = applyDeadzone(-gamepad.axes[3]);
    const l2 = triggerValue(gamepad.buttons, BTN.L2);
    const r2 = triggerValue(gamepad.buttons, BTN.R2);

    const moved = lx || ly || rx || ry || l2 > 0.08 || r2 > 0.08;
    if (moved) {
      interruptCameraMotion('manual-input');
      requestCanvasPointerLock(canvas);
    }

    if (ly) camera.moveForward(moveRate * ly);
    if (lx) camera.moveRight(moveRate * lx);
    if (rx) camera.rotateRight(rotateRate * rx);
    if (ry) camera.lookUp(rotateRate * ry);

    const hadMouseLook = !rx && !ry && (lookMouseDX || lookMouseDY);
    if (hadMouseLook) {
      camera.rotateRight(lookMouseDX * mouseLookScale);
      camera.lookUp(-lookMouseDY * mouseLookScale);
      lookMouseDX = 0;
      lookMouseDY = 0;
    }

    if (r2 > 0.08) camera.zoomIn(zoomRate * r2);
    if (l2 > 0.08) camera.zoomOut(zoomRate * l2);

    const cameraChanged = moved || hadMouseLook;
    if (cameraChanged) {
      holdContinuousRender('deck-controls');
      governorRequestRender('deck-controls');
      cameraActive = true;
    } else if (cameraActive) {
      releaseContinuousRender('deck-controls');
      cameraActive = false;
    }
  };

  const handleButtons = (gamepad) => {
    const { buttons } = gamepad;

    if (buttonPressed(BTN.A, buttons, prevButtons)) {
      if (!isPointerLockedToCanvas(canvas)) requestCanvasPointerLock(canvas);
      else simulateCenterClick(viewer);
    }
    if (buttonPressed(BTN.B, buttons, prevButtons)) dispatchKey('Escape');
    if (buttonPressed(BTN.X, buttons, prevButtons)) dispatchKey('c');
    if (buttonPressed(BTN.Y, buttons, prevButtons)) styleManager?.resetToGlobeView?.();

    if (buttonPressed(BTN.L1, buttons, prevButtons)) toggleHud();
    if (buttonPressed(BTN.R1, buttons, prevButtons)) dispatchKey('f');

    if (buttonPressed(BTN.SELECT, buttons, prevButtons)) {
      styleManager?.shareLinkManager?.claimRestoreLane?.('visual');
      styleManager._detectionUserOverridden = true;
      dispatchKey('d');
    }

    if (buttonPressed(BTN.START, buttons, prevButtons)) beginPushToTalk();
    if (buttonReleased(BTN.START, buttons, prevButtons)) endPushToTalk();

    if (buttonPressed(BTN.L3, buttons, prevButtons)) {
      const cockpit = styleManager?.cockpitView;
      if (cockpit?.active) cockpit.exit();
      else cockpit?.enter?.();
    }
    if (buttonPressed(BTN.R3, buttons, prevButtons)) toggleHelpPanel();

    if (buttonPressed(BTN.DPAD_UP, buttons, prevButtons)) cycleStyle(1);
    if (buttonPressed(BTN.DPAD_DOWN, buttons, prevButtons)) cycleStyle(-1);
    if (buttonPressed(BTN.DPAD_LEFT, buttons, prevButtons)) dispatchKey('o');
    if (buttonPressed(BTN.DPAD_RIGHT, buttons, prevButtons)) dispatchKey('v');
  };

  const poll = () => {
    const pads = navigator.getGamepads?.() || [];
    const gamepad = pads.find((pad) => pad?.connected) || null;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameMs) / 1000));
    lastFrameMs = now;

    if (!enabled || !gamepad) {
      if (connected) {
        endPushToTalk();
        setConnected(false);
      }
      prevButtons = [];
      rafId = requestAnimationFrame(poll);
      return;
    }

    if (!connected) {
      syncStyleIndex();
      setConnected(true);
    }

    updateCamera(gamepad, dt);
    handleButtons(gamepad);
    prevButtons = gamepad.buttons.map((btn) => ({ pressed: btn.pressed, value: btn.value }));
    rafId = requestAnimationFrame(poll);
  };

  const onGamepadConnected = () => {
    if (!enabled) return;
    syncStyleIndex();
    setConnected(true);
  };

  const onGamepadDisconnected = () => {
    if (!(navigator.getGamepads?.() || []).some((pad) => pad?.connected)) {
      endPushToTalk();
      setConnected(false);
      if (cameraActive) {
        releaseContinuousRender('deck-controls');
        cameraActive = false;
      }
    }
  };

  window.addEventListener('gamepadconnected', onGamepadConnected);
  window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

  const toggleBtn = document.getElementById('deck-controls-toggle');
  const switchEl = document.getElementById('deck-controls-switch');
  const onToggleClick = () => setEnabled(!enabled);
  const onSwitchChange = () => setEnabled(Boolean(switchEl?.checked));
  toggleBtn?.addEventListener('click', onToggleClick);
  switchEl?.addEventListener('change', onSwitchChange);
  syncToggleUi();

  rafId = requestAnimationFrame(poll);

  return () => {
    cancelAnimationFrame(rafId);
    window.removeEventListener('gamepadconnected', onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
    toggleBtn?.removeEventListener('click', onToggleClick);
    switchEl?.removeEventListener('change', onSwitchChange);
    endPushToTalk();
    releasePointerLook();
    if (document.pointerLockElement === canvas) document.exitPointerLock?.();
    releaseContinuousRender('deck-controls');
    reticle.remove();
    helpPanel.remove();
    document.body.classList.remove('deck-controls-active');
    document.body.classList.remove('deck-help-hidden');
  };
}
