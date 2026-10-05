// What a session does when the headset's system menu opens over it, and when the page is closed
// underneath it. Two failures this guards against, both seen as a Quest Browser whose Resume and
// Quit buttons stop answering while its banner stays on screen:
//
// - Heavy work while the menu is up. With the system menu open the session is 'visible-blurred'
//   (or 'hidden'), frames arrive slower or not at all, and a frame-time watch reads that as a page
//   running long. Stepping render quality down there recompiles every material and reallocates the
//   shadow map on the main thread at the one moment the browser needs it to answer the menu. The
//   page asks `visible` before it samples frame time, and resets its sampling when focus returns.
// - A page that goes away with its session still open. Closing the tab or the browser, or the
//   browser freezing a backgrounded page, leaves the compositor waiting on a session nothing will
//   end. pagehide and freeze end it here, so the runtime is released before the page is.
//
// end() is the one way the page ends a session: calling it twice, or after the runtime has already
// ended the session (Quit, a lost device), is a no-op rather than an InvalidStateError.
export function watchSession(session,{onVisibility,page=globalThis}={}){
 let state=session.visibilityState??'visible',ended=false,ending=null;
 const doc=page.document;
 const end=()=>{
  if(ended)return Promise.resolve();
  ending??=Promise.resolve().then(()=>session.end()).catch(()=>{});
  return ending;
 };
 const leave=()=>{end()};
 const changed=()=>{
  const next=session.visibilityState??'visible';
  if(next===state)return;
  state=next;onVisibility?.(next);
 };
 const finished=()=>{
  ended=true;
  session.removeEventListener?.('visibilitychange',changed);
  page.removeEventListener?.('pagehide',leave);doc?.removeEventListener?.('freeze',leave);
 };
 session.addEventListener('visibilitychange',changed);
 session.addEventListener('end',finished,{once:true});
 page.addEventListener?.('pagehide',leave);doc?.addEventListener?.('freeze',leave);
 return {
  // True only while the page has the user's attention: not blurred by a system menu, not hidden.
  get visible(){return !ended&&state==='visible'},
  get state(){return ended?'ended':state},
  get ended(){return ended},
  end,
 };
}
