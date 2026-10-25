import { STYLE_KEYS } from './applicationShortcuts.js';

const noop = () => {};

const DEFAULT_DEADZONE = 0.15;
const DEFAULT_ROTATE_SPEED = 1.4; // radians/sec
const DEFAULT_MOVE_FACTOR = 0.8; // scaled by altitude
const DEFAULT_ZOOM_FACTOR = 1.0; // scaled by altitude

const STYLES = Object.values(STYLE_KEYS);

function applyDeadzone(value, deadzone) {
  if (Math.abs(value) <= deadzone) return 0;
  const sign = Math.sign(value);
  return sign * ((Math.abs(value) - deadzone) / (1 - deadzone));
}

function getButtonValue(button) {
  if (!button) return 0;
  if (typeof button === 'number') return button;
  return typeof button.value === 'number'
    ? button.value
    : button.pressed
      ? 1
      : 0;
}

function isButtonPressed(button) {
  if (!button) return false;
  if (typeof button === 'number') return button > 0.5;
  return Boolean(button.pressed || button.value > 0.5);
}

/**
 * Gamepad / controller camera navigation and action binding.
 * Connects standard gamepads (Xbox, PlayStation, etc.) to the Cesium camera and application actions.
 * @param {object} options
 * @param {object} options.viewer - Cesium viewer instance
 * @param {object} [options.actions] - Application actions (toggleHud, toggleOrbit, etc.)
 * @param {number} [options.deadzone=0.15] - Analog stick deadzone
 * @param {number} [options.moveFactor=0.8] - Altitude-relative move speed factor
 * @param {number} [options.rotateSpeed=1.4] - Rotation speed in rad/s
 * @param {number} [options.zoomFactor=1.0] - Altitude-relative zoom speed factor
 * @param {Navigator} [options.navigatorRef=globalThis.navigator] - Navigator reference
 * @param {Window} [options.windowRef=globalThis.window] - Window reference
 * @param {Function} [options.holdRender=holdContinuousRender] - Render governor hold
 * @param {Function} [options.releaseRender=releaseContinuousRender] - Render governor release
 * @returns {{poll: Function, getState: Function, destroy: Function}}
 */
