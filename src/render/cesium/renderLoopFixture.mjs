// A widget on Cesium's real CesiumWidget.prototype (startRenderLoop, the
// useDefaultRenderLoop setter, render) around a scene double, with animation
// frames queued by hand and the render failure notice installed.
import * as Cesium from 'cesium';
import { installRenderFailureNotice } from './renderFailure.js';

export function renderLoopFixture(
  scene,
  { targetFrameRate, viewer: viewerExtras = {}, notice = {} } = {},
) {
  const frames = [];
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  const widget = Object.create(Cesium.CesiumWidget.prototype);
  Object.assign(widget, {
    _scene: scene,
    _clock: { tick() {} },
    _canRender: true,
    _useDefaultRenderLoop: false,
    _renderLoopRunning: false,
    // What src/app/scene.js passes to the viewer.
    _showRenderLoopErrors: false,
    _targetFrameRate: targetFrameRate,
    isDestroyed: () => false,
    resize() {},
  });
  // CesiumWidget's own renderError handler, which marks the loop stopped.
  scene.renderError.addEventListener(() => {
    widget._useDefaultRenderLoop = false;
    widget._renderLoopRunning = false;
  });
  const viewer = Object.assign(
    {
      scene,
      cesiumWidget: widget,
      canvas: { addEventListener() {}, removeEventListener() {} },
      get useDefaultRenderLoop() {
        return widget.useDefaultRenderLoop;
      },
      set useDefaultRenderLoop(value) {
        widget.useDefaultRenderLoop = value;
      },
    },
    viewerExtras,
  );
  const store = {
    renderFailure: null,
    publishRenderFailure(next) {
      this.renderFailure = next;
    },
  };
  const logged = [];
  const uninstall = installRenderFailureNotice(viewer, {
    store,
    locationRef: { href: 'https://gev.example/', reload() {}, assign() {} },
    logError: (error) => logged.push(error),
    ...notice,
  });
  let time = 0;
  const runFrames = (n) => {
    for (let i = 0; i < n; i += 1) {
      // Above a 60 fps target's interval, so every frame draws.
      time += 17;
      for (const fn of frames.splice(0)) fn(time);
    }
  };
  const restore = () => {
    uninstall();
    globalThis.requestAnimationFrame = previousRaf;
  };
  return { frames, widget, viewer, store, logged, runFrames, restore };
}
