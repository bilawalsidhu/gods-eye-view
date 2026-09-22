# User layers

Add your own data layers to an install without editing a tracked file, and
without spending a share-link token.

A **user layer** is an ordinary layer module that lives in `src/userLayers/`
and is discovered at build time. It behaves like a built-in layer everywhere
it matters — it appears in the layer panel, persists across reloads, and rides
in share links — but it is invisible to git, so it never appears in a diff and
never conflicts when you sync with upstream.

---

## Quick start

1. Create `src/userLayers/<name>.layer.js`:

```js
export default {
  id: 'my-thing',
  label: 'My Thing',
  createLayer: () => ({
    id: 'my-thing',
    name: 'My Thing',
    icon: '*',
    enable(viewer) {
      /* start drawing */
    },
    disable(viewer) {
      /* stop drawing */
    },
    async update(viewer) {
      /* refresh */
    },
  }),
};
```

2. Restart the dev server. That is the whole procedure — no registration call,
   no config entry, no edit to `main.js` or `layerState.js`.

`src/userLayers/example.layer.js.example` is a copyable starting point.

---

## The descriptor

The default export describes the layer to the registry.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable identity, `[a-z0-9-]+`. Used in storage and share links. Must not match a built-in layer id. |
| `label` | no | Human name for diagnostics. Defaults to `id`. |
| `createLayer` | yes | Factory returning the live layer object. Called once at startup. |

`id` is a **persistent identifier**. Changing it later orphans any saved
selection and invalidates share links that named it, so pick it deliberately.

## The layer object

`createLayer()` must return something `DataLayerManager` accepts. The contract
is the same one built-in layers implement:

| Member | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Must equal the descriptor `id`. |
| `name` | yes | Shown in the layer panel. |
| `icon` | no | Single character or emoji shown beside the name. |
| `init(viewer)` | no | One-time setup. Create Cesium resources here, not in the factory. |
| `enable(viewer)` | yes | Called when switched on. |
| `disable(viewer)` | yes | Called when switched off. Must release what `enable` acquired. |
| `update(viewer)` | no | Periodic refresh; `updateInterval` (ms, `0` disables) controls cadence. |
| `destroy()` | no | Teardown on shutdown. |
| `showInTogglePanel` | no | Whether the layer appears in the panel. **Defaults to `true` for user layers** (built-ins opt in explicitly). Set `false` for a layer driven only by share links. |

Keep Cesium resource creation in `init`, not in `createLayer()` — the factory
runs during catalog construction, before a viewer exists.

---

## Managing layers in the app

There is an existing in-app UI and your layers join it automatically:

- **Layer panel** — user layers get a toggle row like any other layer, so they
  can be switched on and off, and their enabled state persists.
- **Grouping** — the panel orders layers by a curated list of built-in ids.
  User layers are not in that list, so they collect under a trailing
  **"Other layers"** heading. That is the expected placement, not a bug.
- **State and sharing** — an enabled user layer survives reload and travels in
  share links (see below).

**There is no in-app UI for installing, removing, or editing user layers**, and
that is a deliberate consequence of how discovery works rather than an
oversight. Discovery is build-time: Vite has to see the module specifiers in
order to bundle them, and a runtime `import(someString)` would neither be
bundled nor survive the app's content-security policy. Adding or removing a
layer therefore means adding or removing a file and restarting — the same
motion as any other code change.

What you get in-app is **operating** the layers; what happens on disk is
**installing** them.

---

## Share links and why user layers have no token

Every built-in layer owns a one-character share token (`^[a-z0-9]$`). That is
36 slots for the whole project, and they are contended — the open pull-request
queue regularly has many layers competing for the same letter.

A locally added layer must not spend one. If it did, it would collide with
whatever upstream assigns next, and you would only find out on your next
rebase, as a duplicate-token failure.

So user layers are addressed **by id, in their own `ul` field**:

```
?v=2&l=c.t&ul=my-thing.my-other-thing
        │              │
        │              └── user layers, by id — no token spent
        └── built-in layers, by token
```

Consequences worth knowing:

- **You can never run out.** The limit is link length, not letters. The
  registry caps at 16 layers and `ul` at 256 characters.
- **Upstream token churn cannot affect you.** Nothing you add competes with
  anything upstream assigns.
- **Links degrade gracefully across installs.** Opening a link that names a
  user layer you do not have is safe: unknown ids in `ul` are skipped and the
  rest of the link still restores.

That last point is a deliberate asymmetry. An unknown **token** in `l` fails
the whole payload closed, because it means a corrupt or future link. An
unknown **id** in `ul` just means the sender's local layers differ from yours,
and their built-in selections should still work.

Local storage is keyed by full id already, so persistence needs nothing extra.

---

## Rules the registry enforces

Registration throws — loudly, at startup — rather than dropping a bad layer
quietly, because a layer that silently fails to appear is far harder to
diagnose than one that refuses to load.

- `id` must match `[a-z0-9-]+`.
- `id` must not collide with a built-in layer id.
- `id` must be unique among user layers.
- `createLayer` must be a function.
- At most 16 user layers.

Layers are sorted by id before registration, so discovery order never leaks
into the encoded share link — the same selection always produces the same URL.

---

## Static assets

Put data files in `public/` and fetch them by absolute path:

```js
const response = await fetch('/my-thing/data.geojson');
```

Add your asset directory to `.gitignore` if it should stay out of git too:

```gitignore
public/my-thing/
```

Do not commit data you do not have the right to redistribute — fetch it at
runtime instead.

---

## Live data sources

