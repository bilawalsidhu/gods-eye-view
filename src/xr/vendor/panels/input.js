import * as THREE from 'three';
import {trackedHandPose} from '../xr-hands.js';

export class PanelInput {
  constructor(manager){this.manager=manager;this.kinds=new Map();}
  sample(input){
    const near=input.source?.hand?trackedHandPose(input.hand)?.position:input.grip?.getWorldPosition(new THREE.Vector3());
    // A tracked hand's own aim when the toolkit provides one (input.ray, xr-ray.js createHandAim), else targetRaySpace.
    const aim=input.ray?.hand&&input.source?.hand?input.ray:null;
    const ray=aim?new THREE.Ray(aim.origin.clone(),aim.direction.clone()):new THREE.Ray(input.controller.getWorldPosition(new THREE.Vector3()),input.controller.getWorldDirection(new THREE.Vector3()).negate());
    return this.manager.setInput(input,ray,near);
  }
  begin(input,kind){if(input.held)return false;if(this.manager.captured(input))return true;this.sample(input);const used=this.manager.begin(input,kind);if(used)this.kinds.set(input,kind);return used;}
  end(input,cancel=false,kind){const active=this.kinds.get(input);if(kind&&active&&active!==kind&&!(active==='pointer'&&kind==='select'))return true;this.sample(input);const used=this.manager.end(input,cancel);this.kinds.delete(input);return used;}
  cancel(input){this.kinds.delete(input);this.manager.cancel(input);}
  update(input,dt){if(!input.source||!input.controller.visible){this.cancel(input);return null;}const hit=this.sample(input);if(this.manager.captured(input))this.manager.changeDepth(input,(input.source?.gamepad?.axes?.[3]||0)*dt*.7);
    const button=!!input.source?.gamepad?.buttons?.[4]?.pressed;
    if(button&&!input.panelRecenterDown&&!input.held&&!this.manager.captured(input))this.manager.recenter();input.panelRecenterDown=button;
    const emptyPinch=input.source?.hand&&input.pinching&&!hit&&!input.held&&!this.manager.captured(input);
    input.panelEmptyPinch=emptyPinch?(input.panelEmptyPinch||0)+dt:0;
    if(input.panelEmptyPinch>=1&&!input.panelPinchRecentered){this.manager.recenter();input.panelPinchRecentered=true;}if(!emptyPinch)input.panelPinchRecentered=false;
    return hit;}
  captured(input){return this.manager.captured(input);}
  discontinuity(){this.manager.discontinuity();}
}

export function attachDesktopPanels(canvas,camera,manager){
  const owner={},pointer=new THREE.Vector2(),raycaster=new THREE.Raycaster();let captured=false;
  const sample=e=>{const r=canvas.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);return manager.setInput(owner,raycaster.ray.clone());};
  const down=e=>{if(e.button!==0)return;sample(e);captured=manager.begin(owner,'pointer');if(captured){canvas.setPointerCapture(e.pointerId);e.stopImmediatePropagation();e.preventDefault();}};
  const move=e=>{sample(e);if(captured){e.stopImmediatePropagation();e.preventDefault();}};
  const up=e=>{sample(e);if(captured){manager.end(owner);captured=false;e.stopImmediatePropagation();e.preventDefault();}};
  const cancel=()=>{manager.cancel(owner);captured=false;};
  const wheel=e=>{if(captured){manager.changeDepth(owner,e.deltaY*.001);e.preventDefault();e.stopImmediatePropagation();}};
  const key=e=>{if(e.code==='KeyR'&&!e.repeat&&!/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName)){manager.recenter();}};
  canvas.addEventListener('pointerdown',down,true);canvas.addEventListener('pointermove',move,true);canvas.addEventListener('pointerup',up,true);canvas.addEventListener('pointercancel',cancel);canvas.addEventListener('lostpointercapture',cancel);canvas.addEventListener('wheel',wheel,{passive:false,capture:true});window.addEventListener('blur',cancel);
  window.addEventListener('keydown',key);
  return ()=>{canvas.removeEventListener('pointerdown',down,true);canvas.removeEventListener('pointermove',move,true);canvas.removeEventListener('pointerup',up,true);canvas.removeEventListener('pointercancel',cancel);canvas.removeEventListener('lostpointercapture',cancel);canvas.removeEventListener('wheel',wheel,true);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',key);cancel();};
}
