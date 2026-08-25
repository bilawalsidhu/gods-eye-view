# Open issues

Raised by Alexander Fanthome on 2026-08-25. Each one keeps its own heading until it is fixed,
tested and verified against the running product, at which point it moves to `docs/status.md`.

Ordered by severity rather than by the order they were said. A wrong position outranks a missing
feature, because a wrong position is the one thing this project has repeatedly said it will not
do, and a viewer cannot tell it from a right one.

---

## 1. Positions are wrong: planes and buses are in orbit

> "positions of some assets are wrong (planes and busses are in orbit)"

**Severity: highest.** A regression from the merged-icon work in `d78b695` and `fa8e540`.

### Diagnosed 2026-08-25, and it is not what it looks like

Nothing is in orbit. **The merged icons never get `scaleByDistance`**, so they are the only marks
on the globe drawn at a constant pixel size.

`vessels.ts:664` sets `slot.mark.scaleByDistance` on every individual mark, and `drawBadge` never
sets it on the merged one. Same in the other four layers. At a whole-globe view an individual
vessel shrinks to about 28% of its base size while its merged neighbour stays at 100%, so a group
is drawn three and a half times larger than a single asset. A large billboard held at a fixed
screen size over a surface curving away from the camera does not read as sitting on that surface:
it reads as floating above it. That is the whole of "in orbit", and it is the same defect as issue
2's "the extra large icon looks very silly".

**Two hypotheses checked and disproved first**, both worth recording so nobody re-checks them:

- The live data is sound. 418 aircraft measured against the running backend: altitudes from -15m
  to 12,680m, median 1,410m, **zero above 30km**. No aircraft is being sent to orbit by a feed.
- The spherical lift does not explode, though the arithmetic looked like it should.
  `marks()` computes `lift = (SUM_RADIUS / count) / chord`, and `chord` genuinely does tend to
  zero as a cell's members spread out: measured at 55km for two points 179 degrees apart, and
  3.9e-13 km for antipodal ones, giving a lift of 1.6e16. But the drawn radius is
  `lift * chord`, which is the mean radius **by construction**, so it comes back to 6,371km every
  time. The failure it does cause is different and still real: with the members nearly cancelling,
  the mean *direction* is numerical noise, so the icon lands at an arbitrary point on the surface
  rather than above it. Worth fixing on its own terms even though it is not this bug.

`chord` of exactly zero still yields `lift = 0` and collapses the icon to the earth's centre. Not
a NaN, so it will not kill the render loop, but it is not a position either.

### Fix

Issue 2 says do not group at all, so the merged icons go and the scaling question goes with them.
Keep the disproved hypotheses above: the next person to see a mark in the wrong place will reach
for the lift arithmetic first, and it is not that.

## 2. Do not group icons at all: hide them when too dense

> "do not group asset icons, just hide them when they become too dense. the extra large icon
> looks very silly"

This **reverses** the merging built on 2026-08-24 for item 11, and the instruction is clear:
where a cell is too crowded, draw nothing rather than draw a stand-in.

Note the second half. Merged icons were supposed to stay at the unmerged size and the aircraft
layer does that. If any layer is drawing an oversized icon, that is a second bug on top of the
design being wrong, so find out which before deleting anything.

Consequence to state on the rail rather than hide: a hidden mark is a thing the globe is not
showing, so the count on the row has to say so. The transport row already distinguishes "in view
of" from a total, which is the pattern.

## 3. Assets do not show where they have been or where they are going

> "assets should show the path they have trvelled, and the future path they will travel (planes,
> sattalites, vessels, buses, trains)"

Two halves with very different answers, and they must not be blurred:

- **Future path.** Free and exact for satellites: SGP4 propagates to any epoch. For aircraft,
  ships and buses there is no future to compute, only a projection from current heading and
  speed, which is an inference and has to be labelled one.
- **Travelled path.** This project holds current positions with a time to live and records no
  history. So a travelled path needs history recording, which is a new store. Disk persistence is
  encouraged; a SQLite table of observed fixes is the shape.

Drawing an interpolated past track as though it were observed would be the lie this project
refuses everywhere else.

## 4. Nothing is clickable in some layers

> "all assets should be clickable, with an info box about them, but somtimes nothing happens when
> clicked (social media, public transport)"

Named layers: social posts and public transport.

### Audited 2026-08-25, and my first description of this was wrong

I wrote that the cause was layers that "never stamp a pick id, **or** whose id no resolver
recognises". It is entirely the second half. **Transit and social both stamp ids, and the ids are
correct and stable**: `transit.ts:616,622` and `social.ts:542,544`. Nothing in `main.ts` resolves
them, so the id falls through to `store.select`, which holds only aircraft and vessels.

That distinction matters because "add an id to the layer" would have been the wrong fix, and it
would have meant editing files another agent is rewriting.

