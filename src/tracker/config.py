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
    aishub_username: str = Field(
        default="",
        description="AISHub grants API access only to members streaming raw NMEA from a "
        "physical AIS receiver, so this is empty until an antenna is sited and accepted. "
        "Blank means the provider is left out of the vessel union entirely and reports "
        "itself unavailable, rather than being called and failing every cycle.",
    )
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

    # ------------------------------------------------------------------ vessel feeds

    fintraffic_base_url: str = "https://meri.digitraffic.fi"
    digitraffic_user: str = Field(
        default="",
        description="Value for the Digitraffic-User header the provider asks every API "
        "user to send. Blank omits the header rather than sending an empty one, and the "
        "provider then caps the IP at 60 requests a minute. The wiring falls back to the "
        "User-Agent so a deployment that sets contact_email identifies itself anyway.",
    )
    fintraffic_poll_seconds: Seconds = Field(
        default=60.0,
        description="The provider caches for 60 seconds, so a shorter cycle returns the "
        "same body. The floor is MIN_INTERVAL_SECONDS in sources/fintraffic.py and this "
        "value can only ever slow the feed down.",
    )
    fintraffic_window_seconds: Seconds = Field(
        default=600.0,
        description="How far back the positions query reaches. Ten minutes keeps a ship "
        "that reports slowly on the globe between polls. Clamped up to the cadence floor "
        "in the client, so it can be widened and never narrowed.",
    )
    aishub_poll_seconds: Seconds = Field(
        default=60.0,
        description="AISHub answers an over-frequent call with an empty body, and states "
        "once a minute. The floor is MIN_INTERVAL_SECONDS in sources/aishub.py.",
    )
    aishub_interval_minutes: int = Field(
        default=10,
        ge=1,
        description="Caps the age of the positions AISHub returns, which is what keeps a "
        "worldwide poll cheap.",
    )
    aisstream_bbox_west: float = Field(
        default=1.0,
        ge=-180.0,
        le=180.0,
        description="West edge of the aisstream.io subscription. The four edges default "
        "to the southern North Sea and Channel approaches, which is dense real shipping. "
        "The provider rejects a subscription with no box and warns that a global box "
        "averages 300 messages a second.",
    )
    aisstream_bbox_south: float = Field(default=51.0, ge=-90.0, le=90.0)
    aisstream_bbox_east: float = Field(default=8.0, ge=-180.0, le=180.0)
    aisstream_bbox_north: float = Field(default=58.0, ge=-90.0, le=90.0)
    aisstream_reconnect_seconds: Seconds = Field(
        default=1.0,
        description="Base reconnect delay. Floored at MIN_RECONNECT_DELAY_SECONDS in "
        "sources/aisstream.py, because a reconnect sends a subscribe frame and the "
        "provider caps subscription updates at one a second.",
    )

    # ------------------------------------------------------------------ satellite feed

    celestrak_poll_seconds: Seconds = Field(
        default=21600.0,
        description="Six hours. CelesTrak updates GP data every two, so this fetches a "
        "fresh element set without approaching the floor. The floor is MIN_GROUP_INTERVAL_S "
        "in sources/celestrak.py and is not configurable.",
    )
    celestrak_groups: tuple[str, ...] = Field(
        default=("stations",),
        description="Which GP groups to poll, each on its own two-hour floor. The active "
        "list is 4 to 6 MB per refresh and CelesTrak names it as specifically rate "
        "enforced, so stations is the default.",
    )

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

    @field_validator("adsb_base_url", "adsb_failover_base_url", "fintraffic_base_url")
    @classmethod
    def _no_trailing_slash(cls, value: str) -> str:
        """Adapters join paths with an f-string, so a trailing slash would double up."""
        return value.rstrip("/")

    @property
    def aisstream_available(self) -> bool:
        """Whether the aisstream.io key is set, which global vessel coverage needs.

        Not the same question as whether the vessel layer runs. Fintraffic Digitraffic is
        keyless, so the layer serves without this and covers the Baltic only.
        """
        return bool(self.aisstream_api_key)

    @property
    def aishub_available(self) -> bool:
        """Whether an AISHub username is set. False until a physical receiver is accepted."""
        return bool(self.aishub_username)

    @property
    def camera_layer_available(self) -> bool:
        """Whether at least one camera provider key is set."""
        return bool(self.windy_api_key or self.tfl_app_key)

    @property
    def buildings_layer_available(self) -> bool:
        """Whether the Cesium ion token is set, which the buildings tileset needs."""
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
