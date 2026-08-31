"""Mastodon public timelines: the ``derived`` half of the social post layer.

Keyless on instances that still serve an anonymous public timeline. **A Mastodon status has no
coordinate**, so every position this adapter produces is one we worked out from the words, and
:attr:`~tracker.contracts.social.SocialPost.location_basis` is ``derived`` on every record it
emits. Verified again on 2026-08-23 against a live ``mas.to`` timeline: nothing positional on
the status, nothing on its account, and nothing in the ``meta`` block of its media attachments.

**What gets matched, and why it is so little.** ADR 005 allows a gazetteer match against the
city index and nothing else: no per-post geocoding call, no precision finer than a city. It
does not say which words to match, and the obvious answer is measurably wrong. Measured over
60 real posts, 40 recorded and 20 live:

- Every capitalised word: **208 distinct candidates.** Among them ``Mission``, which is a city
  of 85,000 in Texas and here is the word "mission"; ``Blaine``, a city of 70,000 in Minnesota
  and here a person; ``Chad``, ``Alpha``, ``Bum``, ``Been``, ``Can``, ``August``, ``Science``,
  ``Sports``, ``Position``, ``Posted``, and the sentence-initial ``The`` and ``I'm``. This is
  not a threshold problem. A bare capitalised word carries no locative claim at all, so
  matching it against 34,000 place names manufactures pins out of ordinary prose.
- Multi-word capitalised phrases: 77 across 38 of the 60 posts, and dominated by headline
  fragments such as ``Child Neglect Case After Changing Pleas``. High recall, no precision.
- **A locative preposition followed by a capitalised phrase: 4 across 4 posts.** One was a real
  place (``in Gaza``), the rest fall out at the gazetteer.
- **A hashtag: 26 across 2 posts**, including ``#utrecht`` twice, from a street photographer
  tagging the city the photograph is of.

So this adapter matches exactly two things: a phrase introduced by a locative preposition, and
a hashtag. Both are a deliberate statement about place by the person who wrote the post, which
is the difference between reading a claim and inventing one. Everything else is left alone.

That yields roughly two posts in sixty. ADR 005 predicted it: "Mastodon coverage will be thin.
Public timelines are small, geographic mentions are rare, and the city gazetteer will miss most
posts. Thin is the correct outcome of not inventing precision." The number is the design
working, not the design failing, and a future reader tempted to loosen the rule should re-read
the 208 above first.

**The phrase travels with the record.** ``in Gaza`` and ``#utrecht`` are stored as the matched
phrase, preposition and hash included, because ADR 005 requires the card to show the derivation
and a bare word would hide which of the two rules fired.

**Media is always dropped, and counted.** A Mastodon status carries no rights field of any
kind, so an attachment's licence cannot be determined, and ADR 005 says an item whose licence
cannot be determined is dropped rather than shown. The Mastodon half of this layer is text.
This is the single most surprising thing in the module and it is not an oversight.

**An instance refusing us is not the feed failing.** ``mastodon.social`` answers HTTP 422
``{"error":"This method requires an authenticated user"}`` to the identical anonymous request
that ``mas.to`` answers 200 to, re-verified today. So instances are configuration, and a 401,
403 or 422 drops that instance for the cycle. :data:`INSTANCE_REFUSAL_STATUSES` is that rule.

**The cadence comes from the provider, not from a guess.** Every response carries
``x-ratelimit-limit: 300``, ``x-ratelimit-remaining`` and ``x-ratelimit-reset`` as an ISO
timestamp, and ``cache-control: max-age=15``. So the floor is the provider's own cache window
and the budget is read off the headers rather than assumed from the documented default.
"""

import html
import logging
import re
import unicodedata
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final, Protocol
from urllib.parse import urlsplit

import httpx
from pydantic import RootModel, TypeAdapter

from tracker.contracts.base import WireModel, validate_payload
from tracker.contracts.city import City
from tracker.contracts.social import SocialPost
from tracker.sources.base import ParsedRecords, RateLimitedError, SourceError, retry_after_seconds

