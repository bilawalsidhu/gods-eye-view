import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createImageryGround } from '../../recentImagery/render/navaraGround.js';
import { createEarthquakesNavaraRenderer } from '../../earthquakes/render/navara.js';
import { createGroundCellDisplay } from './navaraGroundCells.js';

// EffectDesc gives insertAfter priority, then tries insertBefore. Check the
// actual renderer declarations under every activation order, including the
// minimal look, whose pipeline has no toneMapping anchor.
const declarations = [
  'gevRecentImagery',
  'gevNepalEvent',
  'gevObservedWeather',
  'gevEarthquakeGround',
  'gevFirmsGround',
  'gevPreSharpenOverlay',
];
// The descriptor a renderer registers; its setup stops there.
const stop = new Error('registered');
function registered(create) {
  let spec;
  const view = {
    camera: {},
    registerEffect(key, Desc) {
      spec = { key, after: Desc.insertAfter, before: Desc.insertBefore };
      throw stop;
    },
  };
  try {
    create({ view, EffectDesc: class {}, NavaraEffect: class {} });
  } catch (error) {
    if (error !== stop) throw error;
  }
  return spec;
}
async function declared(key, path, className) {
  let source = await fs.readFile(new URL(path, import.meta.url), 'utf8');
  if (className) source = source.split(`class ${className}`)[1];
  const anchors = (name) =>
    [
      ...source
        .match(new RegExp(`static ${name} = \\[([^\\]]*)\\]`))[1]
        .matchAll(/'([^']+)'/g),
    ].map((m) => m[1]);
  return { key, after: anchors('insertAfter'), before: anchors('insertBefore') };
}
const specs = [
  registered((sdk) => createImageryGround({}, sdk, {})),
  registered((sdk) => createImageryGround({}, sdk, {}, 'gevNepalEvent')),
  await declared('gevObservedWeather', '../../weather/render/navaraSurface.js'),
  registered((sdk) => createEarthquakesNavaraRenderer({ render: {} }, sdk)),
  registered((sdk) => createGroundCellDisplay({}, sdk, 0)),
  await declared(
    'gevPreSharpenOverlay',
    '../../../globe/navara/overlay.js',
    'GevPreSharpenOverlayEffectDesc',
  ),
];
const permutations = (items) =>
  items.length
    ? items.flatMap((item, i) =>
        permutations(items.filter((_, j) => i !== j)).map((rest) => [
          item,
          ...rest,
        ]),
      )
    : [[]];

test('all ground/glyph activation orders preserve imagery, classification and marker stages', () => {
  for (const toneMapping of [false, true])
    for (const activation of permutations(specs)) {
      const order = [
        'mrt',
        ...(toneMapping ? ['toneMapping'] : []),
        'gevSharpen',
        'smaa',
        'gevOverlay',
        'final',
      ];
      for (const spec of activation) {
        const after = spec.after.find((key) => order.includes(key));
        const before = spec.before.find((key) => order.includes(key));
        const index = after
          ? order.indexOf(after) + 1
          : before
            ? order.indexOf(before)
            : order.length;
        order.splice(index, 0, spec.key);
      }
      assert.deepEqual(
        order.filter((key) => specs.some((s) => s.key === key)),
        declarations,
        `${toneMapping}: ${activation.map((s) => s.key)}`,
      );
    }
});
