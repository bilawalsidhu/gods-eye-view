// Where the player's head actually is, in world space.
//
// This module exists because `renderer.xr.getCamera().getWorldPosition(v)` does NOT give you that,
// and the way it fails is silent. three.js returns an ArrayCamera (`cameraXR`) that is never added
// to the scene graph -- its .parent is null for the whole session. Every frame WebXRManager
// hand-composes `cameraXR.matrixWorld = rig.matrixWorld * cameraXR.matrix`, but leaves
// matrixAutoUpdate at its default true. So Object3D.getWorldPosition() -> updateWorldMatrix() finds
// no parent, recomposes the local matrix, and overwrites matrixWorld with it -- throwing the rig
// transform away and handing back the head in RIG-LOCAL space. Worse, it leaves cameraXR.matrixWorld
// corrupted and out of step with matrixWorldInverse for the rest of the frame.
//
// With a rig at the origin the two agree, which is how this hid: it only bites once a project moves
// or turns the rig, and then it is wrong by the entire rig transform. Teleport landed the player off
// the marker and snap turn pivoted about a phantom point for exactly this reason.
//
// So: compose it ourselves, from the rig and the camera's LOCAL matrix. Reading cameraXR.matrixWorld
// instead would be a frame stale and wrong in the one moment that matters -- immediately after the
// rig has been moved, which is when teleport and snap turn read it. cameraXR.matrix is refreshed at
// the top of the frame, before any of our update code runs, so this stays correct mid-move.
//
// The one safe accessor on the XR camera is .matrix. Never call getWorldPosition, getWorldQuaternion,
// getWorldDirection, localToWorld or worldToLocal on it -- they all route through updateWorldMatrix.
import * as THREE from 'three';

const scratch=new THREE.Matrix4(),scratchPosition=new THREE.Vector3(),scratchScale=new THREE.Vector3();
const FORWARD=new THREE.Vector3(0,0,-1);

// The head's world transform: the rig's world matrix times the head pose the runtime reported this
// frame. `rig` may be null for a camera that really is a scene-graph citizen (the desktop camera),
// in which case its own matrixWorld is already right.
export function headMatrix(rig,xrCamera,target=new THREE.Matrix4()){
 if(!xrCamera)return target.identity();
 if(!rig)return target.copy(xrCamera.matrixWorld);
 rig.updateMatrixWorld(true);
 return target.multiplyMatrices(rig.matrixWorld,xrCamera.matrix);
}

export function headPosition(rig,xrCamera,target=new THREE.Vector3()){
 return target.setFromMatrixPosition(headMatrix(rig,xrCamera,scratch));
}

export function headQuaternion(rig,xrCamera,target=new THREE.Quaternion()){
 headMatrix(rig,xrCamera,scratch).decompose(scratchPosition,target,scratchScale);
 return target;
}

// The way the head is facing. Same forward convention as Object3D.getWorldDirection: -Z.
export function headDirection(rig,xrCamera,target=new THREE.Vector3()){
 return target.copy(FORWARD).applyMatrix4(scratch.extractRotation(headMatrix(rig,xrCamera,scratch))).normalize();
}
