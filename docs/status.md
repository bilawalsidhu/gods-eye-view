# Status

Last updated: 2026-08-23. This is the only document expected to churn.

Nothing goes in **Works** without pasted output from a command that was actually run. The phase 4
figures came off one verification pass on 2026-08-20 between 17:36 and 17:57 local time, on one
laptop. The phase 2 and phase 3 figures came off an earlier pass the same day, between 13:39 and
17:36, and are labelled where they were not re-run.

## Now

**Phase 4 is built and verified on both halves, and all six acceptance criteria are met.** The
GeoNames city layer, `/api/cities`, `/api/cities/{geonames_id}`, `/api/search` and the throttled
Nominatim geocoder behind it, plus the browser half: the label layer, the search box, follow mode
and URL state. Both gates pass in one run and the 18-test Playwright suite passes. Evidence is
below, criterion by criterion, and every number came off a running server today.

Phase 3 is built and verified live: aircraft classification, the adsbdb ownership join, and the
aircraft layer turned into an ADR 010 provider union. Seven of the eight acceptance criteria are
met and one is blocked on source access. Phase 2 before it is built and verified. Aircraft,
military aircraft and ships are all live off keyless feeds.

**Satellites draw as of 2026-08-23: 698 objects, verified in a browser.** The layer had never had a
live element set, and the reason was not the one recorded here. See "Satellites draw, and CelesTrak
was never going to come back" below. Two things changed: the elements now come from a keyless
republisher serving the identical CelesTrak contract, and a real defect was fixed that had been
keeping the store empty on every restart regardless of the source.

**The globe now shows every layer it claims.** Measured on one running server on 2026-08-23: 795
aircraft, 37 military, 630 vessels, 698 satellites, 34,072 cities, zero console errors in Chromium.

**The vessel layer now has four keyless providers on two continents, and the ship count is
6,001 rather than 649.** Verified live on 2026-08-23 at 17:11 UTC on one running server. Per
provider: Kystdatahuset 3,217, Seaway 1,883, Transpordiamet 609, Fintraffic 638. All 6,001
served records had a distinct MMSI, all had `providers[0] == source`, all were positioned, none
carried MMSI 999999999 or a `111` search-and-rescue prefix, and no name kept a `[NN%]` suffix.
346 records were seen by more than one provider, so the merge is doing real work rather than
concatenating.

**The globe is no longer Nordic. 31% of the ships are in North America.** Bounding box lon
-92.12 to 34.25, lat 41.42 to 79.91, against lon 0.9 to 31.5 before. By region: Norwegian coast
and Skagerrak 41%, Great Lakes and St Lawrence and the western Atlantic 31%, Baltic and Gulf of
Finland 19%, Baltic approaches 6%, North Sea 3%, Barents 0.2%.

**And here is the number that matters, stated plainly: 379 one-degree cells have a ship in
them, which is 0.58% of the globe.** Two continents is better than one and it is not global.
The national sweep behind that is in `docs/data-sources.md`: **twenty-nine authorities were
called on 2026-08-23 and four publish keyless live AIS.** Denmark charges DKK 1,800 to 5,600 a
year for it, Sweden's is behind the paid RAIS database, the UK's own dataset is a stub with zero
resources attached, and Italy, Greece and Lithuania answer 403 to a descriptive User-Agent.
Everything else is gated, historical, a density raster or absent. If more of the ocean is
wanted, that is a purchase decision rather than an engineering one.

**Two near-misses worth knowing about, because both look like the answer and neither is.** NOAA
publishes WMO Voluntary Observing Ship reports keylessly and genuinely globally, 9,211
observations from lat -83 to +89, and **there are nine distinct ship identifiers across all of
them**, eight buoy numbers and the literal string `SHIP`, with zero MMSIs. Under ADR 010 every
one of those would merge into a single record. France's oceanographic fleet publishes 9 research
vessels worldwide with no MMSI either. Both are recorded so nobody spends the day again.

**Kystdatahuset was wired in earlier the same day as the second keyless provider, taking the
count from 649 to 1,898.** Verified live on 2026-08-23 at 10:16 UTC on one running server:
`/api/layers` reported `vessels: 1898`, with `digitraffic` contributing 649 and `kystdatahuset`
1,249, and `exclusive` equal to `records` on both because the MMSI intersection is zero. All
1,898 served records had a distinct MMSI and all 1,898 had `providers[0] == source`. Coverage
went from Finnish waters to lon 0.88 to 31.11 and lat 56.27 to 79.59, which is the North Sea to
Svalbard. Norwegian records arrive already decoded: name, IMO, call sign, ship type,
navigational status, draught, length, beam and destination, so nothing is thinner than the
Finnish half.

**The provider's own output varies by a factor of two and a half, and the "triples the count"
claim depends on when you ask.** Measured on 2026-08-23: 3,542 features at 09:53 UTC against
1,467 at 10:18 UTC, from the same unfiltered call twenty-five minutes apart. The empty-geometry
share moves with it, 77 of 3,542 against 252 of 1,467, so a quiet moment is thinner twice over.
The earlier research figure of 4,350 merged vessels was a good moment; 1,898 was a poor one.
Both are real and the layer reports whichever it got rather than smoothing it.

**What it does not show, and why, stated plainly.** Vessel coverage is still Northern Europe
only, bounded by roughly lon 0.14 to 32.54 and lat 56.27 to 80.34, which is 0.33% of the globe's
one-degree cells. Fintraffic is Finnish and Kystverket is Norwegian, and no keyless combination
reaches global AIS: 20-odd national authorities were called on 2026-08-20 and nearly all publish
vessel *density rasters* rather than live positions. Global AIS needs an aisstream.io key, an AISHub
membership with a physical VHF antenna, or a paid aggregator. That is a decision rather than a
finding, and it is open. Until it is taken, the layer rail reads "0 in view of 694" rather than
showing an empty globe, which is the honest version of the same fact.

The three phase 4 numbers worth carrying out of this document. **34,072 cities in the index** off
the real 34,099-row dump, the 27 refusals being dead places, counted where a person can read them.
**"London" answers in 1.46 microseconds in process and 2.1 milliseconds over HTTP** against a
300-millisecond budget, with the English one first and Ontario directly below it. **Four identical
`/api/search?q=Buckingham Palace` requests cost exactly one upstream Nominatim call**, 563ms cold
and 1.8ms warm.

**Phase 4's review findings are applied.** Four reviewers attacked it and seventeen findings
survived an adversarial pass. Fifteen are fixed, two are rejected with reasons, and the whole
list is below under "The phase 4 review, finding by finding". The sharpest was a blocker: a
Nominatim outage on a 79-character query answered `/api/search` with an HTTP 500, because the
degraded group's own reason string overflowed its 300-character contract. The most expensive to
have shipped was silent: a CDN error page served with HTTP 200 was cached over the working city
dump, and the weekly floor then short-circuited onto it for a week while the product reported
that the refresh had never run.

Three things are worth reading before the evidence.

**The aircraft union has exactly one live member.** That is a source-access problem, not a code
problem. adsb.lol is keyless and answers. ADS-B Exchange answers HTTP 401 without a paid key and
prohibits redistribution even with one. airplanes.live answers HTTP 403 until somebody sends the
access email. adsb.one answers HTTP 403 from this network. All four re-verified live today.
adsb.fi is the failover inside the adsb.lol client rather than a union member, per R3. So the
union is a correct implementation behind an access blocker, and the coverage argument ADR 010
rests on is unproven. Adding a provider is one row in `UNION_PROVIDERS`
(`src/tracker/sources/adsb.py`) plus a base URL.

**The LADD flag has a real source and it is the feed, not the FAA.** `dbFlags` bit 8 on the
readsb `/v2` schema is the LADD bit. readsb documents the bitfield in `README-json.md`, adsb.lol
publishes `/v2/ladd` on top of it, and 17 of 856 live aircraft carried the bit on today's run.
Both re-verified today, output below. Anyone reading this file expecting criterion 2 to be
unbuildable should read that section: the FAA registry genuinely has no LADD column, and it does
not need one, because the flag arrives on ordinary position queries from a volunteer receiver
network.

**A green gate is not a working product.** An adversarial pass in an earlier phase found a
frontend vessel layer that nothing imported and a Cesium asset copy that broke every render,
with both gates green throughout. A green gate buys you that the contracts hold, the adapters
map what they claim, the drop counts are real and the cadence floors cannot be configured away.
It does not buy you that a layer is wired, that a browser draws anything, or that an upstream is
reachable. Those need a running server, a real browser and a curl, and this document keeps the
two apart.

## Works

### The badge density at the opening view is the honest state, decided on measurement

Decided 2026-08-24 and deliberately not changed. At the whole-globe default, five layers draw
roughly **22 badges** and they cover Europe and the Mediterranean in a visible lattice. That is
what 24,698 entities on screen look like when each badge carries a true count, and **you cannot
have fewer without either hiding more or smearing more.**

Measured at 1400x900 against live feeds, seven cell sizes and five minimums, driving the
clustering engine directly rather than editing the shared constant. Both levers were costed:

- **A coarser cell works at the top and is paid for at the bottom.** Doubling `CLUSTER_CELL_PX`
  from 56 to 112 takes the opening view from 22 badges to 12 and the worst 300-pixel window from
  17 to 9. It also takes vehicles drawn as themselves at the transit feed's densest city from
  **568 to 280**, so 288 vehicles disappear into badges at exactly the zoom where somebody is
  looking at vehicles.
- **A higher minimum is worse and looks free.** Getting from 22 badges to 13 costs **1,170 loose
  marks**, because every cell that no longer reaches the threshold draws its members
  individually. That is the smear clustering exists to remove, arriving through the front door.
  At a minimum of 50 it is already 131 loose marks bought for four fewer badges.

**The finding that settled it is that the badge count is not a smooth function of cell size.** A
cell is a partition, so shifting its boundaries changes which entities share one: 112 gives 12
badges and 128 gives 18, 56 gives 22 and 64 gives 23. The swing is about a quarter either way
depending on how the grid falls over the data, so any chosen figure carries that noise and "112
is right" would be indefensible later. That converts a tuning question into a reason not to tune.

**A zoom-dependent cell would get both columns and was rejected for a specific reason.** 112 wide
and 56 close gives 12 badges up top and 568 vehicles drawn individually down below, and it is
about thirty lines because `ScreenClusterer.begin` already recomputes its geometry per call. The
no-overlap guarantee survives it, since that rests on the badge being narrower than the cell and
badges sitting on lattice points, neither of which needs the cell to be constant. **What kills it
is the visible reorganisation when the camera crosses a band**: badges jump to a new lattice and
counts change, once per crossing, on a camera that moves continuously. This project has twice
fixed things that merely read as a broken render, the empty badge hexagons and the false-colour
cloud sheet, and buying tidiness with a third artefact is the wrong direction. Blending across the
boundary is a bigger piece of work than the change.

**Europe is dense because that is where the data is.** 1,068 transit vehicles within 25km of
Prague, 641 Helsinki, 601 Amsterdam, 523 Sofia, against **52 in the whole of California** and zero
in San Francisco, London or Sydney. The bounding box spans California to Japan and the weight sits
in central and northern Europe, so the band is a true picture rather than five layers coinciding.

**The lever not taken, which costs no code**: all seven layers are on at first load, which is what
puts five sets of badges over one region simultaneously. The rail already lets a viewer switch any
of them off. That is a defaults decision rather than a rendering one and it is Alexander
Fanthome's, because opening with transit off hides a feature he asked for.

### The transit layer is wired, and one shared-client defect was hiding a tenth of it

Wired and verified live 2026-08-24. The GTFS-Realtime adapter and its 258-feed registry were
built by another agent; this was the wiring into `app.py`, `config.py`, `state.py`,
`routes_entities.py` and `routes_meta.py`, plus the credit structure.

**Live figures, one running server at 07:55 UTC.** 17,217 vehicles served, 17,217 distinct
merge keys so zero collisions, 17 countries, bounding box lon -122.4 to 153.5 and lat -35.3 to
71.0. Zero feed failures. Zero records at 0,0 reached the API. The oldest report served was
300 seconds old, which is the adapter's own window.

**The defect worth writing down: the shared HTTP client was claiming `Accept:
application/json` for every upstream in the project, and it was false.** GTFS-Realtime is
protobuf, so a server honouring the header refused to send it: **32 requests answered HTTP 406
Not Acceptable and 12 to 16 feeds failed on every sweep**, roughly a tenth of the layer, with
nothing in the adapter at fault. Removing the header took it to 3 and then to zero feed
failures. The same header was also wrong for the NMEA feed, the GeoNames zip, the imagery
layers and every CSV registry; nothing here relies on content negotiation for JSON, because
they all say `format=json`, `f=json` or `[out:json]` in the request itself. Two `data.gouv.fr`
dataset-resource URLs still answer 406 and need a per-request `Accept` in the adapter, which is
its owner's file.

**The failure mode the wiring exists to prevent, proved live.** A 30-second poller against
hosts whose floors are 30, 120 and 350 seconds skips most of the registry on most passes, so
`upsert_many` rather than `replace_all` is load-bearing. Four consecutive sweeps:

| Time | Vehicles held | Read or confirmed | Skipped inside a floor | Failures |
| --- | --- | --- | --- | --- |
| 07:53:51 | 16,818 | 129 | 129 | 0 |
| 07:54:23 | 17,114 | 185 | 73 | 0 |
| 07:54:55 | **17,383** | **83** | **175** | 0 |
| 07:55:27 | 17,094 | 113 | 145 | 0 |

At 07:54:55 the sweep skipped 175 of 258 feeds and the store **grew** rather than collapsing to
the 83 that answered. Replacing would have blinked the layer down to a third and back roughly
every other pass. The small dip after it is time-to-live expiry of vehicles that stopped
reporting, which is the mechanism that is supposed to remove them.

**Drops reach `/api/layers` by reason, not by feed.** 258 feeds would be 258 rows nobody reads;
the useful question is what kind of record is refused, because a freshness problem and a
null-island problem have different fixes. Live: 19,406 reports older than the window, 491 with
no position, 51 at 0,0, 6 where a feed repeated an entity id inside one message, 3 timestamped
in the future.

### The 183 transit credits are served as 8 rows, and the licences chose the shape

The framing "183 is too many for a menu" was wrong, and the licence texts are what settled it:
three of the six licences require three different things said, so a grouping that ignored that
would have been shorter **and** non-compliant. Each row carries a complete compliant sentence,
its licence and canonical URL, its operators each with their own terms URL, and a date.

**Etalab 2.0 is the one that changed the data shape, and it is the largest block at 101 feeds
and 67 credits.** It requires "sa source (a minima le nom du Concédant) **et la date de la
dernière mise à jour de l'Information réutilisée**", and a static credit list cannot carry a
date. So `as_of` is resolved per request from the freshest record actually held for that
licence, because the licence asks about the information *being reused*, which is what is on
screen. Verified live: the Etalab credit came back stamped `2026-08-24T08:11:56Z`, naming its 67
producers in `operators` rather than in prose. A licence holding nothing carries no date, which
is correct rather than a gap. See "The Etalab date is carried" below for what closing it
exposed: a date landing on the aircraft and geocoder credits because they share the ODbL licence
string, and a standalone-compliance claim in the docstrings that no wording could have met.

**ODbL will not accept the operators' names alone**, wanting a notice conveying both the source
and the licence, so the licence is inside the sentence rather than only in a neighbouring field
a client might not render. **The 41 "operator terms" operators have 38 different terms pages**,
so that row has no group URL at all and each operator carries its own: picking one would have
stated the wrong terms for 38 of them. **CC0's 18 credits are the only ones owed nothing** and
they are kept anyway, because dropping them would be the only place in this project where
provenance was traded for space. **King County and Hamilton mandate exact words** and get their
own rows, never merged.

One thing the backend cannot honour and the frontend must: COTA, Community Transit and Duluth
Transit forbid use of their marks in any manner likely to cause confusion or that disparages
them, and COTA requires links to its site to open full-screen rather than framed.

The full reasoning, licence by licence, is in `docs/data-sources.md`.



### The transit layer stopped drawing buses where they used to be

Fixed and verified 2026-08-24. Worst position age on screen is **532 seconds against 1,814
originally**, median **61 against 359**, and 3.7% of held vehicles are over five minutes old
where 56% were. Nothing exceeds the derived 540-second bound. Backend gate green at 2,406 tests.

