"""Application settings.

Cadences live here rather than in the adapters because they are the thing most likely to
get an upstream to block us, and having them in one file makes that reviewable. The
defaults are the documented safe values for each provider; the minimums enforced in the
adapters are separate and stricter, so a careless override cannot cause a ban.
"""

from functools import lru_cache
from pathlib import Path
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

    # The aircraft layer is a union of providers, per ADR 010. adsb.lol above is the keyless
    # default and today its only live member. The two unfiltered providers the ADR's coverage
    # argument actually rests on are both unreachable and both report themselves unavailable
    # with the reason, exactly like a missing key. airplanes.live is the only one of the two
    # with a host worth configuring, and its gate is an access grant rather than a key. Every
    # cadence floor and every licence position is a constant in sources/adsb.py, never here.

    airplaneslive_base_url: str = "https://api.airplanes.live"
    airplaneslive_access_granted: bool = Field(
        default=False,
        description="Set true once contact@airplanes.live has granted access. There is no "
        "key to check: the provider allowlists a requester after reading a project "
        "description by email, and until then every path answers HTTP 403. So this is the "
        "access gate, and a provider with no access is left out of the union rather than "
        "added and failed every cycle.",
    )
    # No ADS-B Exchange key setting. The blocker there is a redistribution licence rather
    # than a credential, so a key would not clear the provider and a setting could only ever
    # flip /api/capabilities to available for a provider no code path can fetch from, with
    # the licence warning disappearing off the layer rail as it went. The reason lives on the
    # provider row in sources/adsb.py; add a key back in the change that first calls the
    # provider.

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
    kystdatahuset_base_url: str = "https://kystdatahuset.no"
    kystdatahuset_poll_seconds: Seconds = Field(
        default=60.0,
        description="The provider publishes no rate cap, so this is read off the feed: it "
        "serves the last ten minutes of positions, wipes them after twenty, aggregates by "
        "the minute on its companion endpoint and sends 3.7MB with no ETag. The floor is "
        "MIN_INTERVAL_SECONDS in sources/kystdatahuset.py and this value can only ever "
        "slow the feed down.",
    )
    transpordiamet_base_url: str = "https://gis.transpordiamet.ee"
    transpordiamet_poll_seconds: Seconds = Field(
        default=60.0,
        description="The Estonian ArcGIS service publishes no rate cap, so this is read off "
        "the data: report ages ran 84s at the freshest and 148s at the median, so a quicker "
        "poll buys nothing. The floor is MIN_INTERVAL_SECONDS in sources/transpordiamet.py.",
    )
    seaway_base_url: str = "https://vis.seaway.ca"
    seaway_poll_seconds: Seconds = Field(
        default=60.0,
        description="The Seaway GraphQL endpoint publishes no rate cap. Its freshest report "
        "was 119s old and the ten-minute window held 1,664 vessels against 1,537 at five "
        "minutes, so the feed turns over in minutes. The floor is MIN_INTERVAL_SECONDS in "
        "sources/seaway.py.",
    )
    ownership_refresh_seconds: Seconds = Field(
        default=6.0 * 60.0 * 60.0,
        ge=60.0,
        description="How often to attempt an ownership refresh: the FAA register and the SEC "
        "company index. Not a request cadence. The FAA adapter holds its own daily floor "
        "against the mtime of the copy on disk and the company index holds a weekly one, so a "
        "pass inside either window opens no socket at all. Six hours rather than a day for the "
        "reason the city refresh already carries: a refresh that failed at boot with nothing "
        "on disk must retry in hours, not wait out the floor with an empty index.",
    )

    transit_poll_seconds: Seconds = Field(
        default=30.0,
        description="How often to start a sweep of the GTFS-Realtime registry. This is a "
        "cadence, not a floor: the client refuses a host inside its own window, so a fast "
        "host gets 30s while www.data.gouv.fr gets 120s and passio3.com gets 350s. The floors "
        "are per host in sources/gtfsrt.py, because 99 of 258 feeds sit on one public-sector "
        "host and a per-feed floor would take 3.3 requests a second off it.",
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
        default=(
            "stations",
            "visual",
            "weather",
            "science",
            "gps-ops",
            "galileo",
            "glo-ops",
            "goes",
            "resource",
            "sarsat",
            "dmc",
            "tdrss",
            "intelsat",
            "iridium-NEXT",
        ),
        description="Which GP groups to poll, each on its own two-hour floor. Measured "
        "2026-08-20 against the provider chain: these fourteen return 819 objects between "
        "them, which sits inside the browser's propagation budget while covering "
        "recognisable categories rather than anonymous dots. The single most useful group "
        "is visual, 157 satellites bright enough to see with the naked eye. stations "
        "carries the ISS, which is the one object a viewer looks for. "
        "The active list is deliberately excluded: it is 16,400 objects, which is roughly "
        "44ms of SGP4 per frame against a 16.7ms budget at 60fps, so it would stall the "
        "globe rather than fill it. starlink alone is 10,973 for the same reason. "
        "The noaa group is also excluded because it returns zero objects, verified the "
        "same day, so polling it only spends a request to be told nothing.",
    )

    # ------------------------------------------------------------------ city gazetteer

    geonames_cache_dir: Path = Field(
        default=Path(".cache/geonames"),
        description="Where the cities15000 zip and the ETag served with it are kept "
        "between restarts. The only setting the city layer has, and it is the one that "
        "makes the weekly conditional request real rather than decorative: the refresh "
        "floor is enforced in-process, so a run shorter than a week never reaches the "
        "network at all and only a persisted ETag can be sent by the process that does. "
        "Without it every restart re-downloads 3.3MB to be told nothing changed. There is "
        "deliberately no cadence setting to go with it: MIN_REFRESH_INTERVAL_S in "
        "sources/geonames.py is the weekly floor, and configuration may slow a fetch down "
        "and must never speed one up. Nothing gates the layer either, because GeoNames is "
        "keyless.",
    )

    cache_dir: Path = Field(
        default=Path(".cache"),
        description="The one project cache directory. Holds upstream.sqlite3, which is "
        "where response caches and rate-limit floors survive a restart, and it is the "
        "parent of the GeoNames dump directory above. One directory for the project "
        "rather than one per source, because a removal or a reset should have one place "
        "to go. It is created on first write and a run that caches nothing leaves no "
        "file, so a test that builds the app touches no disk. Inside the repo by default, "
        "where .gitignore already covers it: the alternative is a test suite writing into "
        "the developer's home directory, and on this project the checkout is the "
        "deployment. There is no cadence setting here either, for the reason given above: "
        "every floor is a constant in its own adapter. The two directories are independent "
        "settings and only their defaults nest, so overriding this one and not the GeoNames "
        "one splits the project cache across two places and a reset then clears half of it. "
        "The GeoNames dump stays a file rather than a row on purpose: a 3.3MB zip in a "
        "SQLite TEXT column would need base64, and its weekly floor is measured from the "
        "file's own mtime.",
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

    @field_validator(
        "adsb_base_url",
        "adsb_failover_base_url",
        "airplaneslive_base_url",
        "fintraffic_base_url",
        "kystdatahuset_base_url",
        "transpordiamet_base_url",
        "seaway_base_url",
    )
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
    def airplaneslive_available(self) -> bool:
        """Whether airplanes.live has granted us access. False until the email is answered."""
        return self.airplaneslive_access_granted

    @property
    def aishub_available(self) -> bool:
        """Whether an AISHub username is set. False until a physical receiver is accepted."""
        return bool(self.aishub_username)

    @property
    def osm_services_available(self) -> bool:
        """Nominatim and Overpass both require contact details to be set."""
        return bool(self.contact_email)

    @property
    def filings_available(self) -> bool:
        """Whether SEC EDGAR can be called: it requires a declared contact address.

        Not a courtesy and not a rate-limit nicety. Without one EDGAR returns an "Undeclared
        Automated Tool" error instead of data, so an unset contact address is the filings being
        off rather than impolite. Same condition Nominatim and Overpass impose, and like theirs
        it is free to satisfy, which is why the capability reason may name the variable: setting
        it enables something rather than asking the viewer for a credential this project has
        ruled out.

        **This gates the filings and nothing else.** It used to be called
        ``ownership_available`` and gated the whole ownership layer, which switched off the FAA
        register too. The register needs no contact address at all: it is fetched through
        ``cloudscraper`` because ``registry.faa.gov`` answers HTTP 403 from Akamai to any
        descriptive User-Agent, and a bot filter is a different condition from a declared-client
        requirement. One was governing both, so a deployment with no contact address showed no
        registered owner for any aircraft when it could have shown one for every N-register
        airframe on the globe. Degraded and absent are different, and this project draws that
        distinction everywhere else.
        """
        return bool(self.contact_email)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings, read once.

    Cached because ``Settings`` reads ``.env`` from disk. Tests that need different
    values construct ``Settings(...)`` directly and inject it, rather than clearing this
    cache, so they cannot leak state into each other.
    """
    return Settings()
