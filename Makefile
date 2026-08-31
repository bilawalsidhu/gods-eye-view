.PHONY: install dev test lint fix typecheck verify schema

install:
	uv sync
	cd frontend && pnpm install

dev:
	uv run tracker

test:
	uv run pytest -m "not live"

lint:
	uv run ruff check .
	uv run ruff format --check .

fix:
	uv run ruff check --fix .
	uv run ruff format .

# ty first because it is the fast one, so an obvious mistake surfaces in under a second.
# mypy is the gate: it catches constructor errors on generic pydantic models that ty misses.
typecheck:
	uv run ty check
	uv run mypy

# The full gate, same checks CI runs.
verify: lint typecheck test
	uv run python scripts/dump_openapi.py --check
	cd frontend && pnpm verify

schema:
	uv run python scripts/dump_openapi.py
	cd frontend && pnpm codegen