**Two numbers add and neither of them said so.** `EntityStore` expires on the time it was handed
a record; the adapter decides how old a report may be when accepted. The store held 1,050
seconds and the adapter accepted 900, so the layer could draw a position 1,950 seconds old and
nothing anywhere stated that figure. For a road vehicle at the measured 11.9 km/h that is three
kilometres of unobserved movement, which is the same error this project refuses to make by
extrapolating, held silently rather than openly.

**Both terms came down on their own measurements, not by taste.** The acceptance bound went 900
to 300 seconds because a live sweep showed acceptance ages of median 49s and p90 82s, with only
two records of 5,196 sitting between 600 and 900: the old bound permitted a great deal while
doing almost nothing, and 300 costs 151 vehicles of 5,196, 2.9%. Who pays is the right set:
France 22.8% and Norway 19.6% over the bound, everyone else under 3%, and those two are the
retention-policy feeds where losing a last-known position is the point rather than the cost.
Below 120 seconds the curve falls off a cliff to 64.3%, because publish cadences are themselves
30 to 60 seconds, so a freshly fetched report is already that old.

**The store's figure was measured wrong twice and the second cause is the instructive one.** It
was derived from the slowest entry in `HOST_MIN_INTERVAL_SECONDS`, `passio3.com` at 350 seconds,
and that host governs **no feed at all**: all 23 of its feeds were dropped for having no licence
recorded. So the figure was three times too large and taken from something the registry never
calls. It now derives from `max(feed.min_interval_seconds for feed in FEEDS)`, which is
self-correcting, giving 120 and therefore a 240-second store.

**A coupling worth keeping asserted.** The acceptance bound must stay above the largest floor
that governs a feed, or our own rate discipline manufactures stale drops: a feed we choose to
poll every 350 seconds cannot produce a report under 300 seconds old. There is 180 seconds of
headroom today and a test holds it.

### The transit vehicle count moves by a factor of 2.7, not a quarter

Corrected 2026-08-24 after seven sweeps across a full day. The shipping registry runs **3,629 at
00:48 UTC to 9,668 at 16:50 UTC**; the wider candidate set swings 96%.

The earlier "around a quarter" figure was wrong because the first four sweeps all fell inside one
European working day, and Europe is the largest block of feeds in the registry, so the swing was
reported with confidence without its low point ever having been seen. Finding it required
carrying the sweeps through the European night.

**Our own licence rule made the layer more volatile.** The shipping registry swings 166% against
the candidate set's 96%, because the rule dropped proportionally more Asia-Pacific feeds and left
the layer more Europe-weighted. Right on its own terms, and worth knowing.

**No single sweep sees more than a fraction of the world awake.** The United States peaks at
18:50 UTC, Australia and Japan at 22:33, Poland at 10:21, France at 16:50. Sweep G at 00:48 is
simultaneously the global low and Australia's high.

### The profile-to-asset join runs, and it only runs person to asset

Wired and verified live 2026-08-23. Backend gate green at 2,352 tests and 99.65% branch coverage.

**From one live viewport over the centre of the United States: 345 aircraft airborne, 126
joined, 65 asserted and 61 shown as possible matches, across 9 companies and 22 named people.**
Refusals counted rather than hidden: 169 because no filing entity carries that name, 30 because
the registrant is a natural person and a person is never name-matched. The remaining 20 are not
on the civil register at all, which is military and foreign aircraft and is a skip rather than a
refusal. A resulting profile carries **5 filled fields and 11 empty**, `wealth_tier` None and
`has_pii` False. The whole refresh, including the 73MB register download, took 10.0 seconds.

The companies airborne were the four large airlines, Boeing, UPS, Republic and JetBlue, and then
**Jack Henry & Associates**, a financial-technology firm with a corporate flight department.
That last one is the demo case, alongside Buckle Inc and Micron Technology from the earlier run:
a named officer from a primary filing, that company's aircraft, and a live position.

**The direction is not a choice, it is a fact about the population.** Measured against this
project's own feed, 44 of 44 owners in a jet-heavy New York sample were entities, and 75% of
organisation owners resolve to nothing in Wikidata because they are single-purpose companies
holding one aircraft with no public footprint by design. Full reasoning and figures are in
AGENTS.md under "People, registries and filings".

**Assertion is earned by a measured false-positive rate.** Exact normalised name matching gives
one collision across 7,997 SEC filers, 0.02%, and **zero ambiguous cases across all 78,140
organisation registrants**. The looser rule that strips legal suffixes reaches more aircraft,
1,201 for United and 987 for American, because the SEC indexes holding companies while aircraft
register to operating subsidiaries, but it also produces `KESTREL INC` to `Kestrel Group Ltd`,
which is a guess. So the whole looser tier renders as a possible match with its score, is
excluded from every aggregate, and never asserts. `spine.asserted()` is the single place that
decides, so a card, an aggregate and an API response cannot disagree.

**A natural person is never name-matched, and the refusal beats an otherwise perfect match.** Six
FAA rows typed Individual carry company names like `SOUTHWEST AIRLINES CO`; a test asserts the
type filter wins anyway. An unknown registrant type is refused like a person, because 1,246 rows
carry an empty type. The measurement behind the rule: of 23 registry owners that look like
natural persons, two returned any Wikidata candidate and **both were wrong**, one matching three
researchers and a Waffen-SS tank commander.

**`sources/sec.py` caches nothing at all**, which is stronger than adding a removal hook.
Lookups are demand-driven so there is no restart burst to protect against, and following the
adsbdb reasoning a cache of named people is a cache a removal has to reach. The test asserts the
consequence: after a real lookup, neither the person's name, nor any token of it, nor their CIK
appears anywhere in the disk cache file.

**Wealth tier is a permanently unavailable capability row rather than a silent blank**, because
eleven empty fields on a profile read as a bug unless the product says why. All of Wikidata holds
2,076 humans with a net worth statement, 58% of a 900-row sample cite no source at all, and only
four figures are dated 2026.

### Buses and trains are on the globe, from 258 keyless feeds

Wired and verified live 2026-08-23. `/api/layers` reports **5,645 transit vehicles** beside
5,981 vessels and 698 satellites, with the feed healthy. Full backend gate green at 2,282 tests
and 99.54% branch coverage.

**It is the widest layer geographically in the project**, which nothing else here is: longitude
-122.5 to 153.5 and latitude -27.5 to 70.5, so California to Japan by way of Australia, against
the vessel layer's northern Europe plus the Great Lakes. Live spread by country: US 1,747,
Netherlands 1,329, Czechia 665, Norway 528, Japan 368, France 301, Finland 195, Poland 170.

**The store is `upsert_many`, never `replace_all`, and the conditional request is why.** A sweep
legitimately skips a host inside its own floor and legitimately receives HTTP 304 with a
zero-byte body from a host whose feed has not changed. Both mean the held records still stand.
Replacing from one sweep would delete every vehicle on every skipped and unchanged host, which
is most of the registry on most passes, and the layer would flicker. `SweepResult` separates
`unchanged` from `polled` for exactly that reason.

**The cadence is not the floor.** `transit_poll_seconds` starts a pass at 30 seconds; the client
refuses a host inside its own window, so `www.data.gouv.fr` waits 120 and `passio3.com` waits
350. The floor has to be per host because 99 of the 258 feeds sit on one public-sector host and
a per-feed floor would take 3.3 requests a second off it. The store's time to live is derived
from the slowest floor in the registry rather than from the cadence, so a host at 350 seconds
does not blink its vehicles off the globe between two polls.

**An empty feed is not a broken one.** 261 of 265 feeds carrying nothing in one sweep had a
header timestamp under five minutes old: alive, with no buses running. Across four sweeps the
fleet moved 23% with the time of day, the US going 2,391 to 6,039 while Japan went 518 to 2. So
only a pass where no feed could be read at all is a failed poll.

**Coverage is stated rather than implied.** The capability reason reads "Europe and North America
only. No keyless feed exists for 5 regions." 17 countries, after 184 catalogue feeds were dropped
for having no licence recorded anywhere and 7 more for sitting behind an acceptance agreement,
which is this project's own drop-unlicensed rule rather than a judgement call.

**Attribution is grouped by licence, not by operator, and that is a licence decision rather than
a space-saving one.** 183 distinct credits became 8 rows: two verbatim licensor mandates kept
word for word, and six licence groups. Three of the six licences want different things said, so a
list that ignored that would have been both longer and wrong. ODbL's 46 feeds need the licence
named alongside the operator, which each feed's own credit string already carries. CC-BY's 35
need the licence link. CC0's 31 owe nothing at all and are kept as courtesy.

## Broken or not yet built

### The removal route needs an authentication story before this app goes on a network

Added 2026-08-24 with the removal control. `POST /api/removals` is the first and only endpoint in
this application that writes anything, and what it writes is the deletion of a person record.
**It is unauthenticated, because this application has no authentication anywhere**: no users, no
sessions, no keys of its own. Inventing a bespoke credential for one endpoint would be worse than
saying so, because a single hand-rolled secret in an app with no auth model gets trusted more
than it deserves.

What holds today is that `Settings.host` defaults to `127.0.0.1`, so the shipped configuration is
reachable only from the machine it runs on, and the route **refuses in code** when the API is
bound to anything else rather than warning about it. `bound_to_loopback` in
`src/tracker/api/routes_removals.py` is that check and it runs per request. So the exposure is
structural rather than documentary, which is the same habit as the rest of the codebase.

The blocker is what happens if anyone wants this on a network. Setting `host` to `0.0.0.0` does
not create an open delete, because the route declines, but it does mean **the removal control
stops working**, and a product whose removal control has silently stopped is worse than one that
never had it. So a public deployment needs an authentication story *before* this route in
particular, and it sits alongside the phase 6 US privacy position as a precondition rather than a
nice-to-have.

Note the corollary, which is easy to miss: this is the only part of the product that a network
deployment would turn off rather than expose.

### Three user-visible claims were false, and one was a string that outlived its own feed

Fixed 2026-08-24, all three verified live on one server.

**The vessel layer said "Northern Europe only" while 27.1% of its ships were in North
America.** `sources/aisstream.py` carried "Ships shown for Northern Europe only. Global AIS
needs a key", and live there were **1,614 of 5,948 vessels west of 50°W, every one from
`seaway`**. The contradiction was on the same rail row twice: that sentence sat directly above
a provider line reading `seaway only: 1,614`, so a viewer looking at Lake Erie was told there
was no coverage there while counting the ships.

The string was written the day before to replace one naming an environment variable, and then
the Seaway feed was added and invalidated it. Nobody went back. **Same shape as the cameras
row: grammatical, confident, and outrun by a feed added after it was written.**

Better wording would have gone stale on the next authority, so **the reason is now derived**
rather than described. `_vessel_coverage_reason` counts the providers that actually reported,
which is the same data the provider lines beneath it are built from, so the two cannot
contradict each other again: it reads "No worldwide AIS feed is available. Coverage is the 4
regional feeds reporting", and the rail shows exactly 4 provider lines. Adding a fifth
authority changes the number with nobody having to remember the string exists. What it claims
is what is **absent** — no worldwide keyless AIS — which only stops being true on the day the
row disappears anyway. Two tests forbid the class of claim rather than pinning a wording: one
asserts the count comes from the union, the other that no region word appears in it.

**The credits panel was confessing to a licence breach we are not committing.** Four credits
named sources the same payload reported `available: false`, none of them in any provider tally.
The sharpest was ADS-B Exchange, whose credit asserted "Unfiltered aircraft data from ADS-B
Exchange" beside its own licence field stating that redistribution to a browser is prohibited.
A provenance panel claiming we redistribute data we are barred from redistributing is worse
than a missing credit.

Not deleted, because a credit exists so a source cannot ship uncredited and that has to keep
working. `Attribution.requires` names the capability row a credit depends on, and a credit is
served only while that row is available — one computation of "can this serve" rather than two
that drift, and the credit returns by itself the day the source does. Live: 21 credits served
instead of 25, with `adsbexchange`, `airplanes.live`, `aisstream.io` and `AISHub` all absent and
all four named accurately by their capability rows. `adsb.fi` is deliberately left credited: it
is a live failover that could serve at any moment.

**The social layer had no capability row at all**, so it was the only live layer that could
never report itself bounded, and its two real limits reached a viewer only as a transient
notice. It now carries `available: true` with "Posts near one point, not worldwide: 10km
radius, 500 files per provider", following the transit row's precedent that an available layer
may state its scope. Both figures are Wikimedia Commons' own caps rather than ours. It is worth
saying because "no posts here" and "you have not asked about anywhere" look identical on a map.

### A drop reason is not a provider, and the layer rail was rendering the difference

Fixed 2026-08-24. The rail was showing a viewer six lines under the transit row, five of them
zeros, reading "Seen by one provider alone: report older than 5 minutes only: 0". That is not a
sentence about anything, and **the rail was right to render it badly because it was being handed
the wrong kind of thing.**

`ProviderCoverage` answers one question: how many records did only this provider see. A drop
reason has no records and nothing is exclusive to it, so every reason row came out
`records: 0, exclusive: 0`. Reasons were being fed through it because the tally that holds them
was a `dict[str, ProviderTally]` keyed on the reason.

**The same category error was in the aggregate row and produced a contradiction.**
`empty_polls` read **175 against 83 polls**, which cannot both be true of one provider. Both
were true of a **258-feed registry**: 83 feeds read and 175 held back inside a host cadence
floor, 83 + 175 = 258. Feed counts were sitting in fields that mean poll counts. Not a separate
defect, the same one in a second place.

Refusals now have their own shape. `/api/layers` grew a `sweeps` array carrying
`SweepCoverage`: `feeds`, `read`, `unchanged`, `skipped`, `failed` for the last pass, plus
`refused` as reason-and-count pairs, cumulative, **non-zero only**. A reason that has never
fired is not information, and filtering it at the presenter would have left the wrong shape
underneath for every other client. `state.transit_providers` became
`state.transit_refusals: Counter[str]` and `state.transit_tally: ProviderTally`, because the two
were answering different questions and sharing one dict is what let the leak happen.

Verified live on one server:

| | Before | Now |
| --- | --- | --- |
| provider `polls` | 83, meaning feeds read | **3**, meaning passes run |
| provider `empty_polls` | 175, meaning feeds skipped | **0**, meaning passes that produced no vehicle |
| rows whose provider is a reason | 5, all reading 0 | **0** |
| the same pass, in `sweeps` | nowhere | read 108, skipped 145, unchanged 5, failed 0 |
| arithmetic | did not close | **108 + 145 + 5 + 0 = 258**, the registry |

The refusal counts, which are the point of counting them, survive intact: 5,566 reports refused
as older than five minutes, 2,302 with no position, 62 at 0,0, 3 for a repeated entity id inside
one message, 1 timestamped in the future. The `gtfs-rt` provider row stays where it is, holding
16,146 vehicles with `exclusive` equal to `records` because one adapter supplied every one.

The rail half is separate and belongs to whoever owns `layer-rail.ts`.

### The Etalab date is carried, and the transit blocker is closed

**Closed 2026-08-24, verified live.** Etalab 2.0 requires "la date de la dernière mise à jour de
l'Information réutilisée", the date of the last update of the information reused, not merely the
producer's name. That was **101 of the 258 feeds and 67 of the 183 credits**, by far the largest
block, with Bizkaia's CTB imposing the same condition. The layer was held back from public
display until it was met.

`/api/capabilities` now serves, on one running server at 08:11 UTC: 25 credit rows, **6 carrying
181 structured operator entries** and **8 carrying a date**. The Etalab row names its 67
producers as data rather than prose, links `data.gouv.fr/pages/legal/licences/etalab-2.0`, and
came back stamped `2026-08-24T08:11:56Z`.

**The date is resolved per request from the freshest record actually held under that licence**,
because the licence asks about the information *being reused*, which is what is on screen. A
build-time constant would have described when the registry was compiled. With the store holding
240 seconds of vehicles against a 300-second acceptance window, that date moves every few
minutes, which is what a live feed should do. A licence holding nothing carries `None` rather
than today.

**Two things this exposed that were worse than the missing date.**

