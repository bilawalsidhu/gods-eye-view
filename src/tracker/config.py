"""Application settings.

Cadences live here rather than in the adapters because they are the thing most likely to
get an upstream to block us, and having them in one file makes that reviewable. The
defaults are the documented safe values for each provider; the minimums enforced in the
adapters are separate and stricter, so a careless override cannot cause a ban.
"""

from functools import lru_cache
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Seconds = Annotated[float, Field(gt=0.0)]


class Settings(BaseSettings):
    """Runtime configuration, read from the environment and ``.env``.

    Every credential is optional. The app runs fully keyless, serving aircraft,
    satellites, events and NASA imagery; keyed layers report themselves unavailable
    rather than failing.
    """

    model_config = SettingsConfigDict(
        env_prefix="TRACKER_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
    )

    # ------------------------------------------------------------------ serving

    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    cors_origins: tuple[str, ...] = ("http://127.0.0.1:5173", "http://localhost:5173")

    # ------------------------------------------------------------------ identity

    contact_email: str = Field(
        default="",
        description="Sent in the User-Agent to every upstream. Nominatim, Overpass and "
        "the Wikimedia APIs require contact details in their usage policies; layers "
        "depending on them stay disabled while this is empty.",
    )

    @property
    def user_agent(self) -> str:
        """Descriptive User-Agent, as the OSM and Wikimedia usage policies require."""
        base = "tracker/0.1 (+https://github.com/local/tracker)"
        return f"{base} ({self.contact_email})" if self.contact_email else base

    # ------------------------------------------------------------------ credentials

    aisstream_api_key: str = ""
    windy_api_key: str = ""
    tfl_app_key: str = ""
    cesium_ion_token: str = ""

    # ------------------------------------------------------------------ aircraft feed

    adsb_base_url: str = "https://api.adsb.lol"
    adsb_failover_base_url: str = "https://opendata.adsb.fi/api"
    adsb_poll_seconds: Seconds = Field(
        default=8.0,
        description="adsb.lol publishes no contractual rate limit. Eight seconds is "
        "slower than the roughly five-second aggregation window, so we never poll for "
        "data that has not changed.",
    )
    adsb_radius_nm: int = Field(
        default=250,
        ge=1,
        le=250,
        description="Hard upper bound of the /v2/point endpoint. Requests above 250 are "
        "rejected by the provider.",
    )
    adsb_default_lat: float = Field(default=51.5, ge=-90.0, le=90.0)
    adsb_default_lon: float = Field(default=-0.12, ge=-180.0, le=180.0)

    # ------------------------------------------------------------------ store and fan-out

    entity_ttl_seconds: Seconds = Field(
        default=90.0,
        description="How long an entity survives without a fresh fix before the store "
        "drops it and the hub tells clients to remove it. Roughly ten missed polls, "
        "which tolerates a feed hiccup without leaving ghosts on the globe.",
    )
    broadcast_interval_seconds: Seconds = Field(
        default=1.0,
        description="Hub flush cadence. Clients batch per animation frame regardless, so "
        "pushing faster than this only adds bandwidth.",
    )

    # ------------------------------------------------------------------ HTTP client

    http_timeout_seconds: Seconds = 20.0
    http_max_connections: int = Field(default=32, ge=1)
    http_max_keepalive: int = Field(default=16, ge=1)

    @field_validator("adsb_base_url", "adsb_failover_base_url")
    @classmethod
    def _no_trailing_slash(cls, value: str) -> str:
        """Adapters join paths with an f-string, so a trailing slash would double up."""
        return value.rstrip("/")

    @property
    def ship_layer_available(self) -> bool:
        return bool(self.aisstream_api_key)

    @property
    def camera_layer_available(self) -> bool:
        return bool(self.windy_api_key or self.tfl_app_key)

    @property
    def buildings_layer_available(self) -> bool:
        return bool(self.cesium_ion_token)

    @property
    def osm_services_available(self) -> bool:
        """Nominatim and Overpass both require contact details to be set."""
        return bool(self.contact_email)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings, read once.

    Cached because ``Settings`` reads ``.env`` from disk. Tests that need different
    values construct ``Settings(...)`` directly and inject it, rather than clearing this
    cache, so they cannot leak state into each other.
    """
    return Settings()
