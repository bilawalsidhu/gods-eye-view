# Investigate the observed area

Open **INVESTIGATE AREA** in the standalone globe. It reads the Earth under the
center of the view without moving the camera or adding layers. Review or edit the
coordinates and radius (0.1–100 km), unlock the separate local area vault and
create a case. **Use observed globe center** refreshes coordinates after camera
movement. Looking away from Earth reports failure instead of inventing a point.

## Public sources

Queries run only after source selection and **Query selected sources**. They reuse
existing tools and providers:

| Source | Coverage and limitations |
| --- | --- |
| USGS earthquakes | M2.5+ in the last 24 hours; global feed filtered by area |
| OpenStreetMap dams | Bundled mapped inventory, with river/output where supplied |
| OpenStreetMap datacenters | Bundled inventory, with operator/capacity where supplied |
| NASA recent imagery | Latest HLS image with VIIRS fallback; retained metadata only |

Lists retain at most 25 rows per source plus matched total and truncation. Records
keep provenance, attribution, coverage, retrieval time, known source dates and
missing/stale states. Inventory observation dates are unknown. An unavailable
source or empty list does not prove absence. Queries follow existing area
semantics and coverage; no arbitrary historical search is provided. The existing
imagery query may fetch image bytes, which this workspace discards. There is no
paid place search, person search, corporate registry query, general web crawler,
screenshot capture or automated identity matching in this slice.

## Evidence and storage

Queries record source observations. Add observations, hypotheses, contradictions,
notes or manual follow-up separately; confidence is an operator assessment. Entries
are timestamped and append-only. Identify earlier entries in a contradiction or
note. Only geographic arguments and source selection reach queries; titles, notes,
privacy drafts, approvals and passphrases are not query inputs.

Area cases use a separate encrypted IndexedDB database and passphrase session from
the Social Analyzer privacy workflow. Closing clears displayed content and
secrets, locks the vault and cancels pending queries. Late results cannot restore
closed UI content. Other mutations and case switching are blocked during actions.
The hash chain provides local consistency checking, not independent notarization
or protection against a compromised unlocked browser.

## Backup, restore and deletion

Provide a separate backup passphrase (12+ characters) and download the
authenticated encrypted JSON. It contains no plaintext case fields. To restore,
unlock the local vault, select the backup (8 MiB maximum), and enter its backup
passphrase. Authentication and ledger/workflow consistency checks must pass.
Restore creates a new opaque case ID, preserves the full existing history and
records a separate restoration timestamp, including for a case at its 500-entry
limit. **Delete current case** removes only the open local area case.
Keep backups for recovery after deletion or clearing browser site data.

Area messages offer English/French with bilingual field labels; English is the
initial language. Original provider names/summaries are retained. Privacy drafts
now default to English with explicit French available. Existing approved drafts
retain their original text.

## Validation

Run `node --test src/demonForge/*.test.mjs`, unit/build/boundary checks and
`npm run test:track` with the dev server. A synthetic real-browser walkthrough
must cover globe-center capture, query, evidence, close/clear, reopen, encrypted
download, restore-as-new, deletion and close-during-query; verify that private
notes never enter network inputs.
