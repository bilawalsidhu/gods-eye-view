"""Explicit read-only Parcimonia shadow probe; no browser service or model imports.

Captures and hashes the trusted checkout's contracts/router source bytes before
executing them in an isolated package namespace. Does not import package __init__.
Run with python -B to avoid bytecode writes in any checkout.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sys
import types

ROUTES = {"exact-id", "local-cache", "text-index", "web-nearby", "abstain"}
FEATURE_KEYS = {
    "body", "query_shape", "has_proximity", "result_count", "ambiguous",
    "baseline_route", "cache_available", "source_shape_verified",
    "web_explicitly_allowed", "locality", "baseline_model_calls",
}


def validate_request(document: object) -> list[dict]:
    if not isinstance(document, dict) or set(document) != {"format", "version", "dataOrigin", "requests"}:
        raise ValueError("Unexpected request document fields.")
    if document["format"] != "gods-eye-view/parcimonia-discovery-requests" or document["version"] != 1:
        raise ValueError("Unsupported request format.")
    if document["dataOrigin"] not in {"authored_public_fixtures", "observed_lookup_metadata"}:
        raise ValueError("Unsupported data origin.")
    requests = document["requests"]
    if not isinstance(requests, list) or not 1 <= len(requests) <= 20:
        raise ValueError("Expected 1..20 metadata requests.")
    for request in requests:
        if not isinstance(request, dict) or set(request) != {"features"}:
            raise ValueError("Unexpected request fields.")
        features = request["features"]
        if not isinstance(features, dict) or set(features) != FEATURE_KEYS:
            raise ValueError("Only closed discovery metadata features are accepted.")
        if features["body"] not in {"earth", "moon", "mars"} or features["query_shape"] not in {"empty", "exact-id", "text"}:
            raise ValueError("Invalid body or query shape.")
        if features["baseline_route"] not in ROUTES or features["locality"] != "local":
            raise ValueError("Strict local discovery requirements must be retained.")
        if type(features["result_count"]) is not int or not 0 <= features["result_count"] <= 100:
            raise ValueError("Invalid result count.")
        if type(features["baseline_model_calls"]) is not int or features["baseline_model_calls"] != 0:
            raise ValueError("Baseline must not call a model.")
        for key in ("has_proximity", "ambiguous", "cache_available", "web_explicitly_allowed"):
            if type(features[key]) is not bool:
                raise ValueError("Invalid boolean feature.")
        if features["source_shape_verified"] is not None and type(features["source_shape_verified"]) is not bool:
            raise ValueError("Invalid source verification state.")
    return requests


def load_core(root: Path):
    root = root.resolve(strict=True)
    package = root / "src" / "tiberium_ai"
    captured = {}
    for name in ("contracts", "router"):
        source_path = (package / f"{name}.py").resolve(strict=True)
        if not source_path.is_relative_to(root):
            raise ValueError("Core source must remain inside the explicitly selected checkout.")
        captured[name] = source_path.read_bytes()
        if len(captured[name]) > 262144:
            raise ValueError("Core source exceeds probe limit.")
    namespace = "_gev_parcimonia_probe"
    parent = types.ModuleType(namespace)
    parent.__path__ = []
    sys.modules[namespace] = parent
    for name, source in captured.items():
        module_name = f"{namespace}.{name}"
        module = types.ModuleType(module_name)
        module.__package__ = namespace
        sys.modules[module_name] = module
        exec(compile(source, f"<captured-parcimonia/{name}.py>", "exec"), module.__dict__)
    return sys.modules[f"{namespace}.contracts"], sys.modules[f"{namespace}.router"], {
        f"src/tiberium_ai/{name}.py": hashlib.sha256(source).hexdigest()
        for name, source in captured.items()
    }


def run_probe(document: dict, root: Path) -> dict:
    requests = validate_request(document)  # Reject extra/private data before loading code.
    contracts, core, hashes = load_core(root)
    router = core.ShadowRouter()
    decisions = []
    for index, request in enumerate(requests):
        features = request["features"]
        task = contracts.Task(task_id=f"discovery-{index + 1}", kind="public_discovery", inputs=features,
                              risk_class="low", evidence_level="normal", locality="local")
        # Source linkage does not supply calibrated route confidence. All
        # estimates stay unknown, even when local lookup succeeded.
        candidates = [contracts.CandidateRoute(route_id=features["baseline_route"],
                      capability_ids=("public-discovery",), estimated_cost=None,
                      estimated_latency_ms=None, confidence=None)]
        decision = router.propose(task, candidates)
        decisions.append({**asdict(decision), "requirements": {"locality": "local", "risk_class": "low", "evidence_level": "normal"},
                          "confidenceOrigin": "unknown", "permitsAutoAct": False})
    return {"format": "gods-eye-view/parcimonia-discovery-shadow", "version": 1,
            "dataOrigin": document["dataOrigin"], "coreExecuted": True, "mode": "shadow",
            "policyVersion": router.policy_version, "sourceSha256": hashes,
            "modelCalls": 0, "apiCalls": 0, "permitsAutoAct": False,
            "requestCount": len(decisions), "abstentionCount": sum(item["abstained"] for item in decisions),
            "decisions": decisions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Explicit trusted Parcimonia checkout; read-only.")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    raw = args.input.read_bytes()
    if len(raw) > 262144:
        raise ValueError("Request file exceeds 256 KiB.")
    report = run_probe(json.loads(raw), args.root)
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        # Keep evidence in the calling workspace, never in the source checkout.
        destination = args.output.resolve()
        if not destination.is_relative_to(Path.cwd().resolve()) or destination.is_relative_to(args.root.resolve()):
            raise ValueError("Output must remain in the calling workspace outside Parcimonia.")
        destination.write_text(encoded, encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
