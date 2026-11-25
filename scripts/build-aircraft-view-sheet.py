"""Bake shaded aircraft sprites from the fleet models.

    blender -b --factory-startup --python scripts/build-aircraft-view-sheet.py -- --out <dir> [--only airliner,light]

Writes aircraft-views.png and aircraft-views.json in --out. The npm script
build:aircraft-views encodes the PNG as lossless WebP and writes the manifest
to src/data/aircraftViews.json, which the app imports. The models face -X,
with +Y starboard and +Z up. Helicopter frames share one scale based on the
farthest point each vertex reaches over its rotor sweep.
The layout and frame maths are described in src/data/viewSheet.js.
"""

import json
import math
import os
import struct
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

# The sheet's layout. Only here: the manifest written below carries it to the app.
RING_STEP_DEG = 7.5
# Frames in each ring, from dead ahead round starboard to dead astern.
RINGS = [1, 4, 7, 10, 13, 16, 18, 20, 22, 23, 24, 25, 25, 25, 24, 23, 22]
FRAMES = sum(RINGS)
COLUMNS = 64
CELL_PX = 64
SUPERSAMPLE = 4
SAMPLES = 48
# How much of a cell the model's bounding sphere spans.
FILL = 0.92

# Copy of ROTOR_ANGLES_DEG in src/data/aircraftIcons.js. Keep them equal.
ROTOR_ANGLES_DEG = [15, 45, 75]
# Each class's model in sheet order. Helicopters use one block per rotor frame.
SUBJECTS = [
    ("airliner", "aircraft/a320.glb", None),
    ("widebody", "aircraft/b789.glb", None),
    ("quadjet", "aircraft/b744.glb", None),
    ("turboprop", "aircraft/at72.glb", None),
    ("light", "aircraft/c172.glb", None),
    ("glider", "aircraft/glider.glb", None),
    ("fastjet", "aircraft/t38.glb", None),
    ("bizjet", "aircraft/c56x.glb", None),
    ("uav", "aircraft/mq9.glb", None),
    ("helicopter0", "helicopters/generic_heli.glb", ROTOR_ANGLES_DEG[0]),
    ("helicopter1", "helicopters/generic_heli.glb", ROTOR_ANGLES_DEG[1]),
    ("helicopter2", "helicopters/generic_heli.glb", ROTOR_ANGLES_DEG[2]),
]

# Cell pixels each subject is thickened by before its dark edge, so thin
# wings and rotor blades still read when a contact is drawn 20 to 30 px
# wide. The big aircraft read as they are and are not thickened.
BOLD_PX = {
    "light": 0.35,
    "glider": 1.0,
    "uav": 1.0,
    "helicopter0": 0.4,
    "helicopter1": 0.4,
    "helicopter2": 0.4,
}
# Cells keep this many pixels at each edge clear: the renderer samples the
# sheet with mipmaps (to level 1), so a neighbour's pixels must not reach
# into a cell's footprint.
CLEAR_EDGE_PX = 2

FORWARD = Vector((-1.0, 0.0, 0.0))
RIGHT = Vector((0.0, 1.0, 0.0))
UP = Vector((0.0, 0.0, 1.0))


def frame_directions():
    """Every frame's (ring, index, d) with d in the model's axes."""
    out = []
    for ring, count in enumerate(RINGS):
        alpha = math.radians(ring * RING_STEP_DEG)
        for i in range(count):
            phi = 0.0 if count == 1 else math.pi * i / (count - 1)
            d = (
                FORWARD * (math.sin(alpha) * math.cos(phi))
                + RIGHT * (math.sin(alpha) * math.sin(phi))
                + UP * math.cos(alpha)
            )
            out.append((ring, i, d.normalized()))
    return out


def frame_up(d):
    """A frame's image up: forward, turned as `UP` turns onto `d`."""
    return (UP.rotation_difference(d) @ FORWARD).normalized()



