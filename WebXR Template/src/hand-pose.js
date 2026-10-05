// Procedural posing for the generic-hand skeleton, plus the pure mapping from controller inputs to
// finger curls. No renderer, no loader, no material: the Hand Lab (materials/lab) imports this same
// file so what it previews is exactly what a controller-driven hand does in a headset.
import * as THREE from 'three';

export const FINGERS = ['thumb', 'index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];

// Pose matters more here than it looks. Every one of these changes the SILHOUETTE and the amount
// the hand overlaps itself, which is exactly what a translucent body, a fresnel rim and a hull
// outline are all sensitive to.
export const POSES = [
 'open', 'rest', 'relaxed', 'cup', 'claw', 'fist',
 'point', 'gun', 'peace', 'horns', 'thumbs-up', 'pinch', 'ok',
];

// THE SKELETON IS FLAT. All 25 joints are siblings under `Armature` with no parent/child links --
// verified by walking left.glb's node tree. That is correct for WebXR: a tracked hand delivers an
// absolute pose per joint every frame, so a chain would only be something to fight.
//
// It does mean procedural posing cannot just rotate a knuckle and let the rest of the finger
// follow, because nothing is downstream of it. So the poser builds the chain itself: CHAINS is the
// hierarchy the GLB does not have, and poseHand() walks it, composing each joint's absolute
// transform from its parent's.
export const CHAINS = {
 'thumb':         ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
 'index-finger':  ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
 'middle-finger': ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
 'ring-finger':   ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
 'pinky-finger':  ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};

// How much of a full curl each link takes. The knuckle leads and the middle joint folds hardest --
// that ratio is what stops a curled finger reading like a bent drinking straw. The metacarpal
// barely moves (it is buried in the palm) and the tip is a leaf with nothing beyond it to bend.
export const CURL_SHARE = {
 'metacarpal': 0.06, 'phalanx-proximal': 0.85, 'phalanx-intermediate': 1.0, 'phalanx-distal': 0.8,
};
export const FULL_CURL = THREE.MathUtils.degToRad(105);

// Spread fans the fingers outward from the middle finger, rotating each metacarpal about the palm
// normal rather than across it.
export const SPREAD_SIGN = {'thumb': 1.6, 'index-finger': 0.75, 'middle-finger': 0, 'ring-finger': -0.75, 'pinky-finger': -1.4};
export const FULL_SPREAD = THREE.MathUtils.degToRad(26);

// A thumb opposes rather than folding flat into the palm the way a finger does, so it flexes less.
export const THUMB_CURL_SCALE = 0.75;
const THUMB_SHARE = {'metacarpal': 0.55, 'phalanx-proximal': 0.4, 'phalanx-distal': 0.3};

// Each pose is a curl/spread recipe, with per-finger overrides where the shape needs individual
// fingers doing something different from the rest of the hand.
export const POSE_RECIPES = {
 open:        {curl: 0,    spread: 1.0},
 rest:        {curl: 0.25, spread: 0.2},
 relaxed:     {curl: 0.42, spread: 0.3},
 cup:         {curl: 0.35, spread: 0},
 claw:        {curl: 0.58, spread: 0.7},
 fist:        {curl: 1.0,  spread: 0},
 point:       {curl: 1.0,  spread: 0,    overrides: {'index-finger': 0}},
 gun:         {curl: 1.0,  spread: 0,    overrides: {'index-finger': 0, 'thumb': 0}},
 peace:       {curl: 1.0,  spread: 0.45, overrides: {'index-finger': 0, 'middle-finger': 0}},
 horns:       {curl: 1.0,  spread: 0.4,  overrides: {'index-finger': 0, 'pinky-finger': 0}},
 'thumbs-up': {curl: 1.0,  spread: 0,    overrides: {'thumb': 0}},
 pinch:       {curl: 0.6,  spread: 0.15, overrides: {'thumb': 0.85, 'index-finger': 0.85}},
 ok:          {curl: 0.08, spread: 0.55, overrides: {'thumb': 0.85, 'index-finger': 0.8}},
};

const suffixOf = name => name.replace(/^(thumb|index-finger|middle-finger|ring-finger|pinky-finger)-/, '');

// Depth-first walk collecting every named bone under `root`, keyed by name.
function collectBones(root){
 const bones = {};
 root.traverse(node => {if(node.isBone || node.name) bones[node.name] = node;});
 return bones;
}

// Wraps a loaded (and rebound -- SkeletonUtils.clone, never Object3D.clone) generic-hand object.
// Construct it while the skeleton is still in its bind pose: the bind matrices captured here are
// what every later pose composes from, so a hand posed before this call would bake that pose in.
export function createHandPoser(object){
 object.updateMatrixWorld(true);
 const bones = collectBones(object);

 // Bind state, captured once. Every pose composes from this and never from the previous pose, so
 // dragging a slider cannot accumulate drift.
 const bindLocal = new Map();   // name -> the bone's own matrix at bind, which is Armature space
 for(const name in bones) if(bones[name].isBone) bindLocal.set(name, bones[name].matrix.clone());
 if(!bindLocal.has('wrist')) throw new Error('createHandPoser: no `wrist` bone found');

 // The palm plane, in the same Armature space the bones live in. Flexion is rotation about an axis
 // lying in the palm and across the finger, oriented so a positive angle folds the finger toward
 // the PALM rather than the back of the hand; spread is rotation about the palm normal. Deriving
 // both from the rig rather than hardcoding an axis is what makes this work on the mirrored right
 // hand with no special case -- the cross products flip sign along with the geometry.
 const armaturePos = name => new THREE.Vector3().setFromMatrixPosition(bindLocal.get(name));
 const wristPos = armaturePos('wrist');
 const alongHand = armaturePos('middle-finger-metacarpal').sub(wristPos).normalize();
 const acrossHand = armaturePos('pinky-finger-metacarpal').sub(armaturePos('index-finger-metacarpal')).normalize();
 const palmNormal = new THREE.Vector3().crossVectors(alongHand, acrossHand).normalize();

 // A cross product flips sign on mirrored geometry, and left.glb and right.glb ARE mirrors of each
 // other -- so this normal points out of the palm on one hand and out of the back of the hand on
 // the other, and the fingers of one hand curl backwards. The thumb is the fix: it is anatomically
 // on the PALM side of the hand plane on both hands, so it is a mirror-invariant reference that a
 // cross product is not. Flip the normal to agree with it.
 if(armaturePos('thumb-tip').sub(wristPos).dot(palmNormal) < 0) palmNormal.negate();

 // Spread needs its own mirror correction BECAUSE the normal above is now anatomically consistent:
 // the same signed angle about a palm normal that points the same way on both hands fans the
 // fingers apart on one and squeezes them together on the other. Derive the sign from where the
 // index actually sits rather than from handedness, so it stays right for any rig.
 const towardIndex = armaturePos('index-finger-metacarpal').sub(armaturePos('middle-finger-metacarpal'));
 const indexArm = armaturePos('index-finger-metacarpal').sub(wristPos);
 const fanSign = Math.sign(new THREE.Vector3().crossVectors(palmNormal, indexArm).dot(towardIndex)) || 1;

 const bindRelative = new Map(), flexAxis = new Map(), spreadAxis = new Map();
 const bindRotationInverse = name =>
  new THREE.Quaternion().setFromRotationMatrix(bindLocal.get(name)).invert();

 for(const finger of FINGERS){
  const chain = CHAINS[finger];
  for(let i = 0; i < chain.length; i++){
   const name = chain[i];
   if(!bindLocal.has(name)) continue;
   const parent = i === 0 ? 'wrist' : chain[i-1];
   // parentBind^-1 * jointBind: the offset the chain the GLB lacks would have carried for us.
   bindRelative.set(name, new THREE.Matrix4().copy(bindLocal.get(parent)).invert().multiply(bindLocal.get(name)));

   const next = chain[i+1];
   if(!next || !bindLocal.has(next)) continue;
   const along = armaturePos(next).sub(armaturePos(name)).normalize();
   // The thumb base swings toward the index knuckle (opposition); its distal links flex gently.
   const bendToward = finger === 'thumb' && i === 0
    ? armaturePos('index-finger-phalanx-proximal').sub(armaturePos(name)).normalize()
    : palmNormal;
   const axis = new THREE.Vector3().crossVectors(along, bendToward).normalize();
   // Expressed in the joint's own bind frame, so composing below stays a plain local rotation.
   flexAxis.set(name, axis.applyQuaternion(bindRotationInverse(name)).normalize());
   spreadAxis.set(name, palmNormal.clone().applyQuaternion(bindRotationInverse(name)).normalize());
  }
 }

 const curl = {}, spread = {};
 for(const finger of FINGERS){ curl[finger] = 0; spread[finger] = 0 }

 // Walk each finger, composing the absolute joint transforms the flat rig cannot compose itself.
 const parentMatrix = new THREE.Matrix4(), jointMatrix = new THREE.Matrix4();
 const rotationMatrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), fan = new THREE.Quaternion();
 function poseHand(){
  for(const finger of FINGERS){
   parentMatrix.copy(bindLocal.get('wrist'));
   for(const name of CHAINS[finger]){
    const bone = bones[name];
    if(!bone || !bindRelative.has(name)) continue;
    jointMatrix.multiplyMatrices(parentMatrix, bindRelative.get(name));

    const suffix = suffixOf(name), share = (finger === 'thumb' ? THUMB_SHARE : CURL_SHARE)[suffix];
    if(share && flexAxis.has(name)){
     const scale = finger === 'thumb' ? THUMB_CURL_SCALE : 1;
     rotation.setFromAxisAngle(flexAxis.get(name), FULL_CURL * share * scale * curl[finger]);
     if(suffix === 'metacarpal' && spread[finger]){
      fan.setFromAxisAngle(spreadAxis.get(name), FULL_SPREAD * SPREAD_SIGN[finger] * spread[finger] * fanSign);
      rotation.multiply(fan);
     }
     jointMatrix.multiply(rotationMatrix.makeRotationFromQuaternion(rotation));
    }

    // Every bone is a direct child of Armature, so its local transform IS this absolute one.
    jointMatrix.decompose(bone.position, bone.quaternion, bone.scale);
    parentMatrix.copy(jointMatrix);
   }
  }
 }

 const clamp01 = value => THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);

 function setCurl(finger, amount){
  if(!CHAINS[finger]) throw new Error('setCurl: unknown finger "' + finger + '"');
  curl[finger] = clamp01(amount);
  poseHand();
 }

 // The per-frame path: every finger at once, one rebuild. Unknown keys are ignored so the object
 // controllerCurls() returns (which also carries `spread`) can be passed straight through.
 function setCurls(amounts){
  for(const finger of FINGERS) if(amounts[finger] !== undefined) curl[finger] = clamp01(amounts[finger]);
  poseHand();
 }

 function setSpread(amount){
  const value = clamp01(amount);
  for(const finger of FINGERS) spread[finger] = value;
  poseHand();
 }

 let currentPose = 'rest';
 function setPose(name, {blend = 1} = {}){
  const recipe = POSE_RECIPES[name];
  if(!recipe) throw new Error('setPose: unknown pose "' + name + '"');
  currentPose = name;
  blend = clamp01(blend);
  for(const finger of FINGERS){
   const target = recipe.overrides?.[finger] ?? recipe.curl;
   // blend eases from the flat bind hand toward the recipe; the poser keeps no previous pose to
   // interpolate from, only bind and target.
   curl[finger] = clamp01(target * blend);
   spread[finger] = clamp01(recipe.spread * blend);
  }
  poseHand();   // one rebuild for the whole hand, not one per finger
 }

 return {bones, curl, spread, setCurl, setCurls, setSpread, setPose, get pose(){return currentPose;}};
}

