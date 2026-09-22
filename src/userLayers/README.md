# User layers

Layers you add to your own install, without editing any tracked file.

Drop a `<name>.layer.js` module in this directory. It is discovered at build
time and registered automatically. `.gitignore` covers `*.layer.js` here, so
your layers and their data never show up in `git status`, a diff, or a pull
request — an upstream sync will not conflict with them.

## Contract

```js
// src/userLayers/myThing.layer.js
export default {
  id: 'my-thing',          // [a-z0-9-]+, must not match a built-in layer id
  label: 'My Thing',       // optional, defaults to the id
  createLayer: () => ({    // must return an object DataLayerManager accepts
    id: 'my-thing',
    name: 'My Thing',
    icon: '*',
    enable(viewer) { /* ... */ },
    disable(viewer) { /* ... */ },
    async update(viewer) { /* ... */ },
  }),
};
```

## Why user layers do not have a share token

Built-in layers carry a one-character share token (`^[a-z0-9]$`) — 36 slots
total, and the open-PR queue routinely has many layers competing for the same
letter. A locally added layer must not spend one, or it will collide with
whatever upstream assigns next and break on your next rebase.

So user layers are addressed by **id** in their own `ul` share-link field:

```
?v=2&l=c.t&ul=my-thing.my-other-thing
```

Nothing here touches the token namespace, and you can add as many as the link
length allows (capped at 16 layers / 256 characters).

Opening someone else's share link that names a user layer you do not have is
safe: unknown ids in `ul` are skipped and the rest of the link still restores.
That is deliberately different from `l`, where an unknown *token* fails the
whole payload closed, because an unknown token means a corrupt or future link
while an unknown user-layer id just means a different local install.

## Limits

- **Enabled/disabled only.** User layers have no share-link options; the option
  codec (`lo`) is keyed by built-in tokens. Keep per-layer settings in your own
  module state.
- **Static assets** (GeoJSON and friends) go in `public/`. Add your own path to
  `.gitignore` if they should stay out of git too.

## If you also contribute upstream

`npm run check:boundaries` walks real imports, so while your own `*.layer.js`
files are present it reports them as unowned modules of the packages that
reach this loader. That gate exists to keep the published package exports
honest; it is not a statement about your install.

Move your layers aside before running it, or before opening a pull request:

```bash
mkdir -p ../gev-layers-held && mv src/userLayers/*.layer.js ../gev-layers-held/
npm run format:check && npm run check:boundaries && npm test && npm run build
mv ../gev-layers-held/*.layer.js src/userLayers/
```

The tracked half of this feature passes every gate on its own — the loader
ships with no layers, which is exactly the state CI sees.