A date was landing on the wrong layer. Licence names are not unique across sources: adsb.lol,
Nominatim and 46 of the transit feeds are all "ODbL 1.0", so resolving by licence alone stamped
the **aircraft feed's** credit and the **geocoder's** credit with a French bus's last
observation. Measured live: 10 rows dated, only 8 of them transit. `Attribution.layer` now says
which layer a credit is owed for and the date is keyed on it, so 8 rows carry a date and all 8
are transit.

And the standalone-compliance promise in the docstrings was false and could not be made true.
`text` claimed to be "a complete, compliant sentence on its own", which was never achievable for
Etalab: the condition needs a per-request date and `text` is built at import time, so no wording
of any length discharged it. Naming all 67 producers in prose made the sentence **2,024
characters** and still did not comply. `text` is now 68 characters, the owners are structured in
`operators`, and the docstrings say the true thing: **a row is compliant, not a field.** A client
discharges these licences by rendering `text`, `url`, `operators` and `as_of` together.

Untouched, as they must be: the two verbatim licensor mandates keep their own rows and their
exact wording, and the 31 CC0 feeds are still credited as courtesy rather than obligation.

**The frontend half landed the same day, and the blocker is closed at both ends.**
`frontend/src/ui/attribution.ts` renders the date on the row and the owners behind one
disclosure. Verified in a real browser against the live server rather than against a stub: the
menu holds 26 rows of which **6 are grouped**, each showing its licence and
`information last updated 2026-08-24 08:14 UTC` with nothing clicked, and the Etalab row's
summary reads "67 operators and their terms" with **67 links in the DOM**, hidden while closed
and visible on one click, first `ALEO` and last `Valence Romans Mobilités`.

**Each owner links the terms binding it, not one link standing for all of them**, which the
39-owner "operator terms" group shows is load-bearing rather than decorative: it carries **36
distinct URLs** across its 39 owners. The standard-licence groups share theirs, as they should,
1 URL across ODbL's 27 owners and 2 across Etalab's 67.

**The date is on the row and the owners are behind a disclosure, and the split is deliberate.**
A date inside a closed `<details>` is not displayed, and Etalab asks for it to be displayed. The
owners sit behind the same affordance the whole menu rests on, because 181 owner names open at
rest is the panel across the bottom of the globe that the "i" control was built to remove.
Measured: the open menu is 432px tall, and stays 432px with the 67-owner row expanded, because
the list scrolls inside its own 60vh cap rather than growing. That is a judgement rather than
something the old "text is compliant alone" promise made safe, and it is recorded here so it can
be overruled rather than discovered.

The two verbatim mandates are untouched at this end too. Both carry a date, since the vehicles
behind them are as live as any other, and a date beside a sentence neither reformats nor
truncates it. Neither gets a disclosure, because each row stands for one owner. Asserted by a
test rather than left to care.

### The app opens on a globe, and every cluster badge says how many

Verified 2026-08-23 with the whole gate green: backend 2,054 tests at 99.51%, frontend 806
tests with `pnpm verify` exiting 0 at 93.78% statements, and all 21 Playwright tests passing.

**The opening camera is the whole Earth.** `globe/viewer.ts` opened 2,400km over London, which
frames a few thousand kilometres of Europe and no globe at all, and Alexander Fanthome's
complaint was that he could not see one. It is now longitude 0, latitude 25, at 20,000km. The
figure is derived rather than picked: the disc fits when its angular radius is inside half the
vertical field of view, and Cesium applies its 60-degree default to the wider dimension, so a
1400 by 800 window gets about 36.6 degrees vertically and `sin(18.3) = R / (R + h)` puts the
floor near 13,900km. This is that plus a third, so the limb stays clear of the edge.

Two independent measurements landed on the same answer. Mover marks now scale with camera
range, so a wide view no longer buries the continents. And the cloud layer has no usable
imagery over London at all, which sits 80.8 degrees off nadir from GOES-East where the
reprojection quilts into visible stair-stepping; pulled back to a globe it reads correctly.

**Every cluster badge rendered as an empty black hexagon, and the cause was a render pass.**
The three mover layers cluster crowded marks into a badge carrying the count. On the globe the
counts were invisible, so the badges read as holes punched in the Earth, which looked far worse
than the crowding they fixed. The badge collections are `BlendOption.TRANSLUCENT` while the
count collections took the `LabelCollection` default, and **Cesium draws every translucent
command after every opaque one whatever order the primitives were added in**, so each badge was
painted straight over its own number. The layers had even added the collections in the right
order with a comment explaining why a count must not end up under its badge; primitive order
was simply not what decided it. Both now share the translucent pass and the counts read: 1811,
1350, 515, 383 over northern Europe. Measured, not reasoned: the digits reappeared on the one
layer patched to test the theory and nowhere else.

**Two linters were failing on a plugin's scratch directory.** `frontend/.remember/` is
gitignored and regenerated by a save hook, so deleting it does not stop it coming back, and the
type-aware eslint parser fails on a file outside `tsconfig.json` and takes the whole gate down.
Both configs already ignored `.omc` for the same reason; `.remember` joins it.

**Three e2e tests were quietly asserting the opening view.** Every stub entity in
`e2e/smoke.spec.ts` sits at the old default camera position and the tests reached it by opening
`/` and inheriting that default, so moving the camera read as three broken features rather than
one deliberate change. They now ask for the camera they need through the URL hash, the same way
the shared-link test does. A test about clicking a mark should say where the camera is.

### The four info cards are wired and reachable

Verified live 2026-08-23. Aircraft, vessel, satellite and place, each with the same silhouette
the globe draws for that object, imported from `globe/icons.ts` rather than redrawn, so a card
and the map cannot disagree about what a ship looks like.

The satellite card shows the age of the **element set** rather than of the propagation, and puts
the position on its own line reading "computed here, not observed", because the browser works
that position out from an orbital element set and nobody observed it. The place card refuses to
name a country or region: GeoNames' `admin1_code` is not reliably a country code (London GB
carries `ENG`) and the file that would resolve it is not fetched, so the field stays empty
rather than guessing.

Cities are now pickable. The pick-id namespace is shared across four layers, and a bare GeoNames
id would have collided with an aircraft's ICAO 24-bit address, since a six-digit decimal id is a
valid one, so a click on a city could have opened an aircraft card. Cities use `city:<id>` and a
test asserts neither prefixed scheme is a prefix of the other, which is the property the routing
actually depends on.

### The vessel layer reached a second continent, and that is the ceiling

Built and verified live 2026-08-23. Two more keyless members, taking the union from two to four
and the store from 1,898 vessels to **6,001**.

**Transpordiamet (Estonia)**, an ArcGIS FeatureServer. 609 vessels in the eastern Baltic and
the Gulf of Finland, 263 of them ships no other provider sees, and it reaches further south than
Fintraffic to the Latvian coast. **Finding it took going through a web map**: the authority
publishes an Experience Builder viewer and no API reference, so the endpoint had to be
enumerated out of the portal's service directory, and the AIS layer is not in the maritime
folder but in `Hosted`. The folder that *is* named for vessel traffic holds 52 density rasters,
which is how a quick sweep of that host concludes "density only" and moves on.

**Seaway VIS (Canada and the United States)**, a GraphQL endpoint. **1,883 vessels across the
Great Lakes, the St Lawrence and the Gulf of St Lawrence, and the first ships on this globe
outside northern Europe.** Found by reading the public traffic map's own JavaScript bundle.
Keyless proved rather than assumed: a cold POST with no cookie, referer, session or
authorization header returned all 7,118 records, `robots.txt` on both its hosts permits
everything, and the map's bundle names this endpoint and contains the word "anonymous" nineteen
times. The same schema exposes users, roles and pilot assignments, so **the adapter queries the
AIS fields and nothing else** and a test asserts the query string contains none of them.

**The traps that would have produced a plausible wrong answer.**

- **Seaway's `age` field is not an age**, it is an absolute ISO 8601 instant. And the body is a
  **sixty-day roster rather than a snapshot**: median report 2.4 days old, p90 33.6 days, 4,100
  of 7,118 over 24 hours. Served as-is it draws four thousand ghost ships and looks like a
  working layer. The server cannot help, because its own age filter is in whole days, so the cut
  is local at ten minutes to match what the other three providers already do. Live, that drops
  5,242 records to keep 1,883, and `/api/layers` reports both numbers.
- **Seaway's `sessionFilterOverrides` is a required argument with about seventy non-null
  booleans and no defaults**, and setting any inclusion flag false removes that class of vessel
  with no error and no count. A test asserts the request carries all 70, 50 true and 20 false,
  because the bug is invisible in the response.
- **Estonia's default spatial reference is EPSG:3301, Estonian grid in metres.** Without
  `outSR=4326` a berth reads `x: 466890.13, y: 6529584.57`, which fails a WGS84 contract on every
  record, so the layer would read as an empty sea rather than as a wrong parameter. The adapter
  refuses any reference but 4326 rather than reprojecting, because Cesium owns all projection
  here and a subtle reprojection error returns a valid answer about the wrong place.
- **Estonia's `sys_timestamp` is the constant `-2209161600000` on every record**, which is 1
  January 1900. The real fix time is `timestamp`. Read the wrong one and the whole feed dates to
  1900 and loses every recency contest in the union. It is deliberately absent from the wire
  model so nothing can reach it.
- **Both new providers return errors inside HTTP 200**, ArcGIS with an `error` key and GraphQL
  with an `errors` array. That is the third and fourth instance of this trap class in the repo.
- **Seaway's `accuracyType` reads `MALFUNCTION` on 6,103 of 7,118 records and it does not mean a
  bad position.** The bounding box of the fresh MALFUNCTION records is the same water as the
  HIGH ones. Dropping on it would have thrown away four fifths of the live feed for nothing.

**Two defects were found by writing the tests, not by the feed breaking.**

The first was mine: the Estonian client's paging loop concatenated pages, so a vessel whose row
moved between two offset-based requests would appear twice. ArcGIS pages over a dataset being
written while it is read, so that is a real possibility rather than a hypothetical, and the
count would have been wrong before the merge ever collapsed it. It now dedupes on MMSI keeping
the freshest, which is the ADR 010 rule applied inside one provider.

The second was older and it dropped real ships across **every** AIS provider.
`speed_over_ground_mps` mapped the 102.3-knot not-available sentinel to `None` and refused
negatives, but the contract's own field bound is 100 knots, so a wire value between the two
passed the sentinel check, converted cleanly, and was then rejected by the field, **dropping the
whole vessel over one display attribute**. MMSI 273253530, "RATNIK", reported 102.2 knots on the
Estonian feed and vanished from the globe. The guard now lives in the shared helper rather than
in five adapters, so an out-of-range speed empties the speed and keeps the ship, exactly as
`imo`, `ship_type`, `draught`, `length` and `beam` in that contract already did. **This reverses
what a test in `test_fintraffic.py` used to assert**, and the reason is that the old test's
premise was disproved by real data: it assumed a speed above the bound meant the adapter had
missed the sentinel, and here the provider simply sent junk. RATNIK is now on the globe with an
empty speed, verified live.

**One thing about this provider needed a decision that was not a data question.** All three of
the Seaway's hostnames serve an incomplete TLS chain: the leaf alone, without the Sectigo
intermediate that signs it. curl and browsers paper over it by fetching the intermediate from
the `authorityInfoAccess` URL in the leaf; Python's `ssl` module does not, so httpx failed with
`CERTIFICATE_VERIFY_FAILED` against a host a shell command had just read fine. The fix is the
intermediate committed at `src/tracker/sources/seaway_intermediate.pem` and loaded into the
shared client's context. **This is not a weakening of verification and the reason is the point**:
that intermediate is signed by a root already in the default bundle, so it was already trusted
transitively and nothing new becomes trusted. All that changes is that the link the server omits
is available locally. `verify=False` would have been one character and is not on the table, and
two tests assert that `check_hostname` and `verify_mode` are both still on.

### The vessel layer stopped being Finland-only

Built and verified live 2026-08-23. Kystdatahuset, the Norwegian Coastal Administration's
realtime AIS endpoint, is the second keyless member of the ADR 010 vessel union. Keyless proved
rather than assumed: `robots.txt` is `User-agent: *` with an empty `Disallow:`, the OpenAPI
document declares its one `JWT Bearer` scheme on other paths and none on this one, and a call
with the User-Agent header suppressed entirely returned the full body.

**Before and after, from `/api/layers` on one running server.** 649 vessels from `digitraffic`
alone, then 1,898 with both, `digitraffic` 649 and `kystdatahuset` 1,249, `exclusive` equal to
`records` on both because the two feeds share no MMSI. 1,898 distinct MMSI across 1,898 served
records, and `providers[0] == source` on every one of them.

**The three traps the brief named were all real, and all measured rather than taken on trust.**

1. **The geometry is a `LineString` and the current position is its LAST coordinate.** Proved
   two ways. Taking the last segment as the direction of travel and checking it against each
   vessel's own reported course over ground gave a median error of 0.6 degrees across 585 moving
   vessels, inside 20 degrees on 97.9%; reversing it gave 179.4 degrees and 0.2%. Separately,
   across 638 vessels that reported again 163 seconds later, the old track's last coordinate sat
   a median of 0 metres from the new track. Taking the first coordinate would have placed 754 of
   3,477 vessels over a kilometre from where they were, 376 over five kilometres and one 38.9
   kilometres out, with nothing erroring.
2. **`ship_name` carries a `[NN%]` match confidence.** 15 of 3,542 records, 41% to 95%,
   space-padded before the bracket. Stripped in the adapter, and no served name contains a
   percentage. The strip is anchored to the `[NN%]` form only, because the same body carried
   `DOLPHIN01 [UNCREWED]` where the bracket is part of the vessel's real name.
3. **`draught` is an int on some records and a float on others in the same response.** 2,192
   ints against 1,350 floats out of 3,542, so a `strict=True` float field would lose 62% of the
   feed and a strict int field the other 38%. Same class as the `eo:cloud_cover` trap. Both
   kinds are in the committed fixture and a test asserts both survive.

**Two traps the brief did not name, found on the live body.** 77 of 3,542 features arrived with
`"coordinates": []` and complete properties, so a vessel with no position is dropped and counted
rather than given one. And `cog` carries the *heading* sentinel as well as its own: 542 records
read 360.0 and three read 511.0, so a `0 <= x < 360` check applied before the sentinel mapping
would reject 545 real vessels and read as thin coverage.

**Drop accounting closes exactly.** 3,542 features in, 3,399 vessels out, 124 dropped and 19
duplicate MMSI reports superseded by a fresher fix from the same provider. Every drop is a
non-vessel or a record with no position: 70 empty geometries, 29 unallocated ITU MIDs (fishing-gear
beacons), 21 auxiliary craft on the `98` prefix, and one each of a coast station, a handheld DSC
set, an aid to navigation and a SAR helicopter, that last one named "SAR AIRCRAFT CHC SAR".

**One thing is worse than the earlier research suggested and it is the provider's, not ours.**
The unfiltered call returned 3,542 features at 09:53 UTC and 1,467 at 10:18 UTC the same
morning, with the empty-geometry share moving from 2% to 21% over five polls. So the count this
layer serves swings by a factor of two and a half within half an hour, and the "triples our
ships" figure holds at a good moment rather than always.

**And the empty geometries are real ships, not beacons, which makes it a coverage question
somebody has to decide.** The records carry a name, a length, a status and a timestamp with no
position anywhere: SJOBAS, AQUA MARINE, CAMPUS BLAA, FRANCO. **93% of the ships with no geometry
at 10:20 UTC had a geometry at 09:53 UTC**, and only 6% of one poll's empties recovered one in
the next poll nineteen seconds later. So the provider is intermittently withholding positions it
held minutes earlier, the set churns rather than being a fixed group, and dropping is the only
correct handling because there is nothing in the payload to place them with. What that leaves
open is the vessel store's time to live, which is what decides whether such a ship flickers off
the globe or rides out the gap. Not changed here, because it is one number shared with every
other vessel provider. The obvious backfill route, `POST /api/ais/positions/for-mmsis-time`, is
keyless and **broken**: it answered HTTP 200 with `success: false` and a raw PostgreSQL
`42P01 relation "ais202608.ais_20260823" does not exist`, so the provider's own day partition
was missing.

**One decision is open and it is not mine to take.** A name arriving as `BUOY TJ3 [41%]` is the
provider telling us it matched that name to that MMSI with 41% confidence. The suffix is stripped,
but `Vessel` has no field for the confidence of a display attribute, so a 41% name and a 95% name
are indistinguishable downstream and both read as observed. Under ADR 011 a value produced by a
join is labelled derived, and this is one. Closing it is a contract change plus a card change,
so it is recorded at `sources/kystdatahuset.py` rather than decided there. 15 of 3,542 records.

