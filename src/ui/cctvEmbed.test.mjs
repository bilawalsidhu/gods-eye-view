import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCctvEmbed } from './cctvEmbed.js';

const camera = {
  id: 'encarnacion-sambodromo',
  name: 'Sambódromo',
  feedType: 'embed',
  embedUrl: 'https://rtsp.me/embed/3NsfyZGe/',
  sourcePageUrl: 'https://encarnacion.gov.py/en-vivo/',
};

function fixture() {
  const children = new Set();
  const container = { appendChild: (node) => children.add(node) };
  const documentImpl = {
    createElement(tag) {
      return {
        tag,
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        remove() {
          children.delete(this);
        },
      };
    },
  };
  return { children, player: createCctvEmbed(container, { documentImpl }) };
}

test('one sandboxed public player survives refreshes and unloads when hidden or deselected', () => {
  const { children, player } = fixture();
  player.update(camera, false);
  assert.equal(children.size, 0);
  player.update(camera, true);
  const [iframe, link] = [...children];
  assert.equal(iframe.tag, 'iframe');
  assert.equal(iframe.src, camera.embedUrl);
  assert.ok(iframe.attributes.sandbox.includes('allow-scripts'));
  assert.ok(!iframe.attributes.sandbox.includes('allow-top-navigation'));
  assert.equal(link.href, camera.sourcePageUrl);
  assert.equal(link.rel, 'noopener noreferrer');
  player.update(camera, true);
  assert.deepEqual([...children], [iframe, link]);
  player.update(camera, false);
  assert.equal(children.size, 0);
  player.update(camera, true);
  assert.notEqual([...children][0], iframe);
  player.update({ feedType: 'image' }, true);
  assert.equal(children.size, 0);
  player.update(camera, true);
  player.destroy();
  player.destroy();
  assert.equal(children.size, 0);
});

test('a changed player replaces the previous iframe and invalid URLs never reach the DOM', () => {
  const { children, player } = fixture();
  player.update(camera, true);
  const old = [...children][0];
  player.update(
    {
      ...camera,
      embedUrl: 'https://rtsp.me/embed/1234abcd/',
      sourcePageUrl: 'javascript:alert(1)',
    },
    true,
  );
  assert.equal(children.size, 1);
  assert.ok(!children.has(old));
  assert.equal([...children][0].src, 'https://rtsp.me/embed/1234abcd/');
  player.update({ ...camera, embedUrl: 'https://evil.test/' }, true);
  assert.equal(children.size, 0);
});
