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
    async init(viewer) { /* one-time setup; REQUIRED */ },
    enable(viewer) { /* ... */ },
    disable(viewer) { /* ... */ },
    async update(viewer) { /* ... */ },
  }),
};
```

`init` is **not optional**. The manager calls it once, before the first
`enable`, and does not check whether it exists first — a layer without one
registers and appears in the panel, then refuses every attempt to switch it on
with only a console warning to say why. Returning `false` from it rejects the
layer the same way throwing does.

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

`npm run check:boundaries` exempts your `*.layer.js` files by path, but still
follows what they import. A self-contained layer passes every gate in place; a
layer that imports an application module the loading packages do not own
fails. The exact rule is in
[docs/USER-LAYERS.md](../../docs/USER-LAYERS.md#if-you-also-contribute-upstream).

The tracked half of this feature also passes on its own — the loader ships
with no layers, which is exactly the state CI sees.