**One licence correction.** `docs/data-sources.md` had recorded NLOD 2.0 for both Kystverket
endpoints. This API's own OpenAPI document names NLOD **1.0** and links `data.norge.no/nlod/en/1.0`,
re-read 2026-08-23. Both texts were read the same day and both grant copying, use and distribution
provided the contributor is acknowledged, so the credit discharges either and nothing practical
turns on it. The code serves what the provider stated for the endpoint we call.

### A failover credited the wrong provider, and so stated the wrong licence

Fixed 2026-08-23. Two of 1,040 live aircraft reached `/api/aircraft` reading
`source: adsb.fi` beside `providers: ["adsb.lol"]`. Both contracts promise in the
`providers` field description that "the first entry is the one named in source", so this was
a documented invariant broken in production.

**It is a licence defect, not a label defect.** adsb.lol publishes under ODbL 1.0 and adsb.fi
under non-commercial terms, so a card naming the wrong one of the two states the wrong terms
over the aircraft on screen. R3 confines the adsb.fi exposure to outage windows only on the
condition that the record says when it was served by adsb.fi.

**Cause: two different questions sharing one field.** `AdsbClient` polls adsb.lol and falls
back to adsb.fi inside one union member row, so the member we polled and the host whose bytes
we hold are not the same thing during an outage. `merge_providers` keyed its per-record
sightings on the member, while the adapter set `source` to the host that answered.
`ProviderSighting` now carries both: `provider` is the member, `served_by` is the host, and
`services/union.py` takes attribution from `served_by` while coverage maths keeps using
`provider`. That split matters, because `attributable_counts` answers "aircraft only this
feed can see", which prices a feed we subscribe to and would raise `KeyError` on a host that
is no member at all.

**Nothing caught it, and the test that should have was already there.**
`tests/test_app.py::test_the_union_member_falls_over_to_its_own_failover` drives the real
failover and its docstring already claimed the provenance is "visible on the record rather
than inferred", but it only ever asserted `source`. It now asserts `providers` too, and that
the polled member still owns the coverage count. Four more in `tests/services/test_union.py`
cover the serving host directly, including two members failing back to one host crediting
that host once, since one host's data twice is one origin and not corroboration. Backend
1,679 tests, 99.82%.

### Two attribution controls became one, and the CSS lost twice on the way

Verified 2026-08-23. The bottom left of the globe now holds a single 44px "i" and nothing else.
It used to hold the "i" plus Cesium's own "Data attribution" link, 17px to its right and jammed
7px off the viewport edge, both opening the same one list of credits. That is the clutter
Alexander Fanthome asked to be rid of, and it was a duplicate rather than a second source of
information.

**Proving it was a duplicate came before hiding it.** Measured in a real browser: Cesium's inline
text container was empty, and its lightbox held one string, `Imagery courtesy of NASA EOSDIS
GIBS`, which is character for character the last row of our own panel. It has to be, because
`ui/attribution.ts:46` owns that constant and `globe/viewer.ts:105` imports it, so there is one
string and both controls render it. Hiding Cesium's control drops no credit.

**Asserted, not assumed.** `frontend/e2e/smoke.spec.ts` now reads every credit Cesium holds out of
the hidden container and its lightbox and requires each to appear in the "i" menu. Hand Cesium a
second imagery provider with a hand-typed credit and the suite fails rather than quietly dropping
a licence condition, which is the failure mode a blanket `display: none` would otherwise create.

**The rule lost twice on specificity before it worked, both times silently.** `Viewer.css` ships
`.cesium-viewer .cesium-widget-credits { display: inline }` at (0,2,0), and Cesium's stylesheet is
imported inside `globe/viewer.ts`, which `main.ts` imports after `style.css`. So a one-class rule
lost on specificity, a two-class rule tied and then lost on order, and in both cases the credit
stayed on screen with no error anywhere: the browser listed our `display: none` first and Cesium's
`display: inline` last. Naming the real parent, `.cesium-viewer-bottom`, takes it to (0,3,0) and it
wins whatever import order does later. `!important` was not used, because import order is the thing
that moved and `!important` hides that rather than settling it. The old rule here had already hit
the same trap from the other side: it set `font-size: 13px` on one class against Cesium's (0,2,0)
`10px`, lost, and was worked around by styling the inner text container separately rather than by
counting selectors.

`CreditDisplay.cesiumCredit` in `globe/viewer.ts` still drops the ion logo and stays. Hiding the
container is not a substitute for it: a false credit displayed nowhere is still a false credit in
the DOM.

### Layer-rail reasons say what the viewer loses, not which variable to set

Verified 2026-08-23. Every capability reason is now 120 characters or fewer, asserted in
`tests/api/test_routes.py`, and a card reads `Ships shown for Northern Europe only. Global AIS
needs a key.` rather than a sentence naming `TRACKER_AISSTREAM_API_KEY`.

The old assertion required the environment variable name to be in the reason, on the theory that a
reason should tell you how to fix it. That intent is superseded: Alexander Fanthome ruled on
2026-08-20 that every source must be public with no API key, which puts the keyed providers out of
scope, so telling a viewer to go and get a key argues against the project's own constraint. The
test now asserts the opposite, that no reason names a `TRACKER_` variable, and asserts the
consequence is named instead. Backend 1,675 tests, 99.82% branch coverage.

### Satellites draw, and CelesTrak was never going to come back

Verified 2026-08-23. `/api/layers` reports **698 satellites** and Chromium draws them ringing the
globe with zero console errors.

**The diagnosis in this file was wrong and is corrected here.** It recorded CelesTrak as a transport
failure that might clear. It is a network block on us. Measured from three networks the same day:
this laptop times out on `celestrak.org:443`, Anthropic's fetch service gets `ECONNREFUSED` on the
same IP, and GitHub Actions runners get **HTTP 200 with that day's data**. Two different failure
modes against one address while a third network is served is a firewall rule. A mirror's own README
names the mechanism: it re-fetches "from runner IPs that CelesTrak does not block, so consumers
behind blocked datacenter ASNs can still ingest the data". There is no appeal route in CelesTrak's
usage policy, so retrying was never going to work and redundancy was the only route.

Elements now come from a keyless republisher serving the byte-identical CelesTrak OMM contract, so
the adapter's parser and its committed fixtures were unchanged. Measured on ingest, per group:
median epoch age 17.8h to 65.7h, newest 2026-08-23. Seventeen records were dropped as older than
fourteen days and counted, which is the freshness policy doing its job rather than a fault.

**The group set is fourteen groups and 698 objects, deliberately not 16,400.** `active` is 16,400
element sets and `starlink` alone is 10,973. At roughly 2.7ms of SGP4 per thousand objects
uninstrumented, 16,400 is about 44ms per frame against a 16.7ms budget at 60fps, so it would stall
the globe rather than fill it. The fourteen chosen groups are recognisable categories instead: the
ISS, the 157 satellites bright enough to see with the naked eye, weather, science, GPS, Galileo,
GLONASS, GOES, earth resources, search-and-rescue, TDRSS, Intelsat and Iridium. The `noaa` group is
excluded because it returns zero objects, verified the same day, so polling it only spends a request
to be told nothing.

### A restart inside the poll window used to empty the satellite layer

Found and fixed 2026-08-23, and it had nothing to do with the source. **A restart four minutes after
a successful fetch served 0 satellites from a cache holding 698.**

Two correct guards combined to produce it and neither was at fault alone. The poller persists its
next-allowed-poll time through `cache.py`, so a restart inside the six-hour window declines to call
`poll` at all, which is the rate discipline that keeps us inside the two-hour floor. And the store
was only ever filled by that poll. So the layer reported itself unhealthy with **no error to show**,
because nothing had failed. That is the healthy-while-empty shape this project has now hit five
times, wearing a different coat.

Two subtleties, and the first fix got both wrong. `CelestrakClient.cached_elements` is an
**in-process dedup cache, not the disk cache**, so on a fresh process it is always empty and reading
it alone changes nothing. And `elements` **fetches on a miss**, so priming through it put one request
per configured group inside application startup, fourteen by default, and inside every test that
builds an app: **the suite went from 21 seconds to 27 minutes with fifteen errors.**

`CelestrakClient.restore` is the right door. It reads disk into memory and stops, so the priming is
synchronous, opens no socket, and cannot fail on an unreachable provider. A cold start with nothing
on disk primes nothing and the poller populates it a moment later, which is correct.
`_prime_satellites_from_cache` in `src/tracker/app.py`, with two tests, one of which fails without
it. Suite back to 1,675 tests at 99.82% in 21 seconds.

### A frame-budget test that flaked rather than guarded

`orbit.test.ts` asserted that a thousand satellites propagate inside 16.7ms, the 60fps frame. The
suite runs under v8 coverage instrumentation, which inflates that loop roughly eightfold: the same
work measures about 3.5ms uninstrumented and 20 to 22ms with coverage on. So the assertion passed on
an idle machine and failed on a loaded one, and it broke a build on 2026-08-20. The bound is now
60ms with the reasoning written beside it, which still catches a real regression while leaving
headroom for a busy CI box. Run vitest without `--coverage` for the true figure.

### Upstream caches and rate-limit floors survive a restart

Added 2026-08-20. Every floor, backoff and response cache used to live in memory and die with
the process. `src/tracker/cache.py` is one SQLite file under `settings.cache_dir`, and the
poller, CelesTrak, Nominatim and the ADS-B client write to it. Fintraffic, AISHub, aisstream
and the adsbdb owner cache are deliberately left in memory, with the reason on each.

Evidence below is from the real application lifespan, so the pollers, the adapters and the
cache are the ones `uv run tracker` runs. It binds no port, because another agent had a server
on 8000 at the time, and it uses its own cache directory so nothing here touched that server's
state. **CelesTrak was unreachable throughout**, HTTP 000 with `connect=0.000000`, so the
floor is proved against adsb.lol, which answers, and the CelesTrak evidence is limited to what
can be shown honestly with a dead host.

**A real backoff is earned and written down.** adsb.lol threw HTTP 420 on the first `/v2/mil`
call, and the viewport sweep, a different client object on the same provider, then honoured it:

```
17:48:05,526 INFO    httpx: GET https://api.adsb.lol/v2/mil "HTTP/1.1 420 "
17:48:05,529 WARNING adsb.lol answered HTTP 420; holding off until 16:50:05.528768+00:00
17:48:15,804 WARNING adsb.lol failed for /v2/lat/51.5000/lon/-0.1200/dist/250
                     (AdsbCoolingDownError: still inside the backoff adsb.lol asked for
                     after HTTP 429; no request made, 110s left); trying adsb.fi
```

Read straight out of the file afterwards, `SELECT key, value FROM cache ORDER BY key`:

```
adsb:not_before:adsb.lol         | 2026-08-20T16:50:05.528768+00:00
celestrak:attempted:stations     | 2026-08-20T16:48:04.283745+00:00
poller:adsb.lol/mil:not_before   | 2026-08-20T16:48:36.277947+00:00
poller:aircraft/union:not_before | 2026-08-20T16:48:23.794958+00:00
poller:celestrak/gp:not_before   | 2026-08-20T22:48:04.282638+00:00
poller:vessels/union:not_before  | 2026-08-20T16:49:04.281715+00:00
```

**The next process honours all of it.** Restarted immediately against the same directory:

```
17:48:43,018 WARNING adsb.lol failed for /v2/mil (AdsbCoolingDownError: still inside the
                     backoff adsb.lol asked for after HTTP 429; no request made, 83s left)
17:48:43,022 DEBUG   vessels/union: skipping poll, cadence floor holds until 16:49:04.281715
17:48:43,023 DEBUG   celestrak/gp: skipping poll, cadence floor holds until 22:48:04.282638

$ grep -c "HTTP Request: GET https://api.adsb.lol" run2.log   ->  0
$ grep -c "celestrak.org"                          run2.log   ->  0
$ grep -c "GET https://opendata.adsb.fi"           run2.log   ->  4
```

Zero requests to adsb.lol and zero to CelesTrak, from a process that never saw the 420, with
the two floor lines quoting back the exact instants the previous run wrote. The aircraft layer
stayed up on adsb.fi throughout, so the guard costs coverage nothing.

**A stop cannot become a permanent blackout.** CelesTrak cannot be made to answer 403 from
here, and a transport timeout correctly does not latch, so a policy stop was written with the
product's own serialiser and then cleared. Planted, it is picked up on start-up and no request
goes out:

```
17:49:28,868 WARNING celestrak: still stopped until 2026-08-21 16:49:28.574153+00:00:
                     CelesTrak answered HTTP 403 for GROUP=stations.
celestrak requests while latched: 0
```

The reset route is stop the app, delete `upstream.sqlite3`, start it again. Exercised:

```
$ rm -f .../upstream.sqlite3*
$ grep -c "still stopped until" run4.log     ->  0
17:49:49,938 INFO  httpx: GET https://api.adsb.lol/v2/mil "HTTP/1.1 420 "
```

The stop is gone and adsb.lol is called immediately again, which is the guard cleared rather
than merely reported clear. The automatic route is the expiry: two hours for a 5xx, one day for
a 3xx or 4xx, both asserted with an injected clock in `tests/sources/test_celestrak.py` rather
than by waiting.

**An unwritable cache degrades to the old behaviour and warns once.** A file was put where the
directory needs to be:

```
17:50:18,501 WARNING tracker.cache: cache: cannot open
             /tmp/.../blocked/cache/upstream.sqlite3 ([Errno 20] Not a directory);
             running without it
$ grep -c "cannot open" run5.log   ->  1
17:50:18,784 INFO  geonames: indexed 34072 cities
17:50:20,061 INFO  adsb.lol: kept 306 aircraft, dropped 95 {'heard but not located': 95}
```

One warning rather than one per poll, the app ran to completion, five upstream requests
served, and no file was created where the obstruction was.

**A corrupt floor does not lift the guard, and does not become a blackout either.** This is the
failure direction that matters, so it leans safe on the one provider that firewalls
permanently. `}}garbage not a timestamp{{` was written into `celestrak:attempted:stations`:

```
17:50:46,993 WARNING celestrak: the stored floor for GROUP=stations is unreadable; holding
             off for 7200s from now rather than treating it as never asked
celestrak requests made with a corrupt floor: 0
row after the run: 2026-08-20T16:50:46.992765+00:00
```

An unreadable value would otherwise read as absent, absent means never asked, and never asked
spends a request. The row is rewritten as it is read, so the floor runs two hours from that
moment and the refresh after it is ordinary: one missed refresh is the whole cost. The adsb.lol
cooldown deliberately does **not** lean this way, because there the cost of a corrupt row is one
request rather than a permanent firewall entry, and leaning safe on every guard would mean a
corrupt file could quiet a provider that is answering fine.

### Both halves of the gate pass in one run

Re-verified at 17:56 on 2026-08-20, the whole suite, every command run in sequence, 23 seconds
end to end:

```
uv run ruff check .                             All checks passed!                     exit 0
uv run ruff format --check .                    100 files already formatted            exit 0
uv run ty check                                 All checks passed!                     exit 0
uv run mypy                                     Success: no issues in 74 source files  exit 0
uv run pytest -m "not live"                     1411 passed, 1 deselected in 23.72s    exit 0
                                                Required coverage of 85% reached.
                                                Total coverage: 99.77%
uv run python scripts/dump_openapi.py --check    openapi.json is up to date.           exit 0
```

Test count went 1338 to 1408 across the disk cache and phase 4, and coverage 99.73% to 99.77%.
Nothing was lowered to get there. One honesty note on that figure: the same suite read 1406 at
17:37 and 1408 at 17:56, because a concurrent edit to `src/tracker/sources/celestrak.py` and its
test landed in the tree between the two runs. Both runs were green; the count is the later one.

`mypy` is clean. Earlier versions of this file said otherwise and were wrong.

Frontend, `cd frontend && pnpm verify`, re-verified at 17:57 on 2026-08-20, exit 0, 10 seconds:

