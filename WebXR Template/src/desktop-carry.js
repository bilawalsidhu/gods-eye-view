import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {grabRadius,holdDistanceClamp,carryTarget,limit,qMul,VelocityTracker,THROW_SPEED_LIMIT,THROW_SPIN_LIMIT} from './grab.js';
import {SPRING,springVec,responseFor} from './spring.js';
import {holdOffset,scrollHold,blockerDistance} from './desktop-aim.js';

// Carrying an object on the desktop crosshair, after the Unreal physics-handle pattern: the
// object hangs off a point in front of the eye, that point can be pushed out and pulled in, and
// what happens on the way is decided by the physics rather than by teleporting the object.
//
// Two drivers, chosen by what the object already is, because a workshop holds two different
// kinds of thing:
//
//  - Heavy props -- a battery, a workpiece -- are dynamic bodies. They are carried on a cannon
//    LockConstraint to an invisible kinematic hand, so they genuinely collide with the world:
//    a battery bumps into the rack instead of passing through it, and `maxForce` scaled by mass
//    is what lets a heavy one be wrestled rather than flicked around.
//  - Hand instruments -- a meter, a probe -- are already kinematic with no mass, and they are
//    wanted exactly where they are pointed, not wherever a solver leaves them. They keep the
//    headset path's rigid attach.
//  - Mechanisms -- a vise handle, a door, a lever on a pivot -- are not free bodies at all. They
//    own their own motion and simply want to be told where the hand is, through the same
//    beginGrab/moveGrab/endGrab the headset path drives them with.
//
// Both share one hold point, and that hold point moves on a critically damped spring. That is
// where the weight is: a 14 Hz instrument is essentially where you point it, a 7 Hz battery
// swings along behind you. Putting the lag in the target rather than in the solver means the
// feel is a number in a table and cannot destabilise anything.

export const CARRY={
 instrumentHz:14,      // a hand instrument goes where you point it
 defaultHz:10,
 heavyHz:7,            // a battery follows, and you can feel that it does
 heavyMass:1.5,        // above this, an object is carried at heavyHz unless its kind says otherwise
 forceScale:18,        // maxForce = mass * g * this; roughly 440 N for a 2.5 kg battery
 solverIterations:12,  // a constraint needs more iterations than free-body contact does
 rotateSpeed:.006,     // radians per pixel while R is held
 // The constraint's force limit is the real break rule. This is the safety net underneath it:
 // an object wedged where the hold point cannot reach is let go rather than dragged through the
 // level, and a learner who has walked away from a snagged battery gets their hands back.
 breakDistance:1,
 breakSeconds:.4,
 // A hold point that moves further than this in one frame did not travel there: the camera was
 // teleported -- a scene reset, a lab switch, a spawn. Chasing it would look like the object
 // being flung, and the strain timer would read it as a snag and drop the object mid-flight.
 jump:.75,
 // How much clear air the hold point keeps from whatever the aim ray meets. A kinematic
 // instrument has no collision of its own, so it is held its whole radius clear or it would be
 // driven straight into the surface. A constrained prop is a real physics object that the
 // solver already stops, so it only needs a thin skin -- held a full bounding radius back, it
 // could never be placed down onto the shelf it is being aimed at.
 dynamicSkin:.06,
};

