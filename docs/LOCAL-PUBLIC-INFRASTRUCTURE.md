# Local public infrastructure and camera evidence

The five infrastructure layers are independently controlled and default off.
Existing submarine cables remain separate. City navigation does not imply source
coverage in that city. No new deployment datasets are bundled.

Use the operator-supplied pack schema and preparation command in
[LOCAL-FEATURES-SETUP.md](LOCAL-FEATURES-SETUP.md). EIA-860M records are public
inventory, not current generation; retain release date, inventory status, source
and attribution. OSM data retain ODbL attribution/share-alike. Owner, site operator,
mapped network and hosted carriers are distinct fields. Technology is shown only
when explicitly reported; unknown does not imply absence. Rooftop antennas are
not necessarily towers, and crossings/proximity do not establish network or power
connectivity, service coverage, outages or dependencies.

Packs load on enable from ignored `public/infrastructure/<dataset>/index.json`
and two-degree tiles. At most eight tiles load sequentially and remain cached
per layer. Wide views use representative index clusters. Entity budgets are
80 per layer for narrow/coarse-pointer screens and 160 for desktops. Disable
aborts work, clears resources/caches/selection and removes that layer's credit;
stale responses cannot repopulate a disabled layer. Detail dialogs show source
metadata with textContent and allowlist public source links.

Snapshot downloads are explicit local actions on ready image/video pixels,
with resolution limits and separate source/device-clock captions. CORS is never
bypassed. Marked/enhanced downloads are separate derivatives. Crop, contrast and
sharpening cannot recover absent detail, and research notes remain unverified
hypotheses. The original and annotations are not automatically uploaded.

Ask AI checks the existing server API credential and exact `gpt-6.1-sol` model.
An explicit Send transmits the original PNG, question and bounded normalized
marks using high reasoning, no tools, store=false and no fallback/retry. Enhanced
pixels and notes are excluded. Responses are bounded, rate-limited, cancelable
and same-site gated; bodies and keys are not logged. Account listing is not an
inference/quota guarantee. API charges apply; cancellation cannot recall data
already sent. Confidence percentages are model self-estimates, not validated
accuracy. Person/plate identification and cross-camera matching are excluded.