A layer that polls, streams, or opens a socket is supported, but there are two
different questions hiding here: what happens when your layer misbehaves, and
what your layer is actually allowed to reach.

### The host already contains a misbehaving layer

`src/data/lifecycle.js` isolates each layer, so a live source that fails does
not take the application with it:

- A throwing or rejecting `update()` is caught, logged as
  `[Data] <id> refresh error:`, recorded on the layer's status, and published
  as a `refresh-failed` event. **Other layers keep refreshing.**
- `enable()` and `disable()` are guarded the same way, including the
  cancellation-cleanup paths when a layer is toggled off mid-enable.
- A `refreshEpoch` generation guard discards a slow response that lands after
  the layer was disabled, so a late fetch cannot draw into a torn-down scene.

So a badly behaved live layer degrades itself, not the app. You do not need to
defend the host from your layer.

### What the host cannot do for you

**Release your own resources in `disable()`.** The manager cancels *its*
refresh loop; it has no handle on a socket or timer you opened. Anything
started in `enable()` must be stopped in `disable()`:

```js
let socket = null;
let timer = null;
let inFlight = null;

return {
  id: 'my-live-thing',
  name: 'My Live Thing',
  updateInterval: 15_000,        // let the host drive polling where you can
  enable() {
    socket = new WebSocket('wss://example.invalid/feed');
    timer = setInterval(tick, 1000);
  },
  disable() {
    socket?.close();
    socket = null;
    clearInterval(timer);
    timer = null;
    inFlight?.abort();           // AbortController for in-flight fetches
    inFlight = null;
  },
  async update() {
    inFlight?.abort();
    inFlight = new AbortController();
    const response = await fetch('/my-thing/live.json', {
      signal: inFlight.signal,
    });
    // ...
  },
};
```

Prefer `updateInterval` plus `update()` over your own `setInterval`: the host
already serialises refreshes, guards them against late arrival, and stops
driving them when the layer is off.

### Where your layer is allowed to fetch

This is the real limitation, and it is worth understanding before you plan a
live layer.

| Source | Works | Notes |
| --- | --- | --- |
| `public/` asset, same origin | yes | The simple case. Nothing else needed. |
| A service you run, same origin | yes | Reverse-proxy it to the app's origin. |
| Third-party API, direct from browser | **usually not** | Blocked by CORS unless the provider explicitly allows it. |
| Third-party API, via a project proxy | yes | But the proxy lives in a **tracked** file. |

Every upstream provider in this project is reached through a server-side proxy
registered in `vite.config.js` — that is what makes CORS, caching, rate limits
and key custody tractable. A **new** live upstream needs a proxy too, and
adding one means editing `vite.config.js`, which is tracked.

**So the "no tracked file edits" property of user layers holds for static and
same-origin data, and stops at a new third-party live upstream.** If you need
one, your options are, in increasing order of effort:

1. Serve the data from `public/` and refresh it out of band.
2. Run your own small service and expose it on the app's origin, so the layer
   fetches a same-origin path.
3. Add a proxy to `vite.config.js` — accepting that this is a local patch you
   will carry across upstream syncs, exactly like the two lines this feature
   was built to eliminate.

One forward-looking caveat: there is currently **no `connect-src` policy**, so
a direct third-party fetch that survives CORS will work today. Shipping a full
content-security policy is an open upstream proposal, and if it lands, direct
third-party fetches from a layer would stop working while proxied and
same-origin ones keep working. Building on a proxy or same origin is the
durable choice.

### Be a good citizen

- Respect the provider's rate limits; `updateInterval` is your throttle.
- Bound what you draw. A feed that appends entities forever will exhaust WebGL
  memory long before it exhausts the network.
- Never put a credential in a layer module — it ships to the browser. Keys
  belong server-side, behind a proxy.

---

## Limits

- **No share-link options.** The option codec (`lo`) is keyed by built-in
  tokens, so user layers are enabled/disabled only. Keep per-layer settings in
  your own module state.
- **Build-time discovery.** Adding or removing a layer requires a restart.
- **No sandbox.** A user layer is ordinary application code with the same
  privileges as any built-in layer. Only add layers you trust.
- **Enabled/disabled disposition only.** Each user layer contributes an
  `enabled-only` serialization disposition automatically; there is no way to
  declare a different one.

---

## If you also contribute upstream

`npm run check:boundaries` walks real imports, so while your `*.layer.js` files
are present it reports them as unowned modules of the packages that reach the
loader. That gate keeps the published package exports honest; it is not a
statement about your install.

Move your layers aside before running the gates or opening a pull request:

```bash
mkdir -p ../gev-layers-held && mv src/userLayers/*.layer.js ../gev-layers-held/
npm run format:check && npm run check:boundaries && npm test && npm run build
mv ../gev-layers-held/*.layer.js src/userLayers/
```

The tracked half of this feature passes every gate on its own — the loader
ships with no layers, which is exactly the state CI sees.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Layer never appears in the panel | `showInTogglePanel` explicitly `false`, or `createLayer()` returned nothing. |
| `Invalid user-layer id` at startup | `id` has capitals, underscores, spaces or dots. |
| `collides with a built-in layer` | Your `id` matches a shipped layer; pick another. |
| `must supply a createLayer function` | Descriptor exports a layer object directly instead of a factory. |
| Layer appears but never draws | Cesium resources created in `createLayer()` instead of `init(viewer)`. |
| Share link drops the layer | Opened on an install that does not have that layer — expected. |
| `check:boundaries` reports your layer | Expected while local layers are present; see above. |
