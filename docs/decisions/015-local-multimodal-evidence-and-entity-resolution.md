# ADR 015: entity resolution and corroboration run locally over one evidence contract, whatever the modality

**Date:** 2026-08-19
**Status:** Accepted
**Amends:** ADR 011 (cross-source corroboration), which set the corroboration rules while
assuming every claim arrived as text.
**Relates to:** ADR 004 (scraped and crowd-sourced data is permitted), ADR 005 (derived
versus upstream location on a social post), ADR 007 (a person may be joined to any data),
ADR 008 (production profile attributes), ADR 012 (inferred occupancy), ADR 013 (people are
identified in photographs), ADR 014 (post content analysis).

This ADR does not decide **whether** to read a face, a landmark or a sentiment. ADR 013 and
ADR 014 decided that. It decides **how any of it runs**, on one laptop, over one contract,
without inflating its own confidence.

## Context

ADR 011 says a claim earns display by being corroborated at the origin. It did not say what
a claim is when it did not arrive as text. ADR 013 then put face matching in and ADR 014 put
image content reading in, both of which need machinery neither ADR specified.

The sources now in scope produce plenty that did not arrive as text:

- **Images.** Wikimedia Commons, Flickr, camera stills from TfL, US 511 and Windy, aircraft
  and vessel photographs carrying a registration or a name in the frame, and Wikidata P18
  reference portraits.
- **Audio.** Earnings calls and investor webcasts, and the audio track of social media
  posts.
- **Video.** Social media video.

Two constraints shape the answer and neither is negotiable.

**Everything runs on one laptop with an internet connection.** No cloud inference, no GPU
cluster, no paid model API. That is the deployment target for the demo.

**It is also a licensing constraint.** Posting a scraped photograph or a licensed webcast to
a third-party inference API is redistribution. This project already refuses to redistribute
ADS-B Exchange positions to a browser for exactly that reason. Sending media out to be
described is the same act with a different verb. It is worse for a face: shipping a
reference portrait of a named profile to a third party to be embedded hands a biometric
identifier to someone with no basis to hold it, which is the exact thing ADR 013's
discard-what-does-not-match rule exists to avoid.

The obvious build is a pipeline per modality: an image matcher, a face matcher, an audio
matcher, a video matcher, each with its own scoring and its own thresholds. That produces
four places to get independence wrong, four sets of thresholds nobody can reconcile, and no
way for a phase 12 occupancy estimate to say what its confidence number means.

## Decision

**There is one evidence contract and one resolver. Modality is a property of where a claim
came from, never a branch in the logic that scores it.**

**Media becomes claims at the adapter boundary.** A `sources/` adapter takes an image, an
audio file or a video and emits domain records like any other adapter: dated, sourced text
claims, plus embeddings, plus the item's own licence and author, which travel with it into
the domain contract as they already must. Nothing under `services/` inspects a pixel or a
waveform. The corroboration service and the resolver see claims and cannot tell which
modality produced them, which is the point.

**Video is not a fourth modality.** It is frames plus an audio track, handled by the image
path and the audio path. There is no video-specific scoring.

**Timestamps come from the media, not from the run.** A transcript segment is dated to the
call or the broadcast, not to when we transcribed it. A photograph is dated to its EXIF
capture time where one is present, otherwise to its publication date, and which of the two
was used is recorded on the claim. Media that cannot be dated is dropped at the adapter and
counted, exactly like an undated location under ADR 006.

### The origin key

**Independence is still judged at the origin, and the multimodal version of the wire-story
rule is the easiest thing in this system to get wrong.**

- A video, a still pulled from that video and the transcript of its own audio are **one
  origin**, not three.
- Three re-uploads of one photograph are one origin, and near-duplicate detection is what
  establishes that.
- **Every model output drawn from one media item shares that item's origin key**, which is
  ADR 014's "a model output is not a source" rule made structural. A face match, a landmark
  reading, a registration read off the tail and a caption from the same photograph are one
  origin between them. Running a second model over the same picture does not create a second
  source.
- Cross-modal corroboration counts only where the origins genuinely differ. An earnings call
  recording and a regulatory filing are two. An earnings call recording and a news article
  quoting it are one.

**Modality is not a trust level. Origin is.** A company's own webcast is a primary record on
the same terms as its filing, so it may cross the assertion threshold alone. A caption on a
crowd-uploaded photograph is crowd-sourced input and never does. The per-source weighting in
ADR 011 already carries this and needs no modality axis added to it.

### The resolver

**Entity resolution is deterministic and classical.** Blocked candidate generation, per-field
comparators, additive log-odds scoring, and two thresholds: above the upper one a link is
asserted, between the two it is a possible match shown with its score and excluded from every
aggregate, below the lower one nothing is recorded.

**No model decides whether two records are the same person.** Embeddings propose candidates.
They never score a match. A resolver whose decisions cannot be explained field by field is
unusable underneath a phase 12 occupancy estimate, and it is how chimera profiles get built.

