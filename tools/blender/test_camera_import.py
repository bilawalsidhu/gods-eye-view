"""Data validation checks. Standard Python only; no Blender or rendering required."""
import copy
import importlib.util
import math
from pathlib import Path
import sys
import tempfile
import unittest

module_path = Path(__file__).with_name("camera_import.py")
if module_path.exists():
    spec = importlib.util.spec_from_file_location("camera_import", module_path)
    importer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(importer)
else:
    importer = None


def fixture():
    return {
        "schema": "gev.camera-manifest.v1",
        "source": {"sceneId": "scene", "sceneTitle": "Fixture", "sampling": "director-seek-authored-timing", "attributions": []},
        "coordinates": {"units": "meters", "axes": "east-north-up", "heightDatum": "WGS84-ellipsoid", "origin": {"lat": 0, "lon": 0, "height": 0}, "cameraAxes": "X-right,Y-up,-Z-forward"},
        "camera": {"projection": "perspective", "sensorFit": "HORIZONTAL", "sensorWidthMm": 36, "lensMm": 18, "horizontalFovRadians": math.pi / 2, "verticalFovRadians": math.pi / 2},
        "timeline": {"fps": {"numerator": 30, "denominator": 1}, "width": 100, "height": 100, "pixelAspect": [1, 1], "frameStart": 1, "frameEnd": 1, "durationSec": 1 / 30},
        "shots": [{"id": "north", "title": "North", "startTimeSec": 0, "endTimeSec": 1 / 30, "durationSec": 1 / 30, "holdSec": 0, "frameStart": 1, "frameEndExclusive": 2}],
        "frames": [{"frame": 1, "timeSec": 0, "shotId": "north", "position": [0, 0, 0], "basisColumns": [[1, 0, 0], [0, 0, 1], [0, -1, 0]]}],
    }


class ValidationTests(unittest.TestCase):
    def test_validator_exists(self):
        self.assertIsNotNone(importer, "camera importer is missing")

    def test_valid_manifest_is_not_mutated_and_does_not_import_bpy(self):
        data = fixture()
        before = copy.deepcopy(data)
        importer.validate_manifest(data)
        self.assertEqual(data, before)
        self.assertNotIn("bpy", sys.modules)

    def test_rejects_datum_axes_lens_fps_and_timing_mismatches(self):
        mutations = [
            lambda m: m.update(schema="other"),
            lambda m: m["coordinates"].update(heightDatum="MSL"),
            lambda m: m["coordinates"].update(axes="north-east-down"),
            lambda m: m["camera"].update(lensMm=35),
            lambda m: m["camera"].update(lensMm=0.5),
            lambda m: m["camera"].update(verticalFovRadians=1),
            lambda m: m["timeline"]["fps"].update(denominator=0),
            lambda m: m["timeline"].update(frameEnd=2),
            lambda m: m["timeline"].update(width=1),
            lambda m: m["timeline"].update(pixelAspect=[2, 1]),
            lambda m: m["frames"][0].update(frame=2),
            lambda m: m["frames"][0].update(timeSec=1),
            lambda m: m["frames"][0].update(shotId="missing"),
            lambda m: m["shots"][0].update(frameStart=2),
            lambda m: m["shots"][0].update(endTimeSec=2),
            lambda m: m["frames"][0].update(position=[100001, 0, 0]),
            lambda m: m["frames"][0].update(position=[False, 0, 0]),
            lambda m: m["frames"][0].update(position=[math.nan, 0, 0]),
            lambda m: m["frames"][0].update(basisColumns=[[1, 0, 0], [1, 0, 0], [0, 0, 1]]),
            lambda m: m["frames"][0].update(basisColumns=[[-1, 0, 0], [0, 0, 1], [0, -1, 0]]),
        ]
        for mutate in mutations:
            data = fixture()
            mutate(data)
            with self.subTest(mutation=mutations.index(mutate)):
                with self.assertRaises((ValueError, TypeError, KeyError)):
                    importer.validate_manifest(data)

    def test_output_extension_is_checked_before_existing_file_guard(self):
        with tempfile.TemporaryDirectory(prefix='gev-blender-output-') as directory:
            output = Path(directory) / 'camera.blend'
            output.write_bytes(b'existing file must survive')
            with self.assertRaises(ValueError):
                importer.new_blend_output(Path(directory) / 'camera')
            with self.assertRaises(FileExistsError):
                importer.new_blend_output(output)
            with self.assertRaises(ValueError):
                importer.new_blend_output(Path(directory) / 'new.BLEND')
            self.assertEqual(output.read_bytes(), b'existing file must survive')
            self.assertEqual(importer.new_blend_output(Path(directory) / 'new.blend').name, 'new.blend')


if __name__ == "__main__":
    result = unittest.main(exit=False)
    if result.result.wasSuccessful():
        print("IMPORT_VALIDATION_OK")
    else:
        sys.exit(1)