export function createDesktopCarry({world,camera,onEvent=()=>{},tuning={}}={}){
 const feel={...CARRY,...tuning};
 // The world may be passed as a thunk, because an application that swaps scenes between
 // activities does not have one yet when its controls are built.
 const worldOf=typeof world==='function'?world:()=>world;
 const origin=new THREE.Vector3(),direction=new THREE.Vector3(),worldQuat=new THREE.Quaternion();
 const tracker=new VelocityTracker();
 let item=null,hand=null,constraint=null,rest=null,spring=SPRING;
 let holdDistance=1,radius=0,holdQuat=null,kinematic=false,mechanism=null;
 let holdPos={x:0,y:0,z:0},holdVel={x:0,y:0,z:0},elapsed=0,strain=0,solverWas=null,lastTarget=null;

 const cameraQuat=()=>{camera.getWorldQuaternion(worldQuat);return {x:worldQuat.x,y:worldQuat.y,z:worldQuat.z,w:worldQuat.w}};
 const responseHz=(next,isKinematic)=>next.grab?.responseHz??(isKinematic?feel.instrumentHz:(next.body.mass>feel.heavyMass?feel.heavyHz:feel.defaultHz));

 const detach=()=>{
  if(constraint){worldOf().removeConstraint(constraint);constraint=null}
  if(hand){worldOf().removeBody(hand);hand=null}
  if(solverWas!==null){worldOf().solver.iterations=solverWas;solverWas=null}
 };

 // `item.held` wants a holder to point at, the way the headset inputs are holders, so anything
 // that asks "is this in a hand" gets a truthy answer without knowing whose.
 // It also carries `release`, so a scene reset that finds an object in a hand can ask the hand
 // to let go rather than yanking the object out and leaving a constraint behind it.
 const holder={desktop:true,release:(thrown=false)=>carry.release(thrown)};

 const carry={
  get held(){return item},
  get distance(){return holdDistance},

  grab(next,{distance=1}={}){
   if(item||!next?.body||!next?.object)return false;
   item=next;item.held=holder;item.docked=false;
   const body=item.body;
   // A mechanism moves itself; all it wants is to be told where the hand is. Nothing else in
   // here applies to it -- no constraint, no body flags, no throw.
   mechanism=item.grab?.type==='mechanism'?item.mechanism:null;
   radius=grabRadius(item);
   holdDistance=holdDistanceClamp(distance,radius);
   holdQuat=holdOffset(cameraQuat(),body.quaternion);
   // The spring starts where the object is, so it eases into the hand rather than snapping to
   // it -- the same easing the headset path blends its rigid attach over.
   holdPos={x:body.position.x,y:body.position.y,z:body.position.z};holdVel={x:0,y:0,z:0};
   kinematic=item.grab?.freeze===true||body.type===CANNON.Body.KINEMATIC;
   spring={...SPRING,response:responseFor(responseHz(item,kinematic))};
   rest={type:body.type,mass:body.mass,collisionResponse:body.collisionResponse,allowSleep:body.allowSleep};
   if(mechanism){mechanism.beginGrab(new THREE.Vector3(holdPos.x,holdPos.y,holdPos.z));tracker.clear();elapsed=0;strain=0;return true}
   // A body held still goes to sleep and stops integrating, and then ignores everything written
   // to it until something wakes it. Nothing about a carried object may depend on it moving.
   body.allowSleep=false;body.wakeUp();
   if(kinematic){
    body.type=CANNON.Body.KINEMATIC;body.mass=0;body.updateMassProperties();
    body.velocity.setZero();body.angularVelocity.setZero();
   }else{
    hand=new CANNON.Body({mass:0,type:CANNON.Body.KINEMATIC,collisionResponse:false});
    hand.position.copy(body.position);hand.quaternion.copy(body.quaternion);
    const physics=worldOf();
    physics.addBody(hand);
    const maxForce=Math.max(body.mass,.1)*9.81*feel.forceScale;
    constraint=new CANNON.LockConstraint(hand,body,{maxForce});
    physics.addConstraint(constraint);
    solverWas=physics.solver.iterations;
    physics.solver.iterations=Math.max(solverWas,feel.solverIterations);
   }
   tracker.clear();elapsed=0;strain=0;lastTarget=null;
   return true;
  },

  release(thrown=false){
   if(!item)return null;
   const released=item,body=released.body;
   if(mechanism){
    mechanism.endGrab();mechanism=null;
    released.held=null;item=null;holdQuat=null;rest=null;tracker.clear();
    return released;
   }
   detach();
   body.allowSleep=rest.allowSleep;
   // A hand instrument holds the pose you let go of it in instead of falling, which is what
   // makes it possible to leave a probe resting on a terminal. Only real props are thrown.
   if(kinematic){
    body.type=CANNON.Body.KINEMATIC;body.mass=0;body.updateMassProperties();
    body.velocity.setZero();body.angularVelocity.setZero();
   }else{
    body.type=rest.type;body.mass=rest.mass;body.updateMassProperties();body.collisionResponse=rest.collisionResponse;
    if(thrown){
     const velocity=limit(tracker.linear(),THROW_SPEED_LIMIT),spin=limit(tracker.angular(),THROW_SPIN_LIMIT);
     body.velocity.set(velocity.x,velocity.y,velocity.z);
     body.angularVelocity.set(spin.x,spin.y,spin.z);
    }else{body.velocity.setZero();body.angularVelocity.setZero()}
   }
   body.wakeUp();
   released.held=null;item=null;holdQuat=null;rest=null;tracker.clear();
   return released;
  },

  // A scroll notch is a share of the current distance, so a nudge at the near limit and a push
  // at arm's length both feel like one step.
  push(notches){
   if(!item)return holdDistance;
   holdDistance=holdDistanceClamp(scrollHold(holdDistance,notches),radius);
   return holdDistance;
  },

  // The object is the body's, not the other way round, so a constrained prop shows exactly where
  // the physics put it -- including while it is pressed against something. Call this after the
  // world has stepped: a carried object driven before the step is a frame stale on screen, which
  // reads as the object trailing the crosshair even when it is not.
  // The hold point, the object and the strain timer all start again from here. Called on a
  // camera teleport the carry notices, and callable by an application that is about to make one.
  discontinuity(at=null){
   if(!item)return;
   const body=item.body,to=at??{x:holdPos.x,y:holdPos.y,z:holdPos.z};
   holdPos={x:to.x,y:to.y,z:to.z};holdVel={x:0,y:0,z:0};strain=0;lastTarget={x:to.x,y:to.y,z:to.z};
   body.position.set(to.x,to.y,to.z);body.velocity.setZero();body.angularVelocity.setZero();
   if(hand)hand.position.set(to.x,to.y,to.z);
   tracker.clear();
  },

  sync(){
   if(!item||mechanism)return;
   item.object.position.copy(item.body.position);
   item.object.quaternion.copy(item.body.quaternion);
  },

  // Turning the object in the hand, for seating a battery square in its bay or aiming a probe.
  rotate(dx,dy){
   if(!item||!holdQuat)return;
   const yaw={x:0,y:Math.sin(-dx*feel.rotateSpeed/2),z:0,w:Math.cos(-dx*feel.rotateSpeed/2)};
   const pitch={x:Math.sin(-dy*feel.rotateSpeed/2),y:0,z:0,w:Math.cos(-dy*feel.rotateSpeed/2)};
   holdQuat=qMul(qMul(yaw,pitch),holdQuat);
  },

  update(dt,{blockers=[]}={}){
   if(!item)return null;
   elapsed+=dt;
   const body=item.body;
   camera.getWorldPosition(origin);
   direction.set(0,0,-1).applyQuaternion(camera.getWorldQuaternion(worldQuat));
   // Short of whatever the aim ray meets, by the object's own radius: this is what stops a
   // carried battery being shoved through the rack, and it is a cheaper and more predictable
   // answer than letting the solver fight the wall every frame.
   const surface=blockerDistance(origin,direction,blockers);
   const clearance=kinematic?radius:Math.min(radius,feel.dynamicSkin);
   const target=carryTarget(origin,direction,holdDistance,{surfaceDistance:surface,radius:clearance});
   // A teleport is not motion. Re-seat the spring on the other side of it rather than letting
   // the object fly across the room and then be dropped for lagging.
   if(lastTarget&&Math.hypot(target.x-lastTarget.x,target.y-lastTarget.y,target.z-lastTarget.z)>feel.jump)carry.discontinuity(target);
   lastTarget={x:target.x,y:target.y,z:target.z};
   ({pos:holdPos,vel:holdVel}=springVec(holdPos,holdVel,target,dt,spring));
   const quat=qMul(cameraQuat(),holdQuat);
   if(mechanism){
    mechanism.moveGrab(new THREE.Vector3(holdPos.x,holdPos.y,holdPos.z));
    return {position:holdPos,distance:holdDistance,lag:0};
   }
   if(kinematic){
    body.position.set(holdPos.x,holdPos.y,holdPos.z);
    body.quaternion.set(quat.x,quat.y,quat.z,quat.w);
    body.velocity.setZero();body.angularVelocity.setZero();
   }else{
    hand.position.set(holdPos.x,holdPos.y,holdPos.z);
    hand.quaternion.set(quat.x,quat.y,quat.z,quat.w);
   }
   carry.sync();
   tracker.push(holdPos,quat,elapsed);
   const lag=Math.hypot(body.position.x-holdPos.x,body.position.y-holdPos.y,body.position.z-holdPos.z);
   strain=lag>feel.breakDistance?strain+dt:0;
   if(strain>feel.breakSeconds){
    const dropped=carry.release(false);
    onEvent('break',{item:dropped,lag});
    return null;
   }
   return {position:holdPos,distance:holdDistance,lag};
  },

  dispose(){if(item)carry.release(false);detach()},
 };
 return carry;
}
