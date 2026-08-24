"""The shared source vocabulary: rendering a failure a person has to read.

Several httpx exceptions carry no message at all. On the live run of 2026-08-20 that put
``()`` in a log line and ``unreachable: ConnectTimeout: `` on the browser's layer rail, so
the renderer gets its own tests rather than being trusted at each call site.
"""

import httpx
import pytest

from tracker.sources.base import ParsedRecords, RateLimitedError, describe_exception


@pytest.mark.parametrize(
    "exc",
    [
        pytest.param(httpx.ConnectTimeout(""), id="connect timeout"),
        pytest.param(httpx.ReadTimeout(""), id="read timeout"),
        pytest.param(httpx.PoolTimeout(""), id="pool timeout"),
    ],
)
def test_an_exception_with_no_message_still_names_itself(exc: httpx.HTTPError) -> None:
    """These three stringify to the empty string, which is the whole reason for the helper."""
    assert str(exc) == "", "the premise of this test: httpx sent no message"

    rendered = describe_exception(exc)

    assert rendered.strip(), "a reason shown to a person is never empty"
    assert rendered == type(exc).__name__
    assert not rendered.endswith(":"), "no dangling punctuation where there is no message"


def test_a_message_survives_rather_than_being_thrown_away() -> None:
    rendered = describe_exception(httpx.ConnectError("[Errno 61] Connection refused"))

    assert rendered == "ConnectError: [Errno 61] Connection refused"


def test_a_whitespace_only_message_reads_as_no_message() -> None:
    """``\\n`` is not information, and it would leave the same dangling colon."""
    assert describe_exception(httpx.ReadTimeout("  \n ")) == "ReadTimeout"


def test_our_own_errors_keep_their_detail() -> None:
    """A source error already says what happened, so nothing here shortens it."""
    rendered = describe_exception(RateLimitedError("adsb.lol", 420, 60.0))

    assert rendered.startswith("RateLimitedError: adsb.lol: rate limited (HTTP 420)")


def test_a_parse_with_nothing_refused_reports_zero_drops() -> None:
    assert ParsedRecords(records=(1, 2)).dropped == 0
