// Grab and carry math, shared by the headset and the desktop paths. Pure quaternion and distance
// work with no three and no cannon, so tests/grab.test.js exercises all of it in bare node. The
// per-kind descriptors that say how far a given object can be reached and how it should be held
// are lesson content and stay in the application that owns the object.
export const THROW_SPEED_LIMIT=8;
export const THROW_SPIN_LIMIT=25;
export const DISTANCE_GRAB_RANGE=2.5;
export const SNAP_BLEND_SECONDS=.16;

// How far in front of the eye a carried object may be held, and how much clear air to keep
// between the near plane and the object's own surface so a carried battery never fills the view.
export const MIN_HOLD=.35,MAX_HOLD=2,HOLD_CLEARANCE=.25;

// Separate enter/exit thresholds prevent noisy input from dropping a held tool or flickering a
// hover on and off at the boundary. Used for optical hand tracking and for desktop pick assist.
export function gestureLatch(distance,active,on=.024,off=.038){return distance<(active?off:on)}

const clamp=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
export const qConj=q=>({x:-q.x,y:-q.y,z:-q.z,w:q.w});
export function qMul(a,b){return {
 x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
 y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
 z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,
 w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z};}
export function qRotate(q,v){
 const ix=q.w*v.x+q.y*v.z-q.z*v.y,iy=q.w*v.y+q.z*v.x-q.x*v.z,iz=q.w*v.z+q.x*v.y-q.y*v.x,iw=-q.x*v.x-q.y*v.y-q.z*v.z;
 return {x:ix*q.w+iw*-q.x+iy*-q.z-iz*-q.y,y:iy*q.w+iw*-q.y+iz*-q.x-ix*-q.z,z:iz*q.w+iw*-q.z+ix*-q.y-iy*-q.x};}

// Distance from a world point to the surface of an oriented box (0 when inside). Measuring to the
// surface rather than the origin is what lets a 27 cm battery be grabbed by its base.
export function boxDistance(point,center,quat,half){
 const d={x:point.x-center.x,y:point.y-center.y,z:point.z-center.z};
 const local=qRotate(qConj(quat),d);
 const ox=local.x-clamp(local.x,-half.x,half.x),oy=local.y-clamp(local.y,-half.y,half.y),oz=local.z-clamp(local.z,-half.z,half.z);
 return Math.sqrt(ox*ox+oy*oy+oz*oz);
}

// The world-space centre of a body's first shape, which is not the body origin whenever a shape
// was added at an offset -- every object here whose model pivot sits at its base.
export function shapeCenter(body){
 const offset=body.shapeOffsets?.[0]||{x:0,y:0,z:0},rotated=qRotate(body.quaternion,offset);
 return {x:body.position.x+rotated.x,y:body.position.y+rotated.y,z:body.position.z+rotated.z};
}

// Closest-surface distance from a world point to a grabbable's physics body.
export function grabDistance(item,point){
 const body=item.body,shape=body.shapes[0];if(!shape)return Infinity;
 const center=shapeCenter(body);
 if(shape.halfExtents)return boxDistance(point,center,body.quaternion,shape.halfExtents);
 const dx=point.x-center.x,dy=point.y-center.y,dz=point.z-center.z;
 return Math.max(0,Math.sqrt(dx*dx+dy*dy+dz*dz)-(shape.radius||0));
}

// The half-diagonal of a body's first shape: the radius of the sphere that contains it. Used to
// keep a carried object clear of the near plane and clear of the wall it is held against.
export function grabRadius(item){
 const shape=item?.body?.shapes?.[0];if(!shape)return 0;
 const half=shape.halfExtents;
 return half?Math.hypot(half.x,half.y,half.z):(shape.radius||0);
}