```
$ biome ci .          Checked 64 files in 17ms. No fixes applied.
$ eslint .
$ html-validate -c htmlvalidate.config.mjs index.html
$ tsc --noEmit
$ vitest run --coverage
 Test Files  23 passed (23)
      Tests  478 passed (478)
Statements   : 87.73% ( 1366/1557 )
Branches     : 86.41% ( 719/832 )
Functions    : 87.27% ( 295/338 )
Lines        : 87.71% ( 1335/1522 )
```

The frontend gate was red for two minutes earlier in the day, at 17:36, on an unused `flyToPoint`
import at `frontend/src/main.ts:19`. It is green because that import is now wired to the `flyTo`
callback at `main.ts:181`, which is the phase 4 fly-to path rather than a deletion.

`cd frontend && pnpm e2e`, re-run at 17:40 on 2026-08-20, exit 0, 18 tests in 30.2s. Six were
added by the phase 4 review pass, which found that the previous 12 touched no hash, no switch, no
camera and no search box while three docstrings claimed otherwise:

```
Running 18 tests using 6 workers
  ✓ renders the globe canvas with a live WebGL context
  ✓ shows the attribution the licences require
  ✓ replaces the baseline credits with the list the API serves
  ✓ reports the feed as live rather than leaving the user guessing
  ✓ keeps the card shut until something is picked
  ✓ draws a ship and opens its card with name, type and speed
  ✓ draws a business jet and opens its card with the owner and the LADD flag
  ✓ says the registry lookup failed rather than looking up forever
  ✓ propagates the orbital elements and draws a satellite
  ✓ names a provider that dropped out, and the count only one provider saw
  ✓ a shared link reopens the camera and the layer switches it names
  ✓ the Cities switch moves and the URL carries it
  ✓ typing a place name paints a pickable row and picking it flies the camera
  ✓ the follow key keeps a moving aircraft under the crosshair
  ✓ without the follow key the same aircraft drifts out from under the crosshair
  ✓ a failed gazetteer read says so on the rail rather than the server count
  ✓ has no serious accessibility violations on the map view
  ✓ survives a backend that is not there
  18 passed (31.3s)
```

Read the scope of that suite honestly. Every REST call in it is answered with a canned body and
the socket is answered by a stub. It proves the frontend wiring in a real browser, not the live
path.

### Phase 4 acceptance, criterion by criterion

All six met. One run of `uv run tracker` at 17:39 on 2026-08-20 with `TRACKER_CONTACT_EMAIL` set,
a second run at 17:43 with it unset, and the browser half from `pnpm verify` and `pnpm e2e`.

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | A live callsign, an MMSI or "ISS" resolves in under 300ms from local indices | **Met, live** | Over HTTP: callsign `N10CD` 2.5 to 3.7ms, MMSI `265538450` 2.0 to 2.8ms, `ISS` 1.9 to 2.3ms, five calls each. Two orders of magnitude inside the budget. See the latency block below for what each one returned |
| 2 | "Rotterdam" flies to the port; Nominatim is called at most once per unique query | **Met, live** | `Rotterdam` never reaches Nominatim at all: the gazetteer answers it at `2747891 Rotterdam NL · population 868,135`, first of two. The once-per-query rule is measured on a query the index cannot answer: four `/api/search?q=Buckingham Palace` requests, **one** upstream Nominatim call in the log, 563ms cold and 1.8 to 4.7ms after |
| 3 | "London" resolves from the local GeoNames index with **zero network calls**, UK first, Ontario below, asserted by a test that fails if any HTTP client is touched | **Met, live and by test** | 40 city searches, zero new upstream requests in the server log, and not one line mentioning Nominatim or OpenStreetMap in the whole run. `test_london_resolves_with_no_network_at_all` PASSED. Order: London GB 8,961,989, London CA 422,324, Londonderry County Borough GB 87,153 |
| 4 | City labels readable at country zoom, no overdraw at street zoom, the whole layer costing nothing toggled off | **Met, by measurement and browser test** | Six population bands against the real file: 59 cities in the orbit band, 562 by continent framing, 1,989 by country zoom, 34,072 at street zoom, capped by a 600-label budget. `costs nothing while it is off: no work, no labels touched, no request` and `is readable at country zoom: down to 300,000 and no further` both pass, 33 tests on the layer, plus the browser test `the Cities switch moves and the URL carries it` |
| 5 | Follow mode tracks a moving aircraft and disengages on drag | **Met, by browser test and unit test** | `the follow key keeps a moving aircraft under the crosshair` and its control `without the follow key the same aircraft drifts out from under the crosshair` both pass in Chromium. `disengages on a drag and hands the camera back to the world` and `disengages on a zoom` pass in `follow.test.ts` |
| 6 | Copying the URL into a fresh tab reproduces camera and layers | **Met, by browser test** | `a shared link reopens the camera and the layer switches it names` passes in Chromium, plus 26 tests on the hash format in `url.test.ts`, including `round-trips a camera through a hash` |

Two honest edges on that table. Criterion 1 says "ISS" resolves inside the budget and it does, in
1.9ms, but it resolves to Issia in Côte d'Ivoire and Issy-les-Moulineaux rather than to the space
station, because the satellite store is empty and CelesTrak does not answer from this network. The
latency is met and the identity is not, and the reason is the blocker below rather than the search.
Criterion 4's banding is measured against the real file and asserted by 33 unit tests, and the
browser test covers the switch rather than the label picture, so "readable" is a measured band
table and a passing display-condition assertion, not a screenshot.

### The city layer runs off the real GeoNames dump, and the weekly refresh costs nothing

One run of `uv run tracker` at 17:39 on 2026-08-20. The dump was already on disk from an earlier
run, so the weekly floor short-circuited and the index was built straight from the cached zip.
From the log, 186 milliseconds after the pollers started:

```
17:39:54,137 INFO tracker.sources.geonames: geonames: kept 34072 cities, dropped 27
             {'feature code PPLW is a dead place': 5, 'feature code PPLQ is a dead place': 9,
              'feature code PPLH is a dead place': 13}
17:39:54,202 INFO tracker.app: geonames: indexed 34072 cities
```

Every upstream request the whole run made, grouped by host, and GeoNames is not among them:

```
   6 https://api.adsb.lol
   4 https://meri.digitraffic.fi
   1 https://nominatim.openstreetmap.org
  13 https://opendata.adsb.fi
```

`/api/layers`:

```
layers {'aircraft': 687, 'military': 306, 'vessels': 691, 'satellites': 0, 'cities': 34072}
{'layer': 'cities', 'provider': 'geonames', 'records': 34072, 'exclusive': 34072,
 'error': None, 'polls': 1, 'failures': 0, 'empty_polls': 0, 'drops': 27,
 'last_success_at': '2026-08-20T14:33:36.364158Z'}
```

**34,072 cities from 34,099 rows**, the 27 refusals being dead places (PPLH, PPLQ, PPLW), counted
where a person can read them rather than logged. `last_success_at` is six hours old on purpose:
that is the last time a byte came off GeoNames, and it survived the restart, which is the weekly
floor being real rather than decorative.

The conditional request behind it, called directly with the validator the cache holds:

```
$ curl -H 'If-None-Match: "327468-65970ccb25bfc"' \
    https://download.geonames.org/export/dump/cities15000.zip
HTTP/1.1 304 Not Modified
ETag: "327468-65970ccb25bfc"
[HTTP 304 bytes=0 time=0.063775]
```

Zero bytes, 64 milliseconds, against 3,306,600 bytes for the full file. That is what the weekly
refresh costs in the normal case.

### Search latency, measured over the HTTP round trip

Five calls each, sequential, against the running server. The plan's budget is 300 milliseconds:

```
GET /api/search?q=N10CD        3.7  2.5  3.1  3.3  2.5 ms   (aircraft, live callsign)
GET /api/search?q=265538450    2.8  2.6  2.4  2.2  2.0 ms   (vessels, live MMSI)
GET /api/search?q=ISS          2.3  1.9  2.0  2.0  2.1 ms   (cities and vessels)
GET /api/search?q=London       2.5  2.1  2.1  1.8  2.1 ms   (cities)
GET /api/search?q=Rotterdam    1.7  1.8  1.7  1.6  1.6 ms   (cities)
```

What each one actually returned:

```
N10CD       aircraft  a00291 N10CD | N10CD · S22T · A00291 | 1.0
                      {'lon': -0.513537, 'lat': 51.345062, 'altitude_m': 419.1}
265538450   vessels   265538450 SODERARM | MMSI 265538450 · IMO 9284312 · SBFW | 1.0
London      cities    2643743 London | GB · population 8,961,989 | 0.9
                      6058560 London | CA · population 422,324 | 0.9
                      2643734 Londonderry County Borough | GB · population 87,153 | 0.54
Rotterdam   cities    2747891 Rotterdam | NL · population 868,135 | 0.9
                      5134453 Rotterdam | US · population 20,652 | 0.9
ISS         cities    2287790 Issia CI 68,263 | 3012649 Issy-les-Moulineaux FR 61,447
                      5798487 Issaquah US 36,081 | 3012664 Issoire FR 15,984
            vessels   636014253 PISSIOTIS | 230992690 GRISSLAN
```

The HTTP figure is almost all framework and socket. The index itself, re-measured today against
the real 34,099-row dump over 2,000 iterations each:

```
indexed: 34072 cities
  'London'     median=     1.46us  p95=     1.71us
  'Rotterdam'  median=     1.42us  p95=     1.54us
  'Köln'       median=     1.17us  p95=     1.33us
  'ISS'        median=     1.58us  p95=     1.71us
  'l'          median=   347.17us  p95=   377.92us
London order: [(2643743, 'London', 'GB', 8961989), (6058560, 'London', 'CA', 422324),
               (2643734, 'Londonderry County Borough', 'GB', 87153)]
```

`'l'` is the worst case in the whole design, the one-letter query that matches thousands of rows,
and it is 347 microseconds. `Köln` answering in 1.17 microseconds is the accent fold working: the
query carries an umlaut the sorted key does not.

### A city lookup issues zero requests, and the proof is not an assertion

Three independent pieces, because this is criterion 3 and it is the one worth being sure about.

**The type cannot make a request.** `CityIndex` in `src/tracker/services/gazetteer.py` holds no
client, no URL and no coroutine. There is nothing in it to reach a network with, so this is a
structural fact about the type rather than a rule somebody has to remember.

**The live run.** 20 `/api/search?q=London` calls then 20 `/api/search?q=Rotterdam` calls against
the running server, counting httpx lines in the log either side:

```
httpx requests in log: before=13 after=13
nominatim mentions in log: before=0 after=0
every nominatim / openstreetmap line in the whole log: (none)
```

Forty searches, not one request. The pollers were running throughout, so the counter was live.

**The test that fails if a client is touched.** `test_london_resolves_with_no_network_at_all` in
`tests/api/test_routes.py:1269` builds the real app over an httpx transport whose every request
raises, with `TRACKER_CONTACT_EMAIL` set so the Nominatim client genuinely exists, then reads
`/api/search?q=London` and asserts London GB, London Ontario, Londonderry in that order. It also
asserts `state.nominatim is not None`, which is what stops the test passing because the places
group was skipped for the wrong reason.

```
uv run pytest -v --no-cov tests/api/test_routes.py::test_london_resolves_with_no_network_at_all
tests/api/test_routes.py::test_london_resolves_with_no_network_at_all PASSED
1 passed in 0.41s
```

### Nominatim is called once per unique query, and that is measured rather than designed

Four identical `/api/search?q=Buckingham%20Palace` requests, which the gazetteer cannot answer
because Buckingham Palace is not a populated place. From the server log, the complete list of
Nominatim lines for the whole run:

```
17:41:58,269 INFO httpx: HTTP Request: GET
  https://nominatim.openstreetmap.org/search?q=buckingham+palace&format=jsonv2&limit=5
  "HTTP/1.1 200 OK"
```

One line. The four response times were 563ms, 4.7ms, 1.9ms and 1.8ms, so the cache is doing the
work rather than the provider. The answer:

```
places  relation/5208404 Buckingham Palace | Buckingham Palace, Buckingham Gate, Victoria,
        City of Westminster, Greater London, England, SW1A 1AA, United Kingdom | 0.9
        {'lon': -0.1430045, 'lat': 51.5008349}
        node/8846836625 Buckingham Palace | Buckingham Palace, Teton County, Wyoming,
        United States | 0.9
```

Note the query was folded to `buckingham palace` before it left, which is what makes the cache
key insensitive to case and accents rather than storing four entries for four spellings.

### With no contact email the place search reports itself off and the city search still works

A second run of `uv run tracker` at 17:43 on 2026-08-20 with `TRACKER_CONTACT_EMAIL` unset and
nothing else changed. This is the degradation path for a keyed feed applied to a keyless one, and
it is the pattern `AGENTS.md` requires: a missing credential is a reason, never an empty layer.

At boot:

```
17:43:39,492 INFO tracker.app: nominatim: Nominatim needs contact details in the User-Agent;
             set TRACKER_CONTACT_EMAIL
```

`GET /api/capabilities`, the two rows that matter:

```json
{"layer": "cities",  "available": true,  "reason": null}
{"layer": "places",  "available": false,
 "reason": "Set TRACKER_CONTACT_EMAIL. Nominatim and Overpass require contact details in the
            User-Agent under their usage policies."}
```

`GET /api/search?q=London` on that same run, unchanged and still 2.7ms:

```
group cities | reason: None
   2643743 London | GB · population 8,961,989 | 0.9
   6058560 London | CA · population 422,324 | 0.9
   2643734 Londonderry County Borough | GB · population 87,153 | 0.54
HTTP 200 total=0.002729s
```

And a query only a geocoder could have answered comes back as a group carrying its reason, not a
500 and not an empty world:

```json
{"query": "Buckingham Palace",
 "groups": [{"name": "places", "hits": [],
   "unavailable_reason": "Nominatim needs contact details in the User-Agent;
                          set TRACKER_CONTACT_EMAIL"}]}
```

So the city half of search is independent of the geocoder half in the running product, not only in
the tests: the local index carries every city query and the geocoder says why it is off.

### The city reads answer, and a bad box is refused

Same run, `TRACKER_CONTACT_EMAIL` set:

| Request | Result |
| --- | --- |
| `GET /api/cities` | 200, 2,000 of 34,072 with `total` saying so, Shanghai first at 24,874,500, 598,630 bytes, 10ms |
| `GET /api/cities?limit=40000` | 200, all 34,072, `content-length: 10227194` plain |
| the same with `Accept-Encoding: gzip` | 200, `content-encoding: gzip`, `content-length: 2062053`, 98ms. Five times smaller |
| `GET /api/cities/2643743` | 200, London GB, `feature_code: PPLC`, `admin1_code: ENG`, `timezone: Europe/London`, `modification_date: 2026-08-17` |
| `GET /api/cities?west=-0.6&south=51.2&east=0.4&north=51.8&limit=5` | 200, `total: 179`, and London, Brent, Islington, City of Westminster, Bexley |
| `GET /api/cities?west=-1` | 422, `"a bounding box needs all four of west, south, east and north"` |

The gzip figure is a correction. This file and `docs/architecture.md` both said 1.57MB. The
measured wire size today is **2,062,053 bytes** with `content-encoding: gzip` on the response, off
10,227,194 uncompressed. Both figures read straight off `content-length`.

### The label bands are measured against the real file, not guessed

The full 34,072 rows off `/api/cities?limit=40000`, bucketed by the six bands in
`frontend/src/globe/layers/cities.ts:108`:

```
>=5m    farM 25,000km   band=   59   cumulative visible at that zoom=   59
>=1m    farM  6,000km   band=  503   cumulative visible at that zoom=  562
>=300k  farM  2,000km   band= 1427   cumulative visible at that zoom= 1989
>=100k  farM    700km   band= 4247   cumulative visible at that zoom= 6236
>=50k   farM    250km   band= 6120   cumulative visible at that zoom=12356
rest    farM     80km   band=21716   cumulative visible at that zoom=34072
```

A whole-globe view draws 59 labels. Country zoom draws from at most 1,989, cut further by the view
rectangle. `CITY_LABEL_BUDGET` is 600, which is what stops the street-zoom band putting 34,072
labels in the collection: a Cesium label builds one billboard per glyph as soon as it has text,
whatever its display condition says, so the whole gazetteer is roughly 300,000 glyph billboards
and a multi-second hitch on load. The budget is the fix and the band table is why 600 is enough.

### The phase 4 review, finding by finding

