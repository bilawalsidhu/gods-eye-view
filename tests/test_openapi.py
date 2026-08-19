"""The committed OpenAPI schema must match the application.

``openapi.json`` is the contract between backend and frontend: ``pnpm codegen`` turns it
into TypeScript types. If it drifts, the browser's types describe an API that no longer
exists, and nothing fails until a user hits the endpoint. This test is the CI gate that
makes a drifted schema a failed build.
"""

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from tests.conftest import REPO_ROOT

SCRIPT_PATH = REPO_ROOT / "scripts" / "dump_openapi.py"
COMMITTED = REPO_ROOT / "openapi.json"

EXPECTED_PATHS = {
    "/api/health",
    "/api/capabilities",
    "/api/aircraft",
    "/api/aircraft/{icao24}",
    "/api/layers",
}


def _load_dump_module() -> ModuleType:
    """Import ``scripts/dump_openapi.py`` by path; ``scripts`` is not an installed package."""
    spec = importlib.util.spec_from_file_location("tracker_dump_openapi", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def dump_module() -> ModuleType:
    return _load_dump_module()


@pytest.fixture(scope="module")
def built_schema(dump_module: ModuleType) -> dict[str, Any]:
    schema: dict[str, Any] = dump_module.build_schema()
    return schema


def test_the_committed_schema_exists() -> None:
    assert COMMITTED.is_file(), "openapi.json must be committed; run scripts/dump_openapi.py"


def test_the_committed_schema_matches_the_app(built_schema: dict[str, Any]) -> None:
    """The same comparison ``scripts/dump_openapi.py --check`` performs in CI."""
    rendered = json.dumps(built_schema, indent=2, sort_keys=True) + "\n"

    assert COMMITTED.read_text() == rendered, (
        "openapi.json is out of date. Run: uv run python scripts/dump_openapi.py "
        "and commit the result plus regenerated frontend types."
    )


def test_the_schema_declares_the_five_expected_paths(built_schema: dict[str, Any]) -> None:
    assert set(built_schema["paths"]) == EXPECTED_PATHS
    assert len(built_schema["paths"]) == 5


def test_the_websocket_route_is_absent_from_the_schema(built_schema: dict[str, Any]) -> None:
    """OpenAPI has no way to describe a WebSocket, so the wire contract covers it instead."""
    assert "/ws" not in built_schema["paths"]


def test_the_aircraft_response_schema_omits_derived_values(
    built_schema: dict[str, Any],
) -> None:
    """Derived values must NOT appear in the schema; the frontend computes them."""
    aircraft = built_schema["components"]["schemas"]["Aircraft"]

    assert "label" not in aircraft["properties"]
    assert "in_emergency" not in aircraft["properties"]
    assert "icao24" in aircraft["required"]


def test_the_schema_names_the_application(built_schema: dict[str, Any]) -> None:
    assert built_schema["info"]["title"] == "Tracker"
    assert built_schema["info"]["version"] == "0.1.0"


def test_check_mode_passes_against_the_committed_file(
    dump_module: ModuleType, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["dump_openapi.py", "--check"])

    assert dump_module.main() == 0
    assert "up to date" in capsys.readouterr().out


def test_check_mode_fails_when_the_committed_file_is_stale(
    dump_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    stale = tmp_path / "openapi.json"
    stale.write_text('{"paths": {}}\n')
    monkeypatch.setattr(dump_module, "OUTPUT", stale)
    monkeypatch.setattr(sys, "argv", ["dump_openapi.py", "--check"])

    assert dump_module.main() == 1
    assert "out of date" in capsys.readouterr().out


def test_check_mode_fails_when_the_file_is_missing(
    dump_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(dump_module, "OUTPUT", tmp_path / "absent.json")
    monkeypatch.setattr(sys, "argv", ["dump_openapi.py", "--check"])

    assert dump_module.main() == 1
    assert "is missing" in capsys.readouterr().out


def test_write_mode_produces_the_committed_content(
    dump_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    target = tmp_path / "openapi.json"
    monkeypatch.setattr(dump_module, "OUTPUT", target)
    monkeypatch.setattr(sys, "argv", ["dump_openapi.py"])

    assert dump_module.main() == 0
    assert "(5 paths)" in capsys.readouterr().out
    assert target.read_text() == COMMITTED.read_text()
