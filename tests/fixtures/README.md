# Fixtures

Recorded real payloads from the live feeds, used by tests only. Nothing in the running
product reads them. Keeping the real bytes is the point: a hand-written payload tests the
parser against our own assumptions rather than against what the upstream actually sends.

## The rule where a payload carries personal data

Where a recorded payload carries data about an identifiable natural person, the structure
is kept and the values are made synthetic. Every key, every nesting level, every record
count and every present-versus-absent optional field survives. Only the identifying values
change.

The reason is simple. A fixture is a copy, and the ADR 008 removal and suppression path
cannot reach it. If a person asks to be removed, the product deletes and suppresses their
record, and a real name and home address sitting in a test fixture would survive that
untouched. So the real thing never gets committed in the first place.

What the scrub changes: personal names, street addresses, premises, PO boxes, care-of
names, postcodes and ZIPs, dates of birth, employers, occupations, reference portrait file
names, and identifiers that point at a natural person (a personal SEC CIK, a Wikidata QID
for a person, a Wikipedia or Commons page id for a person or their portrait, an
OpenStreetMap user id, a Mastodon account id, a Companies House PSC record id).

What stays real: business and document identifiers, because they are public and the
fixture has to keep matching the live API. Company numbers, EINs, issuer CIKs, FEC
committee IDs, aircraft registrations and Mode S codes, OpenStreetMap note ids, QIDs for
companies and creative works, and place names, cities, regions, countries and coordinates.
A company is not a natural person, so a corporate PSC entry and a company aircraft
registrant keep their real name and business address.

Synthetic postcodes keep the real format and cannot be real places. No UK postcode area
begins with Q, no Canadian forward sortation area begins with D, US ZIPs land in the
unassigned 005xx block and Australian postcodes in the unassigned 0001 to 0099 block.

## The scrubbed files

`companies_house_psc_snapshot_live.jsonl`, `fec_schedule_a_live.json`,
`fec_schedule_a_named_donor_live.json`, `gdelt_doc_artlist_live.json`,
`sec_edgar_submissions_person_live.json`,
`sec_edgar_form4_officer_live.xml`, `sec_edgar_form4_director_live.xml`,
`sec_edgar_fts_person_live.json`, `faa_master_extract.csv`,
`ccarcs_carsownr_extract.csv`, `casa_acrftreg_extract.csv`,
`commons_imageinfo_p18_live.json`, `wikidata_wdqs_people_live.json`,
`wikidata_wdqs_statements_live.json`, `wikidata_wbsearchentities_live.json`,
`wikipedia_rest_summary_person_live.json`, `mastodon_masto_public_live.json`,
`osm_notes_london_live.json`, `propublica_nonprofit_org_live.json`.

The originals are outside the repository, in the recon scratchpad at
`/private/tmp/claude-2143909198/-Users-alexander-fanthome-PycharmProjects-tracker/bcf7f69d-5743-4512-8c0c-f9dc46b00dc5/scratchpad/fixtures-real-pii/`.
None of them was ever committed. They are kept because the shapes came from real calls and
the scrub has to be checked against them, and they go when the scratchpad goes.

Two limits worth knowing. Mastodon post text, OpenStreetMap note text, photograph alt text
and third-party names inside a news headline are left as recorded, because the words are
what the derived-location resolver is tested against. So a third party named inside a post
survives even though its author does not.

One name that looks like a person and stays real: a company registered under a founder's
name, for example a corporate PSC entry called "Robert Hitchins Limited". That is a company
name on a public register, not a person's record.

## What was checked and left alone

Aircraft, vessel, satellite, earthquake, weather, imagery, camera and gazetteer payloads
carry no personal data. `ccarcs_carscurr_extract.csv` and `faa_acftref_extract.csv` carry
aircraft data with no owner names. `digitraffic_portcall_vessel_details_live.json` names
company ship owners, not people. Wikimedia Commons author credits name people, but a
licence credit has to stay for the licence to be honoured, and it carries no personal
attribute beyond the credit itself.

`commons_thumb_250_live.jpg` was opened and looked at. It is a photograph of a building and
two buses with nobody identifiable in it, so it stays as recorded. There is no reference
portrait image in this directory.

## The guard

`tests/test_fixture_privacy.py` fails if the synthetic markers disappear from the files
listed above. It catches a re-recorded payload being committed over a scrub. It cannot
prove any payload is free of personal data, and its docstring says so. Read a payload
before you put it in here.
