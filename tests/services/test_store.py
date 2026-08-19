"""The live entity store: identity, draining and expiry.

Two behaviours here are load-bearing and easy to break by accident. Draining means an
entity that updated fifty times between flushes is sent once, which is what keeps
bandwidth flat as feed frequency rises. Expiry means an aircraft that has gone quiet
leaves the globe, which is the difference between a live picture and a plausible-looking
lie.
"""

from tests.conftest import FrozenClock, make_aircraft
from tracker.contracts.aircraft import Aircraft
from tracker.services.store import EntityStore, StoreChanges


def _store(ttl_seconds: float = 90.0, clock: FrozenClock | None = None) -> EntityStore[Aircraft]:
    if clock is None:
        return EntityStore(ttl_seconds=ttl_seconds)
    return EntityStore(ttl_seconds=ttl_seconds, clock=clock)


# ---------------------------------------------------------------- upsert and read


def test_upsert_then_snapshot() -> None:
    store = _store()
    aircraft = make_aircraft("3c6444")

    store.upsert("3c6444", aircraft)

    assert store.snapshot() == (aircraft,)
    assert store.get("3c6444") is aircraft
    assert len(store) == 1
    assert "3c6444" in store
    assert store.keys() == frozenset({"3c6444"})


def test_get_of_an_unknown_key_is_none() -> None:
    store = _store()

    assert store.get("nothing") is None
    assert "nothing" not in store
    assert len(store) == 0
    assert store.snapshot() == ()


def test_upsert_of_the_same_key_replaces_rather_than_duplicates() -> None:
    store = _store()
    store.upsert("3c6444", make_aircraft("3c6444", callsign="FIRST"))

    store.upsert("3c6444", make_aircraft("3c6444", callsign="SECOND"))

    assert len(store) == 1
    assert store.snapshot()[0].callsign == "SECOND"


def test_upsert_many_inserts_every_item() -> None:
    store = _store()

    store.upsert_many((a.icao24, a) for a in (make_aircraft("aaaaaa"), make_aircraft("bbbbbb")))

    assert store.keys() == frozenset({"aaaaaa", "bbbbbb"})


def test_upsert_many_of_nothing_is_harmless() -> None:
    store = _store()

    store.upsert_many([])

    assert len(store) == 0
    assert store.take_changes().is_empty


# ---------------------------------------------------------------- take_changes


def test_take_changes_returns_the_upserted_entities() -> None:
    store = _store()
    aircraft = make_aircraft("3c6444")
    store.upsert("3c6444", aircraft)

    changes = store.take_changes()

    assert changes.upserted == (aircraft,)
    assert changes.removed == ()
    assert not changes.is_empty


def test_take_changes_drains() -> None:
    store = _store()
    store.upsert("3c6444", make_aircraft("3c6444"))

    assert len(store.take_changes().upserted) == 1
    assert store.take_changes().is_empty
    assert store.take_changes().upserted == ()

    assert len(store) == 1, "draining changes must not remove the entity itself"


def test_an_entity_updated_five_times_between_flushes_appears_once() -> None:
    """This is what keeps bandwidth flat as a feed's update rate rises."""
    store = _store()
    for index in range(5):
        store.upsert("3c6444", make_aircraft("3c6444", position_age_s=float(index)))

    changes = store.take_changes()

    assert len(changes.upserted) == 1
    assert changes.upserted[0].position_age_s == 4.0, "the latest value must win"


def test_take_changes_reports_several_entities_at_once() -> None:
    store = _store()
    store.upsert("aaaaaa", make_aircraft("aaaaaa"))
    store.upsert("bbbbbb", make_aircraft("bbbbbb"))

    changes = store.take_changes()

    assert {a.icao24 for a in changes.upserted} == {"aaaaaa", "bbbbbb"}


def test_store_changes_is_empty() -> None:
    assert StoreChanges[Aircraft]().is_empty
    assert not StoreChanges(upserted=(make_aircraft(),)).is_empty
    assert not StoreChanges[Aircraft](removed=("3c6444",)).is_empty
    assert not StoreChanges(upserted=(make_aircraft(),), removed=("3c6444",)).is_empty


# ---------------------------------------------------------------- expiry


def test_expire_drops_entities_past_the_ttl(frozen_clock: FrozenClock) -> None:
    store = _store(ttl_seconds=90.0, clock=frozen_clock)
    store.upsert("3c6444", make_aircraft("3c6444"))
    store.take_changes()

    frozen_clock.advance(91.0)
    expired = store.expire()

    assert expired == ("3c6444",)
    assert len(store) == 0
    assert store.get("3c6444") is None


def test_expire_queues_the_dropped_keys_as_removed(frozen_clock: FrozenClock) -> None:
    store = _store(ttl_seconds=90.0, clock=frozen_clock)
    store.upsert("3c6444", make_aircraft("3c6444"))
    store.take_changes()

    frozen_clock.advance(120.0)
    store.expire()
    changes = store.take_changes()

    assert changes.removed == ("3c6444",)
    assert changes.upserted == ()


def test_expire_keeps_entities_inside_the_ttl(frozen_clock: FrozenClock) -> None:
    store = _store(ttl_seconds=90.0, clock=frozen_clock)
    store.upsert("3c6444", make_aircraft("3c6444"))

    frozen_clock.advance(89.0)

    assert store.expire() == ()
    assert len(store) == 1


def test_expire_is_exclusive_at_exactly_the_ttl(frozen_clock: FrozenClock) -> None:
    """An entity exactly at the boundary survives; the comparison is strictly older-than."""
    store = _store(ttl_seconds=90.0, clock=frozen_clock)
    store.upsert("3c6444", make_aircraft("3c6444"))

    frozen_clock.advance(90.0)

    assert store.expire() == ()


