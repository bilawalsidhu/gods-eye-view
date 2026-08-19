# Tracker

A demo of wealth profile enrichment for Altrata, built on public data only.

The business sells wealth and executive intelligence: collect data on people and
organisations, resolve it to one profile, join it up, and sell the insight to private
banks, wealth managers, university advancement teams and fundraisers. The population that
matters is the wealth tiers, UHNW over $30m, VHNW $5m to $30m, HNW over $1m. The
commercial value sits in the join, not in any single field.

Collection in the business is scrape at scale, extract with a language model, verify with a
researcher. That is what the Leadership Extractor, the Annual Report Extractor and the AI
Profile Builder each do, on company websites, on annual reports and filings, and on the
open web. `docs/business-context.md` has the detail.

This project keeps the scraping and the extraction and drops the researcher. It is a proof
of concept and a demo, so there is no human verification anywhere: no review queue, no QA
step, no approval state. Nothing is designed on the assumption a person will check it, and
the code is conservative instead. That is a rule.

This project rebuilds one of those joins from public sources: take a profile, find the
assets linked to it, and show those assets moving live on a globe. Altrata already
licenses private aircraft ownership (JetNet), luxury vehicle ownership and US real estate
(CoreLogic), so this can be demoed without touching licensed data or production systems.

Read `docs/business-context.md` first. It covers the commercial framing, the tier
definitions and where the product deliberately stops.

Seven things the globe puts a pin on: aircraft, ships, satellites, cities, organisations,
public figures and geolocated social posts. Around them sit the context layers: public
cameras, geolocated news and natural events, map points of interest, 3D buildings and
satellite imagery.

Any of the seven can be joined to any other, people included, and every join shows its
source, its confidence and its as-of date. See ADR 007. A social post maps the location of
its subject, never its author.

A profile is the production shape, not a cut-down one: name and alternate names, date of
birth, gender, nationality, wealth tier, roles, dated locations, and contact attributes
including email, phone and postal address. See ADR 008. This demo is public sources only, so
most of the contact fields sit empty and no value is ever guessed to fill one.

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
| `docs/business-context.md` | What the business sells, the wealth tiers, where this stops |
| `docs/architecture.md` | Data flow, where transforms happen, performance decisions |
| `docs/data-sources.md` | One row per feed: URL, auth, rate limits, licence, cost |
| `docs/status.md` | What works now, what is broken, what is next |
| `docs/plan/implementation-plan.md` | The eleven-phase build plan, and what is deliberately not designed |
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

Read ADR 002, ADR 004, ADR 006, ADR 007, ADR 008, ADR 011, ADR 012, ADR 013, ADR 014 and
ADR 015 in `docs/decisions/`
before touching the people or camera layers. In short: a person may be joined to any data in
the system, live
position feeds included. ADR 007 removed the structural firewall that used to prevent it and
the test that asserted it, so nothing in the code now stops this being a person locator. ADR
008 then put the production profile attributes in, contact data included, and settled the
jurisdiction. What holds instead is evidence: a source, a confidence and an as-of date on
every join, sub-threshold joins shown as possible matches and counted nowhere, inferences
labelled as inferences, location held as a dated series rather than a current value, and a
removal request that removes and suppresses the record.

ADR 011 adds the rule that makes the enrichment credible without a researcher: no single
online source is trusted alone. Every enriched attribute carries the set of sources behind
it, confidence is a function of how many independent origins agree, independence is counted
at the origin so a syndicated wire story counts once, and a single scraped or crowd-sourced
source stays unconfirmed and counts towards nothing. Conflicting dated values both stay, with
the disagreement shown.

ADR 012 turns "the owner is aboard" from a banned claim into a built one, in phase 12, as an
explicit inference over ownership, recorded route history, the live track, the associate graph
from public filings, and each candidate's dated locations from every other layer. Contradiction
beats corroboration, so a corroborated location elsewhere in the window removes a candidate.
Below the threshold nothing is named. It counts towards no aggregate, writes no location onto
a profile and sets no wealth tier. It is the highest-harm output in the system and ADR 012
says so plainly.

Erasure is a feature here. A removal request deletes the record and keeps a suppression key
that survives the next crawl, and the suppression shows in the product with its reason. We
honour it as policy rather than because a regulator compels it: the population and the
customers are in the United States, which has no GDPR and instead a state patchwork with
California's CCPA and CPRA at the sharp end. Writing the US position is a phase 6 deliverable
and a hard gate on any public deployment carrying real profiles.

FAA LADD and privacy ICAO addresses are worked through rather than honoured (ADR 009). A
LADD-listed aircraft resolves and displays like any other; a privacy address is correlated
back to a registration in phase 11, above a higher threshold, with the anonymity and the
inference shown on the card. Both are opt-outs the product deliberately works through, and
ADR 009 carries the legal and reputational exposure that comes with that.

People are identified in photographs, 1:N against the profiles already held, as an inference
with its confidence and its evidence shown (ADR 013, phase 14). It is never open-set
identification of the public, a face matching no profile is discarded rather than stored, and
it is not applied to camera feeds. A written legal position from counsel is a blocker on
public deployment carrying real profiles.

All of it runs on one laptop, locally (ADR 015). One evidence contract and one deterministic
resolver serve every modality: text, image, audio and video. Video is frames plus an audio
track, not a third thing. Local inference is four small ONNX models on CPU doing candidate
generation, near-duplicate detection and transcription, and no model ever scores a match. The
rule that keeps it honest is the origin key: a video, a still pulled from it, its transcript
and every model run over any of them are one source, not five. Nothing is sent to a cloud
model, which is a licensing and a biometric position as much as a deployment one.

One thing is out. Aggregators of unsecured private cameras, because using them is
unauthorised access to someone's misconfigured device rather than a data decision. The camera
layer is owner-published and official: TfL JamCams and New York 511 are both keyless and
verified, Windy needs a key.

Wealth tiers come from a profile, never from a position or a track. Owning a jet is not an
estimated net worth and the code never treats it as one.

Several data sources are free for non-commercial use only. This is not licensed for
commercial deployment as it stands.
