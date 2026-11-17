// While Stories is open, GEV's document-level keys stay quiet behind it.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardStoriesKeyboard } from './keyboard.js';

function page() {
  document.body.innerHTML =
    '<div id="gev-stories"><button id="inside"></button></div><button id="gev"></button>';
  const root = document.getElementById('gev-stories');
  const heard = [];
  const gev = (event) => heard.push(`gev ${event.key}`);
  document.addEventListener('keydown', gev);
  const own = (event) => heard.push(`stories ${event.key}`);
  document.getElementById('inside').addEventListener('keydown', own);
  const windowOwn = (event) => heard.push(`window ${event.key}`);
  window.addEventListener('keydown', windowOwn, true);
  const press = (id, key) =>
    document
      .getElementById(id)
      .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  const cleanup = () => {
    document.removeEventListener('keydown', gev);
    window.removeEventListener('keydown', windowOwn, true);
  };
  return { root, heard, press, cleanup };
}

test('keys in Stories reach Stories and stop there; keys elsewhere reach nothing behind it', () => {
  const { root, heard, press, cleanup } = page();
  let open = true;
  const remove = guardStoriesKeyboard({ root, isOpen: () => open });
  press('inside', '3');
  press('gev', 'o');
  assert.deepEqual(heard, ['window 3', 'stories 3', 'window o']);
  // Closed, GEV hears its keys again.
  open = false;
  heard.length = 0;
  press('gev', 'o');
  assert.deepEqual(heard, ['window o', 'gev o']);
  remove();
  cleanup();
});

test('removing the guard lets every key through', () => {
  const { root, heard, press, cleanup } = page();
  const remove = guardStoriesKeyboard({ root, isOpen: () => true });
  remove();
  press('inside', 'h');
  assert.deepEqual(heard, ['window h', 'stories h', 'gev h']);
  cleanup();
});

test("a playing GEV scene's own on-globe controls keep their keys", () => {
  const { root, heard, cleanup } = page();
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div data-globe-overlay><button id="slider"></button></div>',
  );
  const slider = document.getElementById('slider');
  slider.addEventListener('keydown', (e) => heard.push(`slider ${e.key}`));
  const remove = guardStoriesKeyboard({ root, isOpen: () => true });
  document.body.classList.add('stories-scene');
  slider.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  );
  assert.ok(heard.includes('slider ArrowRight'));
  document.body.classList.remove('stories-scene');
  heard.length = 0;
  slider.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  );
  assert.deepEqual(heard, ['window ArrowRight'], 'no scene: GEV stays quiet');
  remove();
  cleanup();
});
