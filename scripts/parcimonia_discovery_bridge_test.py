"""Hermetic metadata boundary tests; real core execution is a separate probe."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from parcimonia_discovery_bridge import validate_request, run_probe


def fixture():
    return {"format": "gods-eye-view/parcimonia-discovery-requests", "version": 1,
            "dataOrigin": "authored_public_fixtures", "requests": [{"features": {
                "body": "earth", "query_shape": "text", "has_proximity": False,
                "result_count": 1, "ambiguous": False, "baseline_route": "text-index",
                "cache_available": False, "source_shape_verified": True,
                "web_explicitly_allowed": False, "locality": "local", "baseline_model_calls": 0}}]}


class MetadataBoundary(unittest.TestCase):
    def test_closed_metadata(self):
        document = fixture()
        self.assertEqual(len(validate_request(document)), 1)
        document["requests"][0]["features"]["source_shape_verified"] = None
        validate_request(document)

    def test_private_fields_refused_before_core_load(self):
        document = fixture()
        document["requests"][0]["features"]["query"] = "PRIVATE"
        with patch("parcimonia_discovery_bridge.load_core") as loader:
            with self.assertRaises(ValueError):
                run_probe(document, Path("unused"))
            loader.assert_not_called()

    def test_no_locality_relaxation_or_unbounded_requests(self):
        for key, value in (("locality", "any"), ("result_count", True), ("result_count", 101),
                           ("has_proximity", "PRIVATE"), ("body", "PRIVATE"), ("baseline_model_calls", 1)):
            document = fixture()
            document["requests"][0]["features"][key] = value
            with self.assertRaises(ValueError):
                validate_request(document)
        document = fixture()
        document["requests"] *= 21
        with self.assertRaises(ValueError):
            validate_request(document)

    def test_missing_explicit_core_has_no_model_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                run_probe(copy.deepcopy(fixture()), Path(directory))


if __name__ == "__main__":
    unittest.main()
