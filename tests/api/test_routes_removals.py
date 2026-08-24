"""The removal route.

This is the only endpoint in the application that writes anything, and the thing it writes is
the deletion of a person record. So most of this file is about the refusals: the loopback
precondition, the absence of a GET form, and the two ways a name could arrive in the body.

The response tests exist to hold one property that is easy to lose in a refactor: what comes
back says what happened and never says whose.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from tracker.api import routes_removals
from tracker.api.routes_removals import REMOVALS_PATH, bound_to_loopback
from tracker.api.state import get_settings_dep, get_state
from tracker.cache import DiskCache
from tracker.services.suppression import RemovalService, SuppressionStore

PERSON = "sec-0001214128"
NAME = "Undersby David L"


@dataclass
class FakeSettings:
    host: str = "127.0.0.1"


@dataclass
class FakeCache:
    name: str
    entries: int = 2

    def forget_all(self) -> int:
        gone, self.entries = self.entries, 0
        return gone


@dataclass
class FakeState:
    """Only what the route reads. Field names matter: they are the state's, not this test's.

    ``removals`` rather than ``removal`` because that is what ``AppState`` calls it. An earlier
    version of the route read it with ``getattr(state, "removal", None)`` while the wiring sat in
    another agent's file, and the fallback turned the mismatch into a permanent 503 instead of an
    AttributeError, so the removal control would have been dead in the product with this file
    green. Plain attribute access is what makes mypy the check.
    """

    suppression: SuppressionStore
    removals: RemovalService


def build(tmp_path: Path, *, host: str = "127.0.0.1") -> tuple[FastAPI, SuppressionStore]:
    store = SuppressionStore(DiskCache(tmp_path), tmp_path)
    app = FastAPI()
    app.include_router(routes_removals.router)
    settings = FakeSettings(host=host)
    app.dependency_overrides[get_settings_dep] = lambda: settings
    service = RemovalService(store, (FakeCache("media proxy"), FakeCache("adsbdb owners", 1)))
    state = FakeState(suppression=store, removals=service)
    app.dependency_overrides[get_state] = lambda: state
    return app, store


async def post(app: FastAPI, **body: Any) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://tests.invalid"
    ) as client:
        return await client.post(REMOVALS_PATH, json=body)


class TestBoundToLoopback:
    """The precondition, decided in code."""

    @pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.5", "::1", "localhost", "LOCALHOST"])
    def test_loopback_is_recognised(self, host: str) -> None:
        assert bound_to_loopback(host) is True

    @pytest.mark.parametrize(
        "host",
        [
            "0.0.0.0",  # noqa: S104 - the string this route exists to refuse
            "192.168.1.10",
            "::",
            "example.invalid",
            "10.0.0.1",
            "",  # an empty host binds to all interfaces, verified with socket.bind
        ],
    )
    def test_anything_else_is_not(self, host: str) -> None:
        # `0.0.0.0` is the one that matters: it is what somebody types to make the app reachable,
        # and it is exactly when this route must stop working.
        assert bound_to_loopback(host) is False

    def test_an_unparseable_host_is_treated_as_exposed(self) -> None:
        # The safe direction. A hostname this cannot parse might resolve anywhere, and the cost
        # of guessing wrong is an unauthenticated delete reachable from a network.
        assert bound_to_loopback("not a host at all") is False
        assert bound_to_loopback("  ") is False


class TestRefusals:
    """What the route will not do."""

    async def test_it_refuses_when_the_api_is_not_on_loopback(self, tmp_path: Path) -> None:
        app, store = build(tmp_path, host="0.0.0.0")  # noqa: S104 - the point of the test

        response = await post(app, person_id=PERSON, reason="requested_by_subject")

        assert response.status_code == 403
        assert "no authentication" in response.json()["detail"]
        # And nothing happened. A refusal that still suppressed would be worse than either.
        assert store.is_suppressed(PERSON) is False

    async def test_there_is_no_get_form(self, tmp_path: Path) -> None:
        # A destructive action must not be reachable by a link, a prefetch or a crawler.
        app, _ = build(tmp_path)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://tests.invalid"
        ) as client:
            assert (await client.get(REMOVALS_PATH)).status_code == 405

    async def test_a_name_cannot_be_sent_as_the_reason(self, tmp_path: Path) -> None:
        # The enumeration is the whole defence: there is no free-text field for a helpful
        # operator to write "removed after the Undersby complaint" into.
        app, _ = build(tmp_path)
        response = await post(app, person_id=PERSON, reason=NAME)
        assert response.status_code == 422

    async def test_a_name_cannot_be_sent_as_the_identifier(self, tmp_path: Path) -> None:
        # Not the store's guarantee, which hashes whatever it gets, but a second line: a
        # person_id has no whitespace and a name almost always does.
        app, _ = build(tmp_path)
        response = await post(app, person_id=NAME, reason="requested_by_subject")
        assert response.status_code == 422

    async def test_an_unknown_field_is_refused(self, tmp_path: Path) -> None:
        # StrictModel forbids extras, so a caller inventing `note="..."` fails rather than
        # having it quietly ignored, which is how a free-text name would arrive.
        app, _ = build(tmp_path)
        response = await post(
            app, person_id=PERSON, reason="requested_by_subject", note="the Undersby request"
        )
        assert response.status_code == 422


class TestRemoving:
    """What it does when it does it."""

    async def test_it_suppresses_and_sweeps_in_one_call(self, tmp_path: Path) -> None:
        app, store = build(tmp_path)

        response = await post(app, person_id=PERSON, reason="requested_by_subject")
        body = response.json()

        assert response.status_code == 200
        assert body["suppressed"] is True
        assert body["already_suppressed"] is False
        assert store.is_suppressed(PERSON) is True
        assert body["swept"] == [
            {"cache": "media proxy", "entries_cleared": 2},
            {"cache": "adsbdb owners", "entries_cleared": 1},
        ]

    async def test_it_takes_effect_before_the_response_is_written(self, tmp_path: Path) -> None:
        # No queue and no human step. By the time a caller has an answer, it is done.
        app, store = build(tmp_path)
        await post(app, person_id=PERSON, reason="requested_by_subject")
        assert store.is_suppressed(PERSON) is True

    async def test_removing_twice_succeeds_and_says_which(self, tmp_path: Path) -> None:
        # A client retrying after a dropped connection must not have to tell the two apart, and
        # there is no state in which "already removed" is a failure.
        app, _ = build(tmp_path)
        first = await post(app, person_id=PERSON, reason="requested_by_subject")
        second = await post(app, person_id=PERSON, reason="requested_by_subject")

        assert (first.status_code, second.status_code) == (200, 200)
        assert first.json()["already_suppressed"] is False
        assert second.json()["already_suppressed"] is True
        # The moment that matters is when the person asked, not when the retry arrived.
        assert first.json()["suppressed_at"] == second.json()["suppressed_at"]

    async def test_the_response_names_nobody(self, tmp_path: Path) -> None:
        # The property that is easy to lose in a refactor: a response is a place an identifier
        # gets echoed back for convenience, and this one must not.
        app, _ = build(tmp_path)
        response = await post(app, person_id=PERSON, reason="requested_by_subject")

        assert PERSON not in response.text
        assert "0001214128" not in response.text

    async def test_the_total_is_reported_for_the_product_to_show(self, tmp_path: Path) -> None:
        app, _ = build(tmp_path)
        await post(app, person_id=PERSON, reason="requested_by_subject")
        second = await post(app, person_id="sec-0000320193", reason="reported_in_product")
        assert second.json()["total_suppressed"] == 2

    @pytest.mark.parametrize(
        "reason", ["requested_by_subject", "reported_in_product", "operator_removed"]
    )
    async def test_every_reason_in_the_enumeration_is_accepted(
        self, tmp_path: Path, reason: str
    ) -> None:
        app, _ = build(tmp_path)
        response = await post(app, person_id=PERSON, reason=reason)
        assert response.status_code == 200
        assert response.json()["reason"] == reason


def test_the_route_is_the_only_write_in_this_module() -> None:
    # Asserted rather than trusted: a GET added here later would be reachable by a link, and the
    # whole argument for POST-only rests on there being no other verb.
    methods = {method for route in routes_removals.router.routes for method in route.methods}  # type: ignore[attr-defined]  # ty: ignore[unresolved-attribute]
    assert methods == {"POST"}


def test_the_timestamp_is_when_the_person_asked(tmp_path: Path) -> None:
    # Not when the retry arrived, and not when the response was written.
    fixed = datetime(2026, 8, 24, 3, 0, tzinfo=UTC)
    store = SuppressionStore(DiskCache(tmp_path), tmp_path, clock=lambda: fixed)
    assert store.suppress(PERSON, "requested_by_subject").suppressed_at == fixed
