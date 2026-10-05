// Pure teleport math. Keep this module free of renderer dependencies so it is easy to test.
export const PLAYER_RADIUS=.25, LAUNCH_SPEED=7, GRAVITY=-9.81, STEP=1/30, MAX_TIME=2;
export function validFloor(point, blockers=[], radius=PLAYER_RADIUS, bounds={minX:-5,maxX:5,minZ:-5,maxZ:5}) {
  if(point.x<=bounds.minX||point.x>=bounds.maxX||point.z<=bounds.minZ||point.z>=bounds.maxZ)return false;
  return !blockers.some(b=>b.max.y>.05&&b.min.y<1.8&&point.x>b.min.x-radius&&point.x<b.max.x+radius&&point.z>b.min.z-radius&&point.z<b.max.z+radius);
}
export function ballistic(origin,direction,{speed=LAUNCH_SPEED,gravity=GRAVITY}={}) {
  const points=[{...origin}];let previous=points[0];
  for(let time=STEP;time<=MAX_TIME;time+=STEP){const next={x:origin.x+direction.x*speed*time,y:origin.y+direction.y*speed*time+.5*gravity*time*time,z:origin.z+direction.z*speed*time};if(previous.y>0&&next.y<=0){const ratio=previous.y/(previous.y-next.y),hit={x:previous.x+(next.x-previous.x)*ratio,y:0,z:previous.z+(next.z-previous.z)*ratio};return {points:[...points,hit],hit}}points.push(next);previous=next}
  return {points,hit:null};
}
