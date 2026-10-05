// A stand-in for public/webxr-profiles/generic-hand/*.glb that needs no loader and no GL: the same
// 25 joint names, the same FLAT layout (every bone a direct child of the armature), fingers along
// +Y, index-to-pinky along +X, and the thumb tip on the palm side so the poser's mirror fix has
// something to agree with. `mirror` flips X, which is what left.glb is to right.glb.
import * as THREE from 'three';

export const JOINTS = {
 'wrist': [0, 0, 0],
 'thumb-metacarpal': [-0.040, 0.020, 0.010], 'thumb-phalanx-proximal': [-0.055, 0.040, 0.020],
 'thumb-phalanx-distal': [-0.065, 0.055, 0.025], 'thumb-tip': [-0.070, 0.065, 0.030],
};
const FINGER_X = {'index-finger': -0.030, 'middle-finger': -0.010, 'ring-finger': 0.010, 'pinky-finger': 0.030};
const FINGER_Y = {'metacarpal': 0.030, 'phalanx-proximal': 0.080, 'phalanx-intermediate': 0.110, 'phalanx-distal': 0.130, 'tip': 0.150};
for(const [finger, x] of Object.entries(FINGER_X)) for(const [link, y] of Object.entries(FINGER_Y)) JOINTS[`${finger}-${link}`] = [x, y, 0];

export function syntheticHand({mirror = false} = {}){
 const armature = new THREE.Group();
 armature.name = 'Armature';
 for(const [name, [x, y, z]] of Object.entries(JOINTS)){
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.set(mirror ? -x : x, y, z);
  armature.add(bone);
 }
 const object = new THREE.Group();
 object.add(armature);
 object.updateMatrixWorld(true);
 return object;
}

export const worldOf = (object, name) => object.getObjectByName(name).getWorldPosition(new THREE.Vector3());
