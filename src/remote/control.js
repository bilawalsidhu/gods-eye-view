/**
 * Wire remote control into the running app.
 *
 * Views arrive on the SSE stream and are applied with the same action runner
 * embed mode uses: visual style, map imagery, layer visibility, annotation
 * pins and entity follow. The camera flight matches a share-link restore.
 */

import * as Cesium from 'cesium';
import { announceNavigationAuthority } from '../navigationPolicy.js';
import { applyRemotePlan } from './protocol.js';
import { createRemoteControl } from './client.js';

const FLIGHT_SECONDS = 2;
const FOLLOW_ATTEMPTS = 15;
const FOLLOW_RETRY_MS = 1000;

function cameraOrientation(camera) {
  if (!Number.isFinite(camera.heading) && !Number.isFinite(camera.pitch))
    return null;
  return {
    heading: Cesium.Math.toRadians(camera.heading || 0),
    pitch: Cesium.Math.toRadians(
      Number.isFinite(camera.pitch) ? camera.pitch : -90,
    ),
    roll: 0,
  };
}

/** Fly to a point or a [west, south, east, north] box. */
export function flyRemoteCamera(viewer, camera) {
  if (!viewer?.camera?.flyTo || viewer.isDestroyed?.())
    return Promise.resolve(false);
  announceNavigationAuthority('remote-control');
  const orientation = cameraOrientation(camera);
  const destination =
    camera.kind === 'bbox'
      ? Cesium.Rectangle.fromDegrees(
          camera.bbox[0],
          camera.bbox[1],
          camera.bbox[2],
          camera.bbox[3],
        )
      : Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat, camera.alt);
  return new Promise((resolve) => {
    viewer.camera.flyTo({
      destination,
      ...(orientation ? { orientation } : {}),
      duration: FLIGHT_SECONDS,
      complete: () => resolve(true),
      cancel: () => resolve(false),
    });
  });
}

const delay = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Apply one normalized view with the app's action runner and camera. */
export function applyRemoteView(view, { viewer, run, signal } = {}) {
  const act = (name, args) => run(name, args);
  return applyRemotePlan(view, {
    setStyle: (style) => act('set_visual_style', { style }),
    setImagery: (imagery) => act('set_map_stack', { stack: imagery }),
    setLayer: (layerId, enabled) =>
      act('set_layer_visibility', { layerId, enabled }),
    clearAnnotations: () => act('clear_annotations', {}),
    addAnnotations: (annotations) =>
      act('annotate_map', { annotations, flyTo: false }),
    flyTo: (camera) => flyRemoteCamera(viewer, camera),
    follow: async (follow) => {
      let result = null;
      for (let attempt = 0; attempt < FOLLOW_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) break;
        result = await act('track_entity', {
          query: follow.id,
          layerId: follow.layerId,
        });
        if (result?.ok) break;
        await delay(FOLLOW_RETRY_MS, signal);
      }
      return result;
    },
  });
}

/**
 * Subscribe for this page. `?remote=off` disables it; `?remote=<session>`
 * overrides the default session. The disposer closes the stream.
 */
export function installRemoteControl({
  viewer,
  run,
  signal,
  location = globalThis.location,
  windowRef = globalThis,
  documentRef = globalThis.document,
} = {}) {
  if (signal?.aborted) return () => {};
  const stop = createRemoteControl({
    search: location?.search || '',
    EventSource: windowRef?.EventSource,
    windowRef,
    documentRef,
    apply: (view) => applyRemoteView(view, { viewer, run, signal }),
  });
  const onAbort = () => stop();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  return () => {
    signal?.removeEventListener?.('abort', onAbort);
    stop();
  };
}