The full audit, and **two layers are broken, one is broken deliberately, and nothing else is
missing**:

| Layer | Stamps an id | Resolver | Card | Verdict |
|---|---|---|---|---|
| aircraft | bare 6-hex ICAO | `store.select` | yes | works |
| vessels | bare 9-digit MMSI | `store.select` | yes | works |
| satellites | `satellite:<norad>` | `noradFromPickId` | yes | works |
| cities | `city:<geonames id>` | `geonamesFromPickId` | yes | works |
| **transit** | `<feed_id>\t<entity_id>` | **none** | **none** | **dead click** |
| **social** | `<source>\t<post_id>` | **none** | **none** | **dead click** |
| user location | none, deliberately | — | — | dead click, documented |
| clouds | imagery, not primitives | — | — | correctly not pickable |

He found both of the genuinely broken ones.

**A second correction.** A note in `main.ts:730` warns that passing a prefixed id into
`store.select` "stops working the day the store counts or logs an id it does not recognise".
It does not: `state/store.ts:206` already returns early on an id held in neither map, so an
unrecognised id is a no-op by construction rather than by luck. Worth removing the pass-through
anyway, but it is not the live hazard the note claims.

### Design note

The two dead ids are both two fields joined by a tab, so no parser can tell them apart by shape.
They are resolved by asking each registry whether it holds the id, which is also immune to the id
scheme changing while the declutter agent rewrites those layers.

Silence on a click is the worst outcome because it is indistinguishable from a missed click, so a
click resolving to no card opens a notice naming the layer rather than doing nothing. That needs
`installPicking` to distinguish a click on a mark carrying no id from a click on empty ocean,
which today both arrive as `null`.

## 5. UK public transport is missing

> "public transport (buses and trains) are missing from the UK, this is publically avaialble"

Measured on 2026-08-24: the transport layer runs 258 keyless GTFS-Realtime feeds and its live
country spread was US, Netherlands, Czechia, Norway, Japan, France, Finland, Poland. **No United
Kingdom.** He is right that the data is public: the Bus Open Data Service publishes national bus
location data, and TfL publishes its own feeds. Find what is genuinely keyless, and where a key is
required, proxy it server-side and gate the row rather than exposing it.

## 6. Static sea assets are missing

> "static sea assets are missing (mining, drilling, etc)"

Fixed offshore installations: platforms, rigs, wind farms, terminals. A new asset class, not a
mover, so the city layer rather than the vessel union is the structural precedent.

One cheap source is already arriving and being thrown away: the AIS adapters drop MMSIs whose
prefix marks them a navigational aid or auxiliary craft, and a fixed installation broadcasting
over AIS appears as exactly that. Measured in one live cycle: Kystdatahuset dropped one
`navigational_aid` and six `auxiliary_craft`, Seaway dropped 69 `auxiliary_craft`. Small, but it
is a primary record from a coastguard rather than a scrape.

## 7. Coverage is still missing across the globe

> "there is a lot of coverage missing from the globe for different assets, ensure they are
> downloaded and tracked"

Aircraft went global on 2026-08-24, from 954 confined to Britain and France to 13,627 worldwide.
Nothing else did. Audit every layer the same way: pull its API, count distinct ten-degree cells
and the longitude and latitude span, then widen whatever is narrow.

Where the ceiling is the provider rather than the sweep, say so with the numbers. The vessel
sweep of 29 maritime authorities found four publishing keyless live AIS, and that is a purchase
decision rather than an engineering one unless a wider sweep finds more.

## 8. The filter rail is too big and cannot filter

> "the filter should be must smaller, and collapsable, and lots of custom filters (not just by
> asset type)"

The rail is a layer switch with counts and notices. It is not a filter, and it takes a large
share of the window.

## 9. There is no real search or filtering

> "there must be a better UI that permits search for asset names, people, locations, filtering on
> any attribute (text, boolean, integer, float, ranges, etc), and visiblity toggles based on the
> filter (show all private jets, hide private jets, etc)"

Search today resolves place names and a few entity ids. What is asked for is a query surface over
every attribute the contracts carry, with the result driving what the globe draws.

This is the largest item on the list and it depends on 8: the filter rail is where a query lives.
It also depends on the contracts being introspectable, which they are, being Pydantic models
served through a committed `openapi.json`.

---

## How these get worked

1. Reproduce before fixing. Every one of these is a claim about the running product, and this
   repository has a documented history of both false claims and correct claims about the wrong
   cause.
2. Fix at the root. AGENTS.md records that patching the path a report names, while leaving
   sibling callers broken, is the recurring failure here.
3. Test the consequence rather than the intent, and mutation-test the test.
4. Verify against the live product, not only the suite. A green suite is not evidence a layer
   draws.
