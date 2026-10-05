import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('./template-manifest.json', import.meta.url), 'utf8'),
);
for (const [name, expected] of Object.entries(manifest)) {
  const contents = await readFile(new URL(`src/xr/vendor/${name}`, root));
  const hash = createHash('sha256').update(contents).digest('hex');
  if (hash !== expected)
    throw new Error(
      `XR template snapshot changed: ${name}. Review upstream sync and update the manifest deliberately.`,
    );
}
const profiles = JSON.parse(
  await readFile(
    new URL('public/webxr-profiles/profilesList.json', root),
    'utf8',
  ),
);
for (const profile of Object.values(profiles)) {
  const definition = JSON.parse(
    await readFile(
      new URL('public/webxr-profiles/' + profile.path, root),
      'utf8',
    ),
  );
  for (const layout of Object.values(definition.layouts)) {
    if (layout.assetPath)
      await readFile(
        new URL(
          'public/webxr-profiles/' +
            profile.path.replace(/[^/]+$/, '') +
            layout.assetPath,
          root,
        ),
      );
  }
}
console.log(
  `Verified ${Object.keys(manifest).length} unchanged XR template modules and vendored controller/hand assets.`,
);