_log = logging.getLogger(__name__)

TIMELINE_PATH: Final = "/api/v1/timelines/public"
"""The anonymous public timeline. ``local=true`` narrows it to the instance's own posts."""

DEFAULT_INSTANCES: Final = ("mas.to",)
"""Instances known to answer anonymously, verified 2026-08-23.

A tuple rather than a setting with a default, because an instance list is a deployment
decision and this is the one that is known to work. ``mastodon.social`` is deliberately absent:
it answers 422 to this request and always has.
"""

PAGE_LIMIT: Final = 40
"""Statuses per request. The provider's own maximum for this endpoint."""

MIN_INTERVAL_SECONDS: Final = 15.0
"""The provider's own cache window, from ``cache-control: max-age=15`` on every response.

Polling faster than a provider's cache cannot return anything new, so this is a floor taken
from the provider rather than invented. The 300-per-five-minutes budget in the rate-limit
headers is far looser than this, which is the right way round.
"""

INSTANCE_REFUSAL_STATUSES: Final = frozenset({401, 403, 422})
"""Statuses that mean "not for anonymous clients", not "broken".

422 is the one that matters and it is not a code anyone would guess: ``mastodon.social``
answers it with ``{"error":"This method requires an authenticated user"}``. Per ADR 005 an
instance answering any of these is dropped for the cycle and the feed carries on with the rest.
"""

RATE_LIMIT_REMAINING_HEADER: Final = "x-ratelimit-remaining"
RATE_LIMIT_RESET_HEADER: Final = "x-ratelimit-reset"
"""The provider's own budget, on every response. Read rather than assumed."""

ATTRIBUTION: Final = "Posts from Mastodon instances, per-instance terms"
"""Layer-level credit. Author handles travel on the records, which is what attribution needs."""


def _now() -> datetime:
    return datetime.now(UTC)


class InstanceRefusedError(SourceError):
    """One instance will not serve anonymous clients. The feed drops it for this cycle."""

    def __init__(self, instance: str, status_code: int) -> None:
        self.instance = instance
        self.status_code = status_code
        super().__init__(
            instance,
            f"instance refused an anonymous public timeline (HTTP {status_code}); "
            "dropped for this cycle",
        )


class PlaceResolver(Protocol):
    """Turns a phrase into a city, or into nothing.

    Injected rather than imported so this adapter never holds the gazetteer: the city index is
    34,000 records loaded once for the whole process, and a source adapter that reached for it
    directly could not be tested without it. :func:`exact_city_resolver` builds one of these
    from a loaded index.
    """

    def __call__(self, phrase: str) -> City | None:
        """The city this phrase names exactly, or None."""
        ...


_TAG = re.compile(r"<[^>]*>")
_WHITESPACE = re.compile(r"\s+")
_URL = re.compile(r"https?://\S+")
_MENTION = re.compile(r"@[\w.]+(?:@[\w.]+)?")

# A capitalised word, then optionally more of them, with the handful of lowercase connectors
# real place names contain ("Stratford upon Avon", "Rio de Janeiro"). Both apostrophes are
# spelled as escapes rather than typed: a straight one and the curly one real posts actually
# use, and a linter cannot tell a deliberate homoglyph in a character class from a typo.
_NAME_WORD = "[A-Z][\\w\u0027\u2019-]+"
_CONNECTOR = "of|upon|on|the|de|del|la|le|van|von"
_PLACE = f"{_NAME_WORD}(?:[ ](?:{_CONNECTOR})[ ]{_NAME_WORD}|[ ]{_NAME_WORD})*"

_LOCATIVE: Final = re.compile(
    r"\b(?:in|at|from|near|outside|across|around|towards?|visiting|arriving in|based in)\s+"
    rf"({_PLACE})"
)
"""A capitalised phrase introduced by a word that makes a claim about place.

The preposition is the signal. Without it, ``Mission`` is a noun and matching it against a
gazetteer is how ordinary prose becomes a pin on a globe.
"""