def args_after_dashes():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    opts = {"out": "public/sprites", "only": None}
    i = 0
    while i < len(argv):
        key = argv[i].lstrip("-")
        if key not in opts:
            raise SystemExit(f"unknown option {argv[i]}")
        opts[key] = argv[i + 1]
        i += 2
    return opts


def setup_scene(render_px, samples):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 3
    scene.cycles.pixel_filter_type = "BOX"
    scene.cycles.filter_width = 1.0
    scene.render.film_transparent = True
    scene.render.resolution_x = render_px
    scene.render.resolution_y = render_px
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.display_settings.display_device = "sRGB"

    # Sky: even light from every side, so the underside is lit and the
    # wings shade the fuselage softly where they meet.
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    background.inputs["Strength"].default_value = SKY_STRENGTH
    scene.world = world

    # Sun: from above, leaning toward the nose, in the aircraft's centre
    # plane (so a mirrored frame is lit as its twin).
    sun_data = bpy.data.lights.new("sun", "SUN")
    sun_data.energy = SUN_STRENGTH
    sun_data.angle = math.radians(18)
    sun = bpy.data.objects.new("sun", sun_data)
    scene.collection.objects.link(sun)
    lean = math.radians(28)
    to_sun = (UP * math.cos(lean) + FORWARD * math.sin(lean)).normalized()
    sun.rotation_euler = to_sun.to_track_quat("Z", "Y").to_euler()

    # Fill: a weak light from the eye, so what faces the viewer is lighter
    # than what turns away and a round body reads as round from any side.
    fill_data = bpy.data.lights.new("fill", "SUN")
    fill_data.energy = FILL_STRENGTH
    fill_data.angle = math.radians(30)
    fill = bpy.data.objects.new("fill", fill_data)
    scene.collection.objects.link(fill)

    camera_data = bpy.data.cameras.new("camera")
    camera_data.type = "ORTHO"
    camera_data.clip_start = 0.1
    camera_data.clip_end = 10000
    camera = bpy.data.objects.new("camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    return scene, camera, fill


# Paint by the model's own colour value (its largest channel, linear): glass
# and tyres stay dark, a livery's accent becomes mid grey, and every body
# colour a light paint, so a tint reads on any model.
PAINT_RAMP = [(0.03, 0.07), (0.10, 0.30), (0.26, 0.56), (0.40, 0.76), (0.85, 0.90)]
HELICOPTER_PAINT_RAMP = [(0.04, 0.07), (0.08, 0.38), (0.39, 0.95)]
SUN_STRENGTH = 1.4
SKY_STRENGTH = 0.38
FILL_STRENGTH = 0.9


def paint_material(paint_ramp=PAINT_RAMP, solid=None):
    """Neutral paint that keeps the model's light and dark parts apart."""
    material = bpy.data.materials.new("paint")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.6
    if solid is not None:
        bsdf.inputs["Base Color"].default_value = (solid, solid, solid, 1.0)
        return material
    colour = nodes.new("ShaderNodeVertexColor")
    colour.layer_name = "Color"
    split = nodes.new("ShaderNodeSeparateColor")
    links.new(colour.outputs["Color"], split.inputs["Color"])
    red_green = nodes.new("ShaderNodeMath")
    red_green.operation = "MAXIMUM"
    links.new(split.outputs[0], red_green.inputs[0])
    links.new(split.outputs[1], red_green.inputs[1])
    value = nodes.new("ShaderNodeMath")
    value.operation = "MAXIMUM"
    links.new(red_green.outputs[0], value.inputs[0])
    links.new(split.outputs[2], value.inputs[1])
    ramp = nodes.new("ShaderNodeValToRGB")
    elements = ramp.color_ramp.elements
    while len(elements) < len(paint_ramp):
        elements.new(0.5)
    for element, (position, grey) in zip(elements, paint_ramp):
        element.position = position
        element.color = (grey, grey, grey, 1.0)
    links.new(value.outputs[0], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return material


def model_parts(path):
    """The part table in a fleet model's root node (`render/modelParts.js`)."""
    with open(path, "rb") as f:
        data = f.read()
    length = struct.unpack("<I", data[12:16])[0]
    document = json.loads(data[20 : 20 + length])
    for node in document.get("nodes", []):
        parts = (node.get("extras") or {}).get("parts")
        if parts:
            return parts
    return []


def gltf_to_blender(v):
    """A glTF (Y up) vector in Blender's axes (Z up)."""
    return Vector((v[0], -v[2], v[1]))


def turn_rotors(mesh, parts, degrees, rotor_material):
    """Pose the rotors and bound each vertex over its entire rotation."""
    part_of = mesh.data.attributes.get("_PART")
    if part_of is None:
        return {}
    mesh.data.materials.append(rotor_material)
    swept_radii = {}
    to_world = mesh.matrix_world
    to_local = to_world.inverted()
    for index, part in enumerate(parts):
        if part.get("kind") != "spin" or not part["name"].startswith("rotor"):
            continue
        pivot = gltf_to_blender(part["pivot"])
        axis = gltf_to_blender(part["axis"]).normalized()
        turn = Matrix.Rotation(math.radians(degrees), 4, axis)
        move = to_local @ Matrix.Translation(pivot) @ turn @ Matrix.Translation(-pivot) @ to_world
        if part_of.domain == "POINT":
            members = [i for i, item in enumerate(part_of.data) if item.value == index]
        else:
            members = sorted(
                {
                    mesh.data.loops[i].vertex_index
                    for i, item in enumerate(part_of.data)
                    if item.value == index
                }
            )
        for i in members:
            vertex = mesh.data.vertices[i]
            relative = to_world @ vertex.co - pivot
            axial = relative.dot(axis)
            center = pivot + axial * axis
            # The sweep lies in a plane perpendicular to the axis. Its
            # farthest point adds the circle radius to the projected center.
            radial = (relative - axial * axis).length
            offset = (center - center.dot(axis) * axis).length
            swept_radii[i] = math.hypot(center.dot(axis), offset + radial)
            vertex.co = move @ vertex.co
    for polygon in mesh.data.polygons:
        if all(i in swept_radii for i in polygon.vertices):
            polygon.material_index = 1
    return swept_radii


def load_model(path, material, rotor_deg, rotor_material):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    objects = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in objects if o.type == "MESH"]
    bpy.context.view_layer.update()
    parts = model_parts(path) if rotor_deg is not None else []
    radius = 0.0
    for mesh in meshes:
        mesh.data.materials.clear()
        mesh.data.materials.append(material)
        swept_radii = turn_rotors(mesh, parts, rotor_deg, rotor_material) if parts else {}
        for vertex in mesh.data.vertices:
            distance = swept_radii.get(vertex.index)
            if distance is None:
                distance = (mesh.matrix_world @ vertex.co).length
            radius = max(radius, distance)
    return objects, radius


def aim(camera, fill, d, radius):
    fill.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    up = frame_up(d)
    right = up.cross(d).normalized()
    rotation = Matrix((right, up, d)).transposed()
    camera.matrix_world = Matrix.Translation(d * (radius * 4 + 10)) @ rotation.to_4x4()
    camera.data.ortho_scale = 2 * radius / FILL



def read_pixels(path):
    image = bpy.data.images.load(path)
    width, height = image.size
    pixels = np.array(image.pixels[:], dtype=np.float32).reshape(height, width, 4)
    bpy.data.images.remove(image)
    return pixels[::-1]  # top row first


def disk_shifts(shape, radius):
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy > radius * radius or (dx == 0 and dy == 0):
                continue
            ys = slice(max(dy, 0), shape[0] + min(dy, 0))
            xs = slice(max(dx, 0), shape[1] + min(dx, 0))
            yd = slice(max(-dy, 0), shape[0] + min(-dy, 0))
            xd = slice(max(-dx, 0), shape[1] + min(-dx, 0))
            yield (ys, xs), (yd, xd)


def dilate(alpha, radius):
    out = alpha.copy()
    for dst, src in disk_shifts(alpha.shape, radius):
        np.maximum(out[dst], alpha[src], out=out[dst])
    return out


def disk_sum(values, radius):
    """Each pixel's sum of `values` over a disk of `radius` around it."""
    out = values.copy()
    for dst, src in disk_shifts(values.shape, radius):
        out[dst] += values[src]
    return out


# Neutral, as the whole sheet is: the renderer keeps it as grey + alpha.
EDGE_RGB = np.array([0.045, 0.045, 0.045], dtype=np.float32)
EDGE_ALPHA = 0.62


def inside_mask(size, supersample):
    """1 within the disk that keeps CLEAR_EDGE_PX of the cell clear, fading
    to 0 over half a cell pixel inside its rim. Only what the bake adds round
    the model (its thickening and dark edge) is faded by it: the model's own
    bounding sphere ends at FILL, inside it."""
    cell = size / supersample
    centre = size / 2
    y, x = np.mgrid[0:size, 0:size] + 0.5
    r = np.hypot(x - centre, y - centre) / supersample
    outer = cell / 2 - CLEAR_EDGE_PX
    return np.clip((outer - r) / 0.5, 0, 1).astype(np.float32)


def finish(pixels, supersample, bold_px=0.0):
    """Thicken the sprite by `bold_px` cell pixels, put a dark edge round it,
    then bring it down to the cell by area."""
    rgb = pixels[..., :3]
    alpha = pixels[..., 3]
    premultiplied = rgb * alpha[..., None]
    mask = inside_mask(pixels.shape[0], supersample)
    radius = round(supersample * bold_px)
    if radius > 0:
        # Under the model, its own colour spread outward: each new pixel the
        # mean colour of the model round it.
        grown = dilate(alpha, radius) * mask
        weight = disk_sum(alpha, radius)
        spread = disk_sum(premultiplied, radius) / np.maximum(weight, 1e-6)[..., None]
        under = grown * (1 - alpha)
        premultiplied = premultiplied + spread * under[..., None]
        alpha = alpha + under
    # About 0.9 cell pixels of edge.
    halo = dilate(alpha, max(1, round(supersample * 0.9))) * EDGE_ALPHA * mask
    out_alpha = alpha + halo * (1 - alpha)
    premultiplied = premultiplied + EDGE_RGB * (halo * (1 - alpha))[..., None]
    size = pixels.shape[0] // supersample

    def area(a):
        return a.reshape(size, supersample, size, supersample, -1).mean(axis=(1, 3))

    small_alpha = area(out_alpha[..., None])[..., 0]
    small = area(premultiplied)
    colour = np.where(
        small_alpha[..., None] > 1e-4, small / np.maximum(small_alpha[..., None], 1e-4), 0
    )
    return np.dstack([np.clip(colour, 0, 1), np.clip(small_alpha, 0, 1)])


# How far a frame's red, green and blue may differ (in 0..1) before the bake
# refuses it as not grey: rendering noise, never a colour.
GREY_TOLERANCE = 1.5 / 255


def to_grey(frame, name, n):
    """The frame with equal red, green and blue (their mean), refusing one
    whose channels differ by more than rendering noise: the sheet ships as
    grey, its red channel read as the grey."""
    rgb = frame[..., :3]
    lit = frame[..., 3] > 0
    spread = (rgb.max(axis=2) - rgb.min(axis=2))[lit]
    if spread.size and spread.max() > GREY_TOLERANCE:
        raise SystemExit(
            f"{name} frame {n}: not grey (its channels differ by "
            f"{spread.max() * 255:.1f}/255); the sheet ships as grey"
        )
    grey = rgb.mean(axis=2, keepdims=True)
    return np.dstack([np.repeat(grey, 3, axis=2), frame[..., 3:]])


def check_clear_edge(frame, name, n):
    """Refuse a frame with anything but transparent pixels near its edge."""
    e = CLEAR_EDGE_PX
    alpha = frame[..., 3]
    band = np.concatenate(
        [alpha[:e].ravel(), alpha[-e:].ravel(), alpha[:, :e].ravel(), alpha[:, -e:].ravel()]
    )
    if band.max() >= 0.5 / 255:
        raise SystemExit(
            f"{name} frame {n}: pixels within {e} px of the cell edge "
            f"(alpha {band.max():.3f}); the fill leaves them no room"
        )


def save_png(path, pixels):
    height, width = pixels.shape[:2]
    image = bpy.data.images.new("out", width, height, alpha=True)
    image.alpha_mode = "STRAIGHT"
    image.pixels.foreach_set(pixels[::-1].astype(np.float32).ravel())
    image.filepath_raw = path
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)



