import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// EffectDesc gives insertAfter priority, then tries insertBefore. Check the
// actual renderer declarations under every activation order, including the
// minimal look, whose pipeline has no toneMapping anchor.
const declarations = ['gevImagery', 'gevGround', 'gevPreSharpenOverlay'];
async function declared(key, path, className) {
  let source = await fs.readFile(new URL(path, import.meta.url), 'utf8');
  if (className) source = source.split(`class ${className}`)[1];
  const anchors = (name) =>
    [
      ...source
        .match(new RegExp(`static ${name} = \\[([^\\]]*)\\]`))[1]
        .matchAll(/'([^']+)'/g),
    ].map((m) => m[1]);
  return {
    key,
    after: anchors('insertAfter'),
    before: anchors('insertBefore'),
  };
}
const specs = [
  await declared('gevImagery', './imagery/pass.js', 'ImageryEffectDesc'),
  await declared('gevGround', './ground/pass.js', 'GroundEffectDesc'),
  await declared(
    'gevPreSharpenOverlay',
    './overlay.js',
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
