# Provisional readings: unratified, reversible, and the code assumes them

Eight places where two documents this repo already holds cannot both be true. Found by the ADR
sweep on 2026-08-19 and recorded in `adr-matrix-b.md` as contradictions C1 to C8, plus one
sourcing conflict found by the live recon.

Alexander Fanthome was asked and was away from the keyboard. Rather than stall the build, each
one below takes the **conservative reading**, which in every case means the reading that asserts
less about a person or exposes less licence risk. Every one is reversible and none is written
into an ADR, because ADRs record his decisions and not mine.

**Rule for implementers:** where a reading below is load-bearing in code, the constant or the
branch carries the reason in a comment beside it and names this file, so reversing the decision
is a grep rather than an excavation. A test asserts the behaviour either way.

---

## R1 (was C7): a provider union counts as ONE origin

**Conflict.** ADR 010 opens by claiming "two independent volunteer networks reporting the same
asset in the same place is exactly the second source ADR 011 asks for, and it is the cheapest one
in the system". ADR 011 says independence is judged at the origin, two aggregators carrying one
wire story are one source, and where independence cannot be shown it is treated as absent.
ADR 015 generalises it to an origin key and calls it "the whole game".

**Reading taken: one origin, by default and in practice always.** Two ADS-B aggregators reporting
one aircraft are both repeating a single transponder broadcast, which is precisely the wire-story
case. Worse, one volunteer antenna routinely feeds adsb.lol, adsb.fi and ADS-B Exchange at the
same time, so two providers agreeing can be one receiver counted twice, and nothing in the readsb
`/v2` schema identifies the receiver. ADR 011's own "where independence cannot be shown it is
treated as absent" therefore forces one origin.

**Why this one matters most of the eight.** It makes a number wrong rather than a document stale.
ADR 010's claim would inflate every corroboration score resting on a position, the phase 12
occupancy candidates included.

**In code.** The origin key for a position claim is derived from the observed asset and the
observation, not from the provider. A test asserts that the same asset reported by three
providers contributes one origin to a corroboration score, and a separate test asserts it still
contributes three entries to the per-record provider list, because coverage and corroboration are
different questions.

---

## R2 (was C6): ADR 011's both-values-stay rule is scoped to enriched attributes, not live positions

**Conflict.** ADR 010: position conflicts resolve by recency, the newer wins. ADR 011 and
AGENTS.md: conflicting dated values both stay with the disagreement shown, nothing is silently
overwritten.

**Reading taken: live positions resolve by recency and the superseded report is dropped. ADR 011's
both-stay rule governs enriched profile attributes only.** A position is an observation of one
physical object at one instant, not a competing claim about a fact. Keeping both would mean two
pins for one aircraft, which is the phantom-fleet bug ADR 010 exists to prevent. "Was he a
director in 2019" is the case ADR 011 is actually about.

**In code.** `services/union.py` resolves by recency. The docstring says this scoping is
provisional and names this file. A test asserts nothing is averaged and the winning position is
byte-identical to one real input.

---

## R3 (was C5): adsb.fi is a failover, not a member of the union

**Conflict.** ADR 010 lists adsb.fi among the union's providers ("adsb.fi remains, non-commercial
licence and all"). The implementation plan's phase 3 says "adsb.fi stays as failover".

**Reading taken: failover only.** adsb.fi is licensed non-commercial. In the union its licence
attaches to records served to browsers on every cycle; as a failover the exposure is confined to
outage windows. This is a commercial demo, so the narrower exposure wins. It also keeps adsb.fi
out of the per-record provider list, the one-record-per-hex count and the
provider-attributable coverage number, which is the honest position given R1.

**Consequence to state plainly:** ADR 010's coverage argument now rests entirely on ADS-B Exchange
and airplanes.live, and neither is accessible today. So the aircraft layer's unfiltered coverage
is zero until a key or an access grant lands, and the provider-attributable count will be zero
rather than absent. Report the zero.

---

## R4: the GeoNames bulk download proceeds