// ---------------------------------------------------------------------------------------------
// Controller -> finger mapping. Pure functions: a gamepad snapshot in, curl amounts out.
// ---------------------------------------------------------------------------------------------

export const CONTROLLER_CURL = {
 indexRest: 0.24,   // finger resting on the trigger: gently hooked, without looking clenched
 thumbRest: 0.34,   // thumb resting on the stick or a face button, before the grip closes it further
 gripRest: [0.30, 0.35, 0.40], // relaxed wrap, progressively tighter toward the little finger
 restSpread: 0.06,  // fingers a little apart at rest; they close together as the fist forms
 smoothing: 18,     // 1/s -- ~95% of the way to a new target in 170 ms, fast enough to feel direct
};

const finite01 = value => { const n = Number(value); return Number.isNaN(n) ? 0 : Math.min(1, Math.max(0, n)); };

// The xr-standard gamepad mapping: 0 trigger, 1 squeeze, 2 touchpad, 3 thumbstick, 4/5 the face
// buttons (A/B or X/Y). Capacitive `touched` is what makes the thumb and index rest realistically,
// and it is not available on every runtime, so each has a fallback that still curls on a pull or a
// stick deflection.
export function readControllerInputs(gamepad){
 const buttons = gamepad?.buttons ?? [], axes = gamepad?.axes ?? [];
 const trigger = finite01(buttons[0]?.value), squeeze = finite01(buttons[1]?.value);
 const triggerTouched = Boolean(buttons[0]?.touched) || trigger > 0.02;
 const stick = Math.hypot(Number(axes[2]) || 0, Number(axes[3]) || 0);
 const thumbTouched = [2, 3, 4, 5].some(i => buttons[i]?.touched || buttons[i]?.pressed) || stick > 0.1;
 return {trigger, squeeze, triggerTouched, thumbTouched};
}

