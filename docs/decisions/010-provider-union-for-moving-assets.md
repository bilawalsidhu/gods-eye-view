# ADR 010: moving assets come from a union of providers, not one provider with a failover

**Date:** 2026-08-19
**Status:** Accepted
**Amends:** ADR 003 (provider swap interfaces), which designed for swapping and failing over
rather than for merging. ADR 003's interface survives; what changes is that more than one
provider is live at once.
**Relates to:** ADR 009 (LADD and privacy ICAO addresses are worked through), ADR 011
(cross-source corroboration), ADR 012 (inferred occupancy).

One thing worth stating up front, because it connects this ADR to ADR 011: a union of
providers is also a corroboration source. Two independent volunteer networks reporting the
same asset in the same place is exactly the second source ADR 011 asks for, and it is the
cheapest one in the system. Two providers agreeing is stronger evidence than one, and the
per-record provider list below is what makes that countable rather than rhetorical.

## Context

Today the aircraft layer polls adsb.lol and falls over to adsb.fi. One provider is live at a
time, and the coverage of the layer is the coverage of whichever one answered.

That is the wrong shape for the coverage this product needs. Aggregators do not see the same
aircraft, for two different reasons.

**Receiver geography.** Each network is the union of its own volunteers' receivers. A
business jet over rural Montana or mid-Atlantic is seen by one network and not another
depending on who has an antenna up.

**Filtering policy, which matters more here.** Most aggregators drop or fuzz aircraft that
appear on FAA blocking programmes. **ADS-B Exchange has never filtered**, and neither do
airplanes.live or adsb.one. Since ADR 009 decided this product works through those opt-outs,
an unfiltered provider is not a nice-to-have: it is the only way the aircraft layer covers
the population the profiles are about. The aircraft most likely to be missing from adsb.lol
are exactly the aircraft a wealth profile wants.

All of these providers serve the identical readsb `/v2` schema, so consuming several costs
no parser work. That is the fact that makes a union cheap.

## Decision

**Every live-mover layer is the union of its configured providers, polled concurrently.**
Failover survives underneath as the within-provider behaviour, but coverage is now additive
rather than exclusive. Aircraft merge on the ICAO 24-bit address; vessels merge on MMSI.

- **Providers.** adsb.lol stays the keyless default. **ADS-B Exchange is promoted from an
  optional extra to a named provider**, on a paid RapidAPI key or a feeder key. airplanes.live
  joins once access is granted by email. adsb.one stays a candidate while it is
  Cloudflare-blocked from our network. adsb.fi remains, non-commercial licence and all.
- **The merge key is the existing stable identity**, unchanged, which is what makes this
  cheap: the same aircraft reported by three networks is one record. ICAO 24-bit address for
  aircraft, MMSI for vessels.
- **Vessels are the same shape as aircraft.** Fintraffic Digitraffic covers Finnish and Baltic
  waters keylessly, aisstream.io covers the world on a free key, and **AISHub** adds a
  contributor network worldwide. The same argument applies: three overlapping volunteer
  networks see different ships, so the union is the coverage. AISHub's own admission price is
  different in kind though, and it is the one thing in this ADR that cannot be solved in
  software.
- **Every record carries the provider that supplied it and the age of that report.** Not one
  provider field on the layer, one per record, because a merged store where you cannot say
  which network saw a given aircraft is unauditable. This is the same per-attribute recency
  machinery phase 10 builds for profiles, applied to positions.
- **Conflicts resolve by recency, not by provider precedence.** Two providers reporting the
  same hex at different times: the newer position wins, and the record keeps the list of
  providers that saw it. Precedence ordering would mean a stale position from a preferred
  network beating a fresh one from another, which is the opposite of what this project is
  demonstrating.
- **A provider-attributable count is exposed**, so "aircraft only ADS-B Exchange can see"
  is a number the demo can put on screen. That number is the argument for paying for the
  feed, and it is measured rather than asserted.
- **Cadence is per provider, floored per provider**, because their limits differ by orders of
  magnitude. adsb.lol is polled on a short cycle; a metered ADS-B Exchange key cannot be, so
  its calls are demand-driven (the current viewport, a specific hex, a specific type) rather
  than a fixed sweep. The floors stay constants in code, per ADR 003's reasoning.
- **One provider failing degrades coverage and does not fail the layer.** A provider that
  errors, rate-limits or loses its key drops out of the union for that cycle and the layer
  reports itself degraded with which provider is missing.

**AISHub is reciprocal, so access needs hardware.** They grant API access only to members
streaming a raw NMEA feed that carries at least 10 vessels averaged over 7 days, at 90%
uptime, downsampled no coarser than 60 seconds and delayed no more than 10 seconds. They
prohibit feeding them synthesized NMEA, scraped data, or data from other public AIS services,
so there is no way to buy or fake the entry. An antenna within VHF range of shipping is the
price of admission, and siting it is a procurement task at the front of phase 2 rather than a
coding task inside it. Until it exists AISHub is configured-but-unavailable, and the vessel
layer runs on the other two providers with the reason reported.

## Consequences

**The licence position on this layer gets worse before it gets better.** ADS-B Exchange
prohibits redistribution without written permission, and serving positions to a browser is
redistribution. Making it a named provider makes that a blocker on the aircraft layer rather
than a footnote on an optional one. Two routes through: permission from the provider, or the
internal JETNET route, since JETNET has owned ADS-B Exchange since 2023 and Altrata licenses
JetNet data. Settle it before the layer ships publicly.

**Scraping the globe map is not an alternative and never becomes one.** Verified on
2026-08-19: the map page loads, `/data/aircraft.json` and `/re-api/` both answer HTTP 403
"Request forbidden by administrative rules", and `robots.txt` disallows `/api/`, `/mapproxy/`,
`/re-api/` and `/globe_history/` by name. Honouring `robots.txt` in code is one of this
project's rules. Anyone who finds a way around the 403 is working against both a technical
control and a stated directive, which is the one sourcing line ADR 004 kept.

**Cost becomes a design input.** A metered key means the polling model changes shape, from
"sweep the viewport every few seconds" to "ask this provider when it is worth asking". That
is more code than a second base URL, and it is the real work in this ADR.

**Double-counting is the obvious new bug class.** Two networks, one aircraft, two records is
a phantom fleet and an inflated layer count. The merge key and a test asserting one record
per identity across a multi-provider fixture are what prevent it: per hex in phase 3, per MMSI
in phase 2.

**AISHub signals failure with an empty HTTP 200**, both for a bad username and for a call
made more often than its documented once per minute. A union makes that more dangerous than
it looks, because an empty success reads as "this provider sees no ships" and could quietly
drop real vessels out of a merged store. An empty 200 is an error, counted, leaving the
existing records in place, and a test proves it never empties the store.

**Positions can now disagree.** Two receivers, two timestamps, slightly different
coordinates. Recency resolves it and the card shows the age, so a viewer can see why a
position is what it is. What the product must not do is average two positions into a third
that no receiver reported.

## Alternatives considered

**Keep ADS-B Exchange as an optional user-supplied key.** Rejected. It made the unfiltered
coverage an accident of configuration, so the demo's coverage depended on whether someone had
pasted a key in, and the aircraft most relevant to a wealth profile were the ones most likely
to be missing.

**Use ADS-B Exchange as the only provider.** Rejected. It is metered and its terms are the
most restrictive of the set, so it would put a paid dependency and a licence blocker on the
one layer that currently works keylessly.

**Scrape the globe map.** Rejected on the facts above: 403 and a robots directive.
