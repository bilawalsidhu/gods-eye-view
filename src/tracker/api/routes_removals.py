"""The removal control: the only write in this application.

AGENTS.md names four things limiting exposure on the people layer and says none is negotiable.
This is the trigger for the fourth. `services/suppression.py` is the mechanism; this is the door.

**It is the first and only non-read endpoint in the product.** Every other route is a GET. The
one thing this application writes is the deletion of a person record, which is worth stating
plainly because it sets the standard for everything below: a route with no precedent to lean on
has to justify each of its own decisions.

**POST, and only POST.** A destructive action must not be reachable by a link, a prefetch, a
crawler or a pasted URL. There is no GET form of this and there must not be one, whatever
convenience argues.

**Loopback is a precondition enforced here rather than documented elsewhere.**
:data:`~tracker.config.Settings.host` defaults to ``127.0.0.1``, so the shipped configuration is
not reachable from a network. Anyone setting it to ``0.0.0.0`` has exposed an unauthenticated
delete, and this project's answer is the route declining rather than a warning in a file nobody
reads. :func:`bound_to_loopback` is that check, and it runs per request rather than at start-up
so that it cannot be true at boot and false later.

**Unauthenticated on loopback, deliberately, and here is the position.** This application has no
authentication anywhere: no users, no sessions, no keys of its own. Inventing a bespoke
credential for one endpoint would be worse than stating the truth, because a single hand-rolled
secret in an app with no auth model is a thing people trust more than it deserves. The honest
arrangement is that the door is only open on the loopback interface of one laptop, which is the
whole deployment AGENTS.md describes, and that **exposing this application on a network needs an
authentication story before this route in particular**. That is recorded as a deployment blocker
in ``docs/status.md`` beside the US privacy position, rather than left implicit here.

**The body cannot carry a name.** The reason is the enumeration from the suppression store, so
there is no free-text field, and ``person_id`` rejects anything containing whitespace because a
``person_id`` never has any and a name almost always does. Neither is a substitute for the
store's own guarantees; both stop a name arriving in the first place.

**Idempotent.** A second removal of the same record answers 200 and says it was already
suppressed. A client retrying after a dropped connection must not have to tell the two apart,
and there is no state in which "already removed" is a failure.

**The response says what it did without saying whose.** A reason, a moment, the per-cache sweep
counts and the total number of suppressions. Nothing attributable, consistent with
:meth:`~tracker.services.suppression.SuppressionStore.suppressions`.
"""

import logging
from ipaddress import ip_address
from typing import Final

from fastapi import APIRouter, HTTPException, status
from pydantic import Field

from tracker.api.state import SettingsDep, StateDep
from tracker.contracts.base import StrictModel, UtcDatetime
from tracker.services.suppression import SuppressionReason

_log = logging.getLogger(__name__)

REMOVALS_PATH: Final = "/api/removals"

LOOPBACK_NAMES: Final = frozenset({"localhost"})
"""Host strings that mean loopback without being addresses.

``localhost`` resolves there on every machine this will run on, and resolving it to check would
make a DNS lookup part of an authorisation decision, which is worse than naming it.

**An empty host is deliberately not in here, and an early version of this had it.** The comment
then read "an empty host is uvicorn's own default binding, which is loopback", and both halves
were wrong: uvicorn's default is ``127.0.0.1``, and an empty string handed to a socket binds to
**all** interfaces. Measured: ``socket.bind(("", 0))`` reports ``('0.0.0.0', ...)``. So an empty
host is the most exposed binding there is, and treating it as loopback would have opened this
route on exactly the configuration it exists to refuse. Caught by the test asserting that a host
this cannot parse is treated as exposed.
"""

NOT_LOOPBACK_REASON: Final = (
    "removals are only accepted when the API is bound to loopback, because this application has "
    "no authentication and a network-reachable removal endpoint is an unauthenticated delete"
)
"""Why the route declined. Said in full, because a bare 403 sends someone looking for a key."""


def bound_to_loopback(host: str) -> bool:
    """Whether this host string means "this machine only".

    Anything that is not demonstrably loopback is treated as not loopback. That is the safe
    direction: a hostname this cannot parse might resolve anywhere, and the failure of guessing
    wrong is an exposed delete.
    """
    stripped = host.strip().lower()
    if stripped in LOOPBACK_NAMES:
        return True
    try:
        return ip_address(stripped).is_loopback
    except ValueError:
        return False


class RemovalRequest(StrictModel):
    """What a caller sends. Neither field can carry a name."""

    person_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^\S+$",
        description=(
            "The record's own key, `sec-{cik}` or `psc-{company}-{id}`. The contract derives it "
            "from the strongest identifier available and never from a name, which is why this "
            "endpoint can take it. Whitespace is refused because a person_id has none and a "
            "name almost always does."
        ),
    )
    reason: SuppressionReason = Field(
        description="Why, from the enumeration. There is deliberately no free-text field."
    )


class CacheSweep(StrictModel):
    """One cache a removal emptied, and how much went.

    The count is not attributable to the person: a sweep cannot know which entries were theirs,
    which is why it is a sweep. It is here so that "did the removal reach everything" has an
    answer.
    """

    cache: str
    entries_cleared: int


class RemovalResponse(StrictModel):
    """What the removal did, in terms that name nobody."""

    suppressed: bool = Field(description="True once the record is suppressed. Never false on 200.")
    already_suppressed: bool = Field(
        description="Whether it was already suppressed before this call. Not a failure."
    )
    reason: SuppressionReason
    suppressed_at: UtcDatetime = Field(
        description="When it was first suppressed, which is when the person asked rather than "
        "when a retry arrived."
    )
    swept: tuple[CacheSweep, ...]
    total_suppressed: int = Field(
        description="How many records are suppressed in total, for the product to show."
    )


router = APIRouter()


@router.post(REMOVALS_PATH, status_code=status.HTTP_200_OK)
async def create_removal(
    state: StateDep,
    settings: SettingsDep,
    body: RemovalRequest,
) -> RemovalResponse:
    """Remove and suppress one person record, at once.

    Both halves in one call, because a removal that only cleared what we hold is undone by the
    next crawl and a suppression that only set a flag reports success while the name is still
    being served.

    Raises:
        HTTPException: 403 when the API is not bound to loopback, with the reason.
    """
    if not bound_to_loopback(settings.host):
        # Refused rather than warned. If someone has exposed this app, the safety has to be in
        # the code path rather than in a document.
        _log.warning("refused a removal: API is bound to %r rather than loopback", settings.host)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NOT_LOOPBACK_REASON)

    # Both fields are required on `AppState`, so there is no "not configured" branch to take
    # and no state in which this route answers 200 having done nothing. An earlier version read
    # them with `getattr` and a `None` fallback, written while the wiring was in another agent's
    # hands, and it named the field `removal` where the state calls it `removals`: the fallback
    # turned that typo into a permanent 503 rather than an AttributeError, so the removal
    # control would have been dead in the product and green in its own tests.
    outcome = state.removals.remove(body.person_id, body.reason)
    return RemovalResponse(
        suppressed=True,
        already_suppressed=outcome.already_suppressed,
        reason=outcome.suppression.reason,
        suppressed_at=outcome.suppression.suppressed_at,
        swept=tuple(CacheSweep(cache=name, entries_cleared=count) for name, count in outcome.swept),
        total_suppressed=len(state.suppression),
    )
