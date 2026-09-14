# Running God's Eye View in Docker

A single isolated container. It does **not** interfere with other stacks on
the host: own compose project/network, loopback-only port publish, unique
container name, no host volumes, and no restart policy (it never resurrects
on daemon restart).

## Quick start

```bash
docker compose up -d --build
# → http://127.0.0.1:5273
```

Change the host port with `GEV_PORT`:

```bash
GEV_PORT=6000 docker compose up -d
```

Stop (container + network removed):

```bash
docker compose down
```

## Why the container runs the dev server (`npm run dev`)

The app's data backbone (OpenSky, CelesTrak, CCTV, adsb.lol, FIRMS, TomTom,
Overpass, GBFS, terrain heights, adsbdb, and the key-setup endpoints) is
implemented as Vite **dev-server** middlewares. Several of those plugins
register only via `configureServer` and are intentionally absent from
`vite preview`, so a `build + preview` container would silently ship a gutted
app. The dev server is the only mode with the full proxy set.

## API keys

Optional — the app degrades gracefully without keys. To supply them, create
`.env` at the repo root (copy from `.env.example`) and (re)start: compose
passes it into the container at runtime. Secrets are never baked into the
image (`.dockerignore`).

Note: the in-app **Provider Settings** panel (`/api/setup/*`) only serves
requests originating on the machine running the server — by design. Inside
Docker your browser is remote to the container, so manage keys via the
`.env` file instead.

## Rebuilding after code changes

The image bakes the source at build time (no live mount, by design, to keep
the container fully isolated from the host checkout):

```bash
docker compose up -d --build
```

## Isolation summary

| Concern | Value |
| --- | --- |
| Compose project | `gods-eye-view` (own bridge network) |
| Container name | `gev-app` |
| Port publish | `127.0.0.1:<GEV_PORT:-5273> → 4173` (loopback only) |
| Host volumes | none |
| Restart policy | `no` |
| Networks joined | own default network only |
