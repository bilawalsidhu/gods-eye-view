"""The social layer's process-lived state: two clients and the last derived page.

Both clients hold state that only means anything across requests, the per-provider cadence
floors and the last timeline page, so they have to outlive a request. This lives under
``services/`` rather than beside the route because :class:`~tracker.api.state.AppState` holds it
and the state module cannot import a router without a cycle.

**Why it is shared rather than held per request, which is the whole reason this module exists.**
It used to be a module-level singleton built lazily on the first request to ``/api/social``. That
worked for serving, and it silently broke the removal path: a :class:`SocialClients` built in
``build_state`` was a *different object* from the one the route answered out of, so a removal
under ADR 008 swept a page nobody read and reported reaching a cache it had never touched. That
is the failure AGENTS.md records against the adsbdb owner cache, which it calls worse than a slow
removal because it looks like it worked.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx

from tracker.contracts.base import ContractViolationError
from tracker.contracts.social import SocialPost
from tracker.sources import commons, mastodon
from tracker.sources.base import RateLimitedError, SourceError, describe_exception


@dataclass
class SocialClients:
    """The two clients and the last thing the polled one said, for the life of the process.

    The Mastodon page is held because the route has to answer *now*. Its floor is fifteen
    seconds, so most requests arrive inside it and would otherwise be told there are no derived
    posts, which is a different statement from "the last page had none" and would make the layer
    flicker between empty and not.

    In memory rather than on disk, and that is the adsbdb precedent rather than an oversight: a
    Commons record carries an uploader and an author, so this holds names of real people.
    AGENTS.md's rule is that persisting a cache of personal data is allowed but the removal path
    is then not optional, and a restart clearing it is the right behaviour rather than a cost.
    Nothing polls it, so there is no burst to protect against either.
    """

    commons_client: commons.CommonsClient
    mastodon_client: mastodon.MastodonClient
    derived: tuple[SocialPost, ...] = ()
    derived_as_of: datetime | None = None
    notices: tuple[str, ...] = field(default_factory=tuple)

    @property
    def name(self) -> str:
        """What a removal calls this cache when reporting what it reached."""
        return "social derived page"

    def forget_all(self) -> int:
        """Drop the held page, and say how many posts went.

        This cache holds personal data and it is easy to miss: a Mastodon post carries an
        author handle and a Commons post carries the licence author, both real people. A
        removal that reached the person store and the media bytes but left this page in memory
        would keep serving a name for up to fifteen seconds, and "briefly" is not a defence.

        The timestamp is cleared with it, because a page that has gone is not a page that was
        fetched at a time.
        """
        gone = len(self.derived)
        self.derived = ()
        self.derived_as_of = None
        return gone

    async def refresh_derived(self) -> None:
        """Take a new timeline page if the provider's cache window has passed.

        A refusal from our own floor is not an error and not logged as one: it means the last
        page is still the newest thing anyone could have. Anything else is recorded as a notice
        so the layer can say why its derived half is thin, rather than looking simply empty.
        """
        try:
            parsed = await self.mastodon_client.recent_posts()
        except RateLimitedError:
            return
        except (SourceError, ContractViolationError, httpx.HTTPError) as exc:
            self.notices = (f"Mastodon unavailable: {describe_exception(exc)}",)
            return
        self.derived = parsed.records
        # Stamped only when an instance actually served. `recent_posts` does not raise when an
        # instance refuses, it records the refusal and returns what the rest gave, so a cycle
        # where every instance turned us away arrives here looking exactly like a successful
        # poll that found nothing. Those are different statements and a timestamp on the second
        # one is a small lie: it tells a client the derived half is current when nothing was
        # fetched. Caught by a test rather than by reading the code.
        served = [
            instance
            for instance in self.mastodon_client.instances
            if instance not in self.mastodon_client.refused
        ]
        if served:
            self.derived_as_of = datetime.now(UTC)
        self.notices = tuple(
            f"{instance} refused anonymous access" for instance in self.mastodon_client.refused
        )
