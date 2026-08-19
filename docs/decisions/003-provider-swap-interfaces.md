# ADR 003: every upstream sits behind a provider-swap adapter

**Date:** 2026-08-19
**Status:** Accepted

## Context

Almost every feed in this project is free, and free feeds change. adsb.lol publishes no
contractual rate limit and plans to introduce API keys earned by feeding data back.
aisstream.io is in beta with no service level agreement. adsb.fi is licensed for
non-commercial use only, which means it is already known to be wrong for one future state of
this project. CelesTrak firewalls abusive clients permanently and without appeal.

So the risk is not "an upstream might be slow". It is "an upstream might stop being usable,
for commercial, licensing or technical reasons, with no notice". A design that treats a
provider as a fixed part of the application makes that an emergency. A design that treats a
provider as a swappable detail makes it a configuration change.

There is a specific opportunity here too. The readsb `/v2` schema is shared by adsb.lol,
adsb.fi and ADSBexchange. Three providers, one response shape, so one parser can serve all
three if the parser is written against the schema rather than against a provider.

## Decision

**Every upstream sits behind an adapter in `src/tracker/sources/`, with a permissive wire
model inside it, so a provider can be swapped by base URL alone.**

Concretely:

- The wire model mirrors what the provider actually sends, `extra="ignore"`, non-strict
  (`src/tracker/contracts/base.py:68`). It is written against the schema, not the
  provider.
- The adapter maps wire to domain explicitly and is the only place a provider quirk is
  allowed to exist (`src/tracker/sources/adsb.py:164`).
- Base URLs are configuration, not constants: `adsb_base_url` and
  `adsb_failover_base_url` at `src/tracker/config.py:64`.
- Failover is built into the client. `AdsbClient._get` (`src/tracker/sources/adsb.py:331`)
  catches transport errors, rate limiting, 5xx and contract violations, then retries the
  same path against the secondary provider. A provider serving a different shape is as
  unavailable to us as one refusing connections, which is why `ContractViolationError`
  triggers failover too.
- Cadence floors live in code as module constants, not in configuration
  (`src/tracker/app.py:33`, `src/tracker/app.py:41`), and `effective_interval`
  (`src/tracker/services/poller.py:104`) is `max(configured, floor)`.

## Evidence it was the right call

**One parser, three providers.** `src/tracker/sources/adsb.py` handles adsb.lol, adsb.fi
and ADSBexchange because all three serve readsb `/v2`. That is not a prediction, it is the
current state of the file.

**The failover fired on the first live run, with zero code change.** adsb.lol answered
`/v2/mil` with HTTP 420, the client fell over to adsb.fi, and the military layer kept
serving. Nobody deployed anything. It fired again during the verification run recorded in
`docs/status.md`, this time against `/v2/point`.

**The interface also found its own limit, which is the useful part.** The military path
`/v2/mil` is identical on both providers, so that failover works. adsb.lol's viewport path
`/v2/point/{lat}/{lon}/{nm}` is not: adsb.fi uses
`/v2/lat/{lat}/lon/{lon}/dist/{nm}` and returns HTTP 400 for the adsb.lol shape. Both
confirmed on 2026-08-19. "Swappable by base URL alone" holds only where the paths agree, so
the adapter needs a per-provider path mapping rather than a shared path string. That is a
contained change inside one file, which is the point: the shortcoming showed up as a 400 in
one adapter, not as a broken frontend. Tracked in `docs/status.md`.

## Consequences

**Rate limiting needs its own exception type.** `RateLimitedError`
(`src/tracker/sources/base.py:47`) is separate from `SourceError` because the correct
response is different. A 500 is worth retrying promptly. A 429 retried promptly is how an
IP gets permanently blocked. The poller honours the provider's own `Retry-After` figure
rather than applying its backoff curve (`src/tracker/services/poller.py:145`), and reports
`rate_limited_until` to the UI so the banner reads "rate limited until X" rather than "feed
down". Those are materially different messages: the data is fine, we are being asked to
wait.

**Non-standard status codes have to be handled explicitly.** adsb.lol answers **420**
("enhance your calm"), not 429. Treating 420 as a plain client error would mean hammering an
endpoint that has explicitly asked us to stop, so `RATE_LIMIT_STATUS_CODES`
(`src/tracker/sources/base.py:21`) holds both. Expect more of this from free providers, and
expect to discover them the way this one was discovered: live.

**Cadence floors belong in code, not configuration.** A floor in a configuration file is one
careless environment variable away from getting the IP banned, and the ban is permanent with
at least one provider. Configuration can slow a feed down and can never speed it past its
floor. Each floor carries the reason as a docstring at the constant, so nobody lowers it
without reading why it is there.

**Failover can mask a licence problem.** adsb.fi is non-commercial, so the failover working
silently is exactly what you do not want before a commercial deployment: the application
looks healthy while quietly relying on a source it is not licensed to use. The licence audit
in `docs/data-sources.md` is the control for that, and the source name travels with every
record (`Aircraft.source`, `src/tracker/contracts/aircraft.py:151`) so which provider served
a given aircraft is visible rather than inferred.

**A permissive wire model can hide a provider drifting.** `extra="ignore"` means a new
upstream field is accepted silently. The mitigation is that the domain contract forbids
extras, so anything genuinely new has to be mapped deliberately before it can reach the
app, and parsers are tested against recorded real payloads that are re-captured when a feed
changes.

**Failover doubles the code paths that need testing.** Each adapter with a secondary needs a
test that kills the primary and asserts the layer stays up. Phase 3's acceptance criteria
require exactly that for the military layer.

## Alternatives considered

**One client class per provider.** Rejected. Three near-identical parsers for one schema,
which means a bug fixed in one and not the others, and a provider swap becoming a code
change under time pressure at exactly the wrong moment.

**Strict models at the wire layer.** Rejected, with a measured reason. adsb.lol's `/v2/mil`
returns eight fields `/v2/point` does not, so a strict wire model would have rejected all
391 military records in the 2026-08-19 capture and the military layer would not exist. The
strictness belongs one layer in, at the domain contract, where rejecting a bad record is the
correct outcome rather than a self-inflicted outage. Full reasoning in
`docs/architecture.md`.

**A generic HTTP-source abstraction shared by every feed.** Rejected as premature. The feeds
have genuinely different shapes: polling versus streaming WebSocket, JSON versus GeoJSON
versus WMTS versus SPARQL. A shared base class over that spread would be an abstraction
fitted to nothing. What is actually shared is small and already factored out:
`src/tracker/sources/base.py` holds the exception types, the rate-limit status codes and the
`Retry-After` parser, and nothing more.

**Configurable failover chains.** Rejected. One primary and one secondary per feed, in
configuration. A chain of arbitrary providers would need per-provider path mappings, per
provider licence tracking and per-provider auth before it did anything useful, and no feed
here has three viable providers today.