Seventeen findings, each one already through an adversarial pass told to refute it. Fifteen
fixed, two rejected. Every fix carries a test that fails without it, and the four browser fixes
were mutation-tested by breaking the line each one asserts.

| # | Finding | Verdict | Test that fails without the fix |
| --- | --- | --- | --- |
| 1 | `/api/search` answered HTTP 500 when Nominatim failed on a query of 79 ASCII or 14 Cyrillic characters: the reason string overflowed its 300-character contract | Fixed. Every dynamic reason goes through one clip | `test_a_long_address_against_a_failing_geocoder_is_a_200`, plus two service tests |
| 2 | A CDN error page served with HTTP 200 was cached over the working GeoNames dump, poisoning the layer for a week and reporting the reason as "never ran" | Fixed. The body is checked before it is written, and an unreadable disk copy sets the reason | `test_an_error_page_served_with_200_never_replaces_the_copy_on_disk`, `test_an_unreadable_copy_on_disk_says_why` |
| 3 | A failed city refresh slept a week, so a network blip at boot emptied the gazetteer for seven days | Fixed. `CITY_RETRY_SECONDS`, five minutes, matching `Poller`'s own ceiling | `test_a_pass_that_indexed_nothing_retries_in_minutes_not_in_a_week` |
| 4 | An empty gazetteer sent every city query to Nominatim and the response said nothing about it | Fixed. The cities group carries the reason and the fall-through is blocked | `test_an_empty_gazetteer_says_so_and_never_reaches_the_geocoder` |
| 5 | The browser cached a transient Nominatim throttle as the answer, poisoning that query for the session | Fixed. A response carrying any reason is not cached | `never caches an answer whose group came back unavailable` |
| 6 | A wire-shape change dropped every record, was cached as "no such place", and was reported nowhere | Fixed. A total drop raises rather than answering | `test_a_response_where_nothing_maps_is_a_failure_and_is_not_cached` |
| 7 | An ETag file outliving its zip was a permanent dead end: the conditional request got a 304 forever | Fixed. The validator is only sent when the zip is in hand | `test_an_etag_that_outlived_its_zip_still_recovers` |
| 8 | Nominatim's own backoff was computed and thrown away, so a 429 asking for 120s got another request one second later | Fixed. A cooldown on the client, from the provider's figure on a 429 and a flat 120s on a 403 block page | `test_the_providers_own_backoff_is_honoured_rather_than_recorded`, `test_a_block_page_holds_the_client_off_and_a_server_fault_does_not` |
| 9 | 10.2MB of city JSON on every page load, uncompressed, with no gzip middleware anywhere | Fixed. Gzip next to CORS at level 1: 1.57MB | `test_the_city_read_is_compressed` |
| 10 | A failed `fetchCities` left an empty layer while the rail reported the server's 34,072 rows | Fixed. Its own catch, a rail notice, and the read moved out of the shared block | `a failed gazetteer read says so on the rail rather than the server count` |
| 11 | The coverage exclusion for `src/main.ts` claimed browser coverage for three acceptance criteria that no test touched | Fixed as far as a browser reaches: five new Playwright tests, and the comment now names the two things it cannot reach | `a shared link reopens the camera and the layer switches it names`, `the Cities switch moves and the URL carries it`, `typing a place name paints a pickable row and picking it flies the camera`, `the follow key keeps a moving aircraft under the crosshair` and its control |
| 12 | Two docstrings claimed the Playwright suite covered the search box's painting, follow mode and URL state | Fixed. Four of the five paths now exist; the comments say plainly what is still uncovered and why | as above |
| 13 | `isTyping` in `follow.ts` and `isEditableTarget` in `search.ts` were the same eleven lines twice | Fixed. One copy, imported | `ignores the key while the user is typing` in `follow.test.ts` |
| 14 | Seven public members with no reader outside their own test | Fixed. All seven deleted, and `SearchHit.source` came off the wire with a schema and type regeneration | Deletions. The suite is the check: nothing in `src/` or `frontend/src/` broke |
| 15 | Five `Place` fields and the bounding-box unpack behind one of them, all unread | Fixed. 47 lines gone, and `place_rank`'s `le=30` went with them, which would have dropped a whole live result the day the provider exceeded its own ceiling | `test_the_extent_and_the_type_fields_are_not_carried`, `test_a_malformed_bounding_box_costs_the_record_nothing` |
| 16 | Five `City` fields with no reader, shipped 34,072 times | **Rejected in this form**, and gzip taken instead, which is the reviewer's own stated preference. The fields are 4.0MB of the raw body and gzip recovers 8.7MB of it without touching a published contract, an OpenAPI regeneration or the frontend types. The module docstring's measured column table is the record of the file either way | Covered by the gzip test above |
| 17 | The dead `min_interval_seconds` sweep across `aishub.py`, `celestrak.py` and `fintraffic.py`, and the unused `PollingSource` protocol | **Rejected as out of scope.** Phase 2 code, three adapters this phase does not touch, and one of them was being edited by another pass at the time. The two phase 4 members of the same family were deleted | n/a |

Two smaller judgement calls inside the fixes, both worth stating. `NominatimClient.drops` is still
read by no API surface: `/api/layers` carries `ProviderCoverage` rows for layers with a store and
a delta channel, and the geocoder has neither, so a row there would mean inventing what `records`
and `exclusive` mean for a demand-driven lookup. That is the same reasoning already recorded for
the CelesTrak drop count. The drop reason does reach the browser, on the search response, which is
the surface a person actually reads. And the gazetteer gate is on the index being **empty** rather
than absent: `AppState` always wires one, so empty means the download has not landed, while
`None` means a deployment built without a city group and has no bearing on the geocoder.

The test count moved from 1183 to 1408 across phases 3 and 4 and the review pass. Coverage is
higher than before the pass rather than lower: the fixes are all branches with tests on them and
the deletions took untested surface out.

The Playwright suite is not in `pnpm verify` and never was: only CI runs it, which is worth
knowing, because it means the browser wiring has no gate on a developer machine, and there is no
CI. See Broken.

### The city layer is not a store, and the refresh is not a poller

Asserted rather than described, and re-run by name at 17:47 on 2026-08-20:

```
uv run pytest -v --no-cov tests/test_app.py -k "city or gazetteer or refresh"
test_the_city_layer_is_an_index_rather_than_a_store                             PASSED
test_the_city_refresh_indexes_the_dump_and_counts_what_it_refused               PASSED
test_a_second_refresh_inside_the_week_never_reaches_the_provider                PASSED
test_a_failed_refresh_with_nothing_on_disk_leaves_the_layer_empty_and_says_why  PASSED
test_a_failed_refresh_keeps_the_cities_it_already_had                           PASSED
test_the_refresh_loop_runs_once_then_waits_a_week                               PASSED
6 passed, 75 deselected in 0.37s
```

The first fails if `cities` is ever registered with the hub or if a poller carries it, which is
what stops a 90-second time to live retiring London. The third is two refreshes and one HTTP call,
which is the weekly floor asserted against the wiring rather than against a constant.

### A live business jet classifies and resolves to its registered owner

`uv run tracker` with `TRACKER_CONTACT_EMAIL` set and no other credentials. Four pollers start,
from the log:

```
13:39:32 INFO tracker.app: started 4 pollers and the broadcast loop
13:39:32 INFO tracker.services.poller: aircraft/union: polling every 8.0s
13:39:32 INFO tracker.services.poller: adsb.lol/mil: polling every 32.0s
13:39:32 INFO tracker.services.poller: vessels/union: polling every 60.0s
13:39:32 INFO tracker.services.poller: celestrak/gp: polling every 21600.0s
```

`GET /api/aircraft` returned HTTP 200 with **856 aircraft**: 30 classified `business_jet`, 34
`military`, 27 `helicopter`, 765 `unknown`, and **17 carrying the LADD flag**. One of them,
whole and unedited from `GET /api/aircraft/adca0b`:

```json
{"aircraft":{"kind":"aircraft","icao24":"adca0b","non_icao_address":false,
 "message_source":"adsb_icao","callsign":"N988NC","registration":"N988NC",
 "type_designator":"GLF6","point":{"lon":-0.71907,"lat":51.29484,"altitude_m":373.38},
 "on_ground":false,"barometric_altitude_m":381.0,"geometric_altitude_m":373.38,
 "ground_speed_mps":63.533834,"track_deg":241.98,"vertical_rate_mps":-4.55168,
 "squawk":"0602","emergency":"none","category":"A3","aircraft_class":"business_jet",
 "is_military":false,"uses_privacy_address":false,"on_ladd":true,"operator":null,
 "owner":"21st Century Fox America Inc","registered_country":"United States",
 "observed_at":"2026-08-20T12:40:29.007000Z","position_age_s":0.213,
 "messages_received":190830,"source":"adsb.lol","providers":["adsb.lol"]},
 "registry":"adsbdb",
 "registry_attribution":"Aircraft registry data via adsbdb, sourced from PlaneBase. Photos via airport-data.com.",
 "joined_at":"2026-08-20T12:40:37.588753Z",
 "conflicts":[{"attribute":"type_designator","feed_value":"GLF6","registry_value":"G650"}],
 "degraded_reason":null}
```

A real Gulfstream G650 over west London, classified as a business jet off its ICAO type
designator, resolved to its registered owner through adsbdb, on the FAA LADD programme, and
rendering like any other aircraft with the flag as an attribute. That is phase 3 acceptance 1
and 2 in one live record. The registry disagreement is served rather than swallowed: the feed
says `GLF6` and adsbdb says `G650`, both sides are on the wire, and nothing was silently
overwritten.

### The LADD bit is documented by the provider, not inferred by us

Two live calls, both today. The readsb JSON schema, `README-json.md` line 115:

```
$ curl -s https://raw.githubusercontent.com/wiedehopf/readsb/dev/README-json.md
HTTP 200 bytes=22058
109:  dbFlags: bitfield for certain database flags, below & must be a bitwise and ...
112:     military = dbFlags & 1;
113:     interesting = dbFlags & 2;
114:     PIA = dbFlags & 4;
115:     LADD = dbFlags & 8;
```

adsb.lol's dedicated endpoint on top of it:

```
$ curl -s https://api.adsb.lol/v2/ladd
HTTP 200 bytes=244212
count: 480
dbFlags histogram: Counter({8: 479, 10: 1})
first record: hex c0797b, r C-GUAC, t BCS3, dbFlags 8
```

480 aircraft, 479 at `dbFlags` 8 and one at 10, which is LADD plus interesting. The bit is read
at `src/tracker/sources/adsb.py:71` and mapped at `:410`. It is not hardcoded, not inferred and
not always false: 17 of 856 live aircraft carried it, including 6 of the 30 business jets.

### The registry lookup is cached, proven on the live run

Four card opens on the same address, one upstream request:

```
$ for i in 1 2 3 4; do curl -s localhost:8000/api/aircraft/adca0b >/dev/null; done
$ grep -c adsbdb server.log
1
13:40:37 INFO httpx: GET https://api.adsbdb.com/v0/aircraft/ADCA0B "HTTP/1.1 200 OK"

GET /api/layers -> registries
  {"registry":"adsbdb","requests":4,"enriched":4,"not_held":0,"failures":0,
   "unmappable":0,"conflicts":4,"last_error":null}
```

`requests: 4` counts card opens and the log counts upstream calls, so the four-to-one ratio is
the cache. The cache and the request budget live in `src/tracker/sources/adsbdb.py` and the
instance lives on `AppState`, so the guarantee holds for the session rather than for one
request.

### The owner cache can be emptied by a removal, and it takes every route to the name

`registered_owner` is a named individual on a great many N-numbers, so the adsbdb lookup holds
personal data with a one-day TTL, and it had no eviction method at all. ADR 008 makes a removal
immediate with no queue and no human step, so a removal would have deleted the profile and left
the deleted name being served from memory for the rest of the day. That is worse than a slow
removal, because it looks like it worked.

`AdsbdbLookup.forget` (`src/tracker/sources/adsbdb.py:592`) sweeps on identity rather than on
the key it was handed. One answer is remembered under three keys, the requested key, the
record's own address and its registration, and a stale entry can still sit under a superseded
registration, so the sweep widens itself with the keys of everything it drops. Phase 6 owns the
suppression register that stops the next card open fetching the name again; this is the hook it
will call and nothing more, so it is not yet wired to a route.

```
uv run pytest tests/sources/test_adsbdb.py -k forget    5 passed, 57 deselected    exit 0
```

All five fail against the code as it stood, with
`AttributeError: 'AdsbdbLookup' object has no attribute 'forget'`. One of them reads the cache
dictionary directly, which the rest of that file avoids on purpose: a call count proves a key
went back to the network, and only the dictionary proves the name is out of memory.

### A registry value that is merely too wide now costs one field, not the whole airframe

`AircraftRegistration.icao_type` took 8 characters against `Aircraft.type_designator`'s 4, and
`registration` took 20 against 12. Nothing was crashing: the merge revalidates, the enrichment
service counted the record unmappable and the aircraft still rendered. The cost was the
consequence. One over-wide field took the owner, the registered country and the class with it.

The two contracts now agree, and the adapter drops an over-long identifier where it arrives
rather than carrying it to the merge to fail there. `owner` and `owner_country` were already
aligned this way, so this is the file's own pattern applied to the two fields it had missed.

```
uv run pytest tests/sources/test_adsbdb.py \
  -k "widths or over_long or blank_identifier or costs_one_field"    7 passed    exit 0
```

Five of the seven fail against the code as it stood: two on the contract widths, two because the
over-long value was carried instead of dropped, and one because the merge raised and the airframe
lost its owner as well as its designator.

### The adsb.fi failover fired three times live

```
13:39:33 GET https://api.adsb.lol/v2/lat/51.5000/lon/-0.1200/dist/250 "HTTP/1.1 420 "
13:39:33 WARNING adsb.lol failed for /v2/lat/51.5000/lon/-0.1200/dist/250
         (RateLimitedError: adsb.lol: rate limited (HTTP 420); backing off 120s); trying adsb.fi
13:39:33 GET https://opendata.adsb.fi/api/v2/lat/51.5000/lon/-0.1200/dist/250 "HTTP/1.1 200 OK"

13:41:53 WARNING adsb.lol failed for /v2/mil (RateLimitedError: HTTP 420); trying adsb.fi
13:41:53 INFO adsb.fi: kept 205 aircraft, dropped 98 {'heard but not located': 98}

13:43:21 WARNING adsb.lol failed for /v2/lat/51.5000/lon/-0.1200/dist/250 (ReadTimeout); trying adsb.fi
13:43:22 INFO adsb.fi: kept 835 aircraft, dropped 1 {'will not map to the contract': 1}
```

Twice on adsb.lol's HTTP 420 rate limit and once on a read timeout. The layer never went empty.
Both the viewport path and the worldwide military path failed over, which is the fix that shares
one path template between both providers, `VIEWPORT_PATH_TEMPLATE` in
`src/tracker/sources/adsb.py`. Earlier versions of this file said the viewport failover was
broken. That was wrong.

### The drop count reaches the API on all three counted layers

```
GET /api/layers -> providers
  {"layer":"aircraft","provider":"adsb.lol","records":810,"exclusive":810,"error":null,
   "polls":25,"failures":0,"empty_polls":0,"drops":1}
  {"layer":"military","provider":"adsb.lol","records":208,"exclusive":208,"error":null,
   "polls":8,"failures":0,"empty_polls":0,"drops":762}
  {"layer":"vessels","provider":"digitraffic","records":660,"exclusive":660,"error":null,
   "polls":3,"failures":0,"empty_polls":0,"drops":6}
```

The military figure is the interesting one, and it is why the aircraft union's near-zero is a
real zero rather than a broken counter. Two live calls, direct to the provider:

```
GET /v2/lat/51.5000/lon/-0.1200/dist/250   792 records, 0 without lat or lon
GET /v2/mil                                302 records, 100 without lat or lon
```

The viewport endpoint only returns located aircraft, so the union has almost nothing to refuse.
The worldwide military sweep refuses a third of what it is sent, and that number is now served
rather than only logged. The one aircraft the union did drop was refused by the contract, on the
adsb.fi failover cycle, and it reached the API.

### Both unfiltered providers report themselves unavailable with the reason

Real `GET /api/capabilities`, aircraft rows only:

