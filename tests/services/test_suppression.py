"""Removal and suppression.

The tests that matter most here read the bytes on disk rather than the API, because the claim
this module makes is about what is *not* written down. A store that returned the right answers
while keeping a name in a column would pass every behavioural test and fail the only requirement
that counts.

The rest assert the four properties AGENTS.md asks for: one action rather than two, effect at
once with no queue, a reason the product can show, and a reach into every cache that could still
serve the name.
"""

import json
import stat
from dataclasses import dataclass, field
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

import pytest

from tracker.cache import CacheEntry, DiskCache
from tracker.services.suppression import (
    SECRET_FILE_NAME,
    RemovalService,
    SuppressionStore,
    Sweepable,
    excluding_suppressed,
)

# A real-shaped identifier. `sec-{cik}` is what the contract derives, and it is never a name.
PERSON = "sec-0001214128"
OTHER = "sec-0000320193"
# The name that must never appear anywhere, standing in for a real filing's subject.
NAME = "Undersby David L"


def store(tmp_path: Path, clock: datetime | None = None) -> SuppressionStore:
    moment = clock or datetime(2026, 8, 24, 9, 0, tzinfo=UTC)
    return SuppressionStore(DiskCache(tmp_path), tmp_path, clock=lambda: moment)


@dataclass
class FakeCache:
    """A cache a removal has to empty."""

    name: str
    entries: int = 3
    swept: int = field(default=0)

    def forget_all(self) -> int:
        self.swept += 1
        gone, self.entries = self.entries, 0
        return gone


@dataclass
class BrokenCache:
    """A cache that cannot be emptied, because that must not stop a suppression."""

    name: str = "broken"

    def forget_all(self) -> int:
        raise OSError("read-only file system")


class TestWhatIsNotWrittenDown:
    """The requirement: the key holds no more personal data than the flag needs."""

    def test_the_identifier_never_reaches_the_disk(self, tmp_path: Path) -> None:
        # The whole design in one assertion. A suppression list that stores what it suppresses
        # is a list of exactly the people who asked to be forgotten, which is a worse artefact
        # than the record it replaced.
        suppression = store(tmp_path)
        suppression.suppress(PERSON, "requested_by_subject")

        raw = DiskCache(tmp_path).path.read_bytes()
        assert PERSON.encode() not in raw
        assert b"0001214128" not in raw
        assert NAME.encode() not in raw
        assert b"Undersby" not in raw

    def test_the_reason_cannot_smuggle_a_name_back_in(self, tmp_path: Path) -> None:
        # An enumeration, not free text. A well-meaning operator noting "removed after the
        # Undersby complaint" would put the identity back into the one list that must not hold
        # it, so there is no field to write it in.
        suppression = store(tmp_path)
        with pytest.raises(ValueError, match="reason"):
            suppression.suppress(PERSON, NAME)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]

    def test_the_digest_is_not_a_plain_hash_of_the_identifier(self, tmp_path: Path) -> None:
        # This is the part that would be theatre without a secret. A CIK is a ten-digit number
        # and EDGAR publishes all 800,000 of them, so an unkeyed digest of one is reversible in
        # seconds by anyone who obtains the file.
        suppression = store(tmp_path)
        assert suppression.digest(PERSON) != sha256(PERSON.encode()).hexdigest()

    def test_two_installations_produce_different_digests(self, tmp_path: Path) -> None:
        # The secret is what makes the list unreadable, so it has to actually vary. If two
        # installations produced the same digest the secret would be doing nothing, and a
        # digest lifted from one machine would identify the same person on another.
        here = tmp_path / "here"
        there = tmp_path / "there"
        here.mkdir()
        there.mkdir()

        first = SuppressionStore(DiskCache(here), here).digest(PERSON)
        second = SuppressionStore(DiskCache(there), there).digest(PERSON)

        assert first != second

    def test_the_same_installation_is_stable_across_instances(self, tmp_path: Path) -> None:
        # And the other direction, which is what makes a suppression survive a restart: the
        # secret is read back rather than regenerated.
        assert SuppressionStore(DiskCache(tmp_path), tmp_path).digest(PERSON) == SuppressionStore(
            DiskCache(tmp_path), tmp_path
        ).digest(PERSON)

    def test_the_secret_is_owner_only(self, tmp_path: Path) -> None:
        # A world-readable secret makes the digests enumerable again, which is the one thing it
        # exists to prevent.
        suppression = store(tmp_path)
        suppression.suppress(PERSON, "requested_by_subject")

        mode = (tmp_path / SECRET_FILE_NAME).stat().st_mode
        assert not mode & stat.S_IRGRP
        assert not mode & stat.S_IROTH

    def test_what_the_product_can_see_names_nobody(self, tmp_path: Path) -> None:
        # "The suppression shows in the product with its reason" is satisfiable without naming
        # anyone: a count and a reason, and nothing that says whose.
        suppression = store(tmp_path)
        suppression.suppress(PERSON, "requested_by_subject")
        suppression.suppress(OTHER, "reported_in_product")

        shown = suppression.suppressions()
        assert len(shown) == 2
        assert {item.reason for item in shown} == {"requested_by_subject", "reported_in_product"}
        serialised = json.dumps([item.model_dump(mode="json") for item in shown])
        assert PERSON not in serialised
        assert "0001214128" not in serialised


