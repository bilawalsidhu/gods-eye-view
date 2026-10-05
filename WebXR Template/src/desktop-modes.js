// Desktop interaction modes: the states a desktop learner can be in that are not "walking around
// looking at things" -- reading an instrument, working a panel. One mode at a time, and the mode
// says what it needs from the input layer rather than reaching into it.
//
// Pure -- no DOM, no three -- so tests/desktop-modes.test.js exercises the whole transition table
// in bare node. The interaction layer reads state() each frame and does as it is told; it never
// has to know which modes exist.
//
// `suppressors` exist because an application usually already has something that freezes input: a
// lab menu, a modal dialog, a loading screen. Those must feed the same derived lock as a mode or
// the two disagree and a menu closes into a half-frozen scene.

// What a mode is allowed to ask for. `pointer` is what the mouse should be doing: 'cursor' means
// the learner needs to click things, 'locked' means keep it captured for look. A mode that names
// neither leaves the profile's own choice alone.
const DEFAULTS={label:'',key:null,lockLook:true,lockMove:true,pointer:'cursor'};

export function createDesktopModes({onChange=null}={}){
 const modes=new Map(),keys=new Map(),suppressors=new Set();
 let active=null;
 const definition=id=>id===null?null:modes.get(id)??null;
 const state=()=>{
  const mode=definition(active),suppressed=suppressors.size>0;
  return {
   mode:active,
   // A suppressor freezes look and movement whether or not a mode is up, so the caller has one
   // value to test rather than a mode check and a menu check that can drift apart.
   lookLocked:suppressed||!!mode?.lockLook,
   moveLocked:suppressed||!!mode?.lockMove,
   pointer:mode?.pointer??null,
   suppressed,
  };
 };
 let last=state();
 const announce=()=>{const next=state();const changed=Object.keys(next).some(k=>next[k]!==last[k]);const previous=last;last=next;if(changed)onChange?.(next,previous);return changed};
 return {
  register(id,options={}){
   if(!id||typeof id!=='string')throw new Error('A desktop mode needs a string id');
   if(modes.has(id))throw new Error(`Desktop mode already registered: ${id}`);
   const mode={...DEFAULTS,...options,id};
   if(mode.key){if(keys.has(mode.key))throw new Error(`Desktop mode key already bound: ${mode.key} (${keys.get(mode.key)})`);keys.set(mode.key,id)}
   modes.set(id,mode);return mode;
  },
  definition,
  list:()=>[...modes.values()],
  byKey:code=>keys.get(code)??null,
  get active(){return active},
  // Returns whether anything the caller acts on actually changed, so an unchanged set() is a
  // cheap no-op rather than a spurious enter/exit cycle.
  set(id){
   if(id!==null&&!modes.has(id))throw new Error(`Unknown desktop mode: ${id}`);
   if(active===id)return false;
   active=id;return announce();
  },
  toggle(id){this.set(active===id?null:id);return active},
  clear(){return this.set(null)},
  // An application hands in a reason rather than a boolean, so two overlapping freezes (a dialog
  // opened over an already-open menu) do not cancel each other when the first one lifts.
  suppress(reason,on=true){
   if(!reason)throw new Error('A suppressor needs a name');
   const had=suppressors.has(reason);
   if(on===had)return false;
   if(on)suppressors.add(reason);else suppressors.delete(reason);
   return announce();
  },
  suppressed:()=>suppressors.size>0,
  state,
 };
}
