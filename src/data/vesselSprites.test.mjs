import test from 'node:test';
import assert from 'node:assert/strict';
import { aidSprite, vesselSprite, VESSEL_SPRITE_PX } from './vesselSprites.js';
import { VESSEL_KINDS, VESSEL_KIND_STYLES, vesselKind } from './vesselTypes.js';
import { AID_TO_NAVIGATION_STYLE, accentForVesselType, vesselTypeCss } from './vesselLabels.js';

const svg = (uri) =>
  Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8');

test('vessel types pick their kind by AIS code or text family', () => {
  const cases = {
    cargo: ['70', '79', 'Container Ship', 'Bulk Carrier', 'Ro-Ro Cargo'],
    tanker: ['80', '89', 'Crude Oil Tanker', 'LNG Carrier', 'LPG'],
    passenger: ['60', '69', 'Passenger/Ferry', 'Cruise Ship'],
    highspeed: ['40', '49', 'High-Speed Craft', 'HSC'],
    fishing: ['30', 'Fishing Vessel', 'Trawler'],
    tug: ['31', '32', '50', '52', '53', '54', 'Tug', 'Pilot Vessel', 'Supply'],
    sailing: ['36', 'Sailing Vessel'],
    pleasure: ['37', 'Pleasure Craft', 'Yacht'],
    military: ['35', '55', '51', 'Military', 'Law Enforcement', 'Coast Guard', 'SAR'],
    other: ['0', '20', '33', '34', '58', '90', 'Dredger', '', null, undefined, '255'],
  };
  for (const [kind, types] of Object.entries(cases))
    for (const type of types) assert.equal(vesselKind(type), kind, String(type));
  assert.deepEqual(new Set(Object.keys(cases)), new Set(VESSEL_KINDS));
});

test('each vessel kind has its own white hull sprite, bow up', () => {
  const sprites = VESSEL_KINDS.map(vesselSprite);
  assert.equal(new Set(sprites).size, VESSEL_KINDS.length);
  for (const uri of sprites) {
    const text = svg(uri);
    assert.match(text, new RegExp(`width="${VESSEL_SPRITE_PX}"`));
    assert.match(text, /viewBox="0 0 96 96"/);
    // Drawn white for the tint; nothing baked in colour.
    assert.match(text, /fill="white"/);
    assert.doesNotMatch(text, /#[0-9a-f]{6}/i);
  }
  assert.equal(vesselSprite('unknown'), vesselSprite('other'));
});

test('vessel colours: one per kind, the new kinds apart from the rest', () => {
  const css = VESSEL_KINDS.map((kind) => VESSEL_KIND_STYLES[kind].css);
  // Only cargo and other share the default cyan.
  assert.equal(new Set(css).size, VESSEL_KINDS.length - 1);
  assert.equal(VESSEL_KIND_STYLES.cargo.css, VESSEL_KIND_STYLES.other.css);
  for (const kind of ['sailing', 'pleasure', 'military', 'highspeed']) {
    const own = VESSEL_KIND_STYLES[kind].css;
    for (const other of VESSEL_KINDS)
      if (other !== kind) assert.notEqual(own, VESSEL_KIND_STYLES[other].css, `${kind} vs ${other}`);
    assert.notEqual(own, AID_TO_NAVIGATION_STYLE.css);
  }
  // The sprite tint and the card accent are the same colour.
  for (const [type, kind] of [['36', 'sailing'], ['37', 'pleasure'], ['55', 'military'], ['41', 'highspeed'], ['71', 'cargo']]) {
    const { css: hex, accent } = VESSEL_KIND_STYLES[kind];
    assert.equal(vesselTypeCss(type), hex);
    assert.equal(accentForVesselType(type), accent);
    const rgb = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ');
    assert.equal(accent, rgb, kind);
  }
});

test('an aid to navigation is the one buoy sprite, white with no halo', () => {
  const text = svg(aidSprite());
  assert.equal(aidSprite(), aidSprite());
  assert.ok(!VESSEL_KINDS.map(vesselSprite).includes(aidSprite()));
  assert.match(text, /fill="white"/);
  // No light halo stroke around it.
  assert.doesNotMatch(text, /rgba\(235,240,245/);
  assert.doesNotMatch(text, /#[0-9a-f]{6}/i);
});