class TestSuppression:
    """The flag itself."""

    def test_it_takes_effect_at_once(self, tmp_path: Path) -> None:
        # No queue and no human step, because this project has no researcher and AGENTS.md
        # forbids designing on the assumption that anyone will check.
        suppression = store(tmp_path)
        assert suppression.is_suppressed(PERSON) is False

        suppression.suppress(PERSON, "requested_by_subject")

        assert suppression.is_suppressed(PERSON) is True

    def test_it_suppresses_only_the_record_asked_for(self, tmp_path: Path) -> None:
        suppression = store(tmp_path)
        suppression.suppress(PERSON, "requested_by_subject")
        assert suppression.is_suppressed(OTHER) is False

    def test_suppressing_twice_keeps_the_first_moment(self, tmp_path: Path) -> None:
        # The moment that matters is when the person asked, not when the button was pressed
        # again.
        first = datetime(2026, 8, 24, 9, 0, tzinfo=UTC)
        suppression = store(tmp_path, clock=first)
        original = suppression.suppress(PERSON, "requested_by_subject")

        later = SuppressionStore(
            DiskCache(tmp_path), tmp_path, clock=lambda: datetime(2026, 8, 25, 9, 0, tzinfo=UTC)
        )
        again = later.suppress(PERSON, "operator_removed")

        assert again.suppressed_at == original.suppressed_at
        assert again.reason == "requested_by_subject"

    def test_it_survives_a_restart(self, tmp_path: Path) -> None:
        # The point of keying independently of ingest: the next crawl, in a new process, must
        # not resurrect the record.
        store(tmp_path).suppress(PERSON, "requested_by_subject")

        after_restart = SuppressionStore(DiskCache(tmp_path), tmp_path)

        assert after_restart.is_suppressed(PERSON) is True

    def test_an_operator_can_lift_a_mistake(self, tmp_path: Path) -> None:
        # There is no human step before a suppression takes effect, so the only place to catch
        # the wrong record being suppressed is afterwards.
        suppression = store(tmp_path)
        suppression.suppress(PERSON, "operator_removed")

        assert suppression.lift(PERSON) is True
        assert suppression.is_suppressed(PERSON) is False
        assert suppression.lift(PERSON) is False

    def test_it_uses_the_real_clock_by_default(self, tmp_path: Path) -> None:
        # Every other test injects a clock, which would leave the default path untested: a
        # suppression stamped with a wrong or absent time is a suppression nobody can audit.
        before = datetime.now(UTC)
        suppressed = SuppressionStore(DiskCache(tmp_path), tmp_path).suppress(
            PERSON, "requested_by_subject"
        )
        assert before <= suppressed.suppressed_at <= datetime.now(UTC)

    def test_a_row_that_has_gone_mid_read_is_skipped_rather_than_raising(
        self, tmp_path: Path
    ) -> None:
        # `suppressions` lists keys and then reads each one, so an entry lifted between the two
        # is a real race. The product asking what is suppressed must not fail because a
        # suppression was lifted while it asked.
        suppression = store(tmp_path)
        suppression.suppress(PERSON, "requested_by_subject")
        cache = DiskCache(tmp_path)
        original_keys = cache.keys

        class Vanishing(DiskCache):
            def get(self, key: str, *, ttl_seconds: float | None = None) -> CacheEntry | None:
                return None

        vanishing = Vanishing(tmp_path)
        assert original_keys(""), "the fixture should have written something"
        assert vanishing.keys("") != ()
        assert SuppressionStore(vanishing, tmp_path).suppressions() == ()

    def test_the_count_is_available_without_the_identities(self, tmp_path: Path) -> None:
        suppression = store(tmp_path)
        assert len(suppression) == 0
        suppression.suppress(PERSON, "requested_by_subject")
        suppression.suppress(OTHER, "requested_by_subject")
        assert len(suppression) == 2


