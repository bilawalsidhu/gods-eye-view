import { ICONIC_TINTS, WILDLIFE_SPRITE_PX } from './policy.js';

// Missing taxon symbols use related shapes from Material Symbols Outlined.
export const WILDLIFE_BADGE_GLYPHS = Object.freeze({
  bird: 'raven',
  mammal: 'pets',
  reptile: 'egg_alt',
  amphibian: 'water_drop',
  fish: 'set_meal',
  insect: 'bug_report',
  arachnid: 'pest_control',
  plant: 'eco',
  fungus: 'umbrella',
  other: 'category',
  unknown: 'question_mark',
});
export const WILDLIFE_SPRITE_GROUPS = Object.freeze(
  Object.keys(WILDLIFE_BADGE_GLYPHS),
);
export const WILDLIFE_SPRITE_ICONIC = Object.freeze({
  bird: 'Aves',
  mammal: 'Mammalia',
  reptile: 'Reptilia',
  amphibian: 'Amphibia',
  fish: 'Actinopterygii',
  insect: 'Insecta',
  arachnid: 'Arachnida',
  plant: 'Plantae',
  fungus: 'Fungi',
  other: 'Animalia',
  unknown: 'Unknown',
});
const ICONIC_GROUPS = Object.freeze(
  Object.fromEntries(
    Object.entries(WILDLIFE_SPRITE_ICONIC).map(([group, iconic]) => [
      iconic,
      group,
    ]),
  ),
);

/** Resolve a taxon or sprite group to one of the shared badge textures. */
export function wildlifeSpriteGroup(groupOrIconic) {
  if (groupOrIconic === 'Mollusca') return 'other';
  return Object.hasOwn(WILDLIFE_SPRITE_ICONIC, groupOrIconic)
    ? groupOrIconic
    : Object.hasOwn(ICONIC_GROUPS, groupOrIconic)
      ? ICONIC_GROUPS[groupOrIconic]
      : 'unknown';
}

export const WILDLIFE_BADGE_OUTLINE_PX = 1.5;
const OUTLINE_COLOR = '#040c10';
const FONT = '400 14px "Material Symbols Outlined"';
const FONT_GLYPHS = Object.values(WILDLIFE_BADGE_GLYPHS).join(' ');
const FALLBACKS = new Map(
  WILDLIFE_SPRITE_GROUPS.map((group) => [
    group,
    `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9.1" fill="${ICONIC_TINTS[WILDLIFE_SPRITE_ICONIC[group]]}" stroke="${OUTLINE_COLOR}" stroke-width="${WILDLIFE_BADGE_OUTLINE_PX}"/></svg>`,
    )}`,
  ]),
);

/** One bounded set of canvas sprites per document, painted only after the
 * icon font is decoded. Until then the very same billboards use plain badges. */
export function createWildlifeSpriteCache({
  documentRef = globalThis.document,
} = {}) {
  const sprites = new Map();
  const listeners = new Set();
  let ready = false;
  let loading = null;

  function paint(group) {
    const canvas = documentRef.createElement('canvas');
    canvas.width = canvas.height = WILDLIFE_SPRITE_PX * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return FALLBACKS.get(group);
    ctx.scale(2, 2);
    ctx.beginPath();
    ctx.arc(10, 10, 9.1, 0, Math.PI * 2);
    ctx.fillStyle = ICONIC_TINTS[WILDLIFE_SPRITE_ICONIC[group]];
    ctx.fill();
    ctx.lineWidth = WILDLIFE_BADGE_OUTLINE_PX;
    ctx.strokeStyle = OUTLINE_COLOR;
    ctx.stroke();
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(WILDLIFE_BADGE_GLYPHS[group], 10, 10, 16);
    return canvas;
  }

  function load() {
    if (loading) return loading;
    if (!documentRef?.fonts?.load) return Promise.resolve(false);
    loading = Promise.resolve()
      .then(() => documentRef.fonts.load(FONT, FONT_GLYPHS))
      .then((faces) => {
        if (!faces?.length) return false;
        // Paint once per group, never once per observation or refresh.
        for (const group of WILDLIFE_SPRITE_GROUPS)
          sprites.set(group, paint(group));
        ready = true;
        for (const listener of [...listeners]) listener();
        return true;
      })
      .catch(() => false);
    return loading;
  }

  return {
    get(groupOrIconic) {
      const group = wildlifeSpriteGroup(groupOrIconic);
      return (ready ? sprites : FALLBACKS).get(group);
    },
    load,
    subscribe(listener) {
      listeners.add(listener);
      void load();
      return () => listeners.delete(listener);
    },
  };
}

const caches = new WeakMap();
let headlessCache;
/** Share the bounded sprite cache among layer instances in one document. */
export function wildlifeSpriteCache(documentRef = globalThis.document) {
  if (!documentRef) return (headlessCache ??= createWildlifeSpriteCache());
  if (!caches.has(documentRef))
    caches.set(documentRef, createWildlifeSpriteCache({ documentRef }));
  return caches.get(documentRef);
}
