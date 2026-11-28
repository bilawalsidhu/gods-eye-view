import * as Cesium from 'cesium';

/**
 * A scene with what a draw set touches: primitives (`added`), a render count,
 * the camera and frame time; `events` adds the pre/post-render events and the
 * ground-height hooks that lines and clamped icons use; `mode` sets the
 * frame's scene mode.
 */
export function fakeDrawScene({ timeMs, mode, events = false } = {}) {
  const added = [];
  return {
    added,
    renders: 0,
    ...(events
      ? {
          postRender: new Cesium.Event(),
          preRender: new Cesium.Event(),
          updateHeight: () => () => {},
          getHeight: () => undefined,
        }
      : {}),
    camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) },
    frameState: {
      ...(mode === undefined ? {} : { mode }),
      time:
        timeMs === undefined
          ? Cesium.JulianDate.now()
          : Cesium.JulianDate.fromDate(new Date(timeMs)),
    },
    primitives: {
      add: (primitive) => (added.push(primitive), primitive),
      remove: (primitive) => {
        const at = added.indexOf(primitive);
        if (at >= 0) added.splice(at, 1);
        return at >= 0;
      },
      length: 0,
    },
    requestRender() {
      this.renders += 1;
    },
    isDestroyed: () => false,
  };
}