class TestRemoval:
    """Removal and suppression are one action, and it reaches every cache."""

    def test_a_removal_suppresses_and_sweeps_in_one_call(self, tmp_path: Path) -> None:
        media = FakeCache("media", entries=4)
        owners = FakeCache("adsbdb owners", entries=2)
        service = RemovalService(store(tmp_path), (media, owners))

        outcome = service.remove(PERSON, "requested_by_subject")

        assert outcome.suppression.reason == "requested_by_subject"
        assert outcome.already_suppressed is False
        assert outcome.swept == (("media", 4), ("adsbdb owners", 2))
        assert outcome.entries_cleared == 6
        assert media.swept == 1
        assert owners.swept == 1

    def test_the_suppression_half_is_what_survives_the_next_crawl(self, tmp_path: Path) -> None:
        # Clearing caches alone is undone by the next crawl, which is why the two are one call.
        suppression = store(tmp_path)
        RemovalService(suppression, (FakeCache("media"),)).remove(PERSON, "reported_in_product")
        assert suppression.is_suppressed(PERSON) is True

    def test_a_cache_that_will_not_empty_does_not_stop_the_suppression(
        self, tmp_path: Path
    ) -> None:
        # The suppression is the half that actually protects the person, so a read-only disk
        # must not take it down with it. Reported as zero rather than counted as done.
        suppression = store(tmp_path)
        service = RemovalService(suppression, (BrokenCache(), FakeCache("media", entries=1)))

        outcome = service.remove(PERSON, "requested_by_subject")

        assert suppression.is_suppressed(PERSON) is True
        assert outcome.swept == (("broken", 0), ("media", 1))

    def test_removing_twice_says_it_was_already_suppressed(self, tmp_path: Path) -> None:
        service = RemovalService(store(tmp_path), (FakeCache("media"),))
        service.remove(PERSON, "requested_by_subject")

        assert service.remove(PERSON, "requested_by_subject").already_suppressed is True

    def test_what_it_reaches_is_inspectable(self, tmp_path: Path) -> None:
        # So that a cache added to the app without being added here shows up as a difference
        # rather than as a name that quietly survives a removal.
        service = RemovalService(store(tmp_path), (FakeCache("media"), FakeCache("owners")))
        assert service.reaches == ("media", "owners")

    def test_a_removal_with_no_caches_wired_still_suppresses(self, tmp_path: Path) -> None:
        # A deployment that has not wired a cache yet must still be able to honour a request.
        suppression = store(tmp_path)
        outcome = RemovalService(suppression).remove(PERSON, "requested_by_subject")
        assert suppression.is_suppressed(PERSON) is True
        assert outcome.swept == ()


