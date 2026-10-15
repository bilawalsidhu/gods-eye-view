import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCctvEmbed } from './cctvEmbed.js';

const camera = {
  id: 'youtube-buenos-aires',
  name: 'Buenos Aires',
  feedType: 'embed',
  embedUrl: 'https://www.youtube-nocookie.com/embed/r8Busmkpsh8?playsinline=1',
  sourcePageUrl: 'https://www.youtube.com/watch?v=r8Busmkpsh8',
};

function fixture() {
  const children = new Set();
  const container = { appendChild: (node) => children.add(node) };
  const documentImpl = {
    location: { hostname: 'localhost' },
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

test('Twitch uses the document host and provider controls, then unloads on switch', () => {
  const { children, player } = fixture();
  const twitch = {
    ...camera,
    embedUrl:
      'https://player.twitch.tv/?channel=tucumanturismo02&parent=evil.test',
    sourcePageUrl: '',
  };
  player.update(twitch, true);
  const [iframe, link] = [...children];
  const url = new URL(iframe.src);
  assert.deepEqual(url.searchParams.getAll('parent'), ['localhost']);
  assert.equal(url.searchParams.get('autoplay'), 'false');
  assert.equal(url.searchParams.get('muted'), 'true');
  assert.match(iframe.className, /cctv-embed-twitch/);
  assert.equal(link.href, 'https://www.twitch.tv/tucumanturismo02');
  player.update(twitch, true);
  assert.deepEqual([...children], [iframe, link]);
  player.update(camera, true);
  assert.ok(!children.has(iframe));
  assert.equal([...children][0].className, 'cctv-embed');
  player.update(twitch, false);
  assert.equal(children.size, 0);
});

test('a changed player replaces the previous iframe and invalid URLs never reach the DOM', () => {
  const { children, player } = fixture();
  player.update(camera, true);
  const old = [...children][0];
  player.update(
    {
      ...camera,
      embedUrl:
        'https://www.youtube-nocookie.com/embed/NfsyRx50gAI?playsinline=1',
      sourcePageUrl: 'javascript:alert(1)',
    },
    true,
  );
  assert.equal(children.size, 2);
  assert.ok(!children.has(old));
  assert.equal(
    [...children][0].src,
    'https://www.youtube-nocookie.com/embed/NfsyRx50gAI?playsinline=1',
  );
  assert.equal(
    [...children][1].href,
    'https://www.youtube.com/watch?v=NfsyRx50gAI',
  );
  player.update({ ...camera, embedUrl: 'https://evil.test/' }, true);
  assert.equal(children.size, 0);
});

test('YouTube uses its public player, keeps the referrer and offers a source link when embedding fails', () => {
  const { children, player } = fixture();
  const youtube = {
    ...camera,
    name: 'Buenos Aires',
    embedUrl: 'https://youtu.be/r8Busmkpsh8?si=tracking',
    sourcePageUrl: '',
  };
  player.update(youtube, true);
  const [iframe, link] = [...children];
  assert.equal(
    iframe.src,
    'https://www.youtube-nocookie.com/embed/r8Busmkpsh8?playsinline=1',
  );
  assert.equal(iframe.title, 'Buenos Aires — public player');
  assert.equal(iframe.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(link.href, 'https://www.youtube.com/watch?v=r8Busmkpsh8');
  player.update(
    { ...youtube, embedUrl: 'https://www.youtube.com/live/r8Busmkpsh8' },
    true,
  );
  assert.deepEqual([...children], [iframe, link]);
  player.update(
    { ...youtube, sourcePageUrl: 'https://www.uade.edu.ar/' },
    true,
  );
  assert.equal(link.href, 'https://www.uade.edu.ar/');
  assert.equal([...children][0], iframe);
  player.update(
    { ...camera, embedUrl: 'https://www.youtube.com/live/NfsyRx50gAI' },
    true,
  );
  assert.equal(children.has(iframe), false);
  assert.equal(
    [...children][0].src,
    'https://www.youtube-nocookie.com/embed/NfsyRx50gAI?playsinline=1',
  );
  player.destroy();
  assert.equal(children.size, 0);
});
