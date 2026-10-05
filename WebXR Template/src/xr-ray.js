import * as THREE from 'three';

// A Meta-style pointer: a slim beam that fades out at its origin so it never looks welded to
// the controller, and lands on a filled cursor with a hover ring. The beam is STRAIGHT: it runs
// along the raycast itself, from the hand to the cursor, so where it points and where the cursor
// sits can never disagree. An earlier version bowed it through the middle, which read as the ray
// missing what it had in fact hit. Nothing bends the beam now, so one length segment is enough --
// the origin fade below is linear in z and interpolates exactly across it.
const SEGMENTS=1;

// Where a tracked hand's beam leaves the hand. The runtime's targetRaySpace is an aiming
// frame, not a place on the body: on Quest its origin sits back above the knuckles, so a beam
// drawn from it appears to leave the back of the hand rather than the pinch. Meta's own
// pointer starts at the pinch, between thumb and index, and that is what this offset restores.
// The direction still comes from targetRaySpace -- only the visible origin moves, so aiming
// is unchanged. Device validation outstanding: confirm on Quest 3 with tracked hands.
export const HAND_RAY_ORIGIN={forward:.026,drop:.006};

export function createAimRay(controller,scene){
 const geometry=new THREE.CylinderGeometry(.0016,.0026,1,8,SEGMENTS,true);
 geometry.rotateX(Math.PI/2);geometry.translate(0,0,-.5);
 const material=new THREE.MeshBasicMaterial({color:'#ffffff',transparent:true,opacity:.45,depthWrite:false,toneMapped:false});
 material.onBeforeCompile=shader=>{
  shader.vertexShader='varying float vRayDistance;\n'+shader.vertexShader;
  // 0 at the hand, 1 at the tip. The origin fade is the only thing that reads it.
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',
   '#include <begin_vertex>\nvRayDistance = -position.z;');
  shader.fragmentShader='varying float vRayDistance;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',
   'diffuseColor.a *= smoothstep(0.03,0.42,vRayDistance) * mix(0.55,1.0,vRayDistance);\n#include <opaque_fragment>');
 };
 const beam=new THREE.Mesh(geometry,material);beam.visible=false;beam.frustumCulled=false;controller.add(beam);

 const cursor=new THREE.Group();cursor.visible=false;scene.add(cursor);
 const dotMaterial=new THREE.MeshBasicMaterial({color:'#ffffff',transparent:true,opacity:.95,depthWrite:false,depthTest:false,side:THREE.DoubleSide,toneMapped:false});
 const ringMaterial=new THREE.MeshBasicMaterial({color:'#ffffff',transparent:true,opacity:.55,depthWrite:false,depthTest:false,side:THREE.DoubleSide,toneMapped:false});
 const dot=new THREE.Mesh(new THREE.CircleGeometry(.0042,24),dotMaterial);
 const ring=new THREE.Mesh(new THREE.RingGeometry(.0092,.0116,32),ringMaterial);
 cursor.add(dot,ring);cursor.renderOrder=10;dot.renderOrder=11;ring.renderOrder=11;

 const normal=new THREE.Vector3(),forward=new THREE.Vector3(0,0,1),origin=new THREE.Vector3();
 const localOrigin=new THREE.Vector3(),localTarget=new THREE.Vector3(),aim=new THREE.Vector3(),up=new THREE.Vector3(0,1,0);
 const basis=new THREE.Matrix4();
 return {beam,cursor,ring,hide(){beam.visible=cursor.visible=false;},
  // `origin` is an optional world-space point the beam should leave from -- the pinch for a
  // tracked hand. `showBeam:false` keeps the cursor and drops the beam, which is what a
  // system-aimed pointer wants: the runtime aims it, so a drawn beam would be our guess at
  // something the user is already being shown by the platform.
  // `direction` (world space, with `origin`) is the ray the hit was cast along when it is not the
  // controller's own -Z: a tracked hand's own aim (createHandAim). The beam then runs along it.
  update(hit,{visible=true,active=false,maxDistance=2.5,origin:worldOrigin=null,direction:worldDirection=null,showBeam=true}={}){
   const distance=hit?Math.min(hit.distance,maxDistance):maxDistance;
   beam.visible=visible&&showBeam;
   if(beam.visible){
    // Default: the beam sits at the controller origin and runs down local -Z, which is the
    // ray the raycast used. With an explicit origin it must be re-aimed, or a beam moved a
    // couple of centimetres would still point parallel and miss its own cursor up close.
    if(worldOrigin){
     localOrigin.copy(controller.worldToLocal(origin.copy(worldOrigin)));
     if(worldDirection)localTarget.copy(controller.worldToLocal(origin.copy(worldOrigin).addScaledVector(worldDirection,distance)));
     else localTarget.set(0,0,-distance);
     aim.copy(localTarget).sub(localOrigin);
     const reach=aim.length()||1e-4;
     beam.position.copy(localOrigin);
     basis.lookAt(new THREE.Vector3(),aim.divideScalar(reach),up);
     // Matrix4.lookAt(eye, target) points local -Z at the target, which is the axis the
     // geometry already runs along, so no further turn is needed.
     beam.quaternion.setFromRotationMatrix(basis);
     beam.scale.z=reach;
    }else{
     beam.position.set(0,0,0);beam.quaternion.identity();beam.scale.z=distance;
    }
    material.opacity=active?.85:.42;
   }
   cursor.visible=visible&&!!hit&&hit.distance<=maxDistance;
   if(!cursor.visible)return;
   // Panel hits report a point without a mesh face, so fall back to the surface the panel
   // presents, then to simply facing the hand.
   if(hit.face&&hit.object)normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
   else if(hit.normal)normal.copy(hit.normal);
   else if(hit.panel)normal.set(0,0,1).applyQuaternion(hit.panel.group.getWorldQuaternion(new THREE.Quaternion()));
   else normal.copy(controller.getWorldPosition(origin)).sub(hit.point).normalize();
   cursor.position.copy(hit.point).addScaledVector(normal,.004);
   cursor.quaternion.setFromUnitVectors(forward,normal);
   // Pressing pulls the cursor in, the way the system pointer acknowledges a click.
   dot.scale.setScalar(active?1.35:1);ring.scale.setScalar(active?.78:1);
   ringMaterial.opacity=active?.9:.5;
  }};
}

