# Discovery routing and optional decision adapters

The discovery UI uses exact source identifiers, a normalized local text index,
body/spatial filtering and a bounded session cache. Ordinary card lookup makes
zero API and model calls. Whole `Q...` queries resolve exactly; an absent QID does
not match longer IDs by prefix. Labels, descriptions and aliases retain the
reference search ordering. Cache entries are cleared whenever a public library
is imported, reset or extended with explicitly fetched nearby cards.

## Optional local observations

Open **Local search observation**, then enable **Observe local search routing**.
This is off by default. At most 200 traces remain in memory; export downloads a
separate JSON file. Traces include mechanism, body, query shape, result count,
ambiguity, lookup milliseconds and zero baseline model/API calls. They contain
no raw search text, coordinates, case fields or study answers. Clear observations
empties them; reloading starts a new session with recording disabled.

Timing covers lookup, not DOM rendering. Source-shape verification checks the
installed source ID/body/provenance structure; it does not prove a visual entity
match or factual accuracy. No results means verification is unknown, not true.
The cache key retains the search text only in session memory; it is never part
of diagnostics export or provider features.

A deterministic shadow proposal reuses a successful local mechanism, or suggests
an explicit Earth geographic request when web permission and proximity are both
present. Otherwise it abstains. A suggestion never sends a request, moves the
camera, selects an identity or changes permissions. Actual web lookup still
requires the separate **Fetch nearby public cards** action.

## Reproducible baseline measurement

```sh
node scripts/benchmark-discovery-routing.mjs routing-report.json bridge-requests.json
```

The script checks 12 authored public fixtures against explicit expected source
IDs and the previous search's ordering/distances. It measures index setup
separately, then reference, uncached index and cached lookup with 30 warmup and
200 measured samples per fixture. Cache eviction happens outside the timed
section. The report identifies Node, catalog SHA-256, fixture denominator and
data origin. Use a supported Node runtime from package.json.

The October 5 local gate matched all 12 fixture expectations with zero model/API
calls. This 15-card catalogue does not demonstrate production search accuracy,
model calibration or monetary savings. Timings are lookup-only and tiny; caching
helps repeated name lookups, while simple browsing/proximity on a small catalogue
can be cheaper with the reference scan. There is no universal speedup claim.

## Real Parcimonia core probe

```sh
python -B scripts/parcimonia_discovery_bridge.py --root /path/to/parcimonia --input bridge-requests.json --output parcimonia-report.json
python -B scripts/parcimonia_discovery_bridge_test.py
```

Select a trusted checkout explicitly. This is a CLI bridge, not a browser service.
It accepts 1–20 closed metadata requests and rejects extra/private fields before
loading code. It captures and hashes that checkout's `contracts.py` and `router.py`
bytes and executes them in an isolated module namespace without importing package
initialization, model backends or weights. Source bytes are not vendored; `-B`
prevents bytecode writes. Output must stay in the calling workspace outside the
Parcimonia checkout. No dependency installation or shared service start is needed.

Task requirements remain `risk_class=low`, `evidence_level=normal`,
`locality=local`. Candidate confidence/cost are unknown: source linkage is not
calibrated route confidence. The inspected `shadow-routing/1` core only supports
`locality=any` and has no candidate locality guarantees. The real local probe
therefore recorded **12/12 abstentions**, no selected route, and zero model/API
calls. This negative compatibility result is retained rather than changing
locality to obtain an apparent success. Full constrained Parcimonia routing
requires a separate change in that project.

## Jev, Laya and OpenJev contract preparation

`systemOneEnvelope` prepares one typed `choice` question for five mechanisms:
exact identifier, cache, index, optional geographic web lookup and abstention.
Only closed, validated metadata enters the request. `createSystemOneShadowAdapter`
accepts a host-injected transport; it includes no SDK, HTTP client, model loader,
provider key or browser activation. Jev/Laya/OpenJev are contract kinds, not claims
of successful live inference.

An explicit model name and caller-declared revision are required; automatic/latest
aliases are refused. Default state is disabled. The strict-local gate refuses a
transport declared remote. Enabled calls are capped at one by default (maximum
20), with a 500 ms default timeout (maximum 5 seconds), cancellation and no retry.
Failures consume the budget. A host's custom transport must honor the abort signal
and locality declaration; these declarations are not an independent sandbox.

Responses must have a valid five-way probability distribution and a highest-
probability choice. Unsupported web/cache/identifier selections are refused,
empty local results cannot authorize a result-based route, and model-name
mismatches are reported. A returned revision matching configuration is only
`identityMatchReported`; `immutableIdentityVerified` remains false because a
response echo does not authenticate a checkpoint. Provider confidence remains
uncalibrated here, billed cost is unknown, and every result has
`permitsAutoAct=false` regardless of confidence.

Tests use injected synthetic responses, including timeouts, cancellation,
malformed probability maps, identity mismatches and unavailable routes. No real
Jev, Laya or OpenJev model was downloaded or executed. Live activation needs a
specific installed service/checkpoint, measured resource/quality/cost comparison
and explicit provider configuration; no paid path is enabled by this gate.

Protocol references inspected October 5, 2026:
[TypeSafe API](https://docs.typesafe.ai/api),
[Laya](https://github.com/NandhaKishorM/laya),
[OpenJev](https://github.com/lookski/openjev).
