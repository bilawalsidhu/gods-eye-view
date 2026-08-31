"""The two guarantees ``AppState`` makes about the objects it builds itself.

Everything else on the state is passed in, so ``build_state`` is where it is checked. The social
pair is the exception: the state constructs it, which is what makes it one object per state, and
that construction has a trap in it worth asserting rather than describing.
"""

from pathlib import Path

import httpx
import pytest

from tests.api.test_routes_social import LONDON
from tracker.api.state import AppState
from tracker.app import build_state
from tracker.config import Settings
from tracker.services.gazetteer import CityIndex
from tracker.services.social import SocialClients


@pytest.fixture
def state(tmp_path: Path) -> AppState:
    """A state on a throwaway cache directory. Opens no socket and writes no file."""
    return build_state(Settings(cache_dir=tmp_path), httpx.AsyncClient())


def test_the_social_page_is_one_object_the_removal_can_reach(state: AppState) -> None:
    # The whole reason it moved here. A second copy would let a removal sweep a page nobody
    # reads and report reaching a cache it never touched.
    assert isinstance(state.social, SocialClients)
    assert state.social is state.social
    assert state.social.name == "social derived page"


def test_the_gazetteer_is_read_at_call_time_rather_than_bound_at_startup(state: AppState) -> None:
    """The trap: ``city_index`` is replaced whole by every weekly refresh.

    A resolver built with ``self.city_index.search`` holds a bound method of the *empty* index
    the state starts with, so it would keep answering out of that dead object for the life of
    the process. Nothing would raise: every derived location would simply fail to resolve and
    the Mastodon half of the social layer would go quiet.
    """
    assert state.city_search("London") == ()

    state.city_index = CityIndex((LONDON,))

    found = state.city_search("London")
    assert [city.name for city in found] == ["London"]