// The world-space point a tracked hand's beam should leave from: the pinch, nudged forward
// along the aim so it clears the fingertips. Pure so the offset can be checked without a
// renderer; `pose` is trackedHandPose()'s result and `direction` the targetRaySpace aim.
export function handRayOrigin(pose,direction,tune=HAND_RAY_ORIGIN){
 if(!pose?.position||!direction)return null;
 return pose.position.clone().addScaledVector(direction,tune.forward).addScaledVector(new THREE.Vector3(0,-1,0),tune.drop);
}

// ---- a tracked hand's own aim ray.
// The runtime's targetRaySpace for a tracked hand is its own guess at a pointer, and on Quest it
// reads high: it points above where the hand is pointing, and moves when the fingers close to
// pinch. So tracked hands aim with a ray built here, the way Meta's own hand pointer is built: from
// an estimated shoulder through the web between thumb and index (their knuckles, which a pinch does
// not move), turned a little toward where the hand itself points (wrist to middle knuckle), and
// smoothed -- lightly while the aim is sweeping, more while it is held on a target. The ray starts
// at about the pinch, and the beam, the cursor, panels, selection, distance grab and point-to-move
// all use this one ray, so they can never disagree. Device validation outstanding: Quest 3 hands.
export const HAND_AIM={
 shoulderDrop:.2,    // the shoulder below the eyes (metres)
 shoulderWidth:.17,  // either side of the head's centre line
 shoulderBack:.05,   // behind the eyes
 handWeight:.3,      // how far the hand's own pointing turns the shoulder-to-hand line (0..1)
 start:.035,         // the ray starts this far past the web of the hand: about at the pinch
 slow:.075,fast:.012,// smoothing time constants (s): with the aim held still, and sweeping
 fastSpeed:2.5,      // rad/s of aim change at which smoothing is at its lightest
};
export const HAND_AIM_JOINTS={wrist:'wrist',thumb:'thumb-phalanx-proximal',index:'index-finger-phalanx-proximal',middle:'middle-finger-phalanx-proximal'};