**Conflict.** AGENTS.md: "Honour `robots.txt`, published crawl delays and stated request caps in
code." Verified 2026-08-19: `download.geonames.org/robots.txt` is `User-agent: *` / `Disallow: /`,
every path and every robot, and `cities15000.zip` sits behind it. The file answered HTTP 200 at
3,306,600 bytes with `ETag` and `Last-Modified` served, is published under CC BY 4.0 and is
documented by GeoNames for exactly this use.

**Reading taken: robots.txt binds crawling, not a once-weekly conditional fetch of a published
data file.** GeoNames puts the dump on a host separate from its website and documents the files
for download. A single `If-None-Match` request a week is not spidering.

**The consistency debt this creates, and how it is paid.** ADS-B Exchange's globe map is currently
excluded partly *because* its `robots.txt` disallows the paths by name. Under this reading that
argument no longer carries the exclusion on its own, so the exclusion is restated on the two
grounds that stand independently: `/data/aircraft.json` and `/re-api/` both answer HTTP 403
"Request forbidden by administrative rules", and the provider's terms prohibit redistribution
while serving positions to a browser is redistribution. Both are already verified and neither
needs robots.txt. AGENTS.md and `docs/data-sources.md` say so in the same change.

---

## R5 (was C1): no live position ever becomes a location entry on a profile

**Conflict.** ADR 007: "a join to a live feed produces a dated entry like anything else, with the
feed named as its source", and phase 6 acceptance 4 asserts it. ADR 012: the occupancy estimate
"never writes a location entry onto a profile", and phase 12 acceptance 5 asserts that. The only
mechanism by which a live position becomes a person's location is the occupancy inference, so
ADR 007 requires the entry and ADR 012 forbids the only route to it.

**Reading taken: the dated entry ADR 007 describes lands on the asset, never on the profile.** A
profile shows the join (this person owns this aircraft, which is currently airborne here) with its
source, confidence and date, and it shows the inference as an inference. It does not gain a
location attribute from it. Live feeds that are not position feeds are unaffected: a geotagged
post joined to a person still produces a dated location entry, because the coordinate is a fact
about the post rather than an estimate about the person.

This is the conservative reading and it is the one that keeps phase 12's hardest safety rule
intact. It is also the reading AGENTS.md already implies.

---

## R6 (was C2): the suppression comparison to FAA LADD is dead

ADR 006 and ADR 008 both anchor removal and suppression to "the same mechanism already demoed for
FAA LADD opt-outs". ADR 009 deleted LADD suppression entirely, so there is nothing to be the same
as. ADRs are append-only and will not be corrected.

**Reading taken:** there is one suppression path and it is ours. AGENTS.md already says this. An
implementer must not go looking for a LADD suppression path to copy, and must not build one:
that would violate ADR 009 directly.

---

## R7 (was C3): removal is immediate, and the thirty-day figure is not a code constraint

ADR 008 gives a thirty-day completion target "matching the business standard" and in the next
breath says there is no queue and no human step so the control takes effect immediately. A
thirty-day service level only means anything where something is pending, and every queue, pending
state and human step is banned outright.

**Reading taken:** immediately. The thirty days is inherited business context. Building anything
deferred to satisfy it would break the no-human-verification rule. A test reads the store in the
same request and finds the record gone.

---

## R8 (was C8): the deployment gate uses ADR 007's wording

ADR 006 blocks "any public deployment carrying real profiles". ADR 007 blocks anything "carrying
person data". Person data is the wider category: a geolocated Mastodon post joined to nobody still
carries it. ADR 007 is later and stricter, so it governs.

---

## Still genuinely unresolved, and not mine to read either way

## U1 (was C4): the LADD flag has no source. WRONG on both counts: see U1 CLOSED below

ADR 009 requires LADD membership carried as an attribute on the aircraft record, "because it is
itself a fact about the owner worth having on a wealth profile". The same ADR's Context says the
LADD list "was never handed to us" and that this is why we stopped applying it. AGENTS.md lists
`dbFlags` bit 1 (military) and bit 4 (privacy ICAO address) and no LADD bit, so the readsb `/v2`
schema does not carry it.

Phase 3 acceptance 2 nonetheless demands "a LADD-listed aircraft resolves to its owner and renders
like any other, with the LADD flag shown as an attribute. Asserted against a real record", which
requires knowing that a specific real aircraft is on the programme.

