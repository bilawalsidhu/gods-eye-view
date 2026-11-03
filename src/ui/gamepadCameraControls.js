import { interruptCameraMotion } from '../cameraVerbs.js';

const POLL_INTERVAL_MS = 16;
const AXIS_DEADZONE = 0.18;
const MIN_PAN_SPEED_MPS = 12;
const MAX_PAN_SPEED_MPS = 250_000;
const PAN_SPEED_BY_ALTITUDE = 0.6;
const ROTATION_SPEED_RAD_S = 1;
const ZOOM_SPEED_BY_ALTITUDE = 0.8;
const MIN_CAMERA_HEIGHT_M = 120;
const CONTROL_KEYS = new Set([
  'w',
  'a',
  's',
  'd',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export function applyGamepadDeadzone(value, deadzone = AXIS_DEADZONE) {
  if (!Number.isFinite(value) || Math.abs(value) <= deadzone) return 0;
  return (
    Math.sign(value) *
    Math.min(1, (Math.abs(value) - deadzone) / (1 - deadzone))
  );
}

function buttonValue(button) {
  if (typeof button === 'number') return button;
  if (!button) return 0;
  if (Number.isFinite(button.value)) return button.value;
  return button.pressed ? 1 : 0;
}

/** Read the standard browser gamepad layout used by Xbox controllers. */
export function readGamepadCameraInput(gamepad) {
  if (!gamepad) return null;
  const axes = gamepad.axes || [];
  const buttons = gamepad.buttons || [];
  const dpadX = buttonValue(buttons[15]) - buttonValue(buttons[14]);
  const dpadY = buttonValue(buttons[13]) - buttonValue(buttons[12]);
  return {
    panX: applyGamepadDeadzone(axes[0] || 0) + dpadX,
    panY: applyGamepadDeadzone(axes[1] || 0) + dpadY,
    orbitX: applyGamepadDeadzone(axes[2] || 0),
    orbitY: applyGamepadDeadzone(axes[3] || 0),
    zoom: buttonValue(buttons[7]) - buttonValue(buttons[6]),
  };
}

function isEditableTarget(target) {
  return Boolean(
    target?.isContentEditable ||
    target?.closest?.(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    ),
  );
}

function firstConnectedGamepad(gamepads) {
  for (const gamepad of gamepads || []) {
    if (gamepad && gamepad.connected !== false) return gamepad;
  }
  return null;
}

/**
 * Add keyboard and standard gamepad navigation to the globe.
 * WASD/left stick pan, arrows/right stick orbit, and triggers zoom.
 */
export function installGamepadCameraControls(
  viewer,
  {
    windowRef = globalThis.window,
    documentRef = globalThis.document,
    navigatorRef = globalThis.navigator,
    now = () => globalThis.performance.now(),
    interrupt = interruptCameraMotion,
  } = {},
) {
  const canvas = viewer?.scene?.canvas;
  if (!canvas || !viewer?.camera)
    throw new TypeError('A complete Cesium viewer is required');

  const originalTabIndex = canvas.tabIndex;
  if (canvas.tabIndex < 0) canvas.tabIndex = 0;
  const keys = new Set();
  let timer = null;
  let lastTime = 0;
  let wasActive = false;
  let destroyed = false;

  const gamepad = () => firstConnectedGamepad(navigatorRef?.getGamepads?.());
  const startPolling = () => {
    if (timer !== null || destroyed) return;
    lastTime = 0;
    timer = windowRef.setInterval(tick, POLL_INTERVAL_MS);
  };
  const stopPolling = () => {
    if (timer === null) return;
    windowRef.clearInterval(timer);
    timer = null;
    lastTime = 0;
    wasActive = false;
  };
  const setKey = (event, pressed) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (!CONTROL_KEYS.has(key) || isEditableTarget(event.target)) return;
    event.preventDefault();
    if (pressed) {
      keys.add(key);
      startPolling();
    } else {
      keys.delete(key);
    }
  };
  const onKeyDown = (event) => setKey(event, true);
  const onKeyUp = (event) => setKey(event, false);
  const onPointerDown = () => canvas.focus?.();
  const onBlur = () => {
    keys.clear();
    if (!gamepad()) stopPolling();
  };
  const onGamepadConnected = () => startPolling();
  const onGamepadDisconnected = () => {
    if (!gamepad() && keys.size === 0) stopPolling();
  };
  const onVisibilityChange = () => {
    if (documentRef?.hidden) {
      keys.clear();
      stopPolling();
    } else if (gamepad() || keys.size) {
      startPolling();
    }
  };

  function tick() {
    if (destroyed) return stopPolling();
    const pad = gamepad();
    if (!pad && keys.size === 0) return stopPolling();
    if (documentRef?.hidden) {
      lastTime = 0;
      return;
    }

    const time = now();
    const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 1 / 60;
    lastTime = time;
    const gamepadInput = readGamepadCameraInput(pad);
    const input = {
      panX:
        (gamepadInput?.panX || 0) +
        Number(keys.has('d')) -
        Number(keys.has('a')),
      panY:
        (gamepadInput?.panY || 0) +
        Number(keys.has('s')) -
        Number(keys.has('w')),
      orbitX:
        (gamepadInput?.orbitX || 0) +
        Number(keys.has('ArrowRight')) -
        Number(keys.has('ArrowLeft')),
      orbitY:
        (gamepadInput?.orbitY || 0) +
        Number(keys.has('ArrowDown')) -
        Number(keys.has('ArrowUp')),
      zoom: gamepadInput?.zoom || 0,
    };
    for (const name of ['panX', 'panY', 'orbitX', 'orbitY', 'zoom'])
      input[name] = Math.max(-1, Math.min(1, input[name]));

    const active = Object.values(input).some((value) => value !== 0);
    if (active && !wasActive && !viewer.trackedEntity) {
      interrupt('manual-input');
      viewer.camera.cancelFlight?.();
    }
    wasActive = active && !viewer.trackedEntity;

    if (active && !viewer.trackedEntity) {
      const camera = viewer.camera;
      const height = Math.max(
        MIN_CAMERA_HEIGHT_M,
        camera.positionCartographic?.height || MIN_CAMERA_HEIGHT_M,
      );
      const panSpeed = Math.min(
        MAX_PAN_SPEED_MPS,
        Math.max(MIN_PAN_SPEED_MPS, height * PAN_SPEED_BY_ALTITUDE),
      );
      if (input.panX) camera.moveRight(input.panX * panSpeed * dt);
      if (input.panY) camera.moveDown(input.panY * panSpeed * dt);
      if (input.orbitX)
        camera.rotateLeft(-input.orbitX * ROTATION_SPEED_RAD_S * dt);
      if (input.orbitY)
        camera.rotateUp(-input.orbitY * ROTATION_SPEED_RAD_S * dt);
      if (input.zoom) {
        let zoomDistance =
          Math.max(MIN_PAN_SPEED_MPS, height * ZOOM_SPEED_BY_ALTITUDE) *
          Math.abs(input.zoom) *
          dt;
        if (input.zoom > 0 && camera.pitch < 0)
          zoomDistance = Math.min(
            zoomDistance,
            Math.max(0, height - MIN_CAMERA_HEIGHT_M),
          );
        if (zoomDistance > 0) {
          if (input.zoom > 0) camera.moveForward(zoomDistance);
          else camera.moveBackward(zoomDistance);
        }
      }
      viewer.scene.requestRender?.();
    }

    if (!pad && keys.size === 0) stopPolling();
  }

  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('blur', onBlur);
  canvas.addEventListener('pointerdown', onPointerDown);
  windowRef?.addEventListener('gamepadconnected', onGamepadConnected);
  windowRef?.addEventListener('gamepaddisconnected', onGamepadDisconnected);
  documentRef?.addEventListener('visibilitychange', onVisibilityChange);

  if (gamepad()) startPolling();

  return () => {
    if (destroyed) return;
    destroyed = true;
    stopPolling();
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('blur', onBlur);
    canvas.removeEventListener('pointerdown', onPointerDown);
    windowRef?.removeEventListener('gamepadconnected', onGamepadConnected);
    windowRef?.removeEventListener(
      'gamepaddisconnected',
      onGamepadDisconnected,
    );
    documentRef?.removeEventListener('visibilitychange', onVisibilityChange);
    canvas.tabIndex = originalTabIndex;
  };
}
