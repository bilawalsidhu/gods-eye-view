"""Wikimedia Commons geosearch: the ``upstream`` half of the social post layer.

Keyless. A Commons file carries a coordinate about **what it is a picture of**, which is why
ADR 005 lets this source claim ``location_basis="upstream"`` while Mastodon cannot: nothing
here says where the uploader was, only where the subject is.

**One request per query, not two, and the provider asked for that.** The obvious shape is
``list=geosearch`` for the coordinates and then ``prop=imageinfo`` for the licences, which is
two round trips and a page of titles pasted between them. MediaWiki's own API:Etiquette says
to use "a generator instead of making a request for each result from another request", so this
uses ``generator=geosearch`` with ``prop=imageinfo|coordinates`` and gets both in one. Verified
on 2026-08-23: 50 pages, all 50 carrying imageinfo, all 50 carrying coordinates, 266KB.

**Everything this module defends against was measured on 2026-08-23, not inferred.**

*The error is inside the 200.* ``gsradius=50000`` answers HTTP 200 with
``{"error":{"code":"outofrange",...}}``. So does a lag refusal, with ``code: "maxlag"``. A
client that branches on status and reaches for ``query`` gets a ``KeyError`` instead of a
reason, and the two error codes need opposite handling: one is our bug, the other is "come
back later".

*``maxlag`` is not optional for us.* API:Etiquette: "If your task is not interactive, i.e. a
user is not waiting for the result, you should use the maxlag parameter." A poller is exactly
that, so every request carries :data:`MAXLAG_SECONDS` and a ``maxlag`` refusal becomes a
backoff rather than a failure. Confirmed working: ``maxlag=-1`` answered
``{"error":{"code":"maxlag","info":"Waiting for 10.64.32.58: 0.701432 seconds lagged."}}``.

*An over-limit ``gslimit`` is a warning, not an error, and the count silently changes.*
``gslimit=600`` answered 200 with a ``warnings`` block saying the value "must be between 1 and
500", and returned **64** results. Not 600, not 500, and no error to branch on. So the limit
is clamped here before it is sent.

*``missing: true`` does not mean missing.* A Commons file queried against a local wiki answers
``"missing": true`` with ``"imagerepository": "shared"`` and a complete ``imageinfo`` block
including its licence, because the file lives on Commons. The drop condition is therefore the
**absence of ``imageinfo``**, never the presence of ``missing``. Reproduced today against
``en.wikipedia.org`` for ``File:Map of Punt region.jpg``: ``missing`` true, licence "Public
domain", fully usable.

*A coordinate has a globe.* ``coordinates`` entries carry ``globe: "earth"``, and MediaWiki
also stores coordinates on the Moon and Mars. Nothing in the London sample was off-earth and
``ggsglobe`` is passed explicitly anyway, for the same reason CelesTrak's ``FORMAT`` is: a
default that is right today is not a default that is documented as stable. The earth
coordinate is then picked by name rather than by position in the list, because a page may
carry more than one.

*``Artist`` is HTML and ``AttributionRequired`` is a string.* Real values:
``'Unknown author<span style="display: none;">Unknown author</span>'`` and ``'true'``. A card
is not a browser and ``if em["AttributionRequired"]:`` is true for ``'false'``, which is the
TfL ``available`` trap in a different payload.

*Zero is not a dimension.* ``application/ogg`` items come back with ``width: 0, height: 0``,
three of fifty in the London sample, while every ``image/jpeg`` carried real pixels. Zero is
this payload's "not applicable", the same shape as every other sentinel in this project, so it
maps to ``None`` in the adapter. A contract field with ``gt=0`` and no mapping drops every
audio and video item on the layer, which is how a geosearch that returned fifty records comes
to draw forty-seven and say nothing about it. Measured, because the first run did exactly that.

*``DateTimeOriginal`` is free text.* ``cir. 1948`` is a real value. It is not read, and
:data:`~tracker.contracts.social.MEDIA_DATED_BY` records that the date on every item here is
the upload time instead.

**Not a poller.** No cadence is published for reads: API:Etiquette says "There is no hard
speed limit on read requests" and asks for requests in series. So the floor here is ours, one
per second, the same figure AGENTS.md already records for Wikimedia, and it is a constant
rather than a setting because a floor that can be lowered from the environment is not a floor.
"""

