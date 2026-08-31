"""Console entry point: ``uv run tracker``.

Single worker, deliberately. Every uvicorn worker runs the application lifespan, so a
second worker would start a second copy of every poller and double our request rate
against feeds that are given to us for free. Scaling out needs a cross-process lock on
the pollers first; see ``docs/architecture.md``.
"""

import logging

import uvicorn

from tracker.config import get_settings


def main() -> None:
    """Run the server with the host, port and log level taken from settings."""
    settings = get_settings()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    uvicorn.run(
        "tracker.app:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        workers=1,
        log_level="info",
    )


if __name__ == "__main__":
    main()
