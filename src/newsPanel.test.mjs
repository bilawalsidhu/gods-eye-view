// Live news dock: channel lookup and embed URL shape. Pure, no DOM, no network.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEWS_CHANNELS, findNewsChannel, embedUrlFor } from './newsPanel.js';

test('every channel has a unique id and a YouTube channel id', () => {
  const ids = new Set();
  for (const c of NEWS_CHANNELS) {
    assert.match(c.channel, /^UC[\w-]{22}$/, `${c.label} channel id`);
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
  }
});

test('findNewsChannel resolves ids, exact labels, and loose names', () => {
  assert.equal(findNewsChannel('sky')?.id, 'sky');
  assert.equal(findNewsChannel('Sky News')?.id, 'sky');
  assert.equal(findNewsChannel('al jazeera')?.id, 'aje');
  assert.equal(findNewsChannel('the fox news channel')?.id, 'fox');
  assert.equal(findNewsChannel(''), null);
  assert.equal(findNewsChannel('no such network'), null);
});

test('embedUrlFor prefers a resolved live video id over the channel form', () => {
  const aje = findNewsChannel('aje');
  const byChannel = new URL(embedUrlFor(aje));
  assert.equal(byChannel.pathname, '/embed/live_stream');
  assert.equal(byChannel.searchParams.get('channel'), aje.channel);
  assert.equal(byChannel.searchParams.get('autoplay'), '1');

  const byVideo = new URL(embedUrlFor(aje, { videoId: 'gCNeDWCI0vo', autoplay: false }));
  assert.equal(byVideo.pathname, '/embed/gCNeDWCI0vo');
  assert.equal(byVideo.searchParams.get('channel'), null);
  assert.equal(byVideo.searchParams.get('autoplay'), '0');
});
