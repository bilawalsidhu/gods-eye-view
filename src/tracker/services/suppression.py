"""Removal and suppression: the fourth of AGENTS.md's four non-negotiables.

The other three exist. This is the one that did not, and it matters more now that the spine
holds real named individuals from SEC filings and the media proxy can hold a photograph of a
person under ADR 013.

**Removal and suppression are one action.** A removal on its own is undone by the next crawl, so
:meth:`SuppressionStore.suppress` is what a removal *is*, and clearing what we currently hold is
the other half of the same call. Nothing here has a queue and nothing waits for a person to
approve it: this project has no researcher and AGENTS.md forbids designing on the assumption
that anyone will check.

We honour it as policy rather than because a regulator compels it. ADR 008 settled that: the
population and the customers are in the United States, so there is no statutory window to build
to. It takes effect at once instead.

## The key, which is the whole design problem

The constraint is that suppression is keyed independently of ingest, so the next crawl cannot
resurrect a record, **and the key holds no more personal data than the flag needs**. Those pull
against each other: to suppress a record on the next crawl you must recognise it, and
recognition means comparing something about it against a list. A list that stores the name it is
suppressing is a list of exactly the people who asked to be forgotten, which is a worse artefact
than the record it replaced.

So the stored key is an **HMAC-SHA256 of the identifier under a secret generated on first use
and held in its own file**. Three properties follow.

*Recognition still works.* The check hashes the incoming identifier and asks for membership,
which is what a crawl needs and all it needs.

*The list cannot be read.* There is no name, no CIK and no reason-with-a-name in it: only
opaque digests and the enumerated reason below.

*It cannot be reversed by enumeration, which a plain hash could.* This is the part worth being
precise about, because a bare SHA-256 here would be theatre. A ``person_id`` is ``sec-{cik}`` and
a CIK is a ten-digit number; EDGAR publishes the whole list, about 800,000 of them. Hashing all
of them takes seconds, so an unkeyed digest of a low-entropy identifier is reversible by anyone
who obtains the file. The secret is what removes that, and it is the only thing that does.

**What this does not protect against, stated rather than implied.** The secret lives in a file
next to the cache, so the separation is file-level: it protects the suppression list being
copied *on its own*, which is what happens in a log, a support bundle or a partial backup. It
does not protect against disclosure of the whole directory, because then the attacker holds both
halves and a ten-digit identifier is enumerable again. Fixing that needs the secret somewhere
this project has ruled out having, a key service or an operator typing a passphrase at start-up,
and AGENTS.md's deployment is one laptop with no cloud and no human step. So the honest claim is
"unreadable if the list leaks alone", not "unreadable".

## The reason is an enumeration, not free text

:data:`SuppressionReason` has three values and no free-text field anywhere. That is deliberate
and it is the hole this design would otherwise have: a free-text reason is somewhere a name gets
written, by a well-meaning operator noting *why*, and the list stops holding no personal data the
first time anyone uses it. The words a person reads live in the product, keyed off the
enumeration.

## Precise targeting is impossible here, so removal sweeps

A removal must reach every cache that could serve the name, per the adsbdb rule in AGENTS.md: a
cache of something a removal can delete needs a way in, or the removal reports success while the
value is still served. But the caches key on things a ``person_id`` cannot be turned into. The
adsbdb owner cache keys on an aircraft registration, the media store on a URL, the social page on
a Mastodon handle. Finding *this person's* entries in them would mean comparing names, which
means holding the name, which is the one thing this module must not do.

So a removal **sweeps** the caches rather than targeting them. It costs re-fetches and it cannot
report which entries were the person's, and both of those are the correct price: the alternative
is a suppression list that knows who it is suppressing.
"""

import hmac
import logging
import secrets
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Final, Literal, Protocol

from tracker.cache import DiskCache, key
from tracker.contracts.base import StrictModel, UtcDatetime

_log = logging.getLogger(__name__)

CACHE_NAMESPACE: Final = "suppressed"
SECRET_FILE_NAME: Final = "suppression-key"  # noqa: S105 - a file name, not a secret value
SECRET_BYTES: Final = 32

