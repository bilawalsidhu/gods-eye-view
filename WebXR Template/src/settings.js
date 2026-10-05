// User-facing scene settings: one definition per setting, one persisted store, one label format.
// Pure -- no DOM, no THREE -- so the in-scene board, the bench button and the tests all read the
// same source of truth. Storage is injected because localStorage is untrusted input: it outlives
// schema changes and can be hand-edited, so anything unrecognised falls back to the default.
export const SETTINGS={
 controllerVisual:{default:'controller',values:['controller','hand'],label:'Controller hands',words:{controller:'off',hand:'on'}},
 // Sharpest first; xr-quality.js steps toward 'smooth' when frames run long. Persisted so the
 // next session starts at the level the last one settled on -- framebuffer scale is fixed at entry.
 renderQuality:{default:'balanced',values:['sharp','balanced','smooth'],label:'Render quality'},
 // Meta's thumb microgestures (microgestures.js) on hands that report them. Off, or where the browser
 // does not report them, hands use the finger-gun and fist gestures in hand-gestures.js instead.
 microgestures:{default:'on',values:['on','off'],label:'Thumb microgestures'},
};
export const STORAGE_KEY='webxr-template:settings';

// 'Controller hands: on' -- the same wording on the board and in the bench, so a tester never has
// to map one phrasing onto the other.
export function labelFor(name,value,definitions=SETTINGS){
 const definition=definitions[name];if(!definition)throw new Error(`Unknown setting: ${name}`);
 return `${definition.label}: ${definition.words?.[value]??value}`;
}

export function createSettings({storage=globalThis.localStorage,key=STORAGE_KEY,definitions=SETTINGS}={}){
 const values={};for(const name in definitions)values[name]=definitions[name].default;
 try{
  const stored=JSON.parse(storage?.getItem(key)||'{}');
  if(stored&&typeof stored==='object')for(const name in definitions)if(definitions[name].values.includes(stored[name]))values[name]=stored[name];
 }catch{/* malformed or unavailable storage: defaults */}
 const listeners=new Set();
 const persist=()=>{try{storage?.setItem(key,JSON.stringify(values))}catch{/* private mode, quota */}};
 const snapshot=()=>({...values});
 function set(name,value){
  const definition=definitions[name];if(!definition)throw new Error(`Unknown setting: ${name}`);
  if(!definition.values.includes(value)||values[name]===value)return false;
  values[name]=value;persist();for(const listener of listeners)listener(name,value,snapshot());return true;
 }
 return {
  get:name=>values[name],
  set,
  toggle(name){const {values:options}=definitions[name];const next=options[(options.indexOf(values[name])+1)%options.length];set(name,next);return next},
  subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener)},
  snapshot,
 };
}
