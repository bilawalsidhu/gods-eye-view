import * as THREE from 'three';
import {PanelManager} from './manager.js';
import {PanelInput,attachDesktopPanels} from './input.js';
import {labelFor,SETTINGS} from '../settings.js';

export function createPanelBench({scene,camera,renderer,brand,logo,starter,settings,onStatus}){
  const manager=new PanelManager({scene,renderer,brand,logo,onStatus});let i=0;
  // Only physical solids. Decorative plaques, rays, text and the learner's hands are excluded.
  scene.traverse(object=>{if(!object.isMesh)return;const type=object.geometry.type;
    if(type==='BoxGeometry'||type==='CylinderGeometry'||(type==='PlaneGeometry'&&object.geometry.parameters.width===20))manager.collision.registerBox(`solid-${++i}`,object);
  });
  const launchers=new Map();
  const settingsContent=()=>({taskId:'settings',eyebrow:'PREFERENCES',title:'Settings',actions:[...Object.keys(SETTINGS).map(id=>({id,label:labelFor(id,settings.get(id)),selected:settings.get(id)!==SETTINGS[id].default})),...Array.from(launchers,([id,panel])=>({id,label:`Open ${panel.content.title}`})),{id:'recenter-panels',label:'Recenter panels'}]});
  const preferences=manager.createPanel({id:'settings',mode:'anchored',pose:{position:[1.05,1.55,-1.45],quaternion:new THREE.Quaternion().setFromEuler(new THREE.Euler(0,-.62,0)).toArray()},content:settingsContent(),onAction:id=>{if(id==='recenter-panels')manager.recenter();else if(launchers.has(id)){const p=launchers.get(id);for(const other of launchers.values())if(other!==p)other.hide();p.show();p.recenter();}else settings.toggle(id);}});
  const unsubscribe=settings.subscribe(()=>preferences.setContent(settingsContent()));
  const following=manager.createPanel({id:'guide',mode:'following',content:{taskId:'guide',eyebrow:'INFORMATION',title:'Explore the demo',description:'Choose an activity to get started.',actions:[{id:'inspect',label:'Inspect an object'},{id:'controls',label:'Try the controls'},{id:'space',label:'Explore the space'}]},onAction:id=>onStatus({inspect:'Reach toward a block and grab it.',controls:'Use trigger or pinch to select. Use grip or pinch on the white bar to move a panel.',space:'Walk or teleport to test collision-aware following.'}[id])});following.hide();
  const movable=manager.createPanel({id:'movable',mode:'movable',content:{taskId:'movable',eyebrow:'GRAB & PLACE',title:'Your workspace',blocks:[{type:'paragraph',text:'Grab the white bar directly, or point at it and grab from a distance. While held, use the controller thumbstick or mouse wheel to bring the panel closer or push it away. Release to leave it in place.'}],actions:[{id:'reset',label:'Reset blocks',primary:true}]},onAction:()=>starter.resetBlocks()});movable.hide();
  const root=document.createElement('details');root.id='panel-controls';const title=document.createElement('summary');title.textContent='Information panels';root.append(title);const controls=document.createElement('div');root.append(controls);document.querySelector('#bench').prepend(root);
  const cleanup=attachDesktopPanels(renderer.domElement,camera,manager),input=new PanelInput(manager);
  launchers.set('open-guide',following);launchers.set('open-workspace',movable);preferences.setContent(settingsContent());
  return {manager,input,preferences,following,movable,controls,addLauncher(id,panel){launchers.set(id,panel);preferences.setContent(settingsContent());},mount(){manager.attachDom(controls);
    const query=new URLSearchParams(location.search),requested=manager.panels.find(p=>p.id===query.get('panel'));
    if(requested){for(const p of manager.panels)p.hide();requested.show();requested.recenter();}
    const focus=document.createElement('button');focus.id='panel-focus';focus.textContent='Focus panel view';focus.onclick=()=>{const active=document.body.classList.toggle('panel-preview');focus.textContent=active?'Show test bench':'Focus panel view';};document.body.append(focus);if(query.get('preview')==='1')focus.click();
  },dispose(){cleanup();unsubscribe();manager.dispose();root.remove();document.querySelector('#panel-focus')?.remove();}};
}
