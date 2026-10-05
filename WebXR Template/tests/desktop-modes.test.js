import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopModes} from '../src/desktop-modes.js';

const fixture=()=>{
 const changes=[];
 const modes=createDesktopModes({onChange:(next,previous)=>changes.push({next,previous})});
 modes.register('multimeter',{label:'Multimeter',key:'KeyM'});
 modes.register('panel',{label:'Panel',key:'KeyP',lockMove:true,lockLook:false});
 return {modes,changes};
};

test('no mode means the profile decides, and a mode states what it needs',()=>{
 const {modes}=fixture();
 assert.deepEqual(modes.state(),{mode:null,lookLocked:false,moveLocked:false,pointer:null,suppressed:false});
 modes.set('multimeter');
 assert.deepEqual(modes.state(),{mode:'multimeter',lookLocked:true,moveLocked:true,pointer:'cursor',suppressed:false});
 // A mode that only pins you in place still lets you look around.
 modes.set('panel');
 assert.equal(modes.state().lookLocked,false);
 assert.equal(modes.state().moveLocked,true);
});

test('one mode at a time, and an unchanged set is a no-op rather than an enter/exit cycle',()=>{
 const {modes,changes}=fixture();
 assert.equal(modes.set('multimeter'),true);
 assert.equal(modes.set('multimeter'),false,'setting the mode that is already up changes nothing');
 assert.equal(changes.length,1);
 assert.equal(modes.set('panel'),true,'switching replaces rather than stacking');
 assert.equal(modes.active,'panel');
 assert.equal(modes.clear(),true);
 assert.equal(modes.active,null);
 assert.equal(modes.clear(),false);
 assert.equal(changes.length,3);
 assert.deepEqual(changes.at(-1).previous.mode,'panel','the callback sees what it came from');
});

test('toggle turns a mode on, off, and out of another mode',()=>{
 const {modes}=fixture();
 assert.equal(modes.toggle('multimeter'),'multimeter');
 assert.equal(modes.toggle('multimeter'),null,'the same key backs out');
 modes.set('panel');
 assert.equal(modes.toggle('multimeter'),'multimeter','and a different one switches across');
});

test('suppressors freeze input whether or not a mode is up, and overlap without cancelling',()=>{
 const {modes}=fixture();
 modes.suppress('menu');
 assert.equal(modes.state().lookLocked,true);
 assert.equal(modes.state().moveLocked,true);
 assert.equal(modes.state().mode,null,'a suppressor is not a mode');
 // Two overlapping freezes: a dialog opened over an already-open menu must not lift the freeze
 // when only the dialog closes. This is the desync the shared lock exists to prevent.
 modes.suppress('dialog');
 assert.equal(modes.suppress('dialog',false),false,'still suppressed, so nothing the caller acts on changed');
 assert.equal(modes.state().lookLocked,true);
 assert.equal(modes.suppress('menu',false),true);
 assert.equal(modes.state().lookLocked,false);
 assert.equal(modes.suppress('menu',false),false,'lifting a freeze that is not held is a no-op');
});

test('a suppressor lifting does not unfreeze a mode that wants the freeze',()=>{
 const {modes}=fixture();
 modes.set('multimeter');modes.suppress('menu');
 modes.suppress('menu',false);
 assert.equal(modes.state().lookLocked,true,'the multimeter still has you standing still');
 assert.equal(modes.state().suppressed,false);
});

test('keys map to modes so a shortcut never needs a second lookup table',()=>{
 const {modes}=fixture();
 assert.equal(modes.byKey('KeyM'),'multimeter');
 assert.equal(modes.byKey('KeyQ'),null);
 assert.deepEqual(modes.list().map(m=>m.id),['multimeter','panel'],'registration order, for a stable button row');
 assert.equal(modes.definition('multimeter').label,'Multimeter');
 assert.equal(modes.definition('nope'),null);
 assert.equal(modes.definition(null),null);
});

test('registration and selection fail fast rather than silently doing nothing',()=>{
 const modes=createDesktopModes();
 modes.register('multimeter',{key:'KeyM'});
 assert.throws(()=>modes.register('multimeter'),/already registered/);
 assert.throws(()=>modes.register('other',{key:'KeyM'}),/key already bound/);
 assert.throws(()=>modes.register(''),/string id/);
 assert.throws(()=>modes.set('typo'),/Unknown desktop mode/);
 assert.throws(()=>modes.suppress(''),/needs a name/);
 assert.equal(modes.set(null),false,'clearing when nothing is active is allowed');
});