const lerp = (a, b, t) => a + (b - a) * t;

// UE 5.3's VR-template scheme: the trigger drives the index finger, the grip drives the other three,
// and the thumb follows contact independently of squeeze. Released fingers retain a relaxed bend;
// squeezing must not drag the thumb off its control or drive it through the palm.
export function controllerCurls({trigger = 0, squeeze = 0, triggerTouched = false, thumbTouched = false} = {}){
 const t = finite01(trigger), s = finite01(squeeze);
 const index = lerp(triggerTouched ? CONTROLLER_CURL.indexRest : 0.12, 1, t);
 const thumb = thumbTouched ? CONTROLLER_CURL.thumbRest : 0.08;
 return {
  'thumb': thumb, 'index-finger': index,
  'middle-finger': lerp(CONTROLLER_CURL.gripRest[0], 1, s),
  'ring-finger': lerp(CONTROLLER_CURL.gripRest[1], 1, s),
  'pinky-finger': lerp(CONTROLLER_CURL.gripRest[2], 1, s),
  spread: CONTROLLER_CURL.restSpread * (1 - s),
 };
}

// Exponential approach so analog values never snap, and a snap to the target once within a
// thousandth so a settled hand stops producing new bone matrices.
export function smoothCurls(previous, target, dt, rate = CONTROLLER_CURL.smoothing){
 const k = 1 - Math.exp(-Math.max(Number(dt) || 0, 0) * rate);
 const next = {};
 for(const key in target){
  const from = Number.isFinite(previous?.[key]) ? previous[key] : target[key];
  let value = from + (target[key] - from) * k;
  if(Math.abs(target[key] - value) < 1e-3) value = target[key];
  next[key] = value;
 }
 return next;
}