SuppressionReason = Literal["requested_by_subject", "reported_in_product", "operator_removed"]
"""Why a record was suppressed. Three values, and no free-text field anywhere.

An enumeration rather than a string, because a free-text reason is where a name gets written.
Someone noting "asked to be removed after the Smith complaint" would put the identity back into
the one list that must not hold it, and they would be trying to be helpful. The sentence a
person reads is built in the product from these values.
"""


class Suppression(StrictModel):
    """One suppression, as the product is allowed to see it.

    Carries no identity of any kind, and that is not an omission: the whole point is that the
    product can say "one person record was removed on request" without being able to say whose.
    A field here naming the subject would defeat the module.
    """

    reason: SuppressionReason
    suppressed_at: UtcDatetime


@dataclass(frozen=True, slots=True)
class RemovalOutcome:
    """What one removal did, in terms that name nobody.

    ``swept`` is per cache rather than a total, because "the media store gave up 4 entries and
    the owner cache 0" is the useful form when someone asks whether a removal reached
    everything. None of the counts is attributable to the person: a sweep cannot know which
    entries were theirs, which is exactly why it is a sweep.
    """

    suppression: Suppression
    already_suppressed: bool
    swept: tuple[tuple[str, int], ...] = ()

    @property
    def entries_cleared(self) -> int:
        """How many cached entries the sweep removed, across every cache it reached."""
        return sum(count for _, count in self.swept)


class Sweepable(Protocol):
    """A cache a removal has to be able to empty.

    ``forget_all`` rather than ``forget(identity)``, because a ``person_id`` cannot be turned
    into the keys these caches use. See the module docstring.
    """

    @property
    def name(self) -> str:
        """What to call this cache when reporting what a removal reached."""
        ...

    def forget_all(self) -> int:
        """Empty it, and say how many entries went."""
        ...


def _now() -> datetime:
    return datetime.now(UTC)