import html
import logging
import re
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Final
from urllib.parse import urlsplit

import httpx
from pydantic import TypeAdapter

from tracker.contracts.base import ContractViolationError, WireModel, validate_payload
from tracker.contracts.geo import Point
from tracker.contracts.social import MediaLicence, PostMedia, SocialPost
from tracker.sources.base import ParsedRecords, RateLimitedError, SourceError, retry_after_seconds

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "commons"
"""Per-record source name, as ``docs/data-sources.md`` names it."""

BASE_URL: Final = "https://commons.wikimedia.org/w/api.php"
"""The action API. Not the REST API: only the action API has geosearch."""

FILE_NAMESPACE: Final = 6
"""Namespace 6 is ``File:``. Anything else geosearch returns is a page, not a media item."""

MEDIA_HOST: Final = "upload.wikimedia.org"
"""Where a Commons rendition actually lives, and the test a `thumburl` has to pass.

Verified 2026-08-23: both ``url`` and ``thumburl`` point here for a file with a real preview.
A ``thumburl`` on any other host is not a rendition of the item. Two of four files in the
recorded fixture, both ``application/ogg``, carry
``https://commons.wikimedia.org/w/resources/assets/file-type-icons/fileicon-ogg.png`` instead,
which is the wiki's own static UI icon for media it cannot render a preview of. Carrying that
as the item's preview would put a generic file-type icon on a card and call it the picture.
"""

GLOBE: Final = "earth"
"""Passed explicitly and checked on the way back. MediaWiki also stores Moon and Mars."""

RADIUS_MIN_M: Final = 10
RADIUS_MAX_M: Final = 10_000
"""The provider's stated bounds, from its own ``outofrange`` error body: "must be between 10
and 10,000". A wider area has to be tiled by the caller; this clamps rather than failing,
because a clamped search returns real posts and a rejected one returns none."""

RESULT_LIMIT_MAX: Final = 500
"""Ceiling on ``ggslimit``, from the provider's own warning text. Exceeding it is a warning
rather than an error and silently changes the count, so it is clamped before sending."""

RESULT_LIMIT: Final = 500
"""Asked for per query, and it is the provider's own ceiling rather than a number we chose.

**It used to be 50, and the 50 was not this constant's fault.** Sending ``ggslimit=500`` while
also sending ``iiurlwidth`` returns 500 pages of which exactly **50 carry ``imageinfo``**, with
``batchcomplete`` absent and an ``iicontinue`` token offering the rest. Our own drop rule then
discards the other 450 as unlicensable, so raising the limit alone bought 450 dropped records
and 32% more bytes for not one extra post. See :data:`PREVIEW_WIDTH` for the cause.

**500 rather than a smaller number, because a city is not legible below it.** Measured
2026-08-24 without ``iiurlwidth``: at Times Square distinct coordinates go 37, 41, 95, 153, 300
for limits of 50, 100, 200, 300, 500, still doubling between the last two, so there is no
plateau to stop at. At Charing Cross it is worse: **19 distinct coordinates from 50 all the way
through 300**, because the nearest 300 files there sit on 19 copied placeholder points, and only
past 300 do real places appear at all. A ladder that stopped at 200 would draw one badge over
central London and call it the layer.

The cost is bytes: 745KB median across twelve city viewports, 712KB best, 1,600KB worst
(Berlin). That is 10x the records for 2.9x the bytes of the old 50, and per record it is
cheaper. It is one request rather than the ten an ``iicontinue`` walk would take for the same
data, and ``batchcomplete`` comes back ``true``, which is the provider stating it served a
complete batch."""