def test_expire_drops_only_the_stale_entities(frozen_clock: FrozenClock) -> None:
    store = _store(ttl_seconds=60.0, clock=frozen_clock)
    store.upsert("stale1", make_aircraft("aaaaaa"))

    frozen_clock.advance(50.0)
    store.upsert("fresh1", make_aircraft("bbbbbb"))

    frozen_clock.advance(20.0)
    expired = store.expire()

    assert expired == ("stale1",)
    assert store.keys() == frozenset({"fresh1"})


def test_a_refreshed_entity_does_not_expire(frozen_clock: FrozenClock) -> None:
    store = _store(ttl_seconds=60.0, clock=frozen_clock)
    store.upsert("3c6444", make_aircraft("3c6444"))

    frozen_clock.advance(50.0)
    store.upsert("3c6444", make_aircraft("3c6444"))
    frozen_clock.advance(50.0)

    assert store.expire() == ()
    assert len(store) == 1


def test_expire_drops_a_pending_upsert_so_a_removed_entity_is_not_also_sent(
    frozen_clock: FrozenClock,
) -> None:
    """Sending an upsert and a remove for the same key in one flush is a client-side race."""
    store = _store(ttl_seconds=30.0, clock=frozen_clock)
    store.upsert("3c6444", make_aircraft("3c6444"))

    frozen_clock.advance(31.0)
    store.expire()
    changes = store.take_changes()

    assert changes.upserted == ()
    assert changes.removed == ("3c6444",)


def test_expire_on_an_empty_store_is_harmless() -> None:
    store = _store()

    assert store.expire() == ()


def test_a_key_removed_then_re_upserted_before_a_flush_is_not_reported_as_removed(
    frozen_clock: FrozenClock,
) -> None:
    """An aircraft that briefly went quiet must not flicker off the globe and back on."""
    store = _store(ttl_seconds=30.0, clock=frozen_clock)
    store.upsert("3c6444", make_aircraft("3c6444"))
    store.take_changes()

    frozen_clock.advance(31.0)
    store.expire()
    store.upsert("3c6444", make_aircraft("3c6444", callsign="BACK"))
    changes = store.take_changes()

    assert changes.removed == ()
    assert len(changes.upserted) == 1
    assert changes.upserted[0].callsign == "BACK"


# ---------------------------------------------------------------- replace_all


def test_replace_all_removes_keys_absent_from_the_incoming_set() -> None:
    """``/v2/mil`` returns a complete worldwide picture, so anything absent has gone."""
    store = _store()
    store.upsert_many(
        [
            ("aaaaaa", make_aircraft("aaaaaa")),
            ("bbbbbb", make_aircraft("bbbbbb")),
            ("cccccc", make_aircraft("cccccc")),
        ]
    )
    store.take_changes()

    store.replace_all([("bbbbbb", make_aircraft("bbbbbb")), ("dddddd", make_aircraft("dddddd"))])

    assert store.keys() == frozenset({"bbbbbb", "dddddd"})


def test_replace_all_queues_the_departed_keys_as_removed() -> None:
    store = _store()
    store.upsert_many([("aaaaaa", make_aircraft("aaaaaa")), ("bbbbbb", make_aircraft("bbbbbb"))])
    store.take_changes()

    store.replace_all([("bbbbbb", make_aircraft("bbbbbb", callsign="STAYING"))])
    changes = store.take_changes()

    assert changes.removed == ("aaaaaa",)
    assert {a.icao24 for a in changes.upserted} == {"bbbbbb"}


def test_replace_all_with_nothing_empties_the_store() -> None:
    store = _store()
    store.upsert("aaaaaa", make_aircraft("aaaaaa"))
    store.take_changes()

    store.replace_all([])

    assert len(store) == 0
    assert store.take_changes().removed == ("aaaaaa",)


def test_replace_all_on_an_empty_store_just_inserts() -> None:
    store = _store()

    store.replace_all([("aaaaaa", make_aircraft("aaaaaa"))])

    changes = store.take_changes()
    assert changes.removed == ()
    assert len(changes.upserted) == 1


def test_replace_all_of_an_identical_set_reports_no_removals() -> None:
    store = _store()
    store.upsert("aaaaaa", make_aircraft("aaaaaa"))
    store.take_changes()

    store.replace_all([("aaaaaa", make_aircraft("aaaaaa", callsign="MOVED"))])
    changes = store.take_changes()

    assert changes.removed == ()
    assert changes.upserted[0].callsign == "MOVED"


def test_replace_all_refreshes_the_update_time(frozen_clock: FrozenClock) -> None:
    store = _store(ttl_seconds=60.0, clock=frozen_clock)
    store.upsert("aaaaaa", make_aircraft("aaaaaa"))

    frozen_clock.advance(50.0)
    store.replace_all([("aaaaaa", make_aircraft("aaaaaa"))])
    frozen_clock.advance(50.0)

    assert store.expire() == ()


# ---------------------------------------------------------------- default clock


def test_the_default_clock_is_the_real_one() -> None:
    """Nothing expires immediately when a store is built without an injected clock."""
    store = _store(ttl_seconds=90.0)
    store.upsert("3c6444", make_aircraft("3c6444"))

    assert store.expire() == ()
    assert len(store) == 1


def test_a_zero_ttl_expires_everything_on_the_next_call(frozen_clock: FrozenClock) -> None:
    store = _store(ttl_seconds=0.0, clock=frozen_clock)
    store.upsert("3c6444", make_aircraft("3c6444"))

    frozen_clock.advance(0.001)

    assert store.expire() == ("3c6444",)
