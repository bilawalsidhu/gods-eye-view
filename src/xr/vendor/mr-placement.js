// Real-surface placement for MR sessions.
//
// sessionOptions() in xr-capabilities.js already asks for the optional hit-test feature; this is
// what consumes it. Hit testing is genuinely optional -- Vision Pro does not expose it today -- so
// every path here degrades to virtual placement and reports the downgrade rather than throwing.

import * as THREE from 'three';

export const HIT_TEST_STATES = { unsupported: 'unsupported', requested: 'requested', ready: 'ready', unavailable: 'not requested' };

// Pure: derive a reticle transform from a WebXR pose matrix. Kept separate from the session
// plumbing so it can be checked without a live XRFrame.
export function reticleFromPose(matrixArray) {
  if (!matrixArray || matrixArray.length !== 16) return null;
  const matrix = new THREE.Matrix4().fromArray(matrixArray);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, quaternion };
}

// A hit test source is only meaningful for the session that created it, so the whole thing is
// rebuilt per session and torn down on end.
export async function requestHitTestSource(session) {
  if (typeof session?.requestHitTestSource !== 'function') return { source: null, state: HIT_TEST_STATES.unsupported };
  try {
    const space = await session.requestReferenceSpace('viewer');
    const source = await session.requestHitTestSource({ space });
    return source ? { source, state: HIT_TEST_STATES.ready } : { source: null, state: HIT_TEST_STATES.unsupported };
  } catch {
    return { source: null, state: HIT_TEST_STATES.unsupported };
  }
}

export function createSurfacePlacement(scene, { onPlace } = {}) {
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  reticle.visible = false;
  reticle.matrixAutoUpdate = false;
  scene.add(reticle);

  const markers = new THREE.Group();
  scene.add(markers);

  let hitTestSource = null;
  let state = HIT_TEST_STATES.unavailable;
  let lastPose = null;

  return {
    reticle,
    markers,
    get state() {
      return state;
    },
    get hasSurface() {
      return reticle.visible;
    },
    async start(session, mixedReality) {
      this.stop();
      if (!mixedReality) {
        state = HIT_TEST_STATES.unavailable;
        return state;
      }
      state = HIT_TEST_STATES.requested;
      const result = await requestHitTestSource(session);
      hitTestSource = result.source;
      state = result.state;
      return state;
    },
    stop() {
      hitTestSource?.cancel?.();
      hitTestSource = null;
      reticle.visible = false;
      lastPose = null;
      state = HIT_TEST_STATES.unavailable;
    },
    update(frame, referenceSpace) {
      if (!hitTestSource || !frame || !referenceSpace) return;
      const hit = frame.getHitTestResults(hitTestSource)[0];
      const pose = hit?.getPose(referenceSpace);
      if (!pose) {
        reticle.visible = false;
        lastPose = null;
        return;
      }
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      lastPose = pose.transform.matrix;
    },
    // Returns the placed marker, or null when there is no surface under the reticle. Callers use
    // the null to distinguish "no real surface found" from "placement failed".
    place() {
      const transform = reticleFromPose(lastPose);
      if (!transform) return null;
      const marker = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 0.02, 24),
        new THREE.MeshStandardMaterial({ color: '#e76850', roughness: 0.5 }),
      );
      marker.position.copy(transform.position).add(new THREE.Vector3(0, 0.01, 0));
      markers.add(marker);
      onPlace?.(marker);
      return marker;
    },
    clear() {
      markers.clear();
    },
  };
}