**A face match is a candidate generator, not a decision**, which is the same boundary and it
is what makes ADR 013 implementable inside this design. Face similarity proposes a profile.
The claim it produces is then scored, thresholded and corroborated like any other claim, at
the higher threshold ADR 013 sets, and one face match never crosses the assertion threshold
alone.

### Local models

**Local models are small ONNX on CPU and their job is narrow.** Four of them, and each is
confined to candidate generation, near-duplicate detection or transcription:

- a **sentence embedder**, for text blocking and near-duplicate detection across articles;
- a **CLIP-family image and text embedder**, for image candidate generation, near-duplicate
  detection, and the closed-set content reading below;
- a **face embedder of the ArcFace class**, used only as ADR 013 permits: 1:N against the
  reference embeddings of profiles we already hold, with a face matching nothing discarded
  rather than stored;
- **Whisper-small**, for transcription.

**Weights are pinned by hash**, are not committed to the repository, and are fetched on first
use. **The model version is recorded on every embedding**, because upgrading a model
invalidates every vector already stored and a silent mixed-version index is a bug that looks
like poor recall. Face reference embeddings carry the model version for the same reason and
because a removal request under ADR 008 has to delete every version of them.

**Image content reading is closed-set, not open-vocabulary description.** ADR 014 allows a
model to name a landmark, a vessel, an aircraft livery, a venue or a registration. Here that
is done by scoring the image embedding against a **candidate label set built from records the
system already holds**: the gazetteer from phase 4, the registries from phase 5, the
organisations and assets from phase 6. The model ranks candidates we can already name and
cite. It does not generate prose about a picture, so there is nothing to hallucinate a place
or an object that no record in the system supports.

### Storage

**Storage is one SQLite file.** FTS5 for blocking keys, embeddings held as blobs and scanned
with numpy. No vector database and no vector server until a brute-force scan is measurably
too slow at demo scale. A removal request deletes the rows; there is no separate vector store
to forget to purge, which is the practical reason this matters more than the performance one.

## Consequences

**Transcription is the expensive step and it dictates the shape of the ingest.** Hours of
earnings calls on a laptop CPU is not a poller. Audio is fetched and transcribed on demand,
keyed and cached by content hash, and never swept on a cycle. This is the same demand-driven
pattern already used for the metered ADS-B Exchange key.

**Most media will yield no assertable claim.** A photograph with no EXIF date, no caption, no
legible registration and no face matching a profile produces an embedding and nothing else.
That is the correct output, and filling the card by relaxing it is the thing ADR 011 exists
to prevent.

**The model weights are a few hundred megabytes and the test suite must not need them.**
Tests run against recorded fixtures of transcripts, captions and embeddings under
`tests/fixtures/`, in keeping with the existing convention. With the weights absent the
product degrades to text-only sources and reports the media layers unavailable, exactly like
a missing API key.

**Whisper output is not bit-stable across runtimes**, so a transcript is never compared
against an expected string in a test. Fixtures pin the transcript; the tests assert what the
adapter does with it.

**Deterministic scoring means the thresholds are explainable**, which is what makes a phase 12
occupancy estimate and an ADR 013 face match defensible. A confidence number traces back to
named fields and named origins.

**Running the face embedder locally is what keeps ADR 013 inside its own limits.** Reference
portraits and candidate faces never leave the machine, nothing is retained for a face that
matches no profile, and a removal deletes the embedding along with the record.

**No measured numbers yet.** No weights have been downloaded and no transcription has been run
on this machine, so every cost claim here is an estimate until phase 13 records real timings.

**This is more work than a single hosted multimodal API call**, and it is the price of the
laptop-local constraint, the redistribution position and the biometric one.

## Alternatives considered

**A local large language model, or a vision-language model generating open-vocabulary
descriptions.** Tempting for name normalisation, for deciding whether two articles are one
wire story, and for describing an image in words. Rejected for now on three grounds: it is
non-deterministic under a branch-coverage gate set at 85, it cannot explain a match field by
field, and a model confidently asserting an attribute from one source is precisely the
single-source assertion ADR 011 bans and the self-inflation ADR 014 warns about. The
closed-set label scoring above covers what ADR 014 actually asks for without any of that.
Worth revisiting only in a role where it proposes candidates that the deterministic scorer
then judges, which is the same boundary every model here already sits behind.

**A hosted multimodal API.** Rejected. The laptop-local constraint rules it out, sending
scraped or licensed media to a third party is redistribution, and sending a reference
portrait out is worse than that.

**A pipeline per modality.** Rejected as described above. Four thresholds nobody can
reconcile, and four chances to double-count one origin.

**Letting a face match assert on its own, given how strong the signal feels.** Rejected, and
ADR 013 already rejected it. It is one origin, it carries a demographically uneven error rate,
and there is no researcher here to catch a wrong one.

**A vector database.** Rejected as unnecessary at demo scale. A numpy scan over a few tens of
thousands of vectors is milliseconds and adds no dependency, no server and no lifecycle, and
it keeps deletion in one place.