_HASHTAG: Final = re.compile(r"#(\w{3,})")
"""A hashtag of three characters or more. The author's own label for what the post is about."""


def plain_text(content: str | None) -> str:
    """A status's ``content`` as text.

    Mastodon serves HTML: paragraphs, mention anchors, hashtag anchors with the word inside a
    nested span. Tags are stripped and then entities decoded, in that order, so a ``&lt;`` the
    author escaped on purpose survives instead of being deleted as if it were markup.
    """
    if content is None:
        return ""
    return _WHITESPACE.sub(" ", html.unescape(_TAG.sub(" ", content))).strip()


def location_phrases(text: str) -> tuple[tuple[str, str], ...]:
    """The phrases in a post worth asking the gazetteer about, in the order they appear.

    Two rules and no others, both measured rather than chosen: a capitalised phrase behind a
    locative preposition, and a hashtag. See the module docstring for the 208 candidates that
    the obvious third rule would have produced.

    Returns pairs of ``(phrase, subject)``. The phrase is what the card shows, keeping its
    preposition or its hash so a reader can see which rule fired and judge it. The subject is
    what the gazetteer is asked about.

    **Both are returned rather than one being derived from the other**, and that is a bug fix
    rather than a convenience. Deriving the subject by dropping the first word works for "in
    Utrecht" and fails for "arriving in Utrecht", where it leaves "in Utrecht" and the lookup
    then matches nothing. Every preposition in the pattern that contains a space had that
    failure. The regex already knows where the place starts, so it says.
    """
    stripped = _URL.sub(" ", _MENTION.sub(" ", text))
    found = [
        (match.group(0).strip(), match.group(1).strip()) for match in _LOCATIVE.finditer(stripped)
    ]
    found += [(match.group(0), match.group(1)) for match in _HASHTAG.finditer(text)]
    # Order preserved, duplicates removed: a post that says "in Utrecht" twice is one claim.
    return tuple(dict.fromkeys(found))


class StatusAccountWire(WireModel):
    """The bit of an account this layer stores, which per ADR 005 is the handle and no more."""

    acct: str | None = None


class MediaAttachmentWire(WireModel):
    """One attachment, modelled only so that dropping it can be counted rather than silent."""

    type: str | None = None


class StatusWire(WireModel):
    """One status. Permissive, and the fields it ignores are the point.

    ``card``, ``quote``, ``quote_approval``, ``tagged_collections``, ``poll`` and ``reblog`` all
    arrive and none is read. A strict model here would break the day an instance upgrades.
    """

    id: str | None = None
    uri: str | None = None
    url: str | None = None
    created_at: datetime | None = None
    content: str | None = None
    language: str | None = None
    account: StatusAccountWire | None = None
    media_attachments: list[MediaAttachmentWire] = []  # noqa: RUF012 - pydantic copies defaults


class TimelineWire(RootModel[list[StatusWire]]):
    """The bare JSON array a public timeline returns.

    A root model rather than a bare ``list`` adapter so it goes through
    :func:`~tracker.contracts.base.validate_payload` like every other payload here and gets
    the same one-line error summary on a violation. The endpoint has no envelope: there is no
    ``statuses`` key and no count, just the array. The instance's own paging lives in a ``Link``
    header instead, which nothing here follows because one page is a poll and not a crawl.
    """


_STATUSES_ADAPTER: Final = TypeAdapter(TimelineWire)


