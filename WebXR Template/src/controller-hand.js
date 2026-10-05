import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {clone as cloneSkinned} from 'three/addons/utils/SkeletonUtils.js';
import {isSpatialPointer} from './xr-capabilities.js';
import {createControllerHandMaterial,styleHandModel} from './xr-hands.js';
import {createHandPoser,controllerCurls,readControllerInputs,smoothCurls} from './hand-pose.js';

// A hand shown in place of the controller model, the way UE 5.3's VR template does it: the same
// generic-hand GLB the tracked hands use, parented to the grip and posed from the gamepad every
// frame. Nothing here is a tracked joint; the fingers are what the trigger, grip and thumb say.

// Where the hand sits on the grip, per handedness. These are the only numbers to touch when a
// controller family needs a different fit; everything else is derived from the skeleton itself.
// Validate each controller family in MR passthrough: with the setting on, the real hand shows through the virtual one, so
// adjust tilt first, then the offset, then roll, until palm and knuckles overlay with the trigger
// half pulled. Offsets name the target WRIST position in grip space: -Z is forward along the
// controller and +Y is up out of the fist.
export const GRIP_TUNE={
 // Dorsal, higher and inward from the controller's grip origin. X mirrors because palms face
 // inward; this directly places the wrist rather than indirectly placing the palm centre.
 right:{tiltDeg:35,rollDeg:0,yawDeg:0,offset:[.0272,.042,.0682]},
 left:{tiltDeg:35,rollDeg:0,yawDeg:0,offset:[-.0361,.0534,.0796]},
};

// Pure: which of the two visuals a source should show. Tracked hands and spatial pointers (gaze,
// transient-pointer) show neither -- they have their own visual or none at all.
export function controllerVisualState(source,mode){
 const usable=!!source&&!source.hand&&!!source.gamepad&&!isSpatialPointer(source);
 return {controller:usable&&mode==='controller',hand:usable&&mode==='hand'};
}

const deg=THREE.MathUtils.degToRad;
// Sets `object`'s local transform so its wrist sits at the controller grip, fingers wrapping forward and
// down along the controller, palm facing the body midline. The frame is read from the bones, not
// hardcoded: left.glb and right.glb are mirrors, and the thumb (always on the palm side) is the
// one mirror-invariant reference that tells us which way the palm normal really points.
export function alignHandToGrip(object,handedness,tune=GRIP_TUNE[handedness]||GRIP_TUNE.right){
 object.position.set(0,0,0);object.quaternion.identity();object.scale.set(1,1,1);object.updateMatrixWorld(true);
 const local=name=>object.worldToLocal(object.getObjectByName(name).getWorldPosition(new THREE.Vector3()));
 const wrist=local('wrist'),middle=local('middle-finger-metacarpal'),index=local('index-finger-metacarpal'),pinky=local('pinky-finger-metacarpal'),thumb=local('thumb-tip');
 const finger=middle.clone().sub(wrist).normalize(),across=pinky.clone().sub(index).normalize();
 const palm=new THREE.Vector3().crossVectors(finger,across).normalize();
 if(thumb.clone().sub(wrist).dot(palm)<0)palm.negate();
 const side=new THREE.Vector3().crossVectors(finger,palm).normalize();palm.crossVectors(side,finger).normalize();
 const tilt=deg(tune.tiltDeg),fingerTarget=new THREE.Vector3(0,-Math.sin(tilt),-Math.cos(tilt));
 const palmTarget=new THREE.Vector3(handedness==='left'?1:-1,0,0),sideTarget=new THREE.Vector3().crossVectors(fingerTarget,palmTarget).normalize();
 palmTarget.crossVectors(sideTarget,fingerTarget).normalize();
 const source=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side,finger,palm)).invert();
 const target=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(sideTarget,fingerTarget,palmTarget));
 const q=target.multiply(source);
 q.premultiply(new THREE.Quaternion().setFromAxisAngle(fingerTarget,deg(tune.rollDeg)));
 q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),deg(tune.yawDeg)));
 object.quaternion.copy(q);
 // The input source's grip pose belongs at the user's wrist when they hold a controller. Anchoring
 // the palm centre made wrist alignment depend on hand proportions and was visible in passthrough.
 object.position.fromArray(tune.offset).sub(wrist.applyQuaternion(q));
 object.updateMatrixWorld(true);
 return object;
}

// One download per URL however many hands ask for it. `cache` is the same {url: gltf} object
// XRHandMeshModel fills for the tracked hands, so whichever visual loads first serves the other.
const pending=new Map();
function loadHandAsset(url,cache){
 if(cache[url])return Promise.resolve(cache[url]);
 if(!pending.has(url))pending.set(url,new Promise((resolve,reject)=>new GLTFLoader().load(url,gltf=>{cache[url]=gltf;resolve(gltf)},undefined,reject)));
 return pending.get(url);
}

export function createControllerHandFactory(basePath,{material=createControllerHandMaterial(),cache={}}={}){
 const rest=controllerCurls(readControllerInputs(null));
 return {createControllerHand(grip){
  const root=new THREE.Group();root.name='Controller hand visual';root.userData.controllerHandVisual=true;root.visible=false;
  let generation=0,poser=null,curls={...rest};
  const clear=()=>{generation++;poser=null;curls={...rest};root.clear();};
  grip.addEventListener('connected',event=>{
   clear();const source=event.data;if(source.hand||!source.gamepad||isSpatialPointer(source))return;
   const current=generation,handedness=source.handedness==='left'?'left':'right';
   loadHandAsset(basePath+'webxr-profiles/generic-hand/'+handedness+'.glb',cache).then(gltf=>{
    if(current!==generation)return;
    // Order matters: the fade bakes in bind space, the poser captures bind matrices, and only then
    // does the hand move onto the grip. SkeletonUtils.clone rebinds the skeleton per instance.
    const object=cloneSkinned(gltf.scene.children[0]);
    styleHandModel(object,material);
    object.traverse(node=>{if(node.isSkinnedMesh)node.frustumCulled=false});
    poser=createHandPoser(object);
    alignHandToGrip(object,handedness);
    poser.setCurls(curls);poser.setSpread(curls.spread);root.add(object);
   }).catch(()=>{});
  });
  grip.addEventListener('disconnected',clear);
  return {
   root,
   get ready(){return !!poser},
   update(gamepad,dt){
    curls=smoothCurls(curls,controllerCurls(readControllerInputs(gamepad)),dt);
    if(poser){poser.setCurls(curls);poser.setSpread(curls.spread)}
   },
   reset(){curls={...rest};if(poser){poser.setCurls(curls);poser.setSpread(curls.spread)}},
  };
 }};
}