PREVIEW_WIDTH: Final = 500
"""Width of the preview we point at. One of Wikimedia's own standard widths, which is required.

**``iiurlwidth`` is not sent, and that is what lifted the record ceiling from 50 to 500.**
MediaWiki resolves a ``prop`` module for at most 50 titles per request *when a thumbnail render
is asked for*, whatever the generator returned. Measured 2026-08-24 against a 500-page geosearch:
with ``iiurlwidth=500`` the response carried 50 ``imageinfo`` blocks in 342KB and no
``batchcomplete``; without it, **500 blocks in 2,081KB and ``batchcomplete: true``**. Nothing in
the payload says the thumbnail is what capped it.

So the address is derived instead, by :func:`_rendition`, and derived is not a euphemism for
guessed: for all 47 raster files in a live 50-record response the derived URL was **byte-identical
to the one the API returned**. The three non-rasters were the only difference and there the API
sends a static UI icon on the wrong host, which the old code already threw away. So this
reproduces today's output exactly while asking the provider to render nothing.

That last part is the point worth keeping. We were making Wikimedia's thumbnailer render fifty
images per viewport request and then not fetching most of them, which is expensive work for them
in a way that JSON is not. The bytes only move when a card opens."""

PREVIEW_MIMES: Final = frozenset({"image/jpeg", "image/png", "image/gif"})
"""Media types with a derivable still, verified live 2026-08-24 by fetching one.

``image/jpeg`` is 99.60% of a 4,000-record census across ten viewports, ``image/png`` 0.23% and
``image/gif`` 0.03%: 99.86% between them. The tail is ``application/ogg`` (0.10%),
``video/webm`` and ``image/tiff`` (0.03% each), and a derived thumbnail for all three answers
**HTTP 400** because Wikimedia renders those under a different name (``lossy-page1-`` and
friends). They get no preview, which is exactly what they got before: the API's own answer for
them was a file-type icon this adapter already refused."""

EXTMETADATA_FIELDS: Final = (
    "LicenseShortName",
    "UsageTerms",
    "LicenseUrl",
    "Artist",
    "AttributionRequired",
    "ImageDescription",
)
"""Every ``extmetadata`` key this adapter reads, sent as ``iiextmetadatafilter``.

``extmetadata`` is the bulk of the response and most of it is licence boilerplate and
descriptions in languages nobody asked for. Filtering to these six took a 500-record London
response from **2,081KB to 743KB**, a 64% saving, with a byte-identical parse: same 500 posts,
same 46 distinct coordinates, same 32 upstream, same 27.2m spread. Measured 2026-08-24.

The list is here rather than inline so that adding a read without adding it to the filter is a
visible mistake. A key that is read but not requested arrives absent, and an absent
``LicenseShortName`` drops the record as unlicensable, so the failure mode of getting this wrong
is a layer that quietly shows nothing."""

SHARED_COORDINATE_MIN: Final = 2
"""How many files on one exact coordinate make it a copied value rather than an observation.

Two, and the number falls out of physics rather than out of tuning.

**The provider quotes six to seven decimal places**, measured 2026-08-24: London's placeholder
is ``51.5073509, -0.1277583``. Seven decimals is about a centimetre. No two independent
photographs have GPS fixes that agree to a centimetre, so an exact repeat at that precision is
not two observations of one spot, it is one value copied onto two records. That makes the
threshold two rather than a figure chosen from a distribution, and it is why no tolerance is
needed anywhere in this check.

What the measurement showed, per 50-file response within 10km of a centre:

- Charing Cross: **all 50 files on one coordinate.** The files are bulk Unsplash imports named
  "Rustic stovetop", "Binoculars", "Stepping in puddle". None is a photograph of Charing Cross.
- Notre-Dame: 259 of 500 on ``48.856614, 2.352222``, the canonical Paris coordinate.
- Midtown Manhattan: 37 distinct coordinates across 50 files, 32 of them carried by one file
  each. The largest group, 45 of 48 uploaded by "File Upload Bot", includes "Princeton" and
  "Small Dog Confidence".
- Reykjavik and rural Wales: 30 and 27 distinct across 50, most carried by one file.

**The errors are asymmetric and that decided the direction.** Reclassifying a genuine cluster,
say three frames of a panorama sharing one fix, weakens a true claim: the pin stays where it is
and the card stops calling it an observation. Leaving a placeholder as ``upstream`` asserts an
observed position that does not exist, which is the failure ADR 005 exists to prevent. So the
threshold errs towards reclassifying, and the singletons, which are the majority everywhere
except the placeholder-dominated cities, keep their ``upstream`` classification.
"""

MIN_INTERVAL_SECONDS: Final = 1.0
"""Our own floor. The provider publishes none for reads and asks for serial requests."""

