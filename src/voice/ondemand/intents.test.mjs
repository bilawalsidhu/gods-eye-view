import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchLayerIntents,
  classifyRoute,
  localConfirmation,
  extractMapActions,
  LAYER_INTENTS,
} from './intents.js';

const ids = (text) => matchLayerIntents(text).map((i) => `${i.layerId}:${i.enabled ? 'on' : 'off'}`);

test('"show military flights near me" enables ONLY the military layer (not the generic flights layer)', () => {
  const intents = matchLayerIntents('Show military flights near me');
  assert.deepEqual(
    intents.map(({ layerId, enabled, label }) => ({ layerId, enabled, label })),
    [{ layerId: 'military', enabled: true, label: 'military flights' }],
  );
});

test('enable / disable verbs map every supported layer family to its DATA LAYERS id', () => {
  assert.deepEqual(ids('turn on live flights'), ['flights:on']);
  assert.deepEqual(ids('enable aircraft'), ['flights:on']);
  assert.deepEqual(ids('show me the planes in the scene'), ['flights:on']);
  assert.deepEqual(ids('hide vessels'), ['ais-live-vessels:off']);
  assert.deepEqual(ids('turn off ships'), ['ais-live-vessels:off']);
  assert.deepEqual(ids('display satellites'), ['satellites:on']);
  assert.deepEqual(ids('show traffic'), ['traffic:on']);
  assert.deepEqual(ids('switch on transit'), ['transit:on']);
  assert.deepEqual(ids('turn on bikeshare'), ['bikeshare:on']);
  assert.deepEqual(ids('disable bikes'), ['bikeshare:off']);
  assert.deepEqual(ids('turn off military'), ['military:off']);
});

test('multiple clauses carry their own verb; a bare clause inherits the previous verb', () => {
  assert.deepEqual(ids('turn off the flights and show ships'), [
    'flights:off',
    'ais-live-vessels:on',
  ]);
  assert.deepEqual(ids('hide satellites, enable transit and bikeshare please'), [
    'satellites:off',
    'transit:on',
    'bikeshare:on',
  ]);
});

test('"air traffic" is flights, never the road-traffic layer; questions without a verb produce no intent', () => {
  assert.deepEqual(ids('show air traffic'), ['flights:on']);
  assert.deepEqual(ids('what is the air traffic like here'), []);
  assert.deepEqual(ids('how many vessels are nearby'), []);
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids(null), []);
});

test('layer ids are the panel ids the layer manager registers', () => {
  assert.deepEqual(
    LAYER_INTENTS.map((i) => i.layerId),
    ['military', 'flights', 'ais-live-vessels', 'satellites', 'traffic', 'transit', 'bikeshare'],
  );
});

test('classifyRoute: spatial tasks default to the workflow route, small talk to chat', () => {
  assert.equal(classifyRoute('show military flights near me'), 'workflow');
  assert.equal(classifyRoute('what is happening overhead'), 'workflow');
  assert.equal(classifyRoute('track the nearest vessel'), 'workflow');
  assert.equal(classifyRoute('fly to Kathmandu'), 'workflow');
  assert.equal(classifyRoute('tell me a joke'), 'chat');
  assert.equal(classifyRoute('who are you'), 'chat');
  assert.equal(classifyRoute('thanks'), 'chat');
  assert.equal(classifyRoute(''), 'chat');
});

test('localConfirmation reads back what was toggled, naming failures', () => {
  const intents = matchLayerIntents('show military flights and hide ships');
  assert.equal(localConfirmation(intents), 'Military flights layer on. Live vessels layer off.');
  assert.equal(
    localConfirmation(intents, { failed: [{ layerId: 'ais-live-vessels' }] }),
    'Military flights layer on. Live vessels layer could not be changed.',
  );
  assert.equal(localConfirmation([]), '');
});

test('extractMapActions: trailing MAPACTIONS line, fenced JSON, bare JSON object, malformed → dropped', () => {
  const line = extractMapActions(
    'Two military tracks are up.\nMAPACTIONS: [{"name":"set_layer_visibility","args":{"layerId":"military","enabled":true}}]',
  );
  assert.equal(line.text, 'Two military tracks are up.');
  assert.deepEqual(line.mapActions, [
    { name: 'set_layer_visibility', args: { layerId: 'military', enabled: true } },
  ]);

  const fenced = extractMapActions(
    'Here you go.\n```json\n{"message":"Framing the port.","mapActions":[{"name":"frame_overhead","args":{}}]}\n```',
  );
  assert.equal(fenced.text, 'Here you go.\nFraming the port.');
  assert.deepEqual(fenced.mapActions, [{ name: 'frame_overhead', args: {} }]);

  const bare = extractMapActions(
    '{"message":"Flying there now.","actions":[{"name":"fly_to_location","params":{"latitude":1,"longitude":2}}]}',
  );
  assert.equal(bare.text, 'Flying there now.');
  assert.equal(bare.mapActions[0].name, 'fly_to_location');

  // Malformed JSON: no actions, and the broken line is never spoken either.
  const malformed = extractMapActions('Sure.\nMAPACTIONS: [{"name": oops]');
  assert.equal(malformed.text, 'Sure.');
  assert.deepEqual(malformed.mapActions, []);

  assert.deepEqual(extractMapActions(''), { text: '', mapActions: [] });
});
