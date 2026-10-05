// The on-hand affordance for the thumb-swipe turn: two flat arrowheads lying on the top face of a
// closed fist, one either side of the thumb, pointing the two ways the thumb can slide across the
// knuckles. Meta's own microgesture material draws exactly this, and the swipe is the one gesture
// with nothing on screen to suggest it exists -- aim has the teleport arc and the tap has the
// marker, the turn had nothing at all.
//
// It belongs to the VERTICAL FIST posture only. The finger gun deliberately shows nothing: it is
// the aiming posture, its arc is its own affordance, and arrows floating beside a pointing finger
// read as something you could slide when nothing there responds to a slide.
//
// Everything above createSwipeHint is pure: plain {x,y,z} objects in, plain objects out, the same
// discipline hand-gestures.js and locomotion.js keep, so the placement can be tested under
// `node --test` against tests/helpers/synthetic-hand.js with no GL.
import * as THREE from 'three';

// Sizes are Meta's proportions rather than ours: the arrowheads are big enough to read at arm's
// length in a headset, which the 4 mm cones this replaced were not.
export const SWIPE_HINT={
 lift:.017,        // how far off the top of the fist the pair floats, clear of the thumb itself
 gap:.019,         // how far each arrowhead sits from the thumb, along the across-the-fist axis
 headLength:.017,  // tip to base
 headWidth:.020,   // base width -- a broad, flat triangle, not a needle
 opacity:.72,
 color:'#ffffff',
};

// Where the pair sits and which way it runs, from one frame of joints. The frame itself comes from
// hand-gestures.js (fistFrame) so the arrows point along the exact axis the swipe is measured on:
// if that axis is ever retuned this follows it rather than drifting out of agreement with it.
// Returns null whenever the hand cannot define the frame -- a hint pointing an arbitrary way is
// worse than no hint at all.
export function swipeHintPlacement(joints,frame,tune=SWIPE_HINT){
 const thumbTip=joints?.['thumb-tip'];
 if(!thumbTip||!frame?.across||!frame?.normal)return null;
 return {
  origin:{x:thumbTip.x+frame.normal.x*tune.lift,y:thumbTip.y+frame.normal.y*tune.lift,z:thumbTip.z+frame.normal.z*tune.lift},
  across:frame.across,
  normal:frame.normal,
 };
}

// The renderer half. One hint per input (both hands can hold the posture at once), parented to the
// scene rather than to the hand: the placement is already world-space, and hanging it off a joint
// would inherit whatever the runtime does to that joint's scale.
export function createSwipeHint(scene,{tune=SWIPE_HINT}={}){
 // noRay keeps the hint out of pointer picking: a project that gathers ray targets by walking the
 // scene (electrical demos) would otherwise let the beam land on the arrows floating by the hand.
 const group=new THREE.Group();group.name='Thumb swipe hint';group.visible=false;group.renderOrder=12;group.userData.noRay=true;
 const material=new THREE.MeshBasicMaterial({color:tune.color,transparent:true,opacity:tune.opacity,depthWrite:false,toneMapped:false,side:THREE.DoubleSide});
 // A flat triangle in the local XZ plane pointing along +X, so the group's basis can lay the pair
 // straight onto the top face of the fist. Flat, not a cone: Meta's are 2D arrowheads.
 const head=new THREE.BufferGeometry();
 head.setAttribute('position',new THREE.Float32BufferAttribute([
  tune.headLength,0,0,
  0,0,tune.headWidth/2,
  0,0,-tune.headWidth/2,
 ],3));
 head.computeVertexNormals();
 const towardPinky=new THREE.Mesh(head,material),towardIndex=new THREE.Mesh(head,material);
 towardPinky.position.x=tune.gap;
 towardIndex.position.x=-tune.gap;towardIndex.rotation.y=Math.PI;
 group.add(towardPinky,towardIndex);
 for(const mesh of group.children){mesh.frustumCulled=false;mesh.renderOrder=12}
 scene.add(group);

 const basis=new THREE.Matrix4(),x=new THREE.Vector3(),y=new THREE.Vector3(),z=new THREE.Vector3();
 return {
  group,
  show(placement){
   if(!placement){this.hide();return;}
   group.position.set(placement.origin.x,placement.origin.y,placement.origin.z);
   // Local +X is the across-the-fist axis and local +Y is off the top face, so the triangles lie
   // flat on the fist the way Meta's do rather than standing up off it.
   x.set(placement.across.x,placement.across.y,placement.across.z).normalize();
   y.set(placement.normal.x,placement.normal.y,placement.normal.z).normalize();
   z.crossVectors(x,y).normalize();
   y.crossVectors(z,x).normalize();
   basis.makeBasis(x,y,z);
   group.quaternion.setFromRotationMatrix(basis);
   group.visible=true;
  },
  hide(){group.visible=false;},
  dispose(){scene.remove(group);head.dispose();material.dispose();},
 };
}
