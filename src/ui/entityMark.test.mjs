// Context marks an item with the sprite the map draws it with: an aircraft by
// its class, an airport vehicle, a vessel by its type, an aid to navigation
// by its buoy. Layers that draw no sprite per kind (fires, places, cameras)
// keep their glyph. The sprite is a mask over the text colour, one em square.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../testSupport/vueDom.mjs';
import { aircraftIcon } from '../data/aircraftIcons.js';
import { aidSprite, vesselSprite } from '../data/vesselSprites.js';
import {
  AID_MARK,
  markKind,
  markSprite,
  markStyle,
  spriteKind,
} from './entityMark.js';

let mount;
let EntityMark;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  EntityMark = (await import('./views/panels/EntityMark.vue')).default;
});
after(() => uninstall());

test('an item takes its kind from its layer record', () => {
  assert.equal(
    markKind('flights', { aircraftClass: 'helicopter', typeCode: 'B738' }),
    'helicopter',
  );
  assert.equal(
    markKind('flights', { typeCode: 'B738', category: null }),
    'airliner',
  );
  assert.equal(markKind('local-adsb', { typeCode: 'ZVEH' }), 'vehicle');
  assert.equal(markKind('military', { type: 'EC35' }), 'helicopter');
  assert.equal(markKind('ais-live-vessels', { type: '84' }), 'tanker');
  assert.equal(markKind('ais-live-vessels', { shipType: 'Cargo' }), 'cargo');
  assert.equal(
    markKind('ais-live-vessels', { mmsi: '993456789', type: '' }),
    AID_MARK,
  );
  assert.equal(markKind('local-firms', { brightness: 330 }), '');
  assert.equal(markKind('flights', null), '');
});

test('an airliner, a helicopter, a vessel type and a ground vehicle each get their own sprite', () => {
  const sprites = {
    airliner: markSprite('flights', 'airliner'),
    helicopter: markSprite('military', 'helicopter'),
    tanker: markSprite('ais-live-vessels', 'tanker'),
    vehicle: markSprite('local-adsb', 'vehicle'),
  };
  assert.equal(sprites.airliner, aircraftIcon('airliner'));
  assert.equal(sprites.helicopter, aircraftIcon('helicopter'));
  assert.equal(sprites.tanker, vesselSprite('tanker'));
  assert.equal(sprites.vehicle, aircraftIcon('vehicle'));
  for (const uri of Object.values(sprites))
    assert.match(uri, /^data:image\/svg\+xml;base64,/);
  assert.equal(new Set(Object.values(sprites)).size, 4, 'four sprites');
  assert.equal(markSprite('ais-live-vessels', AID_MARK), aidSprite());
  // What the map draws for a kind it does not know.
  assert.equal(spriteKind('flights', 'tr3b'), 'airliner');
  assert.equal(spriteKind('ais-live-vessels', ''), 'other');
});

test('each sprite mounts as its own mask', () => {
  const uris = [
    ['flights', 'airliner'],
    ['flights', 'helicopter'],
    ['ais-live-vessels', 'passenger'],
    ['local-adsb', 'vehicle'],
  ].map(([layer, kind]) => {
    const wrapper = mount(EntityMark, { props: { layer, kind } });
    const mark = wrapper.get('.entity-mark');
    assert.equal(mark.attributes('aria-hidden'), 'true');
    assert.equal(mark.attributes('data-mark'), kind);
    assert.equal(mark.text(), '', 'no glyph text');
    assert.ok(!mark.classes().includes('material-symbols-outlined'));
    const style = mark.attributes('style') || '';
    assert.match(style, /background-color:\s*currentcolor/i);
    assert.match(style, /width:\s*1em;\s*height:\s*1em/);
    const uri = /mask-image:\s*url\("?([^")]+)/.exec(style)?.[1] || '';
    wrapper.unmount();
    return uri;
  });
  assert.equal(new Set(uris).size, 4);
  assert.ok(uris.every((uri) => uri.startsWith('data:image/svg+xml;')));
});

test('a fire, a place and a camera keep their layer glyph', () => {
  for (const [layer, glyph] of [
    ['local-firms', 'local_fire_department'],
    ['osm-places', 'location_on'],
    ['cctv', 'videocam'],
  ]) {
    assert.equal(markSprite(layer, 'airliner'), '', layer);
    const wrapper = mount(EntityMark, { props: { layer } });
    const icon = wrapper.get('.entity-mark');
    assert.ok(icon.classes().includes('ui-icon'), layer);
    assert.ok(icon.classes().includes('entity-mark--glyph'), layer);
    assert.equal(icon.text(), glyph, layer);
    assert.equal(icon.attributes('aria-hidden'), 'true', layer);
    assert.equal(icon.attributes('style'), undefined, 'sized by its row');
    wrapper.unmount();
  }
  // A card's own glyph wins over its layer's.
  const wrapper = mount(EntityMark, {
    props: { layer: 'cctv', icon: 'streetview', size: 14 },
  });
  assert.equal(wrapper.text(), 'streetview');
  assert.match(wrapper.get('.entity-mark').attributes('style'), /14px/);
  wrapper.unmount();
});

test('the mask is drawn in currentColor, one em square', () => {
  const uri = markSprite('flights', 'glider');
  const style = markStyle(uri);
  assert.equal(style.backgroundColor, 'currentColor');
  assert.equal(style.width, '1em');
  assert.equal(style.height, '1em');
  assert.equal(style.fontSize, undefined, 'the font size around it');
  for (const prefix of ['mask', 'WebkitMask']) {
    assert.equal(style[`${prefix}Image`], `url("${uri}")`);
    assert.equal(style[`${prefix}Size`], 'contain');
    assert.equal(style[`${prefix}Repeat`], 'no-repeat');
    assert.equal(style[`${prefix}Position`], 'center');
  }
  assert.equal(markStyle(uri, 16).fontSize, '16px');
  // No colour of its own: it is tinted with the text around it.
  const { maskImage, WebkitMaskImage, ...rest } = style;
  assert.doesNotMatch(JSON.stringify(rest), /#[0-9a-f]{3,8}\b|rgb|hsl/i);
});