export function createGamepadNavigation({
  viewer,
  actions = {},
  deadzone = DEFAULT_DEADZONE,
  moveFactor = DEFAULT_MOVE_FACTOR,
  rotateSpeed = DEFAULT_ROTATE_SPEED,
  zoomFactor = DEFAULT_ZOOM_FACTOR,
  navigatorRef = globalThis.navigator,
  windowRef = globalThis.window,
  holdRender = noop,
  releaseRender = noop,
} = {}) {
  let connectedGamepadIndex = null;
  let isMoving = false;
  let lastTimeMs = Date.now();
  let currentStyleIndex = 0;

  // Previous button press states for edge detection (single trigger on press)
  const prevButtonStates = new Map();

  function onConnected(event) {
    if (connectedGamepadIndex === null && event.gamepad) {
      connectedGamepadIndex = event.gamepad.index;
    }
  }

  function onDisconnected(event) {
    if (event.gamepad && event.gamepad.index === connectedGamepadIndex) {
      connectedGamepadIndex = null;
      if (isMoving) {
        isMoving = false;
        releaseRender('gamepad-navigation');
      }
    }
  }

  if (windowRef?.addEventListener) {
    windowRef.addEventListener('gamepadconnected', onConnected);
    windowRef.addEventListener('gamepaddisconnected', onDisconnected);
  }

  function getActiveGamepad() {
    if (!navigatorRef?.getGamepads) return null;
    const gamepads = navigatorRef.getGamepads();
    if (!gamepads) return null;
    if (connectedGamepadIndex !== null && gamepads[connectedGamepadIndex]) {
      return gamepads[connectedGamepadIndex];
    }
    for (const gp of gamepads) {
      if (gp) {
        connectedGamepadIndex = gp.index;
        return gp;
      }
    }
    return null;
  }

  function handleButtonEdges(gamepad) {
    const buttons = gamepad.buttons || [];
    for (let i = 0; i < buttons.length; i++) {
      const pressed = isButtonPressed(buttons[i]);
      const wasPressed = prevButtonStates.get(i) || false;
      prevButtonStates.set(i, pressed);

      if (pressed && !wasPressed) {
        dispatchButtonAction(i);
      }
    }
  }

  function dispatchButtonAction(buttonIndex) {
    switch (buttonIndex) {
      case 0: // Button A / Cross: Toggle HUD
        actions.toggleHud?.();
        break;
      case 1: // Button B / Circle: Cancel Flight (if active) / Clean View
        if (
          (viewer?.camera?._currentFlight || viewer?.camera?._flight) &&
          typeof viewer?.camera?.cancelFlight === 'function'
        ) {
          viewer.camera.cancelFlight();
        } else if (typeof actions.toggleCleanView === 'function') {
          actions.toggleCleanView();
        } else if (typeof viewer?.camera?.cancelFlight === 'function') {
          viewer.camera.cancelFlight();
        }
        break;
      case 2: // Button X / Square: Toggle Orbit
        actions.toggleOrbit?.();
        break;
      case 3: // Button Y / Triangle: Cycle Style
        if (typeof actions.cycleStyle === 'function') {
          actions.cycleStyle();
        } else if (typeof actions.setStyle === 'function') {
          if (typeof actions.getStyle === 'function') {
            const current = actions.getStyle();
            const idx = STYLES.indexOf(current);
            if (idx !== -1) currentStyleIndex = idx;
          }
          currentStyleIndex = (currentStyleIndex + 1) % STYLES.length;
          actions.setStyle(STYLES[currentStyleIndex]);
        }
        break;
      case 4: // Left Bumper (LB / L1): Cycle Detection
        actions.cycleDetection?.();
        break;
      case 5: // Right Bumper (RB / R1): Toggle CCTV
        actions.toggleCctv?.();
        break;
      case 8: // Back / View / Select: Toggle Layers
        actions.toggleLayers?.();
        break;
      case 9: // Start / Menu: Dismiss Search
        actions.dismissSearch?.();
        break;
      default:
        break;
    }
  }

  /**
   * Main poll and update function called every frame.
   * @param {number} [deltaSeconds] - Time elapsed in seconds.
   */
  function poll(deltaSeconds) {
    const now = Date.now();
    const dt =
      Number.isFinite(deltaSeconds) && deltaSeconds > 0
        ? deltaSeconds
        : Math.min(0.1, Math.max(0.001, (now - lastTimeMs) / 1000));
    lastTimeMs = now;

    const gamepad = getActiveGamepad();
    if (!gamepad) {
      if (isMoving) {
        isMoving = false;
        releaseRender('gamepad-navigation');
      }
      return;
    }

    // Handle edge-triggered buttons
    handleButtonEdges(gamepad);

    const camera = viewer?.camera;
    if (!camera) return;

    const axes = gamepad.axes || [];
    const buttons = gamepad.buttons || [];

    // Left Stick: translation
    const rawLx = axes[0] ?? 0;
    const rawLy = axes[1] ?? 0;
    const lx = applyDeadzone(rawLx, deadzone);
    const ly = applyDeadzone(rawLy, deadzone);

    // Right Stick: rotation / tilt
    const rawRx = axes[2] ?? 0;
    const rawRy = axes[3] ?? 0;
    const rx = applyDeadzone(rawRx, deadzone);
    const ry = applyDeadzone(rawRy, deadzone);

    // Triggers: Zoom out / Zoom in
    const lt = getButtonValue(buttons[6]);
    const rt = getButtonValue(buttons[7]);
    const zoomDelta = applyDeadzone(rt - lt, deadzone);

    // D-Pad: translation fallback
    const dpadUp = isButtonPressed(buttons[12]) ? 1 : 0;
    const dpadDown = isButtonPressed(buttons[13]) ? 1 : 0;
    const dpadLeft = isButtonPressed(buttons[14]) ? 1 : 0;
    const dpadRight = isButtonPressed(buttons[15]) ? 1 : 0;

    const dpadX = dpadRight - dpadLeft;
    const dpadY = dpadDown - dpadUp;

    const hasMotion =
      lx !== 0 ||
      ly !== 0 ||
      rx !== 0 ||
      ry !== 0 ||
      zoomDelta !== 0 ||
      dpadX !== 0 ||
      dpadY !== 0;

    if (hasMotion) {
      if (!isMoving) {
        isMoving = true;
        holdRender('gamepad-navigation');
      }
      viewer?.scene?.requestRender?.();

      // Height-scaled motion rates
      const height = camera.positionCartographic?.height
        ? Math.max(10, camera.positionCartographic.height)
        : 1000;

      const moveStep = Math.max(10, height * moveFactor) * dt;
      const rotStep = rotateSpeed * dt;
      const zoomStep = Math.max(10, height * zoomFactor) * dt;

      // Apply translation
      const totalX = lx || dpadX * 0.7;
      const totalY = ly || dpadY * 0.7;

      if (totalX > 0) camera.moveRight?.(moveStep * totalX);
      else if (totalX < 0) camera.moveLeft?.(moveStep * -totalX);

      if (totalY > 0) camera.moveBackward?.(moveStep * totalY);
      else if (totalY < 0) camera.moveForward?.(moveStep * -totalY);

      // Apply rotation / tilt
      if (rx > 0) camera.lookRight?.(rotStep * rx);
      else if (rx < 0) camera.lookLeft?.(rotStep * -rx);

      if (ry > 0) camera.lookDown?.(rotStep * ry);
      else if (ry < 0) camera.lookUp?.(rotStep * -ry);

      // Apply zoom
      if (zoomDelta > 0) camera.zoomIn?.(zoomStep * zoomDelta);
      else if (zoomDelta < 0) camera.zoomOut?.(zoomStep * -zoomDelta);
    } else if (isMoving) {
      isMoving = false;
      releaseRender('gamepad-navigation');
    }
  }

  // Hook scene.preUpdate (or fallback to preRender) so stick input is evaluated
  // continuously even when Cesium is idling in requestRenderMode (#1000, #1010).
  let removeTickListener = null;
  const tickTarget = viewer?.scene?.preUpdate ?? viewer?.scene?.preRender;
  if (tickTarget?.addEventListener) {
    removeTickListener = tickTarget.addEventListener(() => {
      poll();
    });
  }

  return {
    poll,
    getState() {
      const gamepad = getActiveGamepad();
      return {
        connected: Boolean(gamepad),
        id: gamepad?.id || null,
        active: isMoving,
      };
    },
    destroy() {
      if (windowRef?.removeEventListener) {
        windowRef.removeEventListener('gamepadconnected', onConnected);
        windowRef.removeEventListener('gamepaddisconnected', onDisconnected);
      }
      if (typeof removeTickListener === 'function') {
        removeTickListener();
      } else if (removeTickListener) {
        tickTarget?.removeEventListener?.(removeTickListener);
      }
      if (isMoving) {
        isMoving = false;
        releaseRender('gamepad-navigation');
      }
      prevButtonStates.clear();
    },
  };
}