**Either** the FAA's published LADD participation data becomes a source with its own
`docs/data-sources.md` row and a verification date, **or** phase 3 acceptance 2 cannot be built as
written. The aviation-registry recon was asked to look; if it found nothing, phase 3 reports this
as a blocker and does not fake the flag. A hardcoded LADD list, a guessed flag or a test fixture
standing in for a real record would all be placeholder data in the running product, which the
global constraints forbid.

---

## U1 CLOSED 2026-08-20: the LADD flag comes off the feed, and my earlier reading of it was wrong

**Closed, and ADR 009 is buildable exactly as written.** Two earlier entries in this file said the
LADD flag had no source, then said the only source bound us to suppress. Both were wrong, and the
error was mine rather than the recon's.

**What is actually true.** `dbFlags & 8` on the readsb `/v2` schema is the LADD bit. readsb documents
it, `DB_FLAG_LADD: Final = 8` has been in `src/tracker/sources/adsb.py` since phase 1, and adsb.lol
publishes `/v2/ladd` on top of it. Verified live 2026-08-20: 357 aircraft, every one carrying bit 8,
with real registrations. The phase 3 build agents found this and were right.

**Where I went wrong, because the shape of the mistake is worth keeping.** The aviation registry
recon correctly reported that the FAA `MASTER.txt` file has no LADD column, which is true. I read
that as "the project has no source for the flag", searched for the FAA's own list, found it behind a
SWIM Data Access User Agreement that obliges the subscriber to suppress, and concluded ADR 009 was
internally impossible. The registry and the feed are two different sources and only one of them was
ever missing the field. I had already read the `DB_FLAG_LADD = 8` constant earlier in the session and
did not connect it.

**The distinction that makes ADR 009 work.** We consume **the aggregator's assertion**, which
adsb.lol derived from the FAA list and publishes as a database field on a volunteer receiver network.
We do not consume **the FAA list**, which would come with the agreement attached. So the flag arrives
with no obligation, which is exactly the position ADR 009 reasoned toward: LADD binds FAA-provided
feeds, our positions come from volunteer receivers, so the suppression was never handed to us and the
flag is just an attribute.

**What stands from the wrong analysis, because it is still worth holding:** never take the
`IndustryLADD` list. It is on `adx.faa.gov`, first Thursday monthly, and the only route to it binds us
to hide exactly the aircraft ADR 010 exists to reach. Consume the bit, never the list. That line is
now in `AGENTS.md`.

**Phase 3 acceptance criterion 2 and phase 5 acceptance criterion 3 are restored to their original
wording** in `docs/plan/implementation-plan.md`, with the `dbFlags & 8` source named.

---

## U5: the PII suppression is two packages with different field sets, not one flag

**Found:** 2026-08-20, reading `docs/business-context.md:140` against the plan's phase 6 deliverables.
Recorded because phase 6 has not been built and a single boolean is the obvious thing to reach for.

The plan says contact fields "carry a PII marker so a suppressed view can be served", mirroring "the
`NoContactData` and `NoPII` packages the business sells". ADR 008 says the same. Read on its own that
implies one flag on the contact fields.

The business context is more specific, and the names are different:

- **`Core-NoContactData`** strips email addresses and phone numbers. That is it.
- **`Core-NoPII`** strips **nationality, gender, date of birth, age, deceased date, diversity,
  residence, hometown, personal email and personal phone.**

So the two sets are neither equal nor nested in the obvious direction. `Core-NoPII` reaches identity
attributes that are not contact data at all (nationality, gender, date of birth, age, deceased date,
hometown) and reaches only the *personal* email and phone, while `Core-NoContactData` takes every
email and phone including the business ones. Neither is a subset of the other.