// Reads the joints the aim needs from a three.js XRHand (hand.joints), in world space, into `out`.
// Null while any of them is untracked.
export function readHandAimPoints(hand,out={wrist:new THREE.Vector3(),thumb:new THREE.Vector3(),index:new THREE.Vector3(),middle:new THREE.Vector3()}){
 if(!hand?.visible)return null;
 for(const [key,name] of Object.entries(HAND_AIM_JOINTS)){const joint=hand.joints?.[name];if(!joint?.visible)return null;joint.getWorldPosition(out[key]);}
 return out;
}

// Where an input aims, for code outside the toolkit: the tracked hand's own ray while the toolkit
// has one this frame (input.ray, from XRToolkit.updateAim), else targetRaySpace. Into `out`.
export function inputAim(input,out={origin:new THREE.Vector3(),direction:new THREE.Vector3()}){
 if(input?.ray?.hand&&input.source?.hand){out.origin.copy(input.ray.origin);out.direction.copy(input.ray.direction);return out;}
 input.controller.getWorldPosition(out.origin);input.controller.getWorldDirection(out.direction).negate();return out;
}

// Pure: the unsmoothed ray for joint points {wrist, thumb, index, middle} (world Vector3s), a head
// at `head` facing `forward` (only its horizontal part is used, so looking down does not lower the
// shoulders), and `handedness` ('left' | 'right').
const flat=new THREE.Vector3(),right=new THREE.Vector3(),shoulder=new THREE.Vector3(),anchor=new THREE.Vector3(),fromShoulder=new THREE.Vector3(),along=new THREE.Vector3();
export function handAimRay(points,head,forward,handedness,tune=HAND_AIM,out={origin:new THREE.Vector3(),direction:new THREE.Vector3()}){
 flat.set(forward.x,0,forward.z);if(flat.lengthSq()<1e-8)flat.set(0,0,-1);flat.normalize();
 right.set(-flat.z,0,flat.x);
 shoulder.copy(head).addScaledVector(right,(handedness==='left'?-1:1)*tune.shoulderWidth).addScaledVector(flat,-tune.shoulderBack);shoulder.y-=tune.shoulderDrop;
 anchor.copy(points.thumb).add(points.index).multiplyScalar(.5);
 fromShoulder.subVectors(anchor,shoulder);if(fromShoulder.lengthSq()<1e-8)fromShoulder.copy(flat);fromShoulder.normalize();
 along.subVectors(points.middle,points.wrist);if(along.lengthSq()<1e-8)along.copy(fromShoulder);along.normalize();
 out.direction.copy(fromShoulder).multiplyScalar(1-tune.handWeight).addScaledVector(along,tune.handWeight);
 if(out.direction.lengthSq()<1e-8)out.direction.copy(fromShoulder);out.direction.normalize();
 out.origin.copy(anchor).addScaledVector(out.direction,tune.start);
 return out;
}

// One hand's smoothed aim. update() returns {origin, direction} (reused objects) or null while the
// hand is untracked; reset() drops the smoothing, for a hand that comes back somewhere new.
export function createHandAim(tune=HAND_AIM){
 const raw={origin:new THREE.Vector3(),direction:new THREE.Vector3()},ray={origin:new THREE.Vector3(),direction:new THREE.Vector3(),hand:true};
 const base=new THREE.Vector3();let warm=false;
 return {ray,
  reset(){warm=false;},
  update(points,head,forward,handedness,dt){
   if(!points){warm=false;return null;}
   handAimRay(points,head,forward,handedness,tune,raw);
   if(!warm||!(dt>0)){ray.direction.copy(raw.direction);warm=true;}
   else{
    const speed=ray.direction.angleTo(raw.direction)/dt,k=Math.min(1,speed/tune.fastSpeed);
    const tau=tune.slow+(tune.fast-tune.slow)*k;
    ray.direction.lerp(raw.direction,1-Math.exp(-dt/tau)).normalize();
   }
   base.copy(raw.origin).addScaledVector(raw.direction,-tune.start);
   ray.origin.copy(base).addScaledVector(ray.direction,tune.start);
   return ray;
  }};
}