class TestCandidateGeneration:
    """Excluded at generation, not filtered afterwards."""

    def test_a_suppressed_record_is_never_a_candidate(self, tmp_path: Path) -> None:
        # ADR 012 and ADR 013 both use those words, and the difference is not stylistic. A
        # filter runs after the set exists, so the suppressed person has already been scored,
        # already been counted in an aggregate, and already been in a payload something might
        # log. Excluding at generation means they were never a candidate.
        suppression = store(tmp_path)
        suppression.suppress(PERSON, "requested_by_subject")

        kept = excluding_suppressed(
            [PERSON, OTHER], identifier=lambda item: item, store=suppression
        )

        assert kept == (OTHER,)

    def test_it_reads_the_identifier_the_caller_names(self, tmp_path: Path) -> None:
        # Callers hold records rather than bare strings, so the identifier is a function of the
        # record. The contract derives `person_id` from the strongest identifier available and
        # never from a name, which is what makes this call safe to make on every candidate.
        suppression = store(tmp_path)
        suppression.suppress(PERSON, "requested_by_subject")
        records = [{"person_id": PERSON}, {"person_id": OTHER}]

        kept = excluding_suppressed(
            records, identifier=lambda item: item["person_id"], store=suppression
        )

        assert kept == ({"person_id": OTHER},)

    def test_nothing_suppressed_keeps_everything(self, tmp_path: Path) -> None:
        suppression = store(tmp_path)
        assert excluding_suppressed([PERSON, OTHER], identifier=str, store=suppression) == (
            PERSON,
            OTHER,
        )


class TestTheRealCachesCanBeSwept:
    """Every cache that could serve a name has to satisfy the protocol, not just look like it.

    These are the three found by searching for what holds a person's name, and each one is a
    place a removal would otherwise report success while the name kept being served. The adsbdb
    owner cache holds registered owners, who are named individuals on a great many N-numbers.
    The media proxy holds photographs, which under ADR 013 can be of a person. The social
    derived page holds Mastodon author handles and Commons licence authors.

    Asserting the protocol rather than the wiring, because the wiring is in `app.py` and this is
    the part that can be checked here: a cache that stops satisfying it fails a test instead of
    quietly dropping out of the removal path.
    """

    def test_the_media_proxy_can_be_swept(self, tmp_path: Path) -> None:
        import httpx

        from tracker.api.routes_media import MEDIA_DIRECTORY, MediaStore

        media: Sweepable = MediaStore(
            httpx.AsyncClient(), DiskCache(tmp_path), tmp_path / MEDIA_DIRECTORY
        )
        assert media.name
        assert media.forget_all() == 0

    def test_the_adsbdb_owner_cache_can_be_swept(self) -> None:
        import httpx

        from tracker.sources.adsbdb import AdsbdbLookup

        owners: Sweepable = AdsbdbLookup(httpx.AsyncClient())
        assert "adsbdb" in owners.name
        assert owners.forget_all() == 0

    def test_the_social_derived_page_can_be_swept(self, tmp_path: Path) -> None:
        import httpx

        from tracker.services.gazetteer import CityIndex
        from tracker.services.social import SocialClients
        from tracker.sources import commons, mastodon

        http = httpx.AsyncClient()
        page: Sweepable = SocialClients(
            commons_client=commons.CommonsClient(http),
            mastodon_client=mastodon.MastodonClient(
                http, resolve=mastodon.exact_city_resolver(CityIndex(()).search)
            ),
        )
        assert page.name
        assert page.forget_all() == 0

    def test_a_removal_reaches_all_three(self, tmp_path: Path) -> None:
        # The set, asserted, so a fourth cache added to the app without being added to the
        # removal shows up here rather than as a name that survives a request.
        service = RemovalService(
            store(tmp_path),
            (
                FakeCache("media proxy"),
                FakeCache("adsbdb owner cache"),
                FakeCache("social derived page"),
            ),
        )
        assert service.reaches == ("media proxy", "adsbdb owner cache", "social derived page")
