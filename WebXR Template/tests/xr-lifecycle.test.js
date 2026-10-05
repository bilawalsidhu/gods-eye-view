import test from 'node:test';import assert from 'node:assert/strict';
import {watchSession} from '../src/xr-lifecycle.js';
function fakeSession(){
 const session=new EventTarget();session.visibilityState='visible';session.ends=0;
 session.end=async()=>{session.ends++;if(session.over)throw new DOMException('already ended','InvalidStateError');session.over=true;session.dispatchEvent(new Event('end'))};
 session.show=state=>{session.visibilityState=state;session.dispatchEvent(new Event('visibilitychange'))};
 return session;
}
function fakePage(){const page=new EventTarget();page.document=new EventTarget();return page}
test('visible follows the system menu, and each change is reported once',()=>{
 const session=fakeSession(),seen=[];
 const life=watchSession(session,{onVisibility:state=>seen.push(state),page:fakePage()});
 assert.equal(life.visible,true);
 session.show('visible-blurred');assert.equal(life.visible,false);assert.equal(life.state,'visible-blurred');
 session.show('visible-blurred');session.show('hidden');session.show('visible');
 assert.deepEqual(seen,['visible-blurred','hidden','visible']);assert.equal(life.visible,true);
});
test('end is idempotent and quiet when the runtime already ended the session',async()=>{
 const session=fakeSession(),life=watchSession(session,{page:fakePage()});
 await Promise.all([life.end(),life.end()]);
 assert.equal(session.ends,1);assert.equal(life.ended,true);assert.equal(life.visible,false);
 await life.end();assert.equal(session.ends,1);
 const quit=fakeSession(),other=watchSession(quit,{page:fakePage()});
 await quit.end();await other.end();assert.equal(quit.ends,1,'a session ended by Quit is not ended twice');
});
test('closing or freezing the page ends the session, and nothing listens once it has',async()=>{
 for(const [target,type]of [['page','pagehide'],['document','freeze']]){
  const session=fakeSession(),page=fakePage(),life=watchSession(session,{page});
  (target==='page'?page:page.document).dispatchEvent(new Event(type));
  await life.end();
  assert.equal(session.ends,1);assert.equal(life.ended,true);
  page.dispatchEvent(new Event('pagehide'));page.document.dispatchEvent(new Event('freeze'));
  await Promise.resolve();assert.equal(session.ends,1);
 }
});
test('a session with no visibilityState is treated as visible, and a page without events is tolerated',()=>{
 const session=fakeSession();delete session.visibilityState;
 const life=watchSession(session,{page:{}});
 assert.equal(life.visible,true);
});