**What that means for the contract.** A single `pii: bool` marker on the contact fields cannot serve
either package correctly. It would over-strip a `Core-NoContactData` view by hiding date of birth,
and under-strip a `Core-NoPII` view by leaving nationality and gender in. Phase 6 needs the
membership modelled per field and per package, and phase 6 acceptance 7 ("a profile served with
contact data suppressed carries none of its contact fields") should be read as one of two views
rather than the only one.

**Two more facts from the same source worth carrying into the contract:**

- **Personal address is its own table and the platform shows up to fifty personal addresses on a
  profile.** So addresses are a collection with a cap, not a field, and the dated-series rule from
  ADR 006 applies to them the same way it applies to locations.
- **The exact tier vocabulary, which is fixed and must not be paraphrased:** HNW (over $1m excluding
  primary residence), VHNW ($5m to $30m), UHNW (over $30m), plus two that are ours rather than the
  industry's, **Likely VHNW** ($2m to $5m on an incomplete valuation) and **Likely UHNW** (a single
  asset of $5m or more, or total assets of $20m to $29.9m, on an incomplete valuation). One tier per
  profile, higher wins, so a profile that is both Confirmed VHNW and Likely UHNW displays as Likely
  UHNW.
  **One inconsistency to flag rather than resolve:** HNW starts at $1m and Likely VHNW covers $2m to
  $5m, so a $3m incomplete valuation satisfies both definitions. The higher-wins rule settles the
  display, but the thresholds themselves overlap in the source. Not ours to change, worth knowing
  before someone writes a classifier and finds the bands do not partition.

---

## U2: the fixture rule does not distinguish a plane from a person

**Found:** 2026-08-20, during source recon.

`AGENTS.md` and the plan's global constraints both say the same thing about fixtures: "Real data
only. No mock feeds, no sample data, no placeholder entities in the running product. Recorded real
payloads are used *only* as test fixtures." That rule was written when every feed in the project
carried aircraft, ships and satellites. It is exactly right for those.

Applied to the phase 6 sources it produces something nobody decided. The recon recorded, into
`tests/fixtures/`:

- 300 real named UK people from the Companies House PSC snapshot, each with name elements,
  nationality, month and year of birth, country of residence and a full address.
- 10 real US political donors from FEC Schedule A, each with street address, city, state, zip,
  employer and occupation.
- Real named SEC officers and directors with addresses, from Form 4 and the submissions API.
- A real Commons photograph reached through the Wikidata P18 reference-face path.

None of it was committed and none of it left the machine. But the shape of the problem is worth
naming, because it is structural rather than an accident:

**A fixture is a copy that suppression cannot reach.** ADR 008 makes the right to be forgotten a
product feature: a removal deletes the record and keeps a suppression key that survives re-ingest.
ADR 015 goes further and requires a removal to delete every version of a reference face embedding.
A person's name and address sitting in a git-tracked test fixture is outside all of that. It
survives the removal, it survives the re-crawl, and it ships to anyone who clones the repo.

**Reading taken, and it costs nothing.** Where a recorded payload carries data about an
identifiable natural person, the fixture keeps the real structure and takes synthetic values. The
tests over these adapters assert field mapping, sentinel handling, unit conversion and
drop-and-count behaviour. Not one of them needs a real person's name to do that. Entity
identifiers that are public business facts (company number, CIK, committee ID) stay real, so the
fixture still matches the real API.

The originals are kept outside the repo as the recon's evidence, since the shapes came from real
calls and re-fetching them costs provider budget.

**Why this is not a weakening of the real-data rule.** The rule exists so the running product is
never demoed on invented data. Fixtures are tests only and never reach the product, so nothing
about the demo changes. What changes is that cloning this repo no longer hands someone 300 real
people's addresses.

**Needs ratifying** as an amendment to the fixture rule in `AGENTS.md`, and it is the one item here
that probably deserves its own ADR rather than a line in a gotchas list.

---

## U1 update: the FAA registry holds no LADD data (true, and not the point: the feed does), and a different privacy programme was mistaken for it

**Found:** 2026-08-20, aviation registry recon, measured on the real 316,030-row MASTER.txt.

The FAA Releasable Aircraft Database carries **no LADD field and no LADD list**. What it does
carry is the effect of a different programme: **1.51% of records arrive with the owner name and
street blank**, 4,773 of 316,030 rows with an empty `NAME` and 4,771 with an empty `STREET`.

That is 49 U.S.C. section 44114(b), quoted from the FAA's own page: private aircraft owners can
request that personally identifiable information such as names and addresses be withheld from
broad dissemination or display on a publicly available FAA website.

