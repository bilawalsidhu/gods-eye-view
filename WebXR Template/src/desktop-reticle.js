// The desktop crosshair and the click-to-play overlay. DOM rather than a sprite in the scene:
// it is a screen-space affordance, it has to stay crisp at any resolution, and it never wants to
// be occluded by the geometry it is describing.
//
// The crosshair is the aim point in the roomScale profile whether or not the mouse is captured,
// which is what lets capture be an enhancement rather than a dependency.

// Stroked, not filled, so one glyph reads on a dark workshop and a bright tabletop alike.
const GLYPHS={
 // A plain dot: something is there to look at, nothing to do with it.
 idle:'<circle cx="12" cy="12" r="1.6"/>',
 // A ring with a centre dot: a control that can be operated.
 use:'<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.4"/>',
 // An open hand: this can be picked up.
 grab:'<path d="M8 11.5V5.6a1.4 1.4 0 0 1 2.8 0v4.3m0-.5V4.6a1.4 1.4 0 0 1 2.8 0v5.3m0-.4a1.4 1.4 0 0 1 2.8 0v3.6a6 6 0 0 1-6 6h-.6a6 6 0 0 1-5-2.7l-1.5-2.4a1.4 1.4 0 0 1 2.3-1.6l1.4 1.8"/>',
 // A closed hand: you are carrying something.
 holding:'<path d="M7.6 12.4V9.6a1.4 1.4 0 0 1 2.8 0m0 0V8.8a1.4 1.4 0 0 1 2.8 0v1.3m0 0a1.4 1.4 0 0 1 2.8 0v3.3a5.8 5.8 0 0 1-11.6 0v-1.1"/>',
 // Dimmed: in view but out of reach.
 far:'<circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="12" r="6.5" stroke-dasharray="2 3"/>',
};

export const RETICLE_STATES=Object.keys(GLYPHS);

export function createReticle({container=document.body}={}){
 const root=document.createElement('div');
 root.className='desktop-reticle';root.dataset.state='idle';root.hidden=true;
 root.setAttribute('aria-hidden','true');
 root.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true">${Object.entries(GLYPHS).map(([state,path])=>`<g data-glyph="${state}">${path}</g>`).join('')}</svg><p class="desktop-reticle-label"></p><p class="desktop-reticle-hint"></p>`;
 const label=root.querySelector('.desktop-reticle-label'),hint=root.querySelector('.desktop-reticle-hint');
 container.append(root);
 let state='idle',labelText='',hintText='';
 return {
  root,
  get state(){return state},
  set(next,{label:nextLabel='',hint:nextHint=''}={}){
   if(!GLYPHS[next])throw new Error(`Unknown reticle state: ${next}`);
   if(next!==state){state=next;root.dataset.state=next}
   if(nextLabel!==labelText){labelText=nextLabel;label.textContent=nextLabel}
   if(nextHint!==hintText){hintText=nextHint;hint.textContent=nextHint}
  },
  show(visible){root.hidden=!visible},
  dispose(){root.remove()},
 };
}

// The hint that tells a learner the scene wants their mouse. Pointer lock needs a user gesture,
// and the gesture is a click on the scene itself -- so this is a prompt, not a door: it never
// takes pointer events. A full-screen button here would sit over the application's own panels
// and buttons, and a learner would have to click through it and press Esc to reach them.
// It comes back whenever capture is lost, which is also how Esc reads to the learner.
export function createCaptureOverlay({container=document.body,title='Click to play',lines=[]}={}){
 const root=document.createElement('div');
 root.className='desktop-capture';root.hidden=true;root.setAttribute('aria-hidden','true');
 root.innerHTML=`<span class="desktop-capture-title"></span><span class="desktop-capture-lines"></span>`;
 const titleNode=root.querySelector('.desktop-capture-title'),lineNode=root.querySelector('.desktop-capture-lines');
 titleNode.textContent=title;lineNode.textContent=lines.join(' · ');
 container.append(root);
 return {
  root,
  show(visible){root.hidden=!visible},
  setTitle(text){titleNode.textContent=text},
  setLines(next){lineNode.textContent=next.join(' · ')},
  dispose(){root.remove()},
 };
}
