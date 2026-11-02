import {
  array,
  fields,
  string,
  optional,
  uniqueId,
  fail,
} from '../documentFields.js';

/** Validate inert, scene-local actions. Feature existence is checked after asset loading. */
export function validateSceneInteractions(scene, path) {
  const packs = new Map((scene.dataPacks || []).map((p) => [p.id, p]));
  const anchors = new Set((scene.anchors || []).map((a) => a.id));
  const shots = new Map(scene.shots.map((s) => [s.id, s]));
  scene.shots.forEach((shot, index) => {
    optional(shot, 'interactions', `${path}.shots[${index}]`, (items, at) => {
      array(items, at, 64);
      const seen = new Set();
      items.forEach((item, i) => {
        const field = `${at}[${i}]`;
        fields(item, field, ['id', 'label', 'target', 'action']);
        string(item.id, field);
        uniqueId(item, field, seen);
        string(item.label, field, 256);
        fields(item.target, `${field}.target`, ['packId', 'featureId']);
        string(item.target.packId, field);
        string(item.target.featureId, field);
        if (
          packs.get(item.target.packId)?.format !== 'geojson' ||
          !shot.dataPackIds?.includes(item.target.packId)
        )
          fail(field, 'target must belong to a selected GeoJSON pack');
        const a = item.action;
        const specs = {
          card: ['text', 'url'],
          focus: ['anchorId'],
          shot: ['shotId'],
          layer: ['layerId', 'enabled'],
        };
        if (!a || !Object.hasOwn(specs, a.type))
          fail(field, 'unsupported action');
        string(a.type, `${field}.action.type`);
        fields(a, `${field}.action`, ['type', ...specs[a.type]]);
        const reference = {
          focus: 'anchorId',
          shot: 'shotId',
          layer: 'layerId',
        }[a.type];
        if (reference) string(a[reference], `${field}.action.${reference}`);
        if (a.type === 'card') {
          string(a.text, field, 4096);
          optional(a, 'url', field, (url, at) => {
            string(url, at, 2048);
            let parsed;
            try {
              parsed = new URL(url);
            } catch {
              fail(at, 'expected HTTPS source URL');
            }
            if (
              parsed.protocol !== 'https:' ||
              parsed.username ||
              parsed.password ||
              parsed.search ||
              parsed.hash
            )
              fail(
                at,
                'expected HTTPS source URL without credentials, query or fragment',
              );
          });
        } else if (a.type === 'focus' && !anchors.has(a.anchorId))
          fail(field, 'unknown anchor');
        else if (a.type === 'shot') {
          const target = shots.get(a.shotId);
          if (!target) fail(field, 'unknown shot');
          // A transition must restore every layer this shot can change.
          for (const entry of items)
            if (
              entry?.action?.type === 'layer' &&
              !Object.hasOwn(target.layers || {}, entry.action.layerId)
            )
              fail(
                field,
                'target shot must declare interactive layer baseline',
              );
        } else if (a.type === 'layer') {
          if (!Object.hasOwn(shot.layers || {}, a.layerId))
            fail(field, 'layer must have an explicit shot baseline');
          if (typeof a.enabled !== 'boolean')
            fail(field, 'expected enabled boolean');
        }
      });
    });
  });
}
