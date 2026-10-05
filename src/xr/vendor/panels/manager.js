import * as THREE from 'three';
import {headPosition,headQuaternion} from '../xr-head.js';
import {layoutPanel,layoutLabel} from './layout.js';
import {createPanelView} from './view.js';
import {PanelCollision,panelBox} from './collision.js';
import {RoomGeometry} from './room.js';
import {FOLLOW,candidates,copyPose,dampVector,facing,viewError} from './motion.js';

const MODES=['anchored','following','movable'];
export class PanelManager {
  constructor({scene,brand,logo,renderer,onStatus=()=>{},viewFactory=createPanelView}){
    Object.assign(this,{scene,brand,logo,renderer,onStatus,viewFactory});this.panels=[];this.inputs=new Map();this.collision=new PanelCollision();this.room=new RoomGeometry(this.collision,scene);
    this.viewer={position:new THREE.Vector3(0,1.65,3.5),quaternion:new THREE.Quaternion()};this.time=0;
  }
  createPanel({id,mode='anchored',variant='panel',parent=null,content,layout={},pose,onAction=()=>{},onState=()=>{}}){
    if(this.panels.some(p=>p.id===id)||!id||id.startsWith('@'))throw new Error('Panel ID must be unique');
    if(!MODES.includes(mode))throw new Error('Unknown panel mode');
    const label=variant==='label';
    const view=this.viewFactory(this.brand,this.logo,this.renderer?.capabilities.maxTextureSize,{variant});
    const p={id,mode,variant,content,layoutOptions:layout,onAction,onState,view,group:view.group,pose:{position:new THREE.Vector3().fromArray(pose?.position||[0,1.5,-1.25]),quaternion:new THREE.Quaternion().fromArray(pose?.quaternion||[0,0,0,1]),scale:1},velocity:new THREE.Vector3(),page:0,visible:true,initialized:!!pose,authored:!!pose,dirty:true,state:mode==='following'?'following':'placed',appearance:'glass',opacity:1,locked:0};
    p.setContent=next=>{if(p.savedContent)p.savedContent=next;else p.pending=next;};
    p.setMode=next=>{if(!MODES.includes(next))throw new Error('Unknown panel mode');this.cancelPanel(p);p.mode=next;p.size.handle=next==='movable';p.velocity.set(0,0,0);if(next==='following'){this.onlyFollower(p);p.forceRecenter=true;}this.state(p,next==='following'?'following':'placed');p.dirty=true;};
    p.setPose=pose=>{this.cancelPanel(p);p.pose={position:new THREE.Vector3().fromArray(pose.position),quaternion:new THREE.Quaternion().fromArray(pose.quaternion||[0,0,0,1]),scale:1};p.initialized=true;p.authored=true;p.invalid=false;};
    p.show=()=>{p.visible=true;if(p.mode==='following')this.onlyFollower(p);p.dirty=true;};
    p.hide=()=>{this.cancelPanel(p);p.visible=false;p.group.visible=false;};
    p.recenter=()=>{p.visible=true;p.forceRecenter=true;if(p.mode==='following')this.onlyFollower(p);};
    p.dispose=()=>{this.cancelPanel(p);view.dispose();p.dom?.remove();this.panels=this.panels.filter(x=>x!==p);};
    p.setAppearance=value=>{p.appearance=value==='solid'?'solid':'glass';p.dirty=true;};
    p.layout=label?layoutLabel(content,view.metrics,layout):layoutPanel(content,view.metrics,layout);p.size={width:p.layout.physicalWidth,height:p.layout.physicalHeight,handle:mode==='movable'};view.resize(p.layout);
    // A label rides its parent's transform, so its pose is local and it never joins the
    // world-space placement, collision or input systems.
    (label&&parent?parent:this.scene).add(view.group);this.panels.push(p);if(mode==='following')this.onlyFollower(p);this.applyPose(p);return p;
  }
  onlyFollower(p){for(const other of this.panels)if(other!==p&&other.mode==='following')other.hide();}
  state(p,state){if(p.state===state)return;p.state=state;p.dirty=true;p.onState(state);if(state==='blocked')this.onStatus('Panel waiting for clear space. Recenter panels retries placement.');}
  applyPose(p){p.group.position.copy(p.pose.position);p.group.quaternion.copy(p.pose.quaternion);p.group.scale.setScalar(p.pose.scale);p.group.updateMatrixWorld(true);p.view.handle.visible=p.mode==='movable';}
  // `rig` is the player rig when the camera is the XR one. It has to be given, because an XR
  // camera is not in the scene graph and its world accessors quietly return a rig-local pose -- and
  // corrupt its matrixWorld on the way (xr-head.js). Without a rig the camera is a real scene-graph
  // citizen (the desktop camera, or a project that never moves a rig) and its own accessors are right.
  prepare(camera,frame,space,rig=null){
    if(rig){headPosition(rig,camera,this.viewer.position);headQuaternion(rig,camera,this.viewer.quaternion);}
    else{camera.updateWorldMatrix(true,false);this.viewer.position.copy(camera.getWorldPosition(new THREE.Vector3()));this.viewer.quaternion.copy(camera.getWorldQuaternion(new THREE.Quaternion()));}
    const cameras=camera.cameras?.length?camera.cameras:[camera];let width=44,height=32;
    for(const eye of cameras){const e=eye.projectionMatrix?.elements;if(e&&e[0]>0&&e[5]>0){width=Math.min(width,THREE.MathUtils.radToDeg(2*Math.atan((1-Math.abs(e[8]))/e[0]))*.85);height=Math.min(height,THREE.MathUtils.radToDeg(2*Math.atan((1-Math.abs(e[9]))/e[5]))*.85);}}
    const viewportKey=`${width.toFixed(1)}/${height.toFixed(1)}`;
    if(viewportKey!==this.viewportKey){this.viewportKey=viewportKey;for(const p of this.panels){if(p.variant==='label')continue;p.layoutOptions={...p.layoutOptions,maxWidth:width,maxHeight:height};p.pending=p.pending||p.content;}}
    this.room.update(frame,space);this.collision.refresh(this.panels);
  }
  valid(p,pose,options){return this.collision.valid(pose,p.size,this.viewer.position,p.id,options);}
  destination(p){
    let choices=candidates(this.viewer);
    if(p.side)choices=choices.filter(c=>!c.side||c.side===p.side);
    let chosen=choices.find(c=>{if(p.mode!=='following')c.scale=p.pose.scale;return this.valid(p,c);});
    if(!chosen&&p.side){p.side=0;return this.destination(p);}return chosen;
  }
  startRecovery(p,target){if(p.recovery)return;p.recovery={target:copyPose(target),time:0,moved:false};this.cancelPanel(p);p.velocity.set(0,0,0);this.state(p,'recovering');}
  update(dt){
    dt=Math.max(0,Math.min(dt,.05));this.time+=dt;
    for(const p of this.panels){
      if(!p.visible){p.group.visible=false;continue;}
      if(p.variant==='label'){
        if(p.pending){const next=p.pending;p.pending=null;
          try{p.layout=layoutLabel(next,p.view.metrics,p.layoutOptions);p.content=next;p.view.resize(p.layout);p.size={width:p.layout.physicalWidth,height:p.layout.physicalHeight,handle:false};p.dirty=true;}
          catch(error){this.onStatus(error.message);}
        }
        p.group.visible=true;p.view.face.material.opacity=1;p.view.handle.material.opacity=0;
        this.applyPose(p);
        if(p.dirty||p.view.dirty){p.view.paint(p);p.dirty=false;}
        continue;
      }
      if(p.pending&&!p.locked&&this.time-(p.contentTime||0)>=.1){
        const next=p.pending;p.pending=null;let measured;
        try{measured=layoutPanel(next,p.view.metrics,{...p.layoutOptions,...(next.taskId===p.content.taskId?{minWidth:p.size.width,minHeight:p.size.height}:{})});}catch(error){this.onStatus(error.message);continue;}
        const proposed={width:measured.physicalWidth,height:measured.physicalHeight,handle:p.mode==='movable'};
        if(p.initialized&&!this.collision.valid(p.pose,proposed,this.viewer.position,p.id,{sight:false})){
          try{measured=layoutPanel(next,p.view.metrics,{...p.layoutOptions,widthLimit:p.size.width,heightLimit:p.size.height});}catch{p.pending=next;this.state(p,'blocked');continue;}
        }
        const from={width:p.view.face.scale.x,height:p.view.face.scale.y};
        // Only a real size change animates. A no-op resize would otherwise blank the
        // controls out of hit-testing for 180 ms, making live content unclickable.
        const grew=Math.abs(from.width-measured.physicalWidth)>1e-6||Math.abs(from.height-measured.physicalHeight)>1e-6;
        if(next.taskId!==p.content.taskId)p.page=0;p.content=next;p.layout=measured;p.page=Math.min(p.page,measured.pages.length-1);
        p.size=grew?{width:Math.max(from.width,measured.physicalWidth),height:Math.max(from.height,measured.physicalHeight),handle:p.mode==='movable'}:{width:measured.physicalWidth,height:measured.physicalHeight,handle:p.mode==='movable'};
        if(grew)p.resize={from,time:0};else p.view.resize(p.layout);
        p.contentTime=this.time;p.dirty=true;
      }
      if(p.resize){p.resize.time+=dt;const t=Math.min(1,p.resize.time/.18),ease=t*t*(3-2*t);p.view.resize({...p.layout,physicalWidth:THREE.MathUtils.lerp(p.resize.from.width,p.layout.physicalWidth,ease),physicalHeight:THREE.MathUtils.lerp(p.resize.from.height,p.layout.physicalHeight,ease)});if(t===1){p.size={width:p.layout.physicalWidth,height:p.layout.physicalHeight,handle:p.mode==='movable'};p.resize=null;}}
      const physicalValid=this.valid(p,p.pose,{sight:false,headClearance:0});
      if(p.authored&&p.mode==='anchored'&&!physicalValid&&!p.forceRecenter&&!p.recovery){p.group.visible=false;if(!p.invalid)this.onStatus(`Panel ${p.id}: authored placement intersects geometry`);p.invalid=true;continue;}
      p.invalid=false;
      if(!p.initialized){const destination=this.destination(p);if(destination){p.pose=copyPose(destination);p.initialized=true;p.side=destination.side;}else{this.state(p,'blocked');p.group.visible=false;continue;}}
      if(p.recovery){
        const r=p.recovery;r.time+=dt;
        if(!r.moved){p.opacity=Math.max(0,1-r.time/.12);if(r.time>=.12){const target=this.destination(p);if(target){p.pose=copyPose(target);r.moved=true;r.time=0;p.side=target.side;}else{p.opacity=0;this.state(p,'blocked');}}}
        else{p.opacity=Math.min(1,r.time/.18);if(p.opacity===1){p.recovery=null;this.state(p,p.mode==='following'?'following':'placed');}}
      }else if(!physicalValid&&p.mode!=='anchored'){const destination=this.destination(p);this.startRecovery(p,destination||p.pose);}
      else if(p.forceRecenter){p.forceRecenter=false;const destination=this.destination(p);if(destination)this.startRecovery(p,destination);else this.state(p,'blocked');}
      else if(!p.locked&&p.mode==='following'&&this.room.state!=='tracking interrupted'&&!p.near){
        const error=viewError(p.pose,this.viewer),out=Math.abs(error.x)>8||Math.abs(error.y)>6||error.distance<1||error.distance>1.5;
        p.outTime=out?(p.outTime||0)+dt:0;
        const obscured=this.collision.occluded(p.pose,p.size,this.viewer.position,p.id);
        if(p.outTime>=FOLLOW.delay||obscured)p.moving=true;
        if(p.moving){const target=this.destination(p);
          if(!target){this.state(p,'blocked');p.moving=false;}
          else{
            if(p.candidateKey!==target.key){p.candidateKey=target.key;p.candidateTime=this.time;}
            const constrained=p.pose.scale<.99||p.side;
            const ready=obscured||Math.abs(error.x)>60||this.time-p.candidateTime>=(constrained&&!target.side&&target.distance===1.25?1:.3);
            if(ready){
              if(Math.abs(error.x)>60){this.startRecovery(p,target);}
              else{const next=copyPose(p.pose);next.position=dampVector(p.pose.position,p.velocity,target.position,dt,.25,1);next.quaternion.slerp(target.quaternion,1-Math.exp(-dt/.15));next.scale=THREE.MathUtils.lerp(p.pose.scale,target.scale,1-Math.exp(-dt/.25));
                const moved=this.collision.sweep(p.pose,next,p.size,this.viewer.position,p.id);
                if(moved.fraction<.99){this.startRecovery(p,target);}else{p.pose=moved.pose;p.side=target.side;this.state(p,'following');}
              }
            }
            if(Math.abs(error.x)<3&&Math.abs(error.y)<2&&Math.abs(error.distance-target.distance)<.03){p.moving=false;p.velocity.set(0,0,0);}
          }
        }
      }
      if(p.held){const held=p.held,input=this.inputs.get(held.owner);if(input){const point=held.direct?input.near?.clone().addScaledVector(held.direction,held.depthOffset):input.ray.at(held.distance,new THREE.Vector3());if(point){const next=copyPose(p.pose);next.quaternion=facing(p.pose.position,this.viewer.position);const target=point.clone().sub(held.localOffset.clone().multiplyScalar(p.pose.scale).applyQuaternion(next.quaternion));next.position=dampVector(p.pose.position,p.velocity,target,dt,.06,3);const moved=this.collision.move(p.pose,next,p.size,this.viewer.position,p.id);p.pose=moved.pose;if(moved.fraction<1)p.velocity.set(0,0,0);}}}
      // Keep a following panel facing the learner even while it rests inside its position dead zone.
      if(p.mode==='following'&&!p.locked&&!p.recovery){const next=copyPose(p.pose);next.quaternion.copy(facing(p.pose.position,this.viewer.position));const turned=this.collision.sweep(p.pose,next,p.size,this.viewer.position,p.id);if(turned.fraction>=.999)p.pose=turned.pose;}
      const distance=panelBox(p.pose,p.size,0).clampPoint(this.viewer.position,new THREE.Vector3()).distanceTo(this.viewer.position);
      const alpha=p.opacity*THREE.MathUtils.clamp((distance-.3)/.15,0,1);p.group.visible=alpha>0;p.view.face.material.opacity=alpha;p.view.handle.material.opacity=alpha;p.view.setOpacity?.(alpha);
      this.applyPose(p);
      if(p.dirty||p.view.dirty){p.view.paint(p);p.dirty=false;this.paintDom(p);}
    }
  }
  hit(ray,near=null){
    let best=null;
    for(const p of this.panels){if(!p.visible||!p.initialized||p.invalid||!p.group.visible||p.variant==='label')continue;
      const matrix=p.group.matrixWorld.clone().invert(),local=ray.clone().applyMatrix4(matrix),w=p.size.width,h=p.size.height;
      const point=local.intersectPlane(new THREE.Plane(new THREE.Vector3(0,0,1),0),new THREE.Vector3());
      const front=local.direction.z<0;
      if(front&&point&&Math.abs(point.x)<=w/2&&Math.abs(point.y)<=h/2){const x=(point.x/w+.5)*p.layout.width,y=(.5-point.y/h)*p.layout.height;
        const radius=p.layout.outerRadius,dx=Math.max(radius-x,x-(p.layout.width-radius),0),dy=Math.max(radius-y,y-(p.layout.height-radius),0);
        if(dx*dx+dy*dy<=radius*radius){const distance=point.clone().applyMatrix4(p.group.matrixWorld).distanceTo(ray.origin);const control=p.layout.pages[p.page].controls.find(c=>x>=c.x&&x<=c.x+c.width&&y>=c.y&&y<=c.y+c.height);const hit={panel:p,id:p.resize||p.recovery?'@surface':x>=p.layout.width-160&&y>=20&&y<=64?'@options':control?.id||'@surface',control,distance,point:ray.at(distance,new THREE.Vector3())};if(!best||distance<best.distance)best=hit;}
      }
      if(p.mode==='movable'&&!p.recovery&&!p.resize){
        const center=new THREE.Vector3(0,-h/2-.034,0),half=new THREE.Vector3(Math.max(w*.13,.075/p.pose.scale),.034/p.pose.scale,.042/p.pose.scale);
        const box=new THREE.Box3(center.clone().sub(half),center.clone().add(half));
        const hp=local.intersectBox(box,new THREE.Vector3());
        const np=near?.clone().applyMatrix4(matrix),direct=np&&box.clone().expandByScalar(.04/p.pose.scale).containsPoint(np);
        if((hp&&front)||direct){const world=direct?near:hp.clone().applyMatrix4(p.group.matrixWorld),distance=world.distanceTo(ray.origin);if(direct||(!best||distance<best.distance))best={panel:p,id:'@handle',distance,point:world,direct:!!direct};}
      }
    }
    if(best){const distance=this.collision.rayDistance(ray,best.distance,best.panel.id);if(distance<best.distance-.005)return null;}
    return best;
  }
  setInput(owner,ray,near=null){
    let input=this.inputs.get(owner);if(!input){input={};this.inputs.set(owner,input);}input.ray=ray;input.near=near;
    const hit=this.hit(ray,near);input.hit=hit;
    if(input.press&&(!hit||hit.panel!==input.press.panel||hit.id!==input.press.id)){input.press.cancelled=true;input.press.panel.pressed=null;input.press.panel.dirty=true;}
    if(input.grab&&!input.grab.direct){const g=input.grab;if(near&&g.startNear)g.distance=THREE.MathUtils.clamp(g.initialDistance+near.clone().sub(g.startNear).dot(g.direction),.45,3);}
    return hit;
  }
  begin(owner,kind='select'){
    const input=this.inputs.get(owner),hit=input?.hit;if(!hit)return false;
    const p=hit.panel;if(p.held)return true;
    // Trigger/select is a second, discoverable way to acquire the dedicated grab bar.
    // Regular panel controls still begin a press and activate only on release.
    if(hit.id==='@handle'&&(kind==='select'||kind==='grab'||kind==='pinch'||kind==='pointer')){
      if(hit.distance>3&&!hit.direct)return true;
      const g={owner,direct:hit.direct,distance:hit.distance,initialDistance:hit.distance,startNear:input.near?.clone(),direction:input.ray.direction.clone(),depthOffset:0,localOffset:p.group.worldToLocal(hit.point.clone())};p.held=g;input.grab=g;input.panel=p;p.locked++;this.state(p,'held');return true;
    }
    input.press={...hit,cancelled:kind==='grab'};p.pressed=hit.id;p.dirty=true;p.locked++;return true;
  }
  end(owner,cancel=false){
    const input=this.inputs.get(owner);if(!input)return false;let used=false;
    if(input.grab){const p=input.panel;p.held=null;p.locked=Math.max(0,p.locked-1);p.velocity.set(0,0,0);input.grab=null;input.panel=null;this.state(p,'placed');used=true;}
    if(input.press){const press=input.press,p=press.panel;p.pressed=null;p.dirty=true;p.locked=Math.max(0,p.locked-1);input.press=null;used=true;if(!cancel&&!press.cancelled&&input.hit?.panel===p&&input.hit.id===press.id)this.activate(p,press.id);}
    return used;
  }
  cancel(owner){this.end(owner,true);this.inputs.delete(owner);}
  cancelPanel(p){for(const [owner,input]of this.inputs)if(input.panel===p||input.press?.panel===p)this.end(owner,true);}
  captured(owner){const i=this.inputs.get(owner);return !!(i?.grab||i?.press);}
  changeDepth(owner,amount){const input=this.inputs.get(owner),g=input?.grab;if(!g)return;if(g.direct){g.depthOffset=THREE.MathUtils.clamp(g.depthOffset+amount,-2,2);return;}g.distance=THREE.MathUtils.clamp(g.distance+amount,.45,3);g.initialDistance=g.distance;g.startNear=input.near?.clone();}
  activate(p,id){
    if(!p.visible||p.recovery||p.invalid)return;
    if(id==='@options'){this.options(p);return;}
    if(p.savedContent){
      if(id==='panel:back'){p.pending=p.savedContent;p.savedContent=null;return;}
      if(id==='panel:recenter'){p.recenter();return;}
      if(id==='panel:close'){p.hide();return;}
      if(id==='panel:appearance'){p.setAppearance(p.appearance==='glass'?'solid':'glass');this.optionsContent(p);return;}
      if(id.startsWith('panel:mode:')){p.setMode(id.split(':')[2]);this.optionsContent(p);return;}
    }
    if(id==='@previous'){p.page=Math.max(0,p.page-1);p.dirty=true;return;}
    if(id==='@next'){p.page=Math.min(p.layout.pages.length-1,p.page+1);p.dirty=true;return;}
    const action=p.content.actions?.find(a=>a.id===id);if(action&&action.enabled!==false)p.onAction(id);
  }
  options(p){if(p.savedContent){p.pending=p.savedContent;p.savedContent=null;}else{p.savedContent=p.pending||p.content;this.optionsContent(p);}}
  optionsContent(p){p.pending={taskId:'@options',title:'Panel options',actions:[...MODES.map(mode=>({id:`panel:mode:${mode}`,label:mode==='movable'?'Grab & place':mode==='following'?'Follow me':'Anchor here',selected:p.mode===mode})),{id:'panel:appearance',label:`Surface: ${p.appearance}`},{id:'panel:recenter',label:'Recenter',enabled:p.mode!=='anchored'},...(p.savedContent?.closable?[{id:'panel:close',label:'Close panel'}]:[]),{id:'panel:back',label:'Back',primary:true}]};}
  updateHover(){
    for(const p of this.panels){const hits=[...this.inputs.values()].filter(i=>i.hit?.panel===p);const hover=hits[0]?.hit.id;if(p.hover!==hover){p.hover=hover;p.dirty=true;}p.near=hits.some(i=>i.near&&i.near.distanceTo(p.pose.position)<.55);}
  }
  recenter(){for(const p of this.panels)if(p.visible&&p.mode!=='anchored')p.recenter();}
  discontinuity(){for(const p of this.panels)if(p.visible&&p.mode==='following')p.forceRecenter=true;}
  attachDom(root){
    this.domRoot=root;const recenter=document.createElement('button');recenter.textContent='Recenter panels';recenter.onclick=()=>this.recenter();root.append(recenter);
    this.roomLabel=document.createElement('p');this.roomLabel.setAttribute('role','status');root.append(this.roomLabel);
    this.scanButton=document.createElement('button');this.scanButton.textContent='Scan room';this.scanButton.onclick=async()=>this.onStatus(await this.room.scan()?'Room capture requested':'Room capture unavailable');root.append(this.scanButton);
    for(const p of this.panels){if(p.variant==='label')continue;p.dom=document.createElement('details');root.append(p.dom);this.paintDom(p);}
  }
  paintDom(p){
    if(!p.dom)return;const key=`${p.page}/${p.mode}/${p.appearance}/${p.visible}`;if(p.domContent===p.content&&p.domKey===key)return;p.domContent=p.content;p.domKey=key;
    const open=p.dom.open,focused=p.dom.contains(document.activeElement)?document.activeElement.dataset.action:null;p.dom.replaceChildren();p.dom.open=open;let sequence=0;
    const summary=document.createElement('summary');summary.textContent=p.content.title;p.dom.append(summary);
    const button=(label,callback,id)=>{const b=document.createElement('button');b.textContent=label;b.onclick=callback;b.dataset.action=id||`@control-${sequence++}`;p.dom.append(b);return b;};
    button(p.visible?'Hide':'Show',()=>{p.visible?p.hide():p.show();this.paintDom(p);});
    for(const mode of MODES){const b=button(mode==='movable'?'Grab & place':mode==='anchored'?'Anchored':'Following',()=>{p.setMode(mode);p.show();this.paintDom(p);});b.setAttribute('aria-pressed',String(mode===p.mode));}
    button(p.appearance==='glass'?'Use solid surface':'Use glass surface',()=>{p.setAppearance(p.appearance==='glass'?'solid':'glass');});
    const text=document.createElement('p');text.textContent=[p.content.description,...p.layout.pages[p.page].items.filter(i=>i.type==='text').map(i=>i.text),p.content.footer].filter(Boolean).join('\n');p.dom.append(text);
    for(const c of p.layout.pages[p.page].controls){const b=button(c.label,()=>this.activate(p,c.id),c.id);b.disabled=c.enabled===false||(c.id==='@previous'&&p.page===0)||(c.id==='@next'&&p.page===p.layout.pages.length-1);if(c.selected!==undefined)b.setAttribute('aria-pressed',String(c.selected));}
    if(focused){const match=[...p.dom.querySelectorAll('button')].find(b=>b.dataset.action===focused);match?.focus();}
  }
  updateDomStatus(){const label=`Room collision: ${this.room.state}${this.room.state==='unavailable'?' — virtual geometry only':''}`;if(this.roomLabel&&this.roomLabel.textContent!==label)this.roomLabel.textContent=label;if(this.scanButton)this.scanButton.hidden=!this.room.canScan;}
  dispose(){for(const p of [...this.panels])p.dispose();this.room.dispose();this.inputs.clear();this.domRoot?.replaceChildren();}
}