// Pose for a wireframe box drawn around a grab candidate. A wireframe beats an emissive tint
// because a scene usually shares one material across every instance of an object, so tinting the
// material lights all twenty batteries at once. Pure: the caller owns the LineSegments.
export function outlineBox(item){
 const body=item?.body,shape=body?.shapes?.[0];if(!shape)return null;
 const half=shape.halfExtents||(shape.radius?{x:shape.radius,y:shape.radius,z:shape.radius}:null);
 if(!half)return null;
 return {position:shapeCenter(body),quaternion:{...body.quaternion},scale:{x:half.x*2,y:half.y*2,z:half.z*2}};
}

// How far in front of the eye an object of this size may be held. The lower bound grows with the
// object so a big one is pushed out rather than clipped through the near plane, and the upper
// bound is raised to meet it when an object is too large for the normal range at all.
export function holdDistanceClamp(distance,radius=0,{min=MIN_HOLD,max=MAX_HOLD,clearance=HOLD_CLEARANCE}={}){
 const lo=Math.max(min,radius+clearance),hi=Math.max(lo,max);
 return clamp(distance,lo,hi);
}

// Where a carried object's hold point actually lands. `surfaceDistance` is how far the aim ray
// travels before it meets geometry; the hold point is pulled in short of it by the object's own
// radius, which is what stops a carried battery being shoved through the rack. Direction must be
// normalised. Returns the reached distance too, so the caller can show it and keep it for scroll.
export function carryTarget(origin,direction,distance,{surfaceDistance=Infinity,radius=0,min=MIN_HOLD}={}){
 const reach=Math.max(min,Math.min(distance,surfaceDistance-radius));
 return {x:origin.x+direction.x*reach,y:origin.y+direction.y*reach,z:origin.z+direction.z*reach,distance:reach};
}

// Radius in pixels that a world-space sphere covers on screen. Desktop pick assistance is judged
// in screen space -- a 0.03 m hit sphere through a 58° lens 1000 px tall is a comfortable 27 px radius at 1 m and a
// fiddly 9 px one at 3 m, and only this tells the interaction layer which case it is in.
export function screenRadius(worldRadius,distance,fovY,heightPx){
 if(!(distance>0)||!(fovY>0))return Infinity;
 return heightPx/2*worldRadius/(distance*Math.tan(fovY/2));
}

// Short history of poses so a release can throw with the real hand velocity, the way the Unreal
// template reads GetPhysicsLinearVelocity off the motion controller.
export class VelocityTracker{
 constructor(size=4){this.size=size;this.samples=[];}
 clear(){this.samples.length=0;}
 push(pos,quat,time){
  this.samples.push({x:pos.x,y:pos.y,z:pos.z,q:{x:quat.x,y:quat.y,z:quat.z,w:quat.w},time});
  if(this.samples.length>this.size)this.samples.shift();
 }
 span(){const s=this.samples;if(s.length<2)return null;const dt=s[s.length-1].time-s[0].time;return dt>1e-4?{a:s[0],b:s[s.length-1],dt}:null;}
 linear(){const s=this.span();if(!s)return {x:0,y:0,z:0};
  return {x:(s.b.x-s.a.x)/s.dt,y:(s.b.y-s.a.y)/s.dt,z:(s.b.z-s.a.z)/s.dt};}
 angular(){const s=this.span();if(!s)return {x:0,y:0,z:0};
  let d=qMul(s.b.q,qConj(s.a.q));
  if(d.w<0)d={x:-d.x,y:-d.y,z:-d.z,w:-d.w};
  const sin=Math.sqrt(Math.max(0,1-d.w*d.w));if(sin<1e-6)return {x:0,y:0,z:0};
  const rate=2*Math.acos(clamp(d.w,-1,1))/s.dt/sin;
  return {x:d.x*rate,y:d.y*rate,z:d.z*rate};}
}

export function limit(v,max){const l=Math.hypot(v.x,v.y,v.z);if(l<=max||l===0)return v;const k=max/l;return {x:v.x*k,y:v.y*k,z:v.z*k};}
