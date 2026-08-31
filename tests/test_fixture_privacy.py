"""Guard: the fixtures scrubbed of personal data must stay scrubbed.

What this catches. Someone re-records one of the payloads listed in ``SCRUBBED`` from the
live API and commits it, or edits a real address back into one. The scrub leaves markers
behind, a postcode area that does not exist and ZIPs in an unassigned block, and this
test fails the moment those markers go missing.

What this does not catch, and cannot. Personal data in any other shape: a real name, a
phone number, an email address, a date of birth, a photograph of a person. All of those
would pass. A regex cannot prove a payload holds no personal data. This is a cheap
regression guard on one known failure mode, not a completeness check, and it is not a
substitute for reading a payload before it lands in ``tests/fixtures``.

The rule it guards is in ``tests/fixtures/README.md``.
"""

import csv
import io
import json
import re
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"

SCRUBBED = (
    "casa_acrftreg_extract.csv",
    "ccarcs_carsownr_extract.csv",
    "commons_geosearch_generator_live.json",
    "commons_imageinfo_p18_live.json",
    "companies_house_psc_snapshot_live.jsonl",
    "faa_master_extract.csv",
    "fec_schedule_a_live.json",
    "fec_schedule_a_named_donor_live.json",
    "gdelt_doc_artlist_live.json",
    "mastodon_masto_public_live.json",
    "osm_notes_london_live.json",
    "propublica_nonprofit_org_live.json",
    "sec_edgar_form4_director_live.xml",
    "sec_edgar_form4_officer_live.xml",
    "sec_edgar_fts_person_live.json",
    "sec_edgar_submissions_person_live.json",
    "wikidata_wbsearchentities_live.json",
    "wikidata_wdqs_people_live.json",
    "wikidata_wdqs_statements_live.json",
    "wikipedia_rest_summary_person_live.json",
)

# No UK postcode area begins with Q, so a Q area is format-valid and cannot be real. The
# space is required: without it the pattern matches aircraft registrations and Mode S hex.
UK_POSTCODE = re.compile(r"\b[A-Z]{1,2}[0-9][0-9A-Z]? [0-9][A-Z]{2}\b")

# No Canadian forward sortation area begins with D.
CA_POSTAL = re.compile(r"\b[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9]\b")

# Real postcodes that describe a place rather than a person, kept on purpose.
PLACE_POSTCODES = {"nominatim_search_address_live.json": {"SW1A 2AA"}}

# CASA writes a natural person as "SURNAME, Forename". A company can also carry a comma
# ("GY AVIATION LEASE 2302 CO., LIMITED"), so the surname has to be a single token and
# what follows the comma has to look like a given name.
CASA_PERSON = re.compile(r"^[A-Z][A-Za-z'-]+, [A-Z][a-z]")


def fixture_text(path: Path) -> str:
    return path.read_bytes().decode("utf-8", errors="replace")


def test_every_scrubbed_fixture_is_still_present() -> None:
    missing = [name for name in SCRUBBED if not (FIXTURES / name).is_file()]
    assert missing == [], f"scrubbed fixtures have gone: {missing}"


def test_uk_postcodes_are_synthetic_or_a_named_place() -> None:
    offenders: dict[str, list[str]] = {}
    for path in sorted(FIXTURES.iterdir()):
        if not path.is_file():
            continue
        allowed = PLACE_POSTCODES.get(path.name, set())
        found = {
            code
            for code in UK_POSTCODE.findall(fixture_text(path))
            if not code.startswith("Q") and code not in allowed
        }
        if found:
            offenders[path.name] = sorted(found)
    assert offenders == {}, f"real-looking UK postcodes in fixtures: {offenders}"


def test_canadian_postal_codes_in_the_owner_extract_are_synthetic() -> None:
    text = (FIXTURES / "ccarcs_carsownr_extract.csv").read_bytes().decode("cp1252")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    codes = {row[8] for row in rows if row[11] == "Individual"}
    assert codes, "no individual owners left in the extract, so nothing was checked"
    assert [c for c in sorted(codes) if not (CA_POSTAL.fullmatch(c) and c.startswith("D"))] == []


def dict_rows(name: str, encoding: str) -> list[dict[str, str]]:
    text = (FIXTURES / name).read_bytes().decode(encoding)
    return list(csv.DictReader(io.StringIO(text, newline="")))


def test_us_zip_codes_are_in_the_unassigned_block() -> None:
    rows = dict_rows("faa_master_extract.csv", "utf-8-sig")
    faa = {row["ZIP CODE"].strip() for row in rows} - {""}
    assert faa
    assert [z for z in sorted(faa) if not z.startswith("005")] == []

    for name in ("fec_schedule_a_live.json", "fec_schedule_a_named_donor_live.json"):
        payload = json.loads((FIXTURES / name).read_bytes())
        zips = {row["contributor_zip"] for row in payload["results"] if row["contributor_zip"]}
        assert zips, name
        assert [z for z in sorted(zips) if not z.startswith("005")] == [], name


def test_australian_postcodes_of_individual_registrants_are_unassigned() -> None:
    postcodes = {
        row["regholdPostcode"]
        for row in dict_rows("casa_acrftreg_extract.csv", "utf-8-sig")
        if CASA_PERSON.match(row["regholdname"]) and row["regholdPostcode"]
    }
    assert postcodes, "no individual registrants left in the extract, so nothing was checked"
    assert [p for p in sorted(postcodes) if not p.startswith("00")] == []
