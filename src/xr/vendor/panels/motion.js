import * as THREE from 'three';
export const FOLLOW = Object.freeze({distance:1.25,minDistance:1,maxDistance:1.5,enterX:8,enterY:6,exitX:3,exitY:2,delay:.2,smoothTime:.25,maxSpeed:1});
export function dampVector(position,velocity,target,dt,smoothTime=.25,maxSpeed=Infinity){
  // Exact critically damped solution for a fixed target, followed by an explicit speed bound.
  const omega=2/smoothTime,e=Math.exp(-omega*dt),delta=position.clone().sub(target),term=velocity.clone().addScaledVector(delta,omega);
  const next=target.clone().addScaledVector(delta,e).addScaledVector(term,dt*e);
  velocity.addScaledVector(term,-omega*dt).multiplyScalar(e);
  const step=next.sub(position),max=maxSpeed*dt;if(step.length()>max){step.setLength(max);velocity.copy(step).divideScalar(dt||1);}
  return position.clone().add(step);
}
export function facing(position,head){
  const direction=head.clone().sub(position);const yaw=Math.atan2(direction.x,direction.z);
  const pitch=-THREE.MathUtils.clamp(Math.atan2(direction.y,Math.hypot(direction.x,direction.z)),-Math.PI/9,Math.PI/9);
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch,yaw,0,'YXZ'));
}
export function viewError(pose,viewer){
  const local=pose.position.clone().sub(viewer.position).applyQuaternion(viewer.quaternion.clone().invert());
  return {x:THREE.MathUtils.radToDeg(Math.atan2(local.x,-local.z)),y:THREE.MathUtils.radToDeg(Math.atan2(local.y,Math.hypot(local.x,local.z)))+8,distance:local.length()};
}
export function candidates(viewer){
  const results=[];
  for(const x of [0,-5,5,-10,10])for(const y of [0,-3,3,-6,6])for(const distance of [1.25,1.15,1,.0+1.4,1.5]){
    const direction=new THREE.Vector3(Math.tan(THREE.MathUtils.degToRad(x)),Math.tan(THREE.MathUtils.degToRad(y-8)),-1).normalize().applyQuaternion(viewer.quaternion);
    const position=viewer.position.clone().addScaledVector(direction,distance);
    results.push({position,quaternion:facing(position,viewer.position),scale:distance/1.25,distance,side:Math.sign(x),key:`${x}/${y}/${distance}`,score:Math.hypot(x,y)*100+Math.abs(distance-1.25)*10});
  }
  return results.sort((a,b)=>a.score-b.score);
}
export const copyPose=p=>({position:p.position.clone(),quaternion:p.quaternion.clone(),scale:p.scale??1});
export const mixPose=(a,b,t)=>({position:a.position.clone().lerp(b.position,t),quaternion:a.quaternion.clone().slerp(b.quaternion,t),scale:THREE.MathUtils.lerp(a.scale??1,b.scale??1,t)});
