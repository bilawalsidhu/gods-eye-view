"""Synthetic CPU-only Blender import, projection and .blend round-trip check.

blender --background --factory-startup --disable-autoexec --threads 1
  --python tools/blender/check_import.py -- fixture-directory
No renderer or GPU context is requested. All landmarks are synthetic empties.
"""
import importlib.util
import json
from pathlib import Path
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

spec = importlib.util.spec_from_file_location("camera_import", Path(__file__).with_name("camera_import.py"))
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)
args = sys.argv[sys.argv.index("--") + 1:]
if len(args) != 1:
    raise SystemExit("Expected one fixture directory")
directory = Path(args[0])
reference = json.loads((directory / "projection-reference.json").read_text())
original_names = set(bpy.data.scenes.keys())
original_settings = {scene.name: (scene.render.resolution_x, scene.render.resolution_y, scene.frame_end) for scene in bpy.data.scenes}
bpy.context.preferences.filepaths.file_preview_type = 'NONE'


def block(scene, name, center, size):
    """Tiny owned synthetic blockout, so the saved rig has an editable set."""
    x, y, z = center
    sx, sy, sz = [value / 2 for value in size]
    vertices = [(x+dx*sx, y+dy*sy, z+dz*sz) for dx, dy, dz in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    faces = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)


cases = []
for case in reference["cases"]:
    manifest = importer.read_manifest(directory / case["manifest"])
    scene = importer.import_manifest(manifest)
    # All validation occurs before bpy mutation.
    malformed = json.loads(json.dumps(manifest))
    malformed["frames"][-1]["basisColumns"][0] = [2, 0, 0]
    names = set(bpy.data.scenes.keys())
    objects = set(bpy.data.objects.keys())
    try:
        importer.import_manifest(malformed)
        raise AssertionError("Malformed transform was accepted")
    except ValueError:
        assert set(bpy.data.scenes.keys()) == names
        assert set(bpy.data.objects.keys()) == objects
    for index, point in enumerate(case["checks"][0]["points"]):
        landmark = bpy.data.objects.new(f"Synthetic landmark {index}", None)
        landmark.location = point["position"]
        scene.collection.objects.link(landmark)
    block(scene, 'Synthetic ground, no map data', [0, 0, -1], [1400, 1400, 2])
    for index in [0, 6, 9]:
        sample = manifest['frames'][index]
        point = case['checks'][index]['points'][0]['position']
        direction = [(point[i]-sample['position'][i])/100 for i in range(3)]
        distance = -sample['position'][2]/direction[2]
        center = [sample['position'][i]+direction[i]*distance for i in range(2)] + [10]
        block(scene, f'Synthetic block {index}', center, [24, 24, 20])
    cases.append((case, manifest, scene.name))

# JSON may spell an integer-valued number as 1920.0. Blender RNA requires ints.
float_case = dict(reference['cases'][0], name='integer-valued JSON floats')
float_manifest = importer.read_manifest(directory / float_case['manifest'])
for key in ['width', 'height', 'frameEnd']:
    float_manifest['timeline'][key] = float(float_manifest['timeline'][key])
for shot in float_manifest['shots']:
    shot['frameStart'] = float(shot['frameStart'])
float_scene = importer.import_manifest(float_manifest)
cases.append((float_case, float_manifest, float_scene.name))


def check_all():
    max_error = 0.0
    projection_count = 0
    for case, manifest, scene_name in cases:
        scene = bpy.data.scenes[scene_name]
        bpy.context.window.scene = scene
        bpy.context.view_layer.update()
        metadata = json.loads(scene["gev_source"])
        assert metadata["sceneId"] == manifest["source"]["sceneId"]
        assert json.loads(scene["gev_coordinates"]) == manifest["coordinates"]
        assert json.loads(scene["gev_timeline"]) == manifest["timeline"]
        assert scene.frame_start == 1 and scene.frame_end == len(manifest["frames"])
        expected_rate = manifest["timeline"]["fps"]["numerator"] / manifest["timeline"]["fps"]["denominator"]
        assert abs(scene.render.fps / scene.render.fps_base - expected_rate) < 2e-6
        assert scene.unit_settings.scale_length == 1
        assert scene.render.resolution_x == manifest["timeline"]["width"]
        assert scene.render.resolution_y == manifest["timeline"]["height"]
        cameras = {json.loads(obj["gev_shot"])["id"]: obj for obj in scene.objects if "gev_shot" in obj}
        assert set(cameras) == {shot["id"] for shot in manifest["shots"]}
        for shot in manifest["shots"]:
            assert json.loads(cameras[shot["id"]]["gev_shot"]) == shot
        for item in case["checks"]:
            scene.frame_set(item["frame"])
            active = scene.camera
            camera = cameras[item["shotId"]]
            assert active == camera, "Timeline marker selected the wrong camera"
            assert camera.data.sensor_fit == "HORIZONTAL"
            assert abs(camera.data.lens - manifest["camera"]["lensMm"]) < 1e-5
            for point in item["points"]:
                projected = world_to_camera_view(scene, camera, Vector(point["position"]))
                assert projected.z > 0, (case['name'], item['frame'], 'landmark behind camera')
                error = max(abs(projected.x - point["uv"][0]), abs(projected.y - point["uv"][1]))
                max_error = max(error, max_error)
                assert error < 2e-5, (case["name"], item["frame"], error)
                projection_count += 1
    for name in original_names:
        scene = bpy.data.scenes[name]
        assert (scene.render.resolution_x, scene.render.resolution_y, scene.frame_end) == original_settings[name]
    return max_error, projection_count


before_error, count = check_all()
blend = directory / "synthetic-cameras.blend"
if blend.exists():
    raise SystemExit("Synthetic output already exists; choose a fresh fixture directory")
bpy.context.window.scene = bpy.data.scenes[cases[0][2]]
bpy.context.scene.frame_set(1)
for area in bpy.context.screen.areas:
    if area.type == 'VIEW_3D':
        area.spaces.active.region_3d.view_perspective = 'CAMERA'
bpy.ops.wm.save_as_mainfile(filepath=str(blend.resolve()), check_existing=False)
assert blend.stat().st_size > 10000
bpy.ops.wm.open_mainfile(filepath=str(blend.resolve()), load_ui=False, use_scripts=False)
assert bpy.context.scene.name == cases[0][2], 'Demo must reopen on the blockout scene'
after_error, after_count = check_all()
assert after_count == count
receipt = {"state": "BLENDER_CAMERA_PROJECTION_OK", "blenderVersion": bpy.app.version_string, "cases": len(cases), "projectionsBeforeSave": count, "projectionsAfterReload": after_count, "maxUvError": max(before_error, after_error), "rendered": False, "gpuRequested": False, "blend": blend.name}
(directory / "blender-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
