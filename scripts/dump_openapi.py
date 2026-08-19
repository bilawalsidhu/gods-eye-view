"""Write the API's OpenAPI schema to ``openapi.json``.

The committed schema is the contract between backend and frontend. ``pnpm codegen`` turns
it into TypeScript types, and CI regenerates it and fails if the result differs from what
is committed. That is what stops the wire contract drifting: a backend change that alters
a response shape cannot merge without the regenerated schema and the regenerated
TypeScript types coming with it.

Runs without starting a server, so it works offline and in CI.
"""

import json
import sys
from pathlib import Path

from tracker.app import create_app
from tracker.config import Settings

OUTPUT = Path(__file__).resolve().parent.parent / "openapi.json"


def build_schema() -> dict[str, object]:
    """Generate the schema from a fully wired app with no background tasks."""
    app = create_app(Settings(), start_background_tasks=False)
    schema: dict[str, object] = app.openapi()
    return schema


def main() -> int:
    """Write the schema. With ``--check``, verify it matches without writing.

    ``--check`` is what CI uses, so a drifted schema is a failed build rather than a
    silent inconsistency that only shows up as a runtime type error in the browser.
    """
    schema = build_schema()
    rendered = json.dumps(schema, indent=2, sort_keys=True) + "\n"

    if "--check" in sys.argv:
        if not OUTPUT.exists():
            print(f"{OUTPUT.name} is missing. Run: uv run python scripts/dump_openapi.py")
            return 1
        if OUTPUT.read_text() != rendered:
            print(
                f"{OUTPUT.name} is out of date. Run: uv run python scripts/dump_openapi.py "
                "and commit the result (plus regenerated frontend types)."
            )
            return 1
        print(f"{OUTPUT.name} is up to date.")
        return 0

    OUTPUT.write_text(rendered)
    paths = schema.get("paths", {})
    count = len(paths) if isinstance(paths, dict) else 0
    print(f"Wrote {OUTPUT.name} ({count} paths).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