**It is not LADD and ADR 009 does not cover it.** ADR 009 decided that LADD and privacy ICAO
addresses are worked through rather than honoured. Section 44114(b) is a separate programme, it
operates on the *registry* rather than on flight data, and the withholding has already happened
upstream before we fetch anything. There is nothing for the product to decide or work through: the
record simply arrives empty, and it is dropped and counted like any other unmappable record.

**Two consequences.**

1. **The repo should stop implying ADR 009 covers every FAA privacy path.** It covers two, LADD
   and privacy ICAO addresses. A third exists, it bites the ownership spine rather than the
   aircraft layer, and it needs a line in `docs/data-sources.md` next to the FAA row so nobody
   spends a day looking for the suppression logic that would explain 4,773 blank owners.

2. **U1 stands and hardens.** No source for a LADD flag has been found. The registry does not have
   it, and the readsb `/v2` schema has no LADD bit. Phase 3 acceptance 2 ("a LADD-listed aircraft
   resolves to its owner and renders like any other, with the LADD flag shown as an attribute,
   asserted against a real record") therefore cannot be built as written, because nothing tells us
   which real aircraft is on the programme.

   The remaining possibility not yet checked is whether the FAA publishes the LADD participation
   list separately from the registry, through its own request process or a FOIA release. That is
   worth one look before phase 3 declares it blocked. If it exists it becomes a source with its
   own row and verification date. If it does not, phase 3 reports the blocker and builds
   everything else, and the acceptance criterion gets rewritten rather than satisfied with a
   hardcoded list or a fixture standing in for a real record. Either of those would be placeholder
   data in the running product, which the global constraints forbid outright.

---

## U3: two registry hosts refuse the User-Agent our own rules mandate

**Found:** 2026-08-20, aviation registry recon, both measured live.

`AGENTS.md` says, under Data sourcing: "Honour `robots.txt`, published crawl delays and stated
request caps in code. Descriptive User-Agent with contact details." Two of the three aviation
registries the ownership spine depends on will not serve a client that obeys it.

**The evidence.**

- **FAA Releasable Aircraft Database**, `registry.faa.gov`. A descriptive User-Agent carrying a
  project name and a contact address is answered **HTTP 403 by Akamai across the whole host**,
  `robots.txt` included. So the host refuses to serve the crawl policy that would tell us what it
  permits, while that same robots file permits the download path it will not hand over.
- **CASA aircraft register**, `services.casa.gov.au`. Worse, because it is not a refusal you can
  see: the request **hangs until timeout and returns zero bytes**. A bare Chrome User-Agent string
  is not enough either. Only the full browser header set gets a reply. In an adapter this is
  indistinguishable from a network fault, so a silent block gets logged as flaky upstream.
- Transport Canada CCARCS serves the descriptive User-Agent normally, so this is two hosts out of
  three rather than a general position.

**Reading one: send the browser header set, log it, and record it in `docs/data-sources.md`.**
The rule exists so a provider can identify us, throttle us and contact us. Neither of these hosts
offers a route to be identified: there is no key, no registration and no contact channel on the
download path, and both files are published for public download (FAA public domain, CASA CC BY
4.0). Under this reading the User-Agent rule is about not hiding from a provider who wants to
manage us, and a provider whose edge blocks all non-browser clients indiscriminately is not
expressing a preference about us. The fetch is once a day at most on FAA and once on a
`Last-Modified` change on CASA.

**Reading two: the rule binds and both sources are blocked.** A User-Agent chosen to look like a
browser is misrepresentation, which is a different act from being terse. The FAA case is sharper
than it looks: we cannot read `robots.txt`, so we cannot claim to be honouring it, and
"honour `robots.txt` in code" is unsatisfiable on a host that will not serve it. Under this
reading the FAA and CASA rows in `docs/data-sources.md` become blocked pending a licensed or
contacted route, phase 5 builds on CCARCS only, and the plan states the coverage gap rather than
papering over it.

**Consequences of getting it wrong, both directions.** Reading one puts a browser-impersonating
client in the product against a written rule in `AGENTS.md`, on a US government host and an
Australian government host. Reading two removes the FAA register, which is 316,030 rows and the
only registry that ships a deregistration file, and CASA, which is the only Australian one. That
is most of the aircraft-to-owner join the demo is about.

**Not taken either way, and nothing in the code assumes one.** Unlike R1 to R8 above, no
conservative default is available here: one reading breaks a stated rule and the other deletes
two of the three registries. It needs Alexander Fanthome's decision. Until it lands, phase 5
reports both hosts as blocked and builds the CCARCS path, which needs no workaround.

**Do not write this into an ADR.** ADRs record his decisions, not ours.

---

### Decided 2026-08-20 by Alexander Fanthome: use cloudscraper for the bot-filter blocks

He said, verbatim: "if you're struggling to get web pages, use cloudscraper with astral uv, it's
what we use in other projects to download pages". The decision stands and `cloudscraper` is
what phase 5's registry fetcher will use. It is **not** declared in `pyproject.toml` yet: it was
declared ahead of any call site, where it pulled in requests, urllib3, charset-normalizer,
pyparsing and requests-toolbelt, so a project whose HTTP stack is httpx shipped a second HTTP
stack with nothing behind it. It lands in the change that first imports it.

**This settles U3 for the FAA and CASA, and it does not settle everything.** The distinction is
whether the block is a bot filter or a stated directive from the provider, and the two are not the
same thing.

**Where cloudscraper applies.**

- **FAA `registry.faa.gov`.** The 403 comes from Akamai and hits `robots.txt` itself, while the
  FAA's own `robots.txt` **permits the download path**. So the provider allows the fetch and its CDN
  refuses the User-Agent. The data is public domain, published for download. Presenting a browser
  header set to get the file the provider says we may have is closing a gap between two of their own
  systems, not going round a decision they made.
- **CASA `services.casa.gov.au`.** Same shape. It hangs to timeout on a descriptive User-Agent and
  answers on a full browser header set. Nothing states a prohibition.
- **adsb.one.** Cloudflare-blocked, which is what cloudscraper exists for, and no stated
  prohibition. It stays a candidate provider rather than a dead one.

**Where it must not be used, and this is the part worth holding.**

- **airplanes.live.** Its 403 is not a bot filter. It is the provider saying "email us a description
  of your project" and telling us exactly how to get in. Defeating that with a browser header set
  goes round a decision a human made and told us about. The route in is the email, which nobody has
  sent.
- **ADS-B Exchange's globe map.** `/data/aircraft.json` and `/re-api/` answer 403 "Request forbidden
  by administrative rules", `robots.txt` disallows those paths **by name**, and the provider's terms
  prohibit redistribution while serving positions to a browser is redistribution. Three independent
  reasons, none of them a User-Agent problem. ADR 010 already calls this settled twice over and says
  anyone finding a way round the 403 is working against both a technical control and a stated
  directive. cloudscraper changes nothing here.

**The rule this leaves in AGENTS.md.** "Honour `robots.txt`, published crawl delays and stated
request caps in code" stands unchanged. What is now explicit is that a CDN User-Agent filter is not
a stated directive, and that where `robots.txt` permits a path the CDN refuses, the `robots.txt`
governs. Where a provider states a route in, that route is the route in.

**Still open under U3:** nothing on the FAA or CASA side. The rate discipline still applies: the FAA
zip refreshes daily at 23:30 US central, so the fetch is conditional on `Last-Modified` and runs
once a day at most, cloudscraper or not.

---

## U4: three plan claims the live recon disproved, one of them a licence blocker on phase 12

**Found:** 2026-08-19 and 2026-08-20, during the live source recon. Recorded here because each one
sits in a phase not yet built, so the correction has nowhere else to live until then.

### ProPublica does not give trustees, and phase 6 assumes it does

`docs/plan/implementation-plan.md` lists ProPublica Nonprofit Explorer under phase 6 for "trustees,
foundation assets", and the ADR 011 corroboration design counts it as a source of people.

Verified against the live API with all 168 response keys enumerated: **there is no trustee, officer
or director name field anywhere in it.** Assets yes, people no. So ProPublica is a source of
organisation financials and not a source of person records, and phase 6 loses one of its four
public profile sources before it starts.

That matters for corroboration rather than just for coverage. ADR 011 says a single scraped or
crowd-sourced source never crosses the assertion threshold alone, and primary records may. Dropping
ProPublica from the people side removes one of the few primary records that could have corroborated
a trusteeship, so phase 6 should not be planned on the assumption it is there.

### Wikipedia REST has no geosearch, and phase 7 assumes it does

The plan's phase 7 deliverables include a "Wikipedia geosearch nearby panel for the current view".
Geosearch is not in the Wikipedia REST API at all. It exists on the MediaWiki **action** API, which
is a different interface with different error semantics: an error arrives as an `error` key inside a
200 body, `formatversion=2` is mandatory in practice, and `gsradius` is capped at 10 to 10,000
metres so a wide-area search has to be tiled. Also worth correcting in the same pass: the API
declares **CC BY-SA 3.0 and GFDL**, not the CC BY-SA 4.0 the plan and the attribution table claim.

### adsbdb's flight-route licence blocks what ADR 012 wants

This is the one that needs a decision rather than a correction.

adsbdb is already in the tree as the phase 3 registry lookup. Its **flight-route data may not be
copied, published or incorporated into another database.** The aircraft half carries no licence
statement at all.

ADR 012's occupancy estimator draws on "the live transponder or AIS track and the current origin and
destination pair". The origin and destination pair is exactly the route data, and storing it so the
estimator can reason over it is incorporating it into another database. So either:

- the route pair comes out of the phase 12 evidence set, and the estimator loses one of its named
  inputs, or
- another source supplies the route pair on terms that permit storage, and it gets its own
  `docs/data-sources.md` row with a verification date, or
- the route is read at request time and never stored, which is a weaker version of the same claim
  and needs checking against the same licence text rather than assumed to be permitted.

Nobody has picked one. Phase 12 is a long way off, but ADR 012 names the input, so this should be
settled before the estimator is designed rather than discovered while building it.

**Two smaller facts worth carrying, both measured:** adsbdb misses about **19% of real aircraft**
(3 of 16 genuine aircraft in this repo's own live fixture do not resolve) and a 404 is normal
operation rather than a fault, so the enrichment path must treat a miss as an answer. Its airport
`elevation` is in **feet** with nothing in the payload saying so.

---

## U6: the LADD flag is one non-primary source, and nothing says how to label it

**Found:** 2026-08-20, closing out phase 3. Recorded rather than answered: it is a labelling
decision for phase 6, not a phase 3 defect, and no code is waiting on it.

`on_ladd` reaches the aircraft contract from `dbFlags & 8` and the source is verified:
adsb.lol's `/v2/ladd` returned 357 aircraft on 2026-08-20 and every one carried bit 8. U1
CLOSED above settles where the flag comes from, and ADR 009 settles that we carry it as an
attribute rather than applying it as a suppression. Neither settles how it should be
**labelled** once phase 6's corroboration service starts putting confidence on a card.

What the flag actually is: **the aggregator's copy of the FAA list, not the FAA list.**
adsb.lol derived it from the FAA's `IndustryLADD` publication and serves it as a field on its
own aircraft database, over a volunteer receiver network. Under ADR 011 that is a single
non-primary source, and ADR 011 says a single scraped or crowd-sourced source never crosses
the assertion threshold on its own: it is shown as unconfirmed with its score and excluded
from every aggregate. There is no second origin to be had, because the only route to the FAA
list itself binds the subscriber to hide the aircraft.

The two readings:

- **Asserted.** It is a field on a database a provider publishes about an aircraft, the same
  class of thing as the registration and the type designator this project already takes off
  the same feed and displays with no corroboration count. On this reading ADR 011 governs
  claims about people rather than provider database fields, and a card says "on the FAA LADD
  programme" flat.
- **Unconfirmed, with its score.** LADD membership is a fact about the owner, which is the
  reason ADR 009 wants it on a wealth profile at all, so it is a person-attached claim and
  ADR 011's threshold applies. On this reading a card says one source reports it, and it stays
  out of any count of LADD-listed owners.

Whoever settles it settles the same question for `uses_privacy_address` and for every other
provider database flag ADR 009 leans on, so it is worth deciding once rather than per field.