```json
{"layer":"aircraft","available":true,"reason":null}
{"layer":"aircraft/adsbexchange","available":false,
 "reason":"No RapidAPI key, and a key would not be enough. adsbexchange-com1.p.rapidapi.com
  answered HTTP 401 'Invalid API key' on 2026-08-20, and the provider prohibits redistribution
  without written permission while serving positions to a browser is redistribution. Terms and
  the two routes through are in docs/data-sources.md."}
{"layer":"aircraft/airplanes.live","available":false,
 "reason":"Access not granted. api.airplanes.live answered HTTP 403 on 2026-08-20 with 'Please
  contact us at contact@airplanes.live. Your email MUST include any links, a description of the
  project, and any information you deem appropriate.' Nobody has sent that email."}
```

The layer is available and served 856 aircraft while both unfiltered providers said why they are
not in it. That is the same split the vessel layer uses for AISHub and aisstream. The three
access blockers, re-verified live today:

```
adsbexchange-com1.p.rapidapi.com/v2/lat/51.5/lon/-0.12/dist/25/
  HTTP 401  {"message":"Too many requests"}
api.airplanes.live/v2/point/51.5/-0.12/25
  HTTP 403  {"error": "Please contact us at contact@airplanes.live. Your email MUST include
             any links, a description of the project, and any information you deem appropriate."}
api.adsb.one/v2/point/51.5/-0.12/25
  HTTP 403
```

RapidAPI answered `Too many requests` today rather than the `Invalid API key` body recorded in
`docs/data-sources.md`. Same 401, same cause, different message. Both are recorded there now.

### The provider-attributable coverage count is zero, and the zero is the finding

Acceptance 8 asks for the count of aircraft only an unfiltered provider can see. It is zero,
because no unfiltered provider is in the union. `GET /api/layers` served
`aircraft adsb.lol records 810 exclusive 810`, which is true and trivially so: a union of one
attributes everything to its only member.

What is measured rather than asserted is the machinery, on two recorded real provider payloads.
65 and 57 records merge to 118 distinct addresses with 4 seen by both, and the attributable
counts come out adsb.lol 61 and second provider 53. Those are
`tests/test_app.py::test_the_aircraft_attributable_count_is_measured_per_cycle` and
`::test_the_api_serves_the_aircraft_provider_coverage`, both PASSED below. No number was
invented to fill the gap.

### Every REST endpoint answers, and a bad query is refused

| Request | Result |
| --- | --- |
| `GET /api/health` | 200, four feeds, 976 bytes |
| `GET /api/capabilities` | 200, eleven layer rows, ten attributions, 3,460 bytes |
| `GET /api/layers` | 200, four layer counts, three provider rows, one registry row |
| `GET /api/aircraft` | 200, 856 records, 618KB |
| `GET /api/aircraft/adca0b` | 200, the N988NC record above with its adsbdb join |
| `GET /api/aircraft/ffffff` | 200, `null`. An address never seen is not an error |
| `GET /api/aircraft?west=-0.6&south=51.2&east=0.3&north=51.8` | 200, 61 aircraft in the London box |
| `GET /api/aircraft?military_only=true` | 200, 196 records from the separate military store |
| `GET /api/aircraft?west=-1` | 422, `"a bounding box needs all four of west, south, east and north"`. A partial box is refused, never widened to the world |
| `GET /api/aircraft?west=-1&south=200&east=1&north=52` | 422, `"Input should be less than or equal to 90"` |
| `GET /api/vessels` | 200, 662 records, 359KB |
| `GET /api/satellites` | 200, `{"count":0,"satellites":[]}` |
| `GET /api/satellites/elements` | 200, `{"count":0,"fetched":{},"satellites":[]}` |

### Live ships off a keyless feed, five cycles

```
13:39:32 GET https://meri.digitraffic.fi/api/ais/v1/vessels "HTTP/1.1 200 OK"
13:39:32 GET https://meri.digitraffic.fi/api/ais/v1/locations?from=1787228940000 "HTTP/1.1 200 OK"
13:39:32 INFO tracker.sources.fintraffic: digitraffic: kept 658 vessels, dropped 2
         ({'failed the vessel contract': 2})
13:41:31 INFO tracker.sources.fintraffic: digitraffic: kept 660 vessels, dropped 2
13:43:25 INFO tracker.sources.fintraffic: digitraffic: kept 660 vessels, dropped 2
```

658 real ships 0.27 seconds after the poller started, each cycle on its own 60-second floor, and
the `from` parameter passed explicitly so the response is a live snapshot rather than the
provider's default 24 hours of history. Every record passed the `Vessel` contract, which is
`strict=True, extra="forbid", frozen=True`.

### No feed reports healthy while producing nothing

This is the bug class that has bitten this project four times. `GET /api/health`, read as a
table:

```
aircraft/union  healthy=True  count=805  err=None
adsb.lol/mil    healthy=True  count=208  err=None
vessels/union   healthy=True  count=660  err=None
celestrak/gp    healthy=False count=0    err=SourceError: celestrak: unreachable: ConnectTimeout
```

CelesTrak is the only zero and it declares itself. `GET /api/capabilities` says the same thing
in the consumer's words:

```json
{"layer":"satellites","available":false,
 "reason":"CelesTrak has not served an element set: unreachable: ConnectTimeout"}
```

The whole log for the run, with the httpx and access lines stripped, carries four warnings and
nothing else: three adsb.fi failovers and one CelesTrak timeout. No error, no traceback, no
silent empty cycle.

CelesTrak is a network fact, not our code:

```
$ curl -s -m 20 -o /dev/null -w "HTTP %{http_code} time=%{time_total}\n" \
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json"
HTTP 000 time=20.006207
curl exit=28
```

### One socket, snapshot then delta, all four layers

A WebSocket client against `ws://127.0.0.1:8000/ws`:

```
0 type=snapshot layer=aircraft   n=885 | business_jet=29 on_ladd=14
                                       | e.g. 06a1cd A7-CGH GLF6 providers=['adsb.lol'] age=0.227
1 type=snapshot layer=military   n=208
2 type=snapshot layer=vessels    n=662
3 type=snapshot layer=satellites n=0
4 type=upsert   layer=aircraft   n=791
5 type=upsert   layer=military   n=208
6 type=remove   layer=military   n=11
```

The classification, the LADD flag, the per-record provider list and the report age all cross the
socket rather than only the REST snapshot. The satellite snapshot is an honest zero.

### The acceptance-criterion tests, run by name

```
uv run pytest -v --no-cov <10 selected tests>
tests/api/test_routes.py::test_a_live_business_jet_shows_its_registered_owner PASSED
tests/api/test_routes.py::test_a_registry_lookup_is_cached_with_no_repeat_call_for_the_same_hex PASSED
tests/api/test_routes.py::test_the_military_sweep_drop_count_reaches_the_api PASSED
tests/test_app.py::test_two_aircraft_providers_produce_one_record_per_icao_address PASSED
tests/test_app.py::test_every_aircraft_record_names_its_provider_and_the_age_of_that_report PASSED
tests/test_app.py::test_two_providers_on_one_hex_resolve_to_the_newer_position_and_list_both PASSED
tests/test_app.py::test_killing_one_aircraft_provider_leaves_the_layer_up_and_degraded PASSED
tests/test_app.py::test_the_union_member_falls_over_to_its_own_failover PASSED
tests/test_app.py::test_the_aircraft_attributable_count_is_measured_per_cycle PASSED
tests/test_app.py::test_the_api_serves_the_aircraft_provider_coverage PASSED
10 passed in 0.23s
```

### Phase 3 acceptance, criterion by criterion

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | A live business jet is classified and shows its registered owner from a real response | **Met, live** | `GET /api/aircraft/adca0b`: N988NC, a real G650, `business_jet`, owner "21st Century Fox America Inc" from adsbdb, with the type-designator disagreement served. 30 of 856 live aircraft classified as business jets |
| 2 | A LADD-listed aircraft resolves to its owner and renders like any other, with the LADD flag as an attribute, asserted against a real record | **Met, live** | The same record carries `on_ladd: true` with a full owner join and no suppression on any path. 17 of 856 live aircraft carried the flag. The source is `dbFlags` bit 8, documented at readsb `README-json.md:115` and published by adsb.lol on `/v2/ladd`, both re-fetched today. Nothing hardcoded, nothing inferred |
| 3 | Registry lookups are cached, no repeat call for the same hex in a session | **Met, live and by test** | Four card opens, one upstream `GET api.adsbdb.com/v0/aircraft/ADCA0B` in the log. `test_a_registry_lookup_is_cached_with_no_repeat_call_for_the_same_hex` PASSED, plus twelve cache tests in `tests/sources/test_adsbdb.py` |
| 4 | Failover is proven by a test that kills the primary | **Met, by test and live** | `test_the_union_member_falls_over_to_its_own_failover` PASSED. Fired three times live today: two HTTP 420s and one read timeout, on both the viewport path and the worldwide military path |
| 5 | One record per ICAO 24-bit address across a multi-provider fixture | **Met, by test on recorded real payloads** | `test_two_aircraft_providers_produce_one_record_per_icao_address` PASSED: 65 + 57 real records, 118 stored, addresses unique, asserted strictly fewer than the naive sum. Never run against two live providers, because only one answers |
| 6 | Every record names its provider and report age; two providers on one hex resolve to the newer position with both listed; no averaged position | **Met, by test; the live half is single-provider only** | Two tests PASSED, with the winner asserted byte-identical to one real input record rather than merely inside the two, because an average would pass a range check. Live, `source`, `providers` and `position_age_s` are on every served record and over the socket, but the list is always one long |
| 7 | Killing one provider leaves the layer up with a degraded flag naming which provider is missing | **Met, by test** | `test_killing_one_aircraft_provider_leaves_the_layer_up_and_degraded` PASSED: `degraded` true, `missing == ("airplanes.live",)`, the reason names it, 65 aircraft still served, feed still healthy |
| 8 | The count of aircraft visible only via an unfiltered provider, from a real run, recorded here | **Blocked. The number is zero** | No unfiltered provider is reachable. ADS-B Exchange 401, airplanes.live 403, adsb.one 403, all re-verified live today. Machinery built and asserted on recorded real payloads at 61 and 53. The live figure is zero because there is nothing to attribute |

### Phase 2 acceptance, carried forward

Phase 2's criteria were verified on 2026-08-20 in an earlier pass. I re-ran the live vessel path
and the endpoint sweep in this pass and the numbers above confirm them. Two of the nine are still
open and both are frame-rate criteria, recorded below. Criteria 3, 4, 7 and 8 remain met by test
only, because aisstream needs a key nobody has, AISHub needs an antenna, and CelesTrak does not
answer.

## Broken or not yet built

### Every source blocker, re-verified live at 17:49 on 2026-08-20

One sweep, the descriptive User-Agent this project mandates, nothing else changed. This is the
list that does not move, and none of it is a code problem:

```
celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json
  HTTP 000 time=20.001474  curl exit=28  (connect timeout)
api.airplanes.live/v2/point/51.5/-0.12/25
  HTTP 403  {"error": "Please contact us at contact@airplanes.live. Your email MUST include
             any links, a description of the project, and any information you deem appropriate."}
adsbexchange-com1.p.rapidapi.com/v2/lat/51.5/lon/-0.12/dist/25/
  HTTP 401  {"message":"Invalid API key. Go to https://docs.rapidapi.com/docs/keys ..."}
api.adsb.one/v2/point/51.5/-0.12/25
  HTTP 403
data.aishub.net/ws.php?format=1&output=json               (no username at all)
  HTTP 200  bytes=0  content-type: text/html
data.aishub.net/ws.php?username=NOSUCHUSER&format=1&output=json
  HTTP 200  bytes=105
  [{"ERROR":true,"USERNAME":"NOSUCHUSER","FORMAT":"HUMAN",
    "ERROR_MESSAGE":"Invalid username or password!"}]
download.geonames.org/robots.txt
  User-agent: *
  Disallow: /
```

Two of those lines are new information rather than a repeat. **AISHub called with no username at
all answers HTTP 200 with a zero-byte body**, which is the empty-200 case `AGENTS.md` recorded as
untested, and it is a different failure shape from the bad-username envelope on the line below it.
And the envelope is **105 bytes** for `NOSUCHUSER`, not the 115 this repo has quoted since
2026-08-19: the length includes the username echoed back, so a byte count was never a safe check.
The check that holds either way is `body[0]["ERROR"] is True` on a non-empty body, and an empty or
error 200 is a failed poll that never empties the vessel store. Both are now in
`docs/data-sources.md`.

### The GeoNames city layer rests on an unratified reading of robots.txt

`download.geonames.org/robots.txt` is `User-agent: *` / `Disallow: /`, re-verified today and quoted
above, and `cities15000.zip` sits behind it. Every city figure in this document, all 34,072 rows
and every search result that came out of the local index, rests on **R4**: the provisional reading
that `robots.txt` binds crawling and that a once-weekly conditional fetch of a published CC BY 4.0
data file is not crawling. R4 is recorded in `docs/pending-decisions.md`, it is not in an ADR, and
**it has not been ratified**. If Alexander rules the other way, the whole phase 4 city layer stops,
along with the Fintraffic vessel layer, the FEC lookup and the CCARCS ingest.

One thing worth knowing about the other half of R4, found today. **`meri.digitraffic.fi/robots.txt`
only serves a robots policy when the request carries `Accept-Encoding: gzip`.** Without it the path
answers HTTP 200 with the single line "Use of gzip compression is required with Accept-Encoding:
gzip header." With gzip it answers the real 31 bytes, `User-agent: *` / `Disallow: /api/`, which is
what this repo has recorded. So a robots checker that does not negotiate compression cannot read
the crawl policy it claims to honour, and it gets a 200 rather than an error while failing to. Same
class of trap as the FAA host answering 403 on its own `robots.txt`, recorded as U3.

### Phase 3 acceptance 8 cannot be met, and it is the one that carries the commercial argument

**The count of aircraft only an unfiltered provider can see is zero, and it will stay zero until
somebody gets access to one.** This is the criterion ADR 010 exists for. The whole point of
paying for ADS-B Exchange or getting on airplanes.live's allowlist is that most aggregators drop
or fuzz aircraft on the FAA blocking programmes, so the aircraft a wealth profile is about are
exactly the ones a single feed is missing. We cannot measure that today. Three blockers, all
re-verified live on 2026-08-20:

- **ADS-B Exchange**: HTTP 401 without a paid RapidAPI key, and the key is not the real problem.
  The provider prohibits redistribution without written permission and serving positions to a
  browser is redistribution. That is a licence blocker on the layer, not a credential. The only
  published plan is 10,000 requests a month, which a five-second sweep spends in fourteen hours,
  which is why the provider is demand-driven in code rather than swept.
- **airplanes.live**: HTTP 403 with a plain-text ask to email `contact@airplanes.live` a project
  description. Nobody has sent it. This is the cheapest thing on the whole list.
- **adsb.one**: HTTP 403 from this network.

Consequence, stated plainly: criteria 5, 6 and 7 are proven against recorded real payloads
through the real wiring and have never run against two live providers. The merge logic, the
recency rule, the no-averaging rule and the degraded flag are all asserted by tests over real
data, and none of them has been exercised by two networks disagreeing in real time. That is the
same root cause as criterion 8 and it is the second thing about phase 3 that cannot be closed
here.

### A failover record credits the wrong provider on the layer rail

Found in this pass, and it is a real defect rather than a design note. After the adsb.fi failover
fired, `GET /api/aircraft` served 891 records whose `source` field split adsb.lol 829 and adsb.fi
62, while the ADR 010 `providers` list read `["adsb.lol"]` on all 891. The provider row on
`GET /api/layers` said `provider adsb.lol, records 810, exclusive 810` for a cycle in which
adsb.fi supplied every record.

The cause is at `src/tracker/app.py:610`: `providers` comes from the union member's configured
name while `source` comes from whichever host actually answered inside the client. Both fields
are on the same record and they disagree. It matters for two reasons. The card reads `source` and
the layer rail reads the provider list, so the two surfaces credit different providers for the
same aircraft. And adsb.fi is licensed non-commercial, so crediting its data to adsb.lol on the
rail is an attribution error rather than a cosmetic one. Not fixed in this pass.

### There is no git remote, so CI has never run

`git remote -v` returns nothing, re-checked at 17:36 on 2026-08-20. `.github/workflows/ci.yml`
exists and has never executed. Every figure in this document was produced by hand on one laptop, in
one working tree, with one Python and one Node. "Green on a clean clone" is unproven and so is
"green on anything but this machine". That is the largest hole in the evidence above and it is not
a code problem.