def main():
    opts = args_after_dashes()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    models = os.path.join(root, "public", "models", "fleet")
    only = set(opts["only"].split(",")) if opts["only"] else None
    if only:
        known = [name for name, _, _ in SUBJECTS]
        unknown = sorted(only - set(known))
        if unknown:
            raise SystemExit(
                f"unknown --only subjects: {', '.join(unknown)} (known: {', '.join(known)})"
            )
    scene, camera, fill = setup_scene(CELL_PX * SUPERSAMPLE, SAMPLES)
    material = paint_material()
    helicopter_material = paint_material(HELICOPTER_PAINT_RAMP)
    rotor_material = paint_material(solid=0.82)
    directions = frame_directions()
    tmp = os.path.join(bpy.app.tempdir, "view-frame.png")

    rows = math.ceil(len(SUBJECTS) * FRAMES / COLUMNS)
    sheet = np.zeros((rows * CELL_PX, COLUMNS * CELL_PX, 4), dtype=np.float32)
    manifest = {
        "image": "aircraft-views.webp",
        "cellPx": CELL_PX,
        "columns": COLUMNS,
        "rows": rows,
        "ringStepDeg": RING_STEP_DEG,
        "rings": RINGS,
        "fill": FILL,
        "subjects": {},
    }

    for index, (name, model, rotor_deg) in enumerate(SUBJECTS):
        first = index * FRAMES
        manifest["subjects"][name] = {"first": first, "model": model}
        if only and name not in only:
            continue
        objects, radius = load_model(
            os.path.join(models, model),
            material if rotor_deg is None else helicopter_material,
            rotor_deg,
            rotor_material,
        )
        manifest["subjects"][name]["radiusM"] = round(radius, 3)
        for n, (_, _, d) in enumerate(directions):
            aim(camera, fill, d, radius)
            scene.render.filepath = tmp
            bpy.ops.render.render(write_still=True)
            frame = finish(read_pixels(tmp), SUPERSAMPLE, BOLD_PX.get(name, 0.0))
            check_clear_edge(frame, name, n)
            frame = to_grey(frame, name, n)
            at = first + n
            y = (at // COLUMNS) * CELL_PX
            x = (at % COLUMNS) * CELL_PX
            sheet[y : y + CELL_PX, x : x + CELL_PX] = frame
        for obj in objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        print(f"baked {name}: {FRAMES} frames, radius {radius:.2f} m", flush=True)

    out = os.path.join(root, opts["out"]) if not os.path.isabs(opts["out"]) else opts["out"]
    os.makedirs(out, exist_ok=True)
    save_png(os.path.join(out, "aircraft-views.png"), sheet)
    with open(os.path.join(out, "aircraft-views.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    print(f"wrote {out}/aircraft-views.png ({COLUMNS * CELL_PX}x{rows * CELL_PX})")


main()
