// Resolving what the desktop pointer is on. Kept apart from the input surface because the rules
// are the interesting part and they are the same for a captured crosshair, a mouse cursor and,
// when an application wants it, a probe tip being dragged across the room.
//
// Three rules, all of which the headset path already applies in its own raycast:
//  - an object hidden by a parent's `visible` flag is not a target, however solid its mesh;
//  - a hit further away than the reach is out of range rather than absent, because "too far" and
//    "nothing there" are different things to tell a learner;
//  - a hit behind a wall is not a hit. Furniture is not in the raycast set -- the scene meshes
//    are merged for batching -- so the same blocker boxes locomotion walks against are what
//    stand in for it.
import {qConj,qRotate} from './grab.js';

export const visibleInScene=object=>{for(let o=object;o;o=o.parent)if(!o.visible)return false;return true};

// Walks up from a hit mesh to whatever carries the interaction, because a target is usually a
// group and the ray lands on one of its meshes.
export function ancestorWith(object,key){for(let o=object;o;o=o.parent)if(o.userData?.[key]!==undefined)return o;return null}
export const grabbableOf=object=>ancestorWith(object,'grabbable')?.userData.grabbable??null;
export const actionOf=object=>ancestorWith(object,'action')?.userData.action;

// Distance along a ray at which it first enters an axis-aligned box, or null. Slab method, the
// same one locomotion.segmentBox uses on a teleport arc.
export function rayBox(origin,direction,box){
 let near=0,far=Infinity;
 for(const axis of ['x','y','z']){
  const d=direction[axis],lo=box.min[axis],hi=box.max[axis];
  if(Math.abs(d)<1e-9){if(origin[axis]<lo||origin[axis]>hi)return null;continue}
  let a=(lo-origin[axis])/d,b=(hi-origin[axis])/d;
  if(a>b){const swap=a;a=b;b=swap}
  if(a>near)near=a;
  if(b<far)far=b;
  if(near>far)return null;
 }
 return far<0?null:near;
}

// How far the ray travels before it meets the furniture. Infinity when it never does.
export function blockerDistance(origin,direction,blockers=[]){
 let nearest=Infinity;
 for(const box of blockers){const t=rayBox(origin,direction,box);if(t!==null&&t<nearest)nearest=t}
 return nearest;
}

// The interaction under a ray, as the reticle needs to describe it. `hits` is whatever the
// caller's raycaster produced, in order; this module decides which of them counts.
//
// `slack` is the tolerance on the blocker test. A grabbable standing against a wall reports a
// hit a hair beyond the wall's own face, and without it every object on a shelf would read as
// unreachable.
export function resolveAim(hits,{origin,direction,blockers=[],reach=Infinity,slack=.035}={}){
 const wall=origin&&direction?blockerDistance(origin,direction,blockers):Infinity;
 for(const hit of hits){
  if(!visibleInScene(hit.object))continue;
  if(wall<hit.distance-slack)return null;               // the wall is genuinely in front of it
  const item=grabbableOf(hit.object),action=actionOf(hit.object);
  if(!item&&action===undefined)continue;                // scenery the ray happened to cross
  return {hit,object:hit.object,item,action,distance:hit.distance,beyondReach:hit.distance>reach};
 }
 return null;
}

// What the reticle should say. Separated from the reticle itself so the rule is testable and so
// an application can override the wording without reimplementing the state machine.
export function reticleFor(aim,{held=null,canGrab=()=>true}={}){
 if(held)return {state:'holding',label:held.label??'',hint:'E drop · scroll distance · R rotate · right-click throw'};
 if(!aim)return {state:'idle',label:'',hint:''};
 const label=aim.object.userData.label??'';
 if(aim.item&&canGrab(aim.item))return aim.beyondReach?{state:'far',label,hint:'Too far away'}:{state:'grab',label,hint:'E pick up'};
 if(aim.action!==undefined)return aim.beyondReach?{state:'far',label,hint:'Too far away'}:{state:'use',label,hint:'Click to use'};
 return {state:'idle',label:'',hint:''};
}

// Orientation of a carried object relative to the eye, captured at pickup so that turning your
// head carries the object round with you -- which is what lets you turn a meter face toward you.
export const holdOffset=(cameraQuat,bodyQuat)=>{
 const inverse=qConj(cameraQuat);
 return {
  x:inverse.w*bodyQuat.x+inverse.x*bodyQuat.w+inverse.y*bodyQuat.z-inverse.z*bodyQuat.y,
  y:inverse.w*bodyQuat.y-inverse.x*bodyQuat.z+inverse.y*bodyQuat.w+inverse.z*bodyQuat.x,
  z:inverse.w*bodyQuat.z+inverse.x*bodyQuat.y-inverse.y*bodyQuat.x+inverse.z*bodyQuat.w,
  w:inverse.w*bodyQuat.w-inverse.x*bodyQuat.x-inverse.y*bodyQuat.y-inverse.z*bodyQuat.z,
 };
};

// A scroll notch moves the hold point by a share of where it already is, so pushing an object
// out at arm's length and nudging it at the near limit both feel like one step.
export const scrollHold=(distance,notches,{rate=.18}={})=>distance*Math.exp(-notches*rate);

export {qRotate};
