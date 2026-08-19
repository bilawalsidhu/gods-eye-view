# ADR 001: CesiumJS frontend, FastAPI backend, one process owning the feeds

**Date:** 2026-08-19
**Status:** Accepted

## Context

We need a browser application that renders a 3D globe and shows real live public data on
it: aircraft, ships, satellites, cameras, geolocated events, imagery, points of interest,
3D buildings and a knowledge layer of notable public entities. Target is 30 frames per
second or better with 20,000 live entities on an ordinary laptop.

That sets four hard requirements on the rendering engine. A true WGS84 globe, because
aircraft altitude and satellite orbits are meaningless on a flat projection. Native 3D
Tiles, because building meshes stream or they do not work. A built-in clock and time model,
because satellites, timeline scrubbing and track replay all need one. And a documented
self-hosted path, because a dependency on someone else's hosted tier is a licence and cost
risk we would be signing up for at the start.

On the backend the constraint is different. Several upstream feeds are free, run on
donations, and block clients that misbehave. CelesTrak firewalls abusive clients
permanently. Overpass has a fair-use ceiling around ten thousand queries a day per IP.
adsb.lol publishes no contractual rate limit and throttles in practice. Three feeds need
API keys that must never reach a browser. So the question is not which web framework is
nicest, it is where the upstream connections live.

## Decision

**Frontend: CesiumJS with Vite and TypeScript.** One primitive collection per layer,
positions mutated in place, `requestRenderMode` on. Satellites propagated in the browser
with `satellite.js`.

**Backend: FastAPI with Pydantic v2**, Python 3.13, managed by uv with a committed
`uv.lock`. Strict Pydantic contracts at every boundary. The OpenAPI schema is dumped to a
committed `openapi.json` and generates the frontend's TypeScript types, so the wire
contract cannot drift between the two halves.

**One process owns every upstream feed.** Pollers start in the application lifespan
(`src/tracker/app.py:184`) and `workers=1` is pinned at `src/tracker/__main__.py:27`. The
browser only ever talks to us.

## Consequences

**Cesium is a large dependency.** The bundle is heavy, it ships its own asset directory
and web workers, and Vite needs explicit configuration to serve them. That is the price of
being the only engine that meets all four requirements today.

**The Cesium `Entity` API is unusable at our target scale.** It collapses in the low
thousands of movers. Every moving layer must use `PointPrimitiveCollection` or
`BillboardCollection` with in-place position mutation. This is not an optimisation to apply
later: converting an `Entity`-based layer to primitives is a rewrite of that layer. The
discipline is stated in `AGENTS.md` and in `docs/architecture.md`, and it is the reason
phase 1 is a full vertical slice rather than a backend-first build. Discovering at phase 6
that the render architecture cannot carry the load would cost the project.

**Pydantic strictness means upstream changes fail loudly.** `extra="forbid"` on the domain
base (`src/tracker/contracts/base.py:50`) means a provider adding a field breaks a test
rather than being silently ignored. That is the intent, and it costs a maintenance
obligation: someone has to fix the test when a feed evolves.

**Single-process ownership blocks horizontal scaling.** Every uvicorn worker runs its own
lifespan and would duplicate every poller, doubling load on feeds given to us for free.
Scaling out needs a cross-process lock, or a split between a poller process and a
stateless web tier, before anything else.
`create_app(start_background_tasks=False)` (`src/tracker/app.py:159`) already builds a
fully working API over empty stores, which is both what tests use and the shape that web
tier would take.

**FastAPI gives us the wire contract for free.** `scripts/dump_openapi.py` writes the
schema without starting a server, CI regenerates it and fails on any difference, so a
backend response shape cannot change without the frontend types changing in the same
commit.

## Alternatives considered

**deck.gl `GlobeView`.** Rejected. `GlobeView` is still experimental, has no camera pitch
and no terrain. Pitch is not cosmetic here: looking along an aircraft's flight path or up
at a satellite pass is a core interaction. No terrain rules out the imagery and buildings
phases.

**MapLibre GL JS globe.** Rejected. The globe projection is real and performant, but there
is no 3D Tiles support, so building meshes are out, and no time model, so satellite
propagation, timeline scrubbing and track replay would all have to be built from scratch.

**Globe.gl.** Rejected. A demonstration wrapper around three.js. No real geospatial
coordinate handling, no tiled imagery, no time model, no picking at scale. Fine for a
data-art piece, not for this.

**Three.js directly.** Rejected on cost, not capability. It would mean writing the WGS84
ellipsoid maths, tiled imagery streaming, terrain, 3D Tiles parsing, picking and a clock
ourselves. That is Cesium's entire feature set, reimplemented worse.

**Backend feed access from the browser.** Rejected outright. It leaks API keys, multiplies
every rate limit by the number of open tabs, and pushes normalisation into the frontend so
a provider swap becomes a frontend change. The one deliberate exception is satellite
propagation, which fetches nothing at runtime: the browser is given cached orbital elements
and computes positions locally. That is reasoning explained in `docs/architecture.md`.

**Flask or Django for the backend.** Rejected. Neither gives async-native HTTP clients,
WebSockets and OpenAPI generation out of the box, and the whole point here is one async
process holding many long-lived upstream connections.
