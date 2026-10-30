"""Import camera-only GEV JSON. Python validation needs no Blender installation.

Blender console: import camera_import; camera_import.import_file('/path/camera.json')
CLI: blender --background --factory-startup --disable-autoexec --threads 1
     --python tools/blender/camera_import.py -- camera.json output.blend
No image, geometry, network access or rendering is performed.
"""
import json
import math
from pathlib import Path
import sys

SCHEMA = "gev.camera-manifest.v1"
MAX_BYTES = 64 * 1024 * 1024
MAX_FRAMES = 100000


def _number(value, label, low, high, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label}: expected a finite number")
    if not low <= value <= high or (integer and int(value) != value):
        raise ValueError(f"{label}: outside supported range")
    return int(value) if integer else value


def _text(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise ValueError(f"{label}: expected a nonempty string")
    return value


def _near(actual, expected, label, tolerance=1e-8):
    if not math.isclose(actual, expected, rel_tol=1e-10, abs_tol=tolerance):
        raise ValueError(f"{label}: does not match the declared timing or projection")


def _vector(value, label):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{label}: expected three coordinates")
    for component in value:
        _number(component, label, -100001, 100001)
    return value


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def _frame_at(seconds, rate):
    value = seconds * rate
    return (round(value) if abs(value - round(value)) < 1e-9 else math.ceil(value)) + 1


def validate_manifest(data):
    """Validate the complete data before importing bpy or mutating a scene."""
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise ValueError("Unsupported GEV camera manifest schema")
    source = data["source"]
    _text(source["sceneId"], "scene ID")
    if source.get("sampling") != "director-seek-authored-timing":
        raise ValueError("Unsupported camera sampling semantics")
    coordinates = data["coordinates"]
    required = {"units": "meters", "axes": "east-north-up", "heightDatum": "WGS84-ellipsoid", "cameraAxes": "X-right,Y-up,-Z-forward"}
    if any(coordinates.get(key) != value for key, value in required.items()):
        raise ValueError("Explicit ENU meters, WGS84 ellipsoid and Blender camera axes required")
    origin = coordinates["origin"]
    for key, low, high in [("lat", -90, 90), ("lon", -180, 180), ("height", -12000, 1e9)]:
        _number(origin[key], f"origin.{key}", low, high)
    timeline = data["timeline"]
    fps = timeline["fps"]
    for key in ["numerator", "denominator"]:
        _number(fps[key], f"fps.{key}", 1, 1000000, integer=True)
    rate = _number(fps["numerator"] / fps["denominator"], "fps", 1, 240)
    for key in ["width", "height"]:
        _number(timeline[key], key, 4, 16384, integer=True)
    if timeline["pixelAspect"] != [1, 1] or any(isinstance(value, bool) for value in timeline["pixelAspect"]):
        raise ValueError("Only square pixels are supported")
    if timeline["frameStart"] != 1 or isinstance(timeline["frameStart"], bool):
        raise ValueError("Timeline must start at frame 1")
    count = _number(timeline["frameEnd"], "frameEnd", 1, MAX_FRAMES, integer=True)
    _number(timeline["durationSec"], "durationSec", 0, 100000)
    if count != _frame_at(timeline["durationSec"], rate) - 1:
        raise ValueError("Frame count differs from declared duration and fps")
    camera = data["camera"]
    if camera["projection"] != "perspective" or camera["sensorFit"] != "HORIZONTAL":
        raise ValueError("Only a perspective horizontal-sensor camera is supported")
    sensor = _number(camera["sensorWidthMm"], "sensorWidthMm", 1, 100)
    hfov = _number(camera["horizontalFovRadians"], "horizontalFovRadians", math.pi/180, math.pi*179/180)
    lens = _number(camera["lensMm"], "lensMm", 1, 10000)
    _near(lens, sensor / (2 * math.tan(hfov / 2)), "lens")
    _near(_number(camera["verticalFovRadians"], "verticalFovRadians", 0, math.pi), 2 * math.atan(math.tan(hfov / 2) * timeline["height"] / timeline["width"]), "vertical FOV")
    shots = data["shots"]
    if not isinstance(shots, list) or not 1 <= len(shots) <= count:
        raise ValueError("Expected bounded nonempty shots")
    ids = set()
    elapsed = 0
    rounding = 0
    for shot in shots:
        shot_id = _text(shot["id"], "shot ID")
        if shot_id in ids:
            raise ValueError("Duplicate shot ID")
        ids.add(shot_id)
        for key in ["startTimeSec", "endTimeSec", "durationSec", "holdSec"]:
            _number(shot[key], key, 0, 100000)
        if shot["durationSec"] <= 0:
            raise ValueError("Shot duration must be positive")
        _near(shot["startTimeSec"], elapsed, "shot start")
        increment = shot["durationSec"] + shot["holdSec"] - rounding
        next_time = elapsed + increment
        rounding = next_time - elapsed - increment
        elapsed = next_time
        _near(shot["endTimeSec"], elapsed, "shot end")
        for key, expected in [("frameStart", _frame_at(shot["startTimeSec"], rate)), ("frameEndExclusive", _frame_at(elapsed, rate))]:
            _number(shot[key], key, 1, count + 1, integer=True)
            if shot[key] != expected:
                raise ValueError("Shot frame boundaries do not match timing")
        if shot["frameStart"] >= shot["frameEndExclusive"]:
            raise ValueError("Shot has no sampled frames")
    _near(elapsed, timeline["durationSec"], "total duration")
    frames = data["frames"]
    if not isinstance(frames, list) or len(frames) != count:
        raise ValueError("Frame count differs from frame samples")
    shot_index = 0
    for index, sample in enumerate(frames, start=1):
        if sample["frame"] != index or isinstance(sample["frame"], bool):
            raise ValueError("Frames must be sequential integers starting at 1")
        _near(_number(sample["timeSec"], "timeSec", 0, 100000), (index - 1) * fps["denominator"] / fps["numerator"], "sample time")
        while index >= shots[shot_index]["frameEndExclusive"] and shot_index < len(shots) - 1:
            shot_index += 1
        if sample["shotId"] != shots[shot_index]["id"]:
            raise ValueError("Sample references the wrong shot")
        location = _vector(sample["position"], "position")
        if _dot(location, location) > 100000**2 + 0.01:
            raise ValueError("Camera exceeds 100 km local-origin limit")
        basis = sample["basisColumns"]
        if not isinstance(basis, list) or len(basis) != 3:
            raise ValueError("Expected three camera basis columns")
        x, y, z = [_vector(column, "basis") for column in basis]
        for column in [x, y, z]:
            _near(_dot(column, column), 1, "unit camera axis", 1e-6)
        for a, b in [(x, y), (y, z), (z, x)]:
            _near(_dot(a, b), 0, "orthogonal camera axes", 1e-6)
        _near(_dot(_cross(x, y), z), 1, "right-handed camera basis", 1e-6)
    return data


def read_manifest(path):
    """Read bounded JSON only. No imports, URLs or expressions are evaluated."""
    with Path(path).open("rb") as stream:
        payload = stream.read(MAX_BYTES + 1)
    if len(payload) > MAX_BYTES:
        raise ValueError("Camera manifest exceeds 64 MiB")
    return validate_manifest(json.loads(payload))


def import_manifest(data):
    """Create a new scene with editable per-shot cameras; preserve existing scenes."""
    validate_manifest(data)
    import bpy
    from mathutils import Matrix, Vector

    scene = bpy.data.scenes.new(f"GEV {data['source'].get('sceneTitle') or data['source']['sceneId']}")
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    timeline = data["timeline"]
    rate = timeline["fps"]["numerator"] / timeline["fps"]["denominator"]
    scene.render.fps = round(rate)
    scene.render.fps_base = round(rate) / rate
    scene.render.resolution_x = int(timeline["width"])
    scene.render.resolution_y = int(timeline["height"])
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1.0
    scene.frame_start = 1
    scene.frame_end = int(timeline["frameEnd"])
    scene["gev_schema"] = SCHEMA
    scene["gev_source"] = json.dumps(data["source"], ensure_ascii=False)
    scene["gev_coordinates"] = json.dumps(data["coordinates"], ensure_ascii=False)
    scene["gev_timeline"] = json.dumps(timeline)
    root = bpy.data.objects.new("GEV ENU origin", None)
    scene.collection.objects.link(root)
    cameras = {}
    for shot in data["shots"]:
        camera_data = bpy.data.cameras.new(f"GEV {shot['id']}")
        camera_data.type = "PERSP"
        camera_data.sensor_fit = "HORIZONTAL"
        camera_data.sensor_width = data["camera"]["sensorWidthMm"]
        camera_data.lens = data["camera"]["lensMm"]
        camera_data.clip_start = 0.01
        camera_data.clip_end = 200000
        camera = bpy.data.objects.new(f"GEV {shot['id']}", camera_data)
        camera.rotation_mode = "QUATERNION"
        camera.parent = root
        camera["gev_shot"] = json.dumps(shot, ensure_ascii=False)
        camera["gev_scene_id"] = data["source"]["sceneId"]
        scene.collection.objects.link(camera)
        cameras[shot["id"]] = camera
        marker = scene.timeline_markers.new(f"GEV {shot['id']}", frame=int(shot["frameStart"]))
        marker.camera = camera
    previous = {}
    for sample in data["frames"]:
        camera = cameras[sample["shotId"]]
        # Manifest vectors are columns, while mathutils.Matrix accepts rows.
        basis = Matrix(sample["basisColumns"]).transposed()
        rotation = basis.to_quaternion().normalized()
        old = previous.get(sample["shotId"])
        if old is not None and rotation.dot(old) < 0:
            rotation.negate()
        previous[sample["shotId"]] = rotation.copy()
        camera.location = Vector(sample["position"])
        camera.rotation_quaternion = rotation
        camera.keyframe_insert(data_path="location", frame=sample["frame"])
        camera.keyframe_insert(data_path="rotation_quaternion", frame=sample["frame"])
    # Blender defaults to Bezier, which would alter motion between sampled frames.
    for camera in cameras.values():
        action = camera.animation_data.action
        if hasattr(action, "layers") and action.layers:
            for layer in action.layers:
                for strip in layer.strips:
                    bag = strip.channelbag(camera.animation_data.action_slot)
                    for curve in bag.fcurves if bag else []:
                        for key in curve.keyframe_points:
                            key.interpolation = "LINEAR"
        else:
            for curve in action.fcurves:
                for key in curve.keyframe_points:
                    key.interpolation = "LINEAR"
    scene.camera = cameras[data["shots"][0]["id"]]
    if bpy.context.window:
        bpy.context.window.scene = scene
    scene.frame_set(1)
    return scene


def import_file(path):
    """Import a camera JSON file into a new Blender scene without rendering."""
    return import_manifest(read_manifest(path))


def new_blend_output(path):
    """Require Blender's final extension before checking overwrite protection."""
    output = Path(path).resolve()
    if output.suffix != '.blend':
        raise ValueError('Output must end in lowercase .blend')
    if output.exists():
        raise FileExistsError('Output already exists; choose a new .blend path')
    return output


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) != 2:
        raise SystemExit("Usage: blender --background --factory-startup --disable-autoexec --threads 1 --python camera_import.py -- camera.json output.blend")
    output = new_blend_output(args[1])
    import_file(args[0])
    import bpy
    preview = bpy.context.preferences.filepaths.file_preview_type
    try:
        bpy.context.preferences.filepaths.file_preview_type = 'NONE'
        bpy.ops.wm.save_as_mainfile(filepath=str(output.resolve()), check_existing=False)
    finally:
        bpy.context.preferences.filepaths.file_preview_type = preview
    print("CAMERA_IMPORT_OK")