def exact_city_resolver(
    search: Callable[[str], tuple[City, ...]],
) -> PlaceResolver:
    """Build a :class:`PlaceResolver` that accepts only an exact name match.

    The gazetteer's own search ranks partial matches, which is right for a search box and wrong
    here: a user typing "lon" wants London offered, whereas a post saying "Lon" is not a claim
    about London. So the index does the lookup and this keeps only a candidate whose name or
    ASCII name equals the phrase, case and accents folded. The most populous survivor wins,
    because two cities of the same name is the normal case and the larger one is the likelier
    subject of a sentence that names nothing else.
    """

    def resolve(phrase: str) -> City | None:
        wanted = _fold(phrase)
        if not wanted:
            return None
        exact = [
            city
            for city in search(phrase)
            if _fold(city.name) == wanted or _fold(city.ascii_name) == wanted
        ]
        if not exact:
            return None
        return max(exact, key=lambda city: city.population)

    return resolve


def _fold(value: str) -> str:
    """Case-folded, accent-stripped, whitespace-collapsed, for comparing names."""
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    bare = "".join(char for char in decomposed if not unicodedata.combining(char))
    return _WHITESPACE.sub(" ", bare).strip()


def parse_timeline(
    payload: bytes | str,
    *,
    instance: str,
    resolve: PlaceResolver,
    retrieved_at: datetime,
) -> ParsedRecords[SocialPost]:
    """Map one public timeline into posts, counting everything that did not become one.

    Most of a timeline does not become a post here, and the counts say why. That is the honest
    shape of a derived layer: a post with no locative phrase is not a post with a missing
    location, it is a post that never claimed one.

    One thing about the returned counter is deliberate and would otherwise look like a bug.
    **It counts two different units**, statuses that did not become posts and media items
    dropped for want of a licence, so ``len(records) + dropped`` does not equal the number of
    statuses in the payload. Both belong in it: ADR 005's "dropped and counted" rule is about
    items, and a media item is an item that was lost. The two keys name their own unit so the
    figures can be read apart, which is why the reasons are sentences rather than codes.
    """
    statuses = validate_payload(_STATUSES_ADAPTER, payload, source=instance).root
    posts: list[SocialPost] = []
    drops: Counter[str] = Counter()
    for status in statuses:
        if status.id is None or status.created_at is None:
            drops["status carried no id or no timestamp"] += 1
            continue
        text = plain_text(status.content)
        phrases = location_phrases(text)
        if not phrases:
            drops["no locative phrase or hashtag in the text"] += 1
            continue
        matched: tuple[str, City] | None = None
        for phrase, subject in phrases:
            city = resolve(subject)
            if city is not None:
                matched = (phrase, city)
                break
        if matched is None:
            drops["phrases found but none is a city in the gazetteer"] += 1
            continue
        if status.media_attachments:
            # ADR 005: an item whose licence cannot be determined is dropped and counted. A
            # Mastodon attachment carries no rights field at all, so this is every one of them.
            drops["media items dropped: no determinable licence"] += len(status.media_attachments)
        phrase, city = matched
        link = status.url or status.uri
        if link is None:
            drops["status carried no link, so it cannot be attributed"] += 1
            continue
        posts.append(
            SocialPost(
                source=instance,
                post_id=status.id,
                url=link,
                author_handle=_handle(status.account),
                posted_at=status.created_at,
                text=text,
                point=city.point,
                location_basis="derived",
                location_phrase=phrase,
                place_name=city.name,
                media=(),
                retrieved_at=retrieved_at,
            )
        )
    return ParsedRecords(records=tuple(posts), drops=drops)


def _handle(account: StatusAccountWire | None) -> str | None:
    """``@user`` or ``@user@instance``, or None when the instance sent no account."""
    if account is None or not account.acct:
        return None
    return f"@{account.acct}"


