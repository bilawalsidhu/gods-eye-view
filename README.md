# Tracker

An interactive 3D globe that shows real public data in near real time: aircraft, ships,
satellites, public cameras, geolocated news and natural events, map points of interest,
3D buildings and satellite imagery, plus a knowledge layer of notable public figures and
organisations.

Search for a place, an asset or a public figure. The camera flies there and an
information card tells you what you are looking at, where the data came from, and how old
it is.

Every data point comes from a real, live, public source. There is no sample data in the
running product.

## Quick start

```bash
uv sync                      # install the backend and its dev tools
cd frontend && pnpm install  # install the frontend
```

Run both halves in two terminals:

```bash
uv run tracker               # backend on http://127.0.0.1:8000
cd frontend && pnpm dev      # frontend on http://127.0.0.1:5173
```

Open http://127.0.0.1:5173. Real aircraft appear over real NASA imagery within a few
seconds. No API key is needed for the default layers.

Optional keys unlock further layers. Copy `.env.example` to `.env` and fill in what you
have; every layer degrades cleanly when its key is absent.

## Verification

```bash
uv run ruff check . && uv run ruff format --check .
uv run mypy
uv run pytest
cd frontend && pnpm lint && pnpm typecheck && pnpm test
```

## Documentation

| Document | What it covers |
| --- | --- |
| `AGENTS.md` | Working conventions. Read this first, human or agent. |
| `docs/architecture.md` | Data flow, where transforms happen, performance decisions |
| `docs/data-sources.md` | One row per feed: URL, auth, rate limits, licence, cost |
| `docs/status.md` | What works now, what is broken, what is next |
| `docs/plan/implementation-plan.md` | The eight-phase build plan |
| `docs/superpowers/specs/` | The design spec |
| `docs/decisions/` | Architecture decision records |

## Data attribution

This project displays third-party public data and honours each licence. Attribution is
rendered in the application and recorded per source in `docs/data-sources.md`.

Aircraft data from [adsb.lol](https://adsb.lol) under ODbL. Imagery courtesy of NASA
EOSDIS GIBS. Orbital elements from [CelesTrak](https://celestrak.org). Earthquake data
from the USGS. Map data © OpenStreetMap contributors under ODbL. Person and place
knowledge from Wikidata (CC0) and Wikipedia (CC BY-SA 4.0).

## Scope and limits

Read `docs/superpowers/specs/2026-08-19-tracker-design.md` section 8 before touching the
people or camera layers. In short: the people layer is a knowledge map of notable public
entities built from static, historical, public associations. It is not a locator, it
cannot show a current location, and that constraint is enforced in the database query
rather than in policy. Camera feeds come only from official open-data programmes and
owner-submitted directories.

Several data sources are free for non-commercial use only. This is not licensed for
commercial deployment as it stands.