class SuppressionStore:
    """The list of suppressed identifiers, as digests nobody can read back.

    One instance per process. It owns the secret, so building a second one against the same
    directory is harmless but building one against a different directory would produce digests
    that do not match the stored ones.
    """

    def __init__(
        self,
        cache: DiskCache,
        secret_directory: Path,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._cache = cache
        self._secret_path = secret_directory / SECRET_FILE_NAME
        self._clock = clock or _now
        self._secret: bytes | None = None

    def _load_secret(self) -> bytes:
        """The HMAC secret, generated on first use.

        Written with owner-only permissions and never logged. If it is lost the stored digests
        become unmatchable, which fails *closed* in the wrong direction: a suppression would
        stop being recognised. That is a real operational hazard and it is the price of the list
        being unreadable, so it is stated here rather than discovered.
        """
        if self._secret is not None:
            return self._secret
        if self._secret_path.is_file():
            self._secret = bytes.fromhex(self._secret_path.read_text(encoding="ascii").strip())
            return self._secret
        generated = secrets.token_bytes(SECRET_BYTES)
        self._secret_path.parent.mkdir(parents=True, exist_ok=True)
        self._secret_path.write_text(generated.hex(), encoding="ascii")
        # Owner only. A world-readable secret makes the digests enumerable again, which is the
        # one thing the secret exists to prevent.
        self._secret_path.chmod(0o600)
        self._secret = generated
        return generated

    def digest(self, person_id: str) -> str:
        """The stored form of one identifier. One way, and keyed so it cannot be enumerated."""
        return hmac.new(self._load_secret(), person_id.encode("utf-8"), sha256).hexdigest()

    def suppress(self, person_id: str, reason: SuppressionReason) -> Suppression:
        """Suppress this identifier now, and keep no record of what it was.

        Idempotent: suppressing twice keeps the first timestamp, because the moment that matters
        is when the person asked rather than when the button was pressed again.
        """
        existing = self.suppression_for(person_id)
        if existing is not None:
            return existing
        suppression = Suppression(reason=reason, suppressed_at=self._clock())
        self._cache.set(
            key(CACHE_NAMESPACE, self.digest(person_id)),
            suppression.model_dump_json(),
        )
        # The identifier is never logged. A log line naming what was suppressed is the same
        # artefact this module exists to avoid, written somewhere nobody thinks to look.
        _log.info("suppressed one record, reason %s", reason)
        return suppression

    def is_suppressed(self, person_id: str) -> bool:
        """Whether this identifier is suppressed. The call a crawl makes on every candidate."""
        return self._cache.get(key(CACHE_NAMESPACE, self.digest(person_id))) is not None

    def suppression_for(self, person_id: str) -> Suppression | None:
        """The suppression on this identifier, when there is one."""
        entry = self._cache.get(key(CACHE_NAMESPACE, self.digest(person_id)))
        if entry is None:
            return None
        return Suppression.model_validate_json(entry.value)

    def lift(self, person_id: str) -> bool:
        """Un-suppress, for an operator who suppressed the wrong record.

        Needed because there is no human step before a suppression takes effect, so the only
        place to catch a mistake is after it. Returns whether anything was lifted.
        """
        return self._cache.delete(key(CACHE_NAMESPACE, self.digest(person_id))) > 0

    def suppressions(self) -> tuple[Suppression, ...]:
        """Every suppression, for the product to show. Carries no identities, by construction.

        This is what makes "the suppression shows in the product with its reason" satisfiable
        without naming anyone: a count and a reason per entry, and nothing that says whose.
        """
        found: list[Suppression] = []
        for stored in self._cache.keys(key(CACHE_NAMESPACE, "")):
            entry = self._cache.get(stored)
            if entry is not None:
                found.append(Suppression.model_validate_json(entry.value))
        return tuple(sorted(found, key=lambda item: item.suppressed_at))

    def __len__(self) -> int:
        return len(self._cache.keys(key(CACHE_NAMESPACE, "")))


class RemovalService:
    """One call that suppresses a record and empties everything that could still serve it.

    The two halves are not separable. A removal that cleared the caches without suppressing is
    undone by the next crawl, and a suppression that did not clear them reports success while
    the name is still being served, which AGENTS.md calls worse than a slow removal because it
    looks like it worked.
    """

    def __init__(self, suppression: SuppressionStore, caches: Iterable[Sweepable] = ()) -> None:
        self._suppression = suppression
        self._caches = tuple(caches)

    @property
    def reaches(self) -> tuple[str, ...]:
        """The caches this removal will empty, for the wiring to be checkable rather than hoped.

        Exposed so a test can assert the set, and so a cache added to the app without being
        added here shows up as a difference rather than as a name that survives a removal.
        """
        return tuple(cache.name for cache in self._caches)

    def remove(self, person_id: str, reason: SuppressionReason) -> RemovalOutcome:
        """Suppress this record and empty every cache that could hold its name. Immediately.

        Args:
            person_id: The record's own key, ``sec-{cik}`` or ``psc-{company}-{id}``. Never a
                name: the contract derives it from the strongest identifier available precisely
                so that this call does not have to take one.
            reason: Why, from the enumeration. There is no free-text field.

        Returns:
            What it did, in terms that name nobody.
        """
        already = self._suppression.is_suppressed(person_id)
        suppression = self._suppression.suppress(person_id, reason)
        swept: list[tuple[str, int]] = []
        for cache in self._caches:
            try:
                swept.append((cache.name, cache.forget_all()))
            except OSError as exc:
                # A cache that will not empty must not stop the suppression, which is the half
                # that actually protects the person. It is logged and reported as zero rather
                # than silently counted as done.
                _log.warning("removal could not empty %s: %s", cache.name, type(exc).__name__)
                swept.append((cache.name, 0))
        return RemovalOutcome(
            suppression=suppression, already_suppressed=already, swept=tuple(swept)
        )


def excluding_suppressed[T](
    candidates: Iterable[T],
    *,
    identifier: Callable[[T], str],
    store: SuppressionStore,
) -> tuple[T, ...]:
    """Candidates with the suppressed ones never generated, rather than filtered afterwards.

    ADR 012 and ADR 013 both use the words "excluded from candidate generation rather than
    filtered afterwards", and the difference is not stylistic. A filter runs after the set
    exists, so the suppressed person has already been scored, already been counted in an
    aggregate, and already been in a payload that something might log. Excluding at generation
    means they were never a candidate.

    This is the shape the caller wants: build the set through this rather than building it and
    then removing from it.
    """
    return tuple(item for item in candidates if not store.is_suppressed(identifier(item)))