class MastodonClient:
    """One or more public timelines, polled no faster than the instances cache them.

    Not thread-safe. One event loop owns it.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        resolve: PlaceResolver,
        instances: tuple[str, ...] = DEFAULT_INSTANCES,
        clock: Callable[[], datetime] = _now,
    ) -> None:
        self._client = client
        self._resolve = resolve
        self._instances = instances
        self._clock = clock
        self._last_request_at: dict[str, datetime] = {}
        self.drops: Counter[str] = Counter()
        """Statuses that did not become posts, keyed by reason, since start-up."""
        self.refused: dict[str, str] = {}
        """Instances that refused us, and why, for the layer's own health reporting."""

    @property
    def name(self) -> str:
        """Short identifier for this feed."""
        return "mastodon"

    @property
    def min_interval_seconds(self) -> float:
        """The provider's own cache window. Polling faster returns the same bytes."""
        return MIN_INTERVAL_SECONDS

    @property
    def instances(self) -> tuple[str, ...]:
        """The instances configured, so a caller can tell "all refused" from "none matched".

        Exposed because :attr:`refused` alone cannot answer that: a caller comparing it against
        nothing has no way to know whether any instance served, and would stamp a successful
        poll on a cycle where every one of them turned us away.
        """
        return self._instances

    async def recent_posts(self) -> ParsedRecords[SocialPost]:
        """Every configured instance's public timeline, merged.

        One instance refusing or failing does not fail the call: it is recorded in
        :attr:`refused` and the rest are still returned, which is ADR 005's rule about
        instance availability not being ours to control.
        """
        posts: list[SocialPost] = []
        drops: Counter[str] = Counter()
        for instance in self._instances:
            try:
                parsed = await self._fetch(instance)
            except InstanceRefusedError as exc:
                self.refused[instance] = exc.detail
                drops[f"{instance} refused anonymous access"] += 1
                continue
            self.refused.pop(instance, None)
            posts.extend(parsed.records)
            drops.update(parsed.drops)
        self.drops.update(drops)
        return ParsedRecords(records=tuple(posts), drops=drops)

    async def _fetch(self, instance: str) -> ParsedRecords[SocialPost]:
        """One instance's timeline."""
        self._reserve_request_slot(instance)
        response = await self._client.get(
            f"https://{instance}{TIMELINE_PATH}", params={"limit": str(PAGE_LIMIT)}
        )
        if response.status_code in INSTANCE_REFUSAL_STATUSES:
            raise InstanceRefusedError(instance, response.status_code)
        if response.status_code == httpx.codes.TOO_MANY_REQUESTS:
            raise RateLimitedError(instance, response.status_code, retry_after_seconds(response))
        response.raise_for_status()
        self._note_budget(instance, response)
        parsed = parse_timeline(
            response.content,
            instance=instance,
            resolve=self._resolve,
            retrieved_at=self._clock(),
        )
        if parsed.dropped:
            _log.info(
                "%s: %d of %d statuses did not become posts: %s",
                instance,
                parsed.dropped,
                parsed.dropped + len(parsed.records),
                dict(parsed.drops),
            )
        return parsed

    def _note_budget(self, instance: str, response: httpx.Response) -> None:
        """Log the provider's own remaining budget when it is running low.

        Read rather than assumed: the documented default is 300 per five minutes, and the
        headers say what this instance is actually allowing us. Logged rather than acted on,
        because the 15-second floor already keeps us two orders of magnitude inside it, so a
        low figure here means something else on this address is spending the budget.
        """
        remaining = response.headers.get(RATE_LIMIT_REMAINING_HEADER)
        if remaining is None:
            return
        try:
            left = int(remaining)
        except ValueError:
            return
        if left < PAGE_LIMIT:
            _log.warning(
                "%s says %d requests left before %s",
                instance,
                left,
                response.headers.get(RATE_LIMIT_RESET_HEADER, "an unstated time"),
            )

    def _reserve_request_slot(self, instance: str) -> None:
        """Refuse before sending if this instance was asked inside its own cache window."""
        now = self._clock()
        last = self._last_request_at.get(instance)
        if last is not None:
            elapsed = (now - last).total_seconds()
            if elapsed < MIN_INTERVAL_SECONDS:
                raise RateLimitedError(instance, 429, MIN_INTERVAL_SECONDS - elapsed)
        self._last_request_at[instance] = now


def instance_of(url: str) -> str:
    """The host part of a status URL, for naming the source a remote post came from."""
    return urlsplit(url).hostname or ""