MAXLAG_SECONDS: Final = 5
"""Replication lag we are willing to accept, in seconds, on every request.

Not a tuning knob. API:Etiquette asks a non-interactive client to send this so the API can
shed our load when the databases are behind, and a poller that omits it is asking to be
throttled by something less polite.
"""

MAXLAG_BACKOFF_SECONDS: Final = 30.0
"""How long to hold off when the API says it is lagging.

Shorter than the generic rate-limit default, because replication lag clears in seconds and a
two-minute backoff would turn a blip into a gap. The provider sends ``Retry-After`` with a
maxlag refusal when it has a figure, and that figure wins over this one.
"""

ATTRIBUTION: Final = "Media from Wikimedia Commons, licensed per file"
"""Layer-level credit. Per-file licences travel on the records, because that is where they
differ: one file is CC BY-SA 4.0 and the next is public domain."""


def _now() -> datetime:
    return datetime.now(UTC)


class CommonsLaggingError(RateLimitedError):
    """The API refused because its databases are behind, inside an HTTP 200.

    A :class:`~tracker.sources.base.RateLimitedError` subclass so every caller that already
    backs off on a throttle backs off on this too. It is not a throttle and not a fault: the
    request was well formed and the answer is "ask again shortly".
    """

    def __init__(self, *, lag_seconds: float, retry_after: float) -> None:
        self.status_code = 200
        self.retry_after_seconds = max(retry_after, 1.0)
        self.lag_seconds = lag_seconds
        SourceError.__init__(
            self,
            SOURCE_NAME,
            f"API reports {lag_seconds:.1f}s of replication lag; "
            f"retry in {self.retry_after_seconds:.0f}s",
        )


class CoordinateWire(WireModel):
    """One entry of a page's ``coordinates`` list."""

    lat: float | None = None
    lon: float | None = None
    globe: str | None = None
    primary: bool | None = None


class ImageInfoWire(WireModel):
    """One entry of a page's ``imageinfo`` list.

    ``extmetadata`` is left as a raw mapping rather than modelled: it is an open-ended bag
    whose keys vary per file and per licence template, every value is itself a
    ``{"value", "source", "hidden"}`` wrapper, and modelling it would be a strict model
    wearing a disguise. What is read out of it is named in :func:`_licence`.
    """

    url: str | None = None
    mime: str | None = None
    width: int | None = None
    height: int | None = None
    user: str | None = None
    timestamp: datetime | None = None
    descriptionurl: str | None = None
    extmetadata: dict[str, Any] = {}  # noqa: RUF012 - pydantic copies field defaults per model


class PageWire(WireModel):
    """One page from a ``generator=geosearch`` query.

    ``missing`` is modelled precisely so that it can be *ignored* deliberately rather than by
    omission: a reader who sees the field here and no branch on it will go and find the note
    in the module docstring, which is the point.
    """

    pageid: int | None = None
    ns: int | None = None
    title: str | None = None
    missing: bool | None = None
    imagerepository: str | None = None
    imageinfo: list[ImageInfoWire] | None = None
    coordinates: list[CoordinateWire] | None = None


class QueryWire(WireModel):
    """The ``query`` block. Only ``pages`` is read; the generator puts everything there."""

    pages: list[PageWire] = []  # noqa: RUF012 - pydantic copies field defaults per model


class EnvelopeWire(WireModel):
    """The whole response.

    ``error`` and ``warnings`` are modelled because both arrive inside an HTTP 200 and both
    change what the response means. ``warnings`` in particular is the only signal that a
    parameter was silently altered: ``ggslimit=600`` warned and returned 64 results.
    """

    error: dict[str, Any] | None = None
    warnings: dict[str, Any] | None = None
    query: QueryWire | None = None


_ENVELOPE_ADAPTER: Final = TypeAdapter(EnvelopeWire)