It bites hardest on the browser half of phase 4. The 18-test Playwright suite is not in
`pnpm verify` and only CI runs it, so four of the six phase 4 acceptance criteria rest on a suite
that nothing gates. I ran it by hand today and it passed. Nothing stops the next change breaking
it silently.

### Neither frame-rate number has been measured

1,000 satellites at 60fps and 5,000 combined entities at 30fps are both open. What is proven is
the approach and the cost, not the rate: one `PointPrimitiveCollection` per layer created once
with positions mutated in place, 1,000 element sets propagating through SGP4 inside a 16.7ms
budget in Node, and the ISS position right to 1.50km and 2.21km against an independent
propagator. Today's live run held 1,725 entities across three layers. None of that is a frame
rate. A Playwright number in CI would come off software rasterisation and would say nothing about
a GPU, so a green badge earned there would be worse than an open criterion. This waits for real
hardware in phase 9.

### The satellite drop count is still only logged

`parse_elements` in `src/tracker/sources/celestrak.py` counts its refusals and only logs them.
The aircraft, military, vessel and registry counts are all served on `/api/layers` now. CelesTrak
is one provider with no union, so there is no provider row to carry the number, and serving it
means deciding what `records` and `exclusive` mean for a layer where nothing was merged. That is
an API change and a decision, not a patch. Inventing the numbers to fill the row would be worse
than the gap.

### ~~The CelesTrak floor and stop latch do not survive a restart~~ Fixed 2026-08-20

Superseded. This entry said `_attempted_at` and `_stopped_reason` were instance attributes and
that nothing in `src/tracker` wrote to disk. Both are now false: see "Upstream caches and
rate-limit floors survive a restart" above.

The objection recorded here was that a latch on disk turns one transient 503 into a permanent
satellite blackout no restart clears. That objection was right and it is what shaped the fix
rather than blocking it. The floor persists unconditionally, because a floor can only ever delay
us. The stop latch persists with an expiry set by its cause: a transient 5xx holds for one GP
publication cycle, a policy refusal holds for a day so a person has a chance to look at it. The
reset route is to stop the app, delete `upstream.sqlite3` and start again, and it is exercised in
the Works section.

Kept rather than deleted because the reasoning is worth having: the reviewer's objection to
persisting a stop latch was correct on its own terms, and the answer was an expiry rather than
either persisting it naively or leaving the floor in memory where a restart loop clears it.

### Blockers carried forward

**CelesTrak is unreachable from here.** DNS resolves, TCP 443 times out, `curl --max-time 20`
returns HTTP 000 with exit 28, re-checked at 17:49 today and quoted in the sweep above. Same answer
as the previous four checks on two networks. Zero requests have been served, so the two-hour budget
is intact and has never been tested against a real response. The satellite layer runs entirely on
recorded elements and reports itself unavailable when the cache is empty, which is the degradation
path working rather than a gap being hidden. It also costs phase 4 the "ISS" half of acceptance 1:
the query resolves inside the budget and resolves to Issia, because there is no satellite in the
store to find.

**AISHub needs an antenna, not code.** Access is granted only to members streaming raw NMEA from
a physical AIS receiver: at least 10 vessels averaged over 7 days, 90% uptime, downsampling no
coarser than 60 seconds, delay under 10 seconds, to a UDP port they allocate. Their terms prohibit
feeding them synthesized NMEA, scraped data or data from other public AIS services by name, so
there is no software route in. The adapter is written, tested and reports itself unavailable. Both
failure shapes are now measured, at 17:49 today: no username at all is HTTP 200 with a zero-byte
body, a bad username is HTTP 200 with a 105-byte JSON error envelope. The check is
`body[0]["ERROR"] is True` on a non-empty body, never a byte count.

**ADS-B Exchange is a licence blocker, not a credential.** Worth separating from the 401. The
provider prohibits redistribution without written permission, and serving positions to a browser is
redistribution, so buying the key does not clear it. The published plan is 10,000 requests a month
either way, which a five-second sweep spends in fourteen hours. ADR 010 names the JETNET route:
JETNET has owned ADS-B Exchange since 2023 and Altrata licenses JetNet data. That is a
conversation, not code.

**No live aisstream or AISHub data has ever been seen.** The vessel union has run three providers
in one cycle only against recorded payloads through the real wiring. Live, it runs on one.

**U2: the fixture rule does not distinguish a plane from a person.** The recon recorded 300 real
named UK people with addresses from the Companies House PSC snapshot, 10 real US donors from FEC
Schedule A, real named SEC officers and a real Commons portrait. None was committed. The rule as
written would put them in `tests/fixtures/`, where suppression under ADR 008 cannot reach them and
a clone ships them to anyone. The provisional reading keeps the real structure and synthetic
values, and it needs ratifying as an amendment to the fixture rule.

**U3: two registry hosts refuse the User-Agent our own rules mandate.** `registry.faa.gov`
answers HTTP 403 from Akamai across the whole host, `robots.txt` included, so we cannot read the
crawl policy we claim to honour. `services.casa.gov.au` hangs to timeout and returns zero bytes
unless the full browser header set is sent, so a block is indistinguishable from a network fault.
Transport Canada CCARCS serves the descriptive User-Agent normally. Neither reading is safe: one
puts a browser-impersonating client on two government hosts against a written rule, the other
deletes 316,030 FAA rows and the only Australian registry, which is most of the aircraft-to-owner
join. It needs Alexander Fanthome's decision, and it lands on phase 5 rather than here.

**U1: the LADD flag has a source, and what is still open is whose assertion it is.** Read this
before repeating "the LADD flag has no source", which was true of an earlier version of this file
and is not true of the code. The flag comes off `dbFlags` bit 8 on the readsb `/v2` schema, read at
`src/tracker/sources/adsb.py:71` and mapped at `:410`, documented by readsb in `README-json.md:115`
and published by adsb.lol on its own `/v2/ladd` endpoint. 17 of 856 live aircraft carried it on
today's earlier run, including 6 of the 30 business jets, so it is not hardcoded, not inferred and
not always false. Evidence is above under "The LADD bit is documented by the provider".

What stays shut is the FAA's own `IndustryLADD` file, published monthly through the NAS
Aeronautical Data Exchange portal to Service Consumers who have signed terms that oblige
suppressing those aircraft. We decline that route under ADR 009, so what the record carries is the
aggregator's assertion sourced from the FAA list rather than the FAA's own file, and the card says
so. The FAA register has no LADD column at all, measured on the real 316,030-row `MASTER.txt`, and
it does not need one. Its 4,773 blank owner names are 49 U.S.C. section 44114(b), a separate
programme operating on the registry rather than on flight data, recorded in
`docs/data-sources.md`.

### Provisional readings the code already assumes

All eight are unratified, none is in an ADR, and four are load-bearing right now. Full list in
`docs/pending-decisions.md`.

**R4 carries both bulk fetches this project depends on, and phase 4 is now one of them.**
`download.geonames.org/robots.txt` is `Disallow: /` for every path and every robot, re-verified
today, and `meri.digitraffic.fi/robots.txt` contains `Disallow: /api/`, re-verified today but only
when the request offers gzip. The reading taken is that `robots.txt` binds crawling rather than a
conditional fetch of a published licensed data file. Every live vessel number in this document
rests on it, and so does every one of the 34,072 cities and every phase 4 search result. It is
still unratified.

**R1 says a provider union counts as one origin**, because two aggregators repeat one transponder
or one AIS broadcast and one antenna often feeds several networks. ADR 010 claims the opposite in
its own opening. Taking ADR 010 at its word would inflate every confidence number resting on a
position, phase 12's occupancy candidates included.

**R2 scopes ADR 011's both-values-stay rule to enriched attributes**, so a live position conflict
resolves by recency and the superseded report is dropped. `src/tracker/services/union.py` assumes
it.

**R3 keeps adsb.fi a failover rather than a union member**, on its non-commercial licence. The
consequence is that the aircraft layer's provider-attributable coverage is zero until a second
provider lands, and the zero gets reported rather than hidden.

### Everything else standing still

**Four of the seven entity classes exist.** Aircraft, vessels, satellites and now cities.
Social posts (phase 8) have no code. Nor do events or POIs. `/api/capabilities` reports each one
unavailable with a reason. Organisations and people are no longer on that list: the ownership
spine ships, and `ownership` reports itself available once `TRACKER_CONTACT_EMAIL` is set.

**Buildings is not on that list any more**: it was reported unavailable with the reason "Set
TRACKER_CESIUM_ION_TOKEN to stream 3D buildings", which put a request for a Cesium key on the
layer rail, and there is no keyless global 3D building source to point it at. Removed on
2026-08-20 along with the `cesium_ion_token` setting.

**Cameras came off the list on 2026-08-23 for the same reason, and it was worse.** The row read
"Set TRACKER_WINDY_API_KEY or TRACKER_TFL_APP_KEY to enable public cameras", which was wrong three
ways at once. There is no camera adapter anywhere in the tree, so neither key would have enabled
anything. TfL JamCams are verified as needing **no key at all**, and New York 511 is keyless too,
so it asked for credentials from providers that do not issue them. And `Settings.camera_layer_
available` existed only to answer that one question, so it went with the row.

The opportunity is real and it is here rather than on a rail a viewer reads as a switch they could
throw. **A camera layer is buildable today with no key**: TfL JamCams are keyless with a 1.1MB
inventory to fetch daily and a mandatory three-string credit, and New York 511 is keyless with
1,066 of 2,931 cameras disabled, a second `Blocked` flag to honour, four records carrying
impossible coordinates and eleven shipping plaintext basic-auth credentials over plain HTTP. Both
are recorded in `docs/data-sources.md`. Windy needs a key and is the only one of the three that
does, so it is the part a keyless deployment goes without.

**The commercial join does not exist.** No profile, no wealth tier, no ownership link, no contact
or identity attributes. What runs is raw positions plus one registry lookup. The profile-to-asset
join that carries the commercial story starts at phase 5.

**Single worker only.** Pollers start in the lifespan, so a second uvicorn worker duplicates every
upstream request against feeds given to us for free. `src/tracker/__main__.py:28` pins
`workers=1`. Horizontal scaling needs a cross-process lock first.

**Cross-source corroboration, occupancy, multimodal evidence and the resolver are all decided and
unbuilt.** ADR 011, ADR 012 and ADR 015 are settled on paper. No model weights have been
downloaded and no CPU cost claim in ADR 015 has a measured number behind it. Post content analysis
under ADR 014 and face matching under ADR 013 are decided and unbuilt, at phases 8 and 14. The
written legal position from counsel that gates public deployment carrying real profiles does not
exist, and neither does the phase 6 US privacy position.

**The removal and suppression control exists and is not yet reachable.** Corrected 2026-08-24:
this said the control did not exist and that there was nothing to build against until phase 6.
Both halves are now wrong. The spine holds real named individuals from SEC filings, and
`services/suppression.py` plus `api/routes_removals.py` implement the whole of ADR 008's right to
be forgotten: one call that suppresses and sweeps, keyed by HMAC so the list cannot be read back,
reasons from a three-value enumeration so no name can be written into one. What is missing is one
line, `app.include_router(routes_removals.router)`, so `POST /api/removals` does not answer yet
and the only way to remove a record today is to call `RemovalService.remove` in a shell. The
authentication precondition above is a separate matter and applies once it is mounted.

**Seven sources are called, verified and unconsumed.** Sentinel-2 through earth-search STAC and
the Copernicus catalogue, NASA Worldview, TfL JamCams, New York 511, Wikidata WDQS, and GDELT DOC
2.0. All in `docs/data-sources.md` with their traps. No adapter exists for any of them.

Four have left that list since it was written, and they left in three different ways. The GeoNames
city file is consumed: `sources/geonames.py` reads it and the gazetteer answers out of it. Commons
geosearch and the `mas.to` public timeline are consumed: `sources/commons.py` and
`sources/mastodon.py` are the two halves of the social layer. The OpenStreetMap notes API is
**refused rather than unconsumed**, on the provider's own terms, and its row in
`docs/data-sources.md` says so.

**Not licensed for commercial deployment.** adsb.fi is non-commercial and it is the aircraft
failover, and it carried live traffic three times today. adsbdb's aircraft half has no licence at
all and its route half is prohibited from republication. Full audit in `docs/data-sources.md`.

## Next

Rewritten 2026-08-24. The previous list sent a reader to build phase 5, which is built, and to fix
the adsb.fi attribution defect, which was fixed the same day. Both are why this section is dated.

1. **Commit, then add a git remote and get CI green.** `.github/workflows/ci.yml` was written on
   2026-08-19 and has never run anywhere, because there is no remote for it to run on. Meanwhile
   **255 files are uncommitted on `main`**: the transit layer, the social layer, the ownership
   spine, the four-provider vessel union, the satellite fix and every audit fix from 2026-08-24
   exist in exactly one place, which is one working tree on one laptop with no backup.

   This is not theoretical. On 2026-08-23 a `git checkout --` on `src/tracker/app.py` destroyed
   about 450 lines of uncommitted work, recovered only from a dangling stash blob plus a replay of
   the session transcript, and a second agent repeated the same mistake on
   `frontend/src/globe/layers/aircraft.test.ts`. AGENTS.md now bans the command. The ban reduces
   the chance of a repeat, it does not make the tree recoverable.

   So this is first, above every feature and every decision below it, and the ordering is not a
   judgement call. Everything else on this list is a thing the project does not yet have. This one
   is everything the project already has, held without a copy.

2. **Get R4 ratified, or ruled against.** `download.geonames.org/robots.txt` is `Disallow: /` and
   the city layer sits behind the provisional reading that this binds crawling rather than a weekly
   conditional fetch of a CC BY 4.0 file. Unratified and load-bearing on 34,072 cities plus the
   place resolution behind every derived social location. Alexander Fanthome's call.

3. **Send airplanes.live the access email** to `contact@airplanes.live`, with links and a project
   description. Still the only cheap route to a second unfiltered aircraft provider: keyless once
   granted, one request per second, and the parser already handles its schema because it is the
   same readsb `/v2`. Until then the aircraft union has exactly one live member.

4. **Get a decision on ADS-B Exchange's redistribution terms**, since a key alone does not clear
   them. ADR 010 names the JETNET route: JETNET has owned ADS-B Exchange since 2023 and Altrata
   licenses JetNet data. A conversation, not code.

5. **Decide the authentication story for `POST /api/removals`**, recorded in Broken above. The
   route refuses in code when the API is not bound to loopback, so there is no open delete, but the
   consequence is that a networked deployment turns the removal control off rather than exposing
   it. A product whose removal control has silently stopped is worse than one that never had it.
   This sits alongside the US privacy position as a precondition for any public deployment
   carrying real profiles.

6. **Fold the two `## Broken or not yet built` sections into one.** This document has two headings
   of that exact name, at lines 402 and 1799, and has reached 2,128 lines. AGENTS.md describes it
   as Now, Works, Broken, Next; a reader cannot tell which of two identically named sections is
   current, and the duplication is how the stale Next above survived as long as it did.

### What is deliberately not on this list

Three things a reader keeps proposing, each already measured and refused, with the figure that
refused it. They are closed, not pending.

- **Wikidata as a person source.** Of 23 registry owners that look like natural people, two
  returned any candidate and both were wrong, one matching three researchers and a Waffen-SS tank
  commander. 44 of 44 owners in a jet-heavy New York sample were entities rather than people, and
  75% of organisation owners resolve to nothing because they are single-purpose companies with no
  public footprint by design. The working direction is person to asset through primary filings,
  which is built.
- **A wealth tier from a public source.** All of Wikidata holds 2,076 humans with a net worth
  statement, 58% of a 900-row sample cite no source at all, and four figures are dated 2026. It is
  a permanently unavailable capability row rather than a silent blank, because eleven empty fields
  on a profile read as a bug unless the product says why.
- **More ocean for the vessel layer.** Twenty-nine authorities were called on 2026-08-23 and four
  publish keyless live AIS. Denmark charges DKK 1,800 to 5,600 a year, Sweden's sits behind the
  paid RAIS database, and Italy, Greece and Lithuania answer 403 to a descriptive User-Agent. More
  coverage is a purchase decision rather than an engineering one.
