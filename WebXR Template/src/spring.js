// Critically damped spring motion for anything that has to chase a moving target without lagging
// at the start or creeping at the end: a following panel, the hold point of a carried object.
// Pure -- no three, no cannon -- so tests/spring.test.js exercises it in bare node.
//
// Parameterised the way the HIG spec is written: `response` is the settling time in seconds and
// `damping` 1.0 means it reaches the target and stops, never overshoots. A lerp has no velocity
// term, so it lags when a follow starts and creeps at the end; a spring absorbs a target that
// moves mid-flight, which is exactly what a hold point in front of a turning head does.
export const SPRING={
 response:.35,        // settling time in seconds; the HIG default band is 0.3-0.4
 damping:1,           // critically damped
 maxStep:1/30,        // dt clamp; a frame hitch must not detonate the integrator
 settleDistance:.02,  // close enough to the target to call it arrived
};

// Frame-rate independent exponential smoothing, for the cases that want a plain follow factor
// rather than a second-order spring -- an orientation slerp, a fading opacity.
export const smoothing=(rate,dt)=>1-Math.exp(-rate*Math.max(dt,0));

// One axis. Semi-implicit Euler, which stays stable where explicit Euler would wobble. Call it
// once per axis: decomposing motion into independent springs is what keeps a diagonal move from
// curving, and it is why this takes a scalar rather than a vector.
//
// Semi-implicit Euler is only conditionally stable: the damping term alone needs 2*damping*w*h
// below 2, so a stiff spring diverges at a normal frame time rather than merely lagging. A 14 Hz
// hold point (w = 88 rad/s) integrated in one 1/60 s step runs away to 1e6 within a fifth of a
// second. Subdividing the frame into steps that satisfy the condition is what makes the stiffness
// a free parameter instead of a trap, and it makes the result frame-rate independent as a
// side effect. MAX_SUBSTEPS bounds the work; the dt clamp already bounds the input.
const SAFE_STEP=.5,MAX_SUBSTEPS=16;
export function springStep(current,velocity,target,dt,opts=SPRING){
 const step=Math.min(Math.max(dt,0),opts.maxStep);
 if(step===0)return {value:current,velocity};
 const w=2*Math.PI/opts.response;
 const substeps=Math.min(MAX_SUBSTEPS,Math.max(1,Math.ceil(step/(SAFE_STEP/w))));
 const h=step/substeps;
 let value=current,v=velocity;
 for(let i=0;i<substeps;i++){
  const accel=-(w*w)*(value-target)-(2*opts.damping*w)*v;
  v+=accel*h;value+=v*h;
 }
 return {value,velocity:v};
}

export function springVec(pos,vel,target,dt,opts=SPRING){
 const x=springStep(pos.x,vel.x,target.x,dt,opts);
 const y=springStep(pos.y,vel.y,target.y,dt,opts);
 const z=springStep(pos.z,vel.z,target.z,dt,opts);
 return {pos:{x:x.value,y:y.value,z:z.value},vel:{x:x.velocity,y:y.velocity,z:z.velocity}};
}

export const settled=(a,b,opts=SPRING)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<opts.settleDistance;

// A settling time from a stiffness in hertz, so per-kind carry weight reads as one number in a
// descriptor table: 14 Hz for a hand instrument that must go exactly where you point it, 7 Hz for
// a battery that should swing along behind you. Higher is stiffer, and so lighter-feeling.
export const responseFor=hz=>1/Math.max(hz,.01);