_HIDDEN = re.compile(r"<(\w+)[^>]*\bdisplay\s*:\s*none[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_TAG = re.compile(r"<[^>]*>")
_WHITESPACE = re.compile(r"\s+")


def strip_markup(raw: str | None) -> str:
    """Turn one of Commons' HTML-bearing metadata values into plain text.

    ``Artist`` and ``Credit`` both arrive as HTML: an anchor tag in the second, and in the
    first a name repeated inside a ``display: none`` span. Both were measured today.

    Three steps, and the order of the last two is the whole point.

    **Hidden elements go first, contents and all.** The real ``Artist`` value is
    ``'Unknown author<span style="display: none;">Unknown author</span>'``. A browser renders
    that once. Strip tags without looking at the style and it renders twice, as
    ``'Unknown author Unknown author'``, which is what the first version of this function did.
    The pattern is deliberately narrow: one element, its own closing tag, ``display: none`` in
    its attributes. It is not an HTML parser and is not trying to be, because the input is one
    metadata field from one API rather than the open web.

    **Then tags are removed, and only then are entities decoded.** The other way round,
    ``&lt;b&gt;`` decodes into ``<b>`` and the tag stripper then deletes it as if the author
    had written markup, silently losing text they had escaped on purpose. Measured: the first
    version turned ``'a &lt;b&gt; b <i>c</i>'`` into ``'a b c'`` instead of ``'a <b> b c'``.
    """
    if raw is None:
        return ""
    return _WHITESPACE.sub(" ", html.unescape(_TAG.sub(" ", _HIDDEN.sub(" ", raw)))).strip()


def _extmetadata_value(extmetadata: dict[str, Any], key: str) -> str | None:
    """One value out of the ``extmetadata`` bag, or None.

    Every entry is a ``{"value": ..., "source": ..., "hidden": ...}`` wrapper and the value
    may be a number as readily as a string, so it is coerced to text here rather than at four
    call sites.
    """
    entry = extmetadata.get(key)
    if not isinstance(entry, dict):
        return None
    value = entry.get("value")
    if value is None:
        return None
    text = strip_markup(str(value))
    return text or None


def _licence(extmetadata: dict[str, Any]) -> MediaLicence | None:
    """The item's rights, or None when they cannot be determined.

    None is the drop signal, and ADR 005 makes it a drop rather than a display: an item whose
    licence we cannot state is not an item we show. ``LicenseShortName`` is the field that
    decides, because it is the one a card renders; ``UsageTerms`` is a fuller sentence and is
    used only when the short name is absent.

    ``AttributionRequired`` is compared as a string. It arrives as ``'true'`` or ``'false'``,
    and both are truthy.
    """
    name = _extmetadata_value(extmetadata, "LicenseShortName") or _extmetadata_value(
        extmetadata, "UsageTerms"
    )
    if name is None:
        return None
    return MediaLicence(
        name=name,
        url=_extmetadata_value(extmetadata, "LicenseUrl"),
        author=_extmetadata_value(extmetadata, "Artist"),
        attribution_required=(_extmetadata_value(extmetadata, "AttributionRequired") or "").lower()
        == "true",
    )


def _rendition(url: str, mime: str) -> str | None:
    """A 500px preview address, worked out from the original rather than asked for.

    See :data:`PREVIEW_WIDTH` for why this is derived: asking for the thumbnail is what capped
    the whole query at 50 records. Wikimedia's layout puts the thumbnail beside the original
    under a ``thumb`` segment, so ``/commons/6/66/Name.jpg`` becomes
    ``/commons/thumb/6/66/Name.jpg/500px-Name.jpg``, and for every raster file checked that is
    character for character what the API itself returns.

    Three things are checked rather than assumed, because a derived address that 404s is a
    broken picture on a card and nothing would raise. The media type has to be one with a
    derivable still (:data:`PREVIEW_MIMES`); the host has to be the media host, so a URL from
    somewhere unexpected produces no preview instead of a fabricated one; and the two path
    segments before the filename have to be the shard pair Wikimedia actually uses, one hex
    character and then that same character plus one. A path that is not that shape is not a
    layout this function knows, so it declines.
    """
    if mime not in PREVIEW_MIMES:
        return None
    split = urlsplit(url)
    if split.hostname != MEDIA_HOST:
        return None
    parts = split.path.split("/")
    if len(parts) < _SHARDED_PATH_PARTS:
        return None
    first, pair, name = parts[-3], parts[-2], parts[-1]
    if len(first) != _SHARD_FIRST_LEN or len(pair) != _SHARD_PAIR_LEN or not pair.startswith(first):
        return None
    directory = "/".join([*parts[:-3], "thumb", first, pair, name])
    return f"{split.scheme}://{split.netloc}{directory}/{PREVIEW_WIDTH}px-{name}"


_SHARDED_PATH_PARTS: Final = 6
"""``["", "wikipedia", "commons", "6", "66", "Name.jpg"]``: the shortest path with a shard pair."""

_SHARD_LENGTHS: Final = (1, 2)
"""The two directory names before the filename: the first and first-two hex characters of the
name's MD5. Wikimedia's storage layout, and the reason a thumbnail address is derivable at all."""

_SHARD_FIRST_LEN: Final = 1
"""The first shard segment: one hex character of the filename's MD5."""

_SHARD_PAIR_LEN: Final = 2
"""The second: that same character plus one, which is what makes the pair checkable."""


def _dimension(raw: int | None) -> int | None:
    """One pixel dimension, with the provider's zero mapped to "not applicable".

    Audio has no width. Commons says so with a ``0`` rather than by omitting the field, and a
    zero would either fail the contract or, worse, describe a real item as nought by nought.
    """
    return raw or None


def _earth_point(coordinates: list[CoordinateWire] | None) -> Point | None:
    """The page's coordinate on this planet, or None.

    Picked by globe rather than by position in the list. A page may carry several coordinates,
    and one of them being about a crater on the Moon is a thing MediaWiki genuinely stores.
    """
    for entry in coordinates or ():
        if entry.lat is None or entry.lon is None:
            continue
        if (entry.globe or GLOBE).lower() != GLOBE:
            continue
        return Point(lon=float(entry.lon), lat=float(entry.lat))
    return None


def raise_for_api_error(envelope: EnvelopeWire, *, response: httpx.Response | None = None) -> None:
    """Turn an error carried inside a 200 body into the right exception.

    The action API answers HTTP 200 and puts the failure in an ``error`` key, so this has to
    be called before anything reaches for ``query``. Two codes matter and they need opposite
    treatment: ``maxlag`` means the databases are behind and we should come back, everything
    else means the request was wrong and no amount of waiting will fix it.
    """
    error = envelope.error
    if not error:
        return
    code = str(error.get("code", "unknown"))
    info = strip_markup(str(error.get("info", ""))) or "no detail given"
    if code == "maxlag":
        lag = error.get("lag")
        raise CommonsLaggingError(
            lag_seconds=float(lag) if isinstance(lag, int | float) else 0.0,
            retry_after=(
                retry_after_seconds(response) if response is not None else MAXLAG_BACKOFF_SECONDS
            ),
        )
    raise ContractViolationError(SOURCE_NAME, f"API error {code}: {info}")


def parse_posts(payload: bytes | str, *, retrieved_at: datetime) -> ParsedRecords[SocialPost]:
    """Map one ``generator=geosearch`` response into posts, counting what would not map.

    Every drop reason is a sentence about this provider rather than a generic code, because a
    poll that loses half its records has to say which half and why. The reasons are the ones
    measured: a page with no ``imageinfo`` (which is not the same as ``missing``), a page with
    no earth coordinate, and an item whose licence cannot be determined.
    """
    envelope = validate_payload(_ENVELOPE_ADAPTER, payload, source=SOURCE_NAME)
    raise_for_api_error(envelope)
    if envelope.warnings:
        # A parameter the API quietly altered. Never an exception: the response is real and
        # usable, it is just not the response that was asked for, and silence here is how
        # "ggslimit=600 returned 64" becomes a mystery about missing posts.
        _log.warning("commons altered a parameter: %s", envelope.warnings)
    if envelope.query is None:
        raise ContractViolationError(SOURCE_NAME, "response carried neither an error nor a query")
    pages = envelope.query.pages

    posts: list[SocialPost] = []
    drops: Counter[str] = Counter()
    for page in pages:
        if page.title is None or page.pageid is None:
            drops["page carried no title or id"] += 1
            continue
        # Deliberately not `if page.missing`. A Commons file reached through a local wiki
        # reports missing with a full licence attached; the absence of imageinfo is the fact.
        info = page.imageinfo[0] if page.imageinfo else None
        if info is None:
            drops["no imageinfo, so no licence and no media URL"] += 1
            continue
        point = _earth_point(page.coordinates)
        if point is None:
            drops["no coordinate on this planet"] += 1
            continue
        licence = _licence(info.extmetadata)
        if licence is None:
            drops["licence could not be determined"] += 1
            continue
        if info.url is None or info.mime is None or info.timestamp is None:
            drops["imageinfo lacked a URL, a media type or an upload time"] += 1
            continue
        posts.append(
            SocialPost(
                source=SOURCE_NAME,
                post_id=str(page.pageid),
                url=info.descriptionurl or info.url,
                # Commons has uploaders rather than handles, and the person to credit is the
                # author on the licence rather than whoever pressed upload.
                author_handle=None,
                posted_at=info.timestamp,
                text=_extmetadata_value(info.extmetadata, "ImageDescription") or "",
                point=point,
                location_basis="upstream",
                media=(
                    PostMedia(
                        url=info.url,
                        preview_url=_rendition(info.url, info.mime),
                        mime=info.mime,
                        width=_dimension(info.width),
                        height=_dimension(info.height),
                        licence=licence,
                    ),
                ),
                retrieved_at=retrieved_at,
            )
        )
    return ParsedRecords(records=tuple(posts), drops=drops)


def mark_shared_coordinates(
    posts: tuple[SocialPost, ...],
) -> tuple[tuple[SocialPost, ...], int]:
    """Reclassify any post whose coordinate other posts in the same response also carry.

    The whole check is inter-file agreement, and that is the point: it needs no gazetteer, no
    reverse lookup and **no tolerance**. Comparing each coordinate against a known city centroid
    would need one, because two independent roundings of the same nominal point differ in their
    last digits, and it would also miss every placeholder that is not a city centre. Asking
    instead whether several files quote the *same* value to the centimetre answers the real
    question directly: was this observed, or copied.

    Grouping is on the value as the provider sent it, unrounded. Rounding first would merge
    coordinates four metres apart, which Reykjavik really has as two separate copied batches,
    and would start inventing agreement rather than detecting it.

    Returns the posts and how many were reclassified, because a derivation that happens
    silently is a derivation nobody can audit.

    ponytail: one pass and a dict, no spatial index. A response is capped at
    :data:`RESULT_LIMIT` records, so this is fifty comparisons.
    """
    counts: Counter[tuple[float, float]] = Counter(
        (post.point.lon, post.point.lat) for post in posts
    )
    reclassified = 0
    marked: list[SocialPost] = []
    for post in posts:
        shared = counts[(post.point.lon, post.point.lat)]
        if shared < SHARED_COORDINATE_MIN or post.location_basis != "upstream":
            marked.append(post)
            continue
        marked.append(
            post.model_copy(update={"location_basis": "derived", "coordinate_shared_by": shared})
        )
        reclassified += 1
    return tuple(marked), reclassified


class CommonsClient:
    """Geosearch against Commons, one request per query and one second between them.

    Not thread-safe. One event loop owns it, like every other adapter here.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str = BASE_URL,
        clock: Callable[[], datetime] = _now,
    ) -> None:
        self._client = client
        self._base_url = base_url
        self._clock = clock
        self._last_request_at: datetime | None = None
        self.drops: Counter[str] = Counter()
        """Records the provider sent that would not map, keyed by reason, since start-up."""
        self.reclassified = 0
        """Records whose provider coordinate turned out to be copied, so it is not an
        observation. Counted since start-up, because a derivation nobody can see is a
        derivation nobody can audit. See :func:`mark_shared_coordinates`."""

    @property
    def name(self) -> str:
        """Short identifier for this feed, as health output and per-record `source` use it."""
        return SOURCE_NAME

    @property
    def min_interval_seconds(self) -> float:
        """Our own cadence floor. The provider publishes none for reads."""
        return MIN_INTERVAL_SECONDS

    async def posts_near(
        self, centre: Point, *, radius_m: int = RADIUS_MAX_M, limit: int = RESULT_LIMIT
    ) -> ParsedRecords[SocialPost]:
        """Posts whose subject is within ``radius_m`` of ``centre``.

        Args:
            centre: Where to search from. Longitude and latitude in contract order; the
                provider wants them the other way round and this swaps at the boundary.
            radius_m: Clamped to the provider's stated 10 to 10,000 metres. A wider area is
                the caller's problem to tile, because how to tile it depends on what the
                caller is drawing.
            limit: Clamped to the provider's stated ceiling of 500.

        Returns:
            The posts that mapped, and a count per reason of those that did not.

        Raises:
            CommonsLaggingError: The API is behind and asked us to come back.
            RateLimitedError: The API asked us to back off.
            ContractViolationError: The response carried an error, or was not the documented
                shape.
            httpx.HTTPError: Transport failure or a non-2xx status.
        """
        params = {
            "action": "query",
            "format": "json",
            # Without this, booleans arrive as empty strings and pages come back keyed by
            # pageid instead of as a list. Mandatory in practice rather than optional.
            "formatversion": "2",
            "maxlag": str(MAXLAG_SECONDS),
            "generator": "geosearch",
            # The provider takes latitude first. Our contracts are longitude first. This line
            # is the boundary that AGENTS.md requires the swap to happen at.
            "ggscoord": f"{centre.lat}|{centre.lon}",
            "ggsradius": str(min(max(radius_m, RADIUS_MIN_M), RADIUS_MAX_M)),
            "ggslimit": str(min(max(limit, 1), RESULT_LIMIT_MAX)),
            "ggsnamespace": str(FILE_NAMESPACE),
            "ggsglobe": GLOBE,
            "prop": "imageinfo|coordinates",
            "iiprop": "url|user|extmetadata|mime|size|timestamp",
            # No `iiurlwidth`. It caps the whole query at 50 records however large `ggslimit`
            # is, and the preview address it would return is one `_rendition` derives exactly.
            "iiextmetadatafilter": "|".join(EXTMETADATA_FIELDS),
            "colimit": "max",
        }
        self._reserve_request_slot()
        response = await self._client.get(self._base_url, params=params)
        if response.status_code == httpx.codes.TOO_MANY_REQUESTS:
            raise RateLimitedError(SOURCE_NAME, response.status_code, retry_after_seconds(response))
        response.raise_for_status()
        # The action API puts its failures in a 200 body, so the error check has to happen
        # before anything reads `query`. It happens inside `parse_posts`, on the one parse of
        # the body rather than on a second one: these responses run to 266KB and parsing
        # twice to read one key would be a quarter of a megabyte of waste per poll. The
        # response is passed in only so a maxlag refusal can honour its own `Retry-After`.
        parsed = self._parse(response, retrieved_at=self._clock())
        records, reclassified = mark_shared_coordinates(parsed.records)
        if reclassified:
            self.reclassified += reclassified
            _log.info(
                "commons reclassified %d of %d records as derived: their coordinate is shared "
                "by other files in the same response, so it was copied rather than observed",
                reclassified,
                len(records),
            )
        parsed = ParsedRecords(records=records, drops=parsed.drops)
        self.drops.update(parsed.drops)
        if parsed.dropped:
            _log.info(
                "commons dropped %d of %d records: %s",
                parsed.dropped,
                parsed.dropped + len(parsed.records),
                dict(parsed.drops),
            )
        return parsed

    def _parse(
        self, response: httpx.Response, *, retrieved_at: datetime
    ) -> ParsedRecords[SocialPost]:
        """Map the body, letting a lag refusal carry the provider's own retry figure."""
        envelope = validate_payload(_ENVELOPE_ADAPTER, response.content, source=SOURCE_NAME)
        raise_for_api_error(envelope, response=response)
        return parse_posts(response.content, retrieved_at=retrieved_at)

    def _reserve_request_slot(self) -> None:
        """Spend our one-per-second slot, or refuse before touching the network.

        A refusal rather than a sleep, for the same reason Nominatim's client refuses: a
        caller that wanted to know it was too early can back off, and a caller that silently
        slept would hide a poll cadence set too fast.
        """
        now = self._clock()
        last = self._last_request_at
        if last is not None:
            elapsed = (now - last).total_seconds()
            if elapsed < MIN_INTERVAL_SECONDS:
                raise RateLimitedError(SOURCE_NAME, 429, MIN_INTERVAL_SECONDS - elapsed)
        self._last_request_at = now
