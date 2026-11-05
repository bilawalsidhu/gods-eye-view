# Convergence detection

A derived-intelligence layer, sibling to Pattern Watch. It reads the track
history already sitting client-side and reports where two independently tracked
entities **closed to the same place and time, held proximity, then separated**.

## What it reports, and what it does not

It reports an **observed spatiotemporal coincidence**, with the geometry
attached:

- the two `{layerKey, id}` identities,
- when they were closest and how close (`tClosest`, `minSeparationM`),
- how long they held proximity (`dwellS`),
- whether they approached and then departed (`approached`, `departed`),
- a coincidence **score** in `[0,1]` derived only from that geometry.

It does **not** assert intent. There is no "meeting", "transfer", "handoff",
"contact", or "relationship" — the event object has no field for any of it, and
a source-level test (`event shape asserts no intent`) fails the build if one is
added. Two entities being in the same place at the same time is a geometric
fact; what it means is a judgement the operator makes and owns.

This mirrors the language distinction Pattern Watch draws between an observed
flight pattern and inferred purpose.

## Method

For each candidate pair (coarse-gated by time overlap and a spatial bucket, so
not every `O(n²)` pair is scored):

1. Resample both tracks onto a common time grid across their overlap.
2. Build the separation series `d(t)`.
3. Require **all three**:
   - `min(d) ≤ rNearM` — they actually got close;
   - `dwell(d ≤ rNearM) ≥ tMinDwellS` — they _held_, so a crossing fly-by is
     not a convergence;
   - approach → departure — separation fell to the minimum, then rose.
4. Score = `0.5·closeness + 0.3·dwell + 0.2·approach/departure geometry`.

Gaps are not interpolated across: if two reports straddle a gap longer than
`maxGapS`, the position between them is left undefined rather than invented, so
a convergence is never manufactured from a feed gap or a dead-reckoned stretch.

## Rendezvous signature — separating a meet from a drift-by

The hard case that proximity and dwell alone cannot answer: two entities that
_do_ hold within range for minutes, but only because they were already near and
drifting — not because they came together and stopped. Raw proximity scores
both the same.

Every event therefore carries a **rendezvous signature**: the additional
observed geometry that a deliberate meet shows and a drift-by does not.

- **`closedFromM`** — how much distance the pair erased before the closest
  approach. A deliberate meet closes kilometres; a drift-by was always near.
- **`loiterRatio` (per entity)** — hold speed ÷ transit speed. A meet holds
  station (ratio near zero); a drift-by keeps its way (ratio near one).
- **`stationKeeping`** — both entities demonstrably slowed at the hold.
- **`coMotion`** — how much the two moved together during the hold.
- **`signatureStrength`** ∈ `[0,1]` — a composite of reach, mutual loiter,
  dwell and closeness. Events are ranked by this, so a coincidental hold sinks
  below a deliberate-looking meet even when its raw proximity `score` is high.

On the test fixtures the separation is wide: a scripted meet (came 8 km, held
station, parted) scores `signatureStrength ≈ 0.90` with `stationKeeping: true`;
a coincidental slow hold (drifted within 130 m for 15 min but never slowed and
never came from far) scores `≈ 0.32` with `stationKeeping: false` — while its
raw proximity `score` is `0.67`, high enough to mislead on its own.

**This is still observed behaviour, not intent.** A strong signature means the
_motion_ matched a deliberate-meet profile. It does not assert that a meeting,
transfer, or exchange occurred, or its purpose. That remains the operator's
judgement — the event object still has no field for it.

## Recurring rendezvous — repetition is the strongest signal

One close approach is ambiguous. The **same two entities meeting again and
again, at the same place, on a regular cadence** is a pattern a single event
cannot be. `detectRecurringRendezvous(events)` groups events by the unordered
pair (order-independent) and, for pairs that meet at least `recurMinOccurrences`
times, reports:

- **`occurrences`**, **`spanS`**, **`medianIntervalS`** — how many, over how
  long, how often.
- **`cadenceRegularity`** ∈ `[0,1]` — regular clockwork cadence vs erratic.
- **`locationSpreadM`** + **`meetPoint`** — do the meets cluster at one spot?
- **`meanSignatureStrength`** — how deliberate the individual meets looked.
- **`recurrenceStrength`** ∈ `[0,1]` — a composite of count, location tightness,
  cadence regularity, and per-event signature. Results are ranked by it.

On the fixtures: three meets at one spot on a weekly cadence score
`recurrenceStrength ≈ 0.84` (spread 16 m, cadence 1.0); three scattered,
irregular meets score `≈ 0.39` (spread 37 km). A single meet is never
"recurring." Feed it one run's events, or concatenate events across hours or
days (`engine.recurring({ priorEvents })`) to catch a pattern that no single
window shows.

Still observed structure, not intent: a recurring meet can be a ferry pair, a
pilot boat working its station, or a tug and its charge. The engine measures the
repetition; the meaning is the operator's.

## Limitations — read before trusting an event

- **A strong signature is evidence of behaviour, not of intent.** Station-
  keeping in company can be fishing, waiting out weather, mechanical aid, or a
  meet. The engine describes the motion; it does not read the reason.
- **Detection quality follows the feed.** Sparse or noisy position reports widen
  the effective separation and blur the speed profile, weakening both detection
  and the signature. `tMinDwellS` is the main control over crossings;
  `loiterFrac` and `reachRefM` tune how demanding the signature is.
- **Thresholds are domain-specific.** `rNearM`, `tMinDwellS`, `reachRefM` and
  `loiterFrac` must be chosen for the entities being watched — vessels differ
  from aircraft differ from road vehicles. There is no universal default.
- **An event is a prompt to look, not a conclusion.** Any operational meaning —
  and the lawfulness of acting on it — rests with the operator, not this module.

## Wiring

The engine is pure and renders nothing, like `analystEngine`. A surface injects
a provider and consumes the returned `items`:

```js
import { createConvergenceEngine } from './data/convergenceDetection.js';

const engine = createConvergenceEngine({
  // return the current per-entity fix history from the trail store:
  // [{ layerKey, id, kind?, fixes: [{ t, lat, lon }] }, ...]
  getTracks,
});

const { items, disclaimer } = engine.detect({ rNearM: 200, tMinDwellS: 120 });
// items: convergence events, highest score first — mark each at event.closest
// disclaimer: the observed-only line to surface alongside the results
```
