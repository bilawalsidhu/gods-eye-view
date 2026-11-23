"""Bake a view sheet: each subject of a sheet (an aircraft class, a vessel
kind) seen from a sphere of directions, as one image of small shaded sprites.

    blender -b --factory-startup --python scripts/bake-view-sheet.py -- \
        --sheet aircraft|vessels --out <dir> [--cell 64] [--supersample 4]
        [--only airliner,light] [--preview <dir>]

It writes `<name>.png` and its manifest `<name>.json` to `--out`, `<name>`
being the sheet's name (`aircraft-views`, `vessel-views`). The manifest names
the shipped image, `<name>.webp`, which `npm run build:aircraft-views` or
`npm run build:vessel-views` (scripts/build-view-sheet.mjs) makes from the
PNG (lossless) and writes to `public/sprites/` with the manifest.

The layers draw a contact with the frame that shows it from where the eye is
(`src/data/viewSheet.js` holds the same layouts and maths; its test,
`src/data/viewSheet.test.mjs`, checks this script's sheets and the shipped
manifests against it). A frame is an orthographic view of the subject's
fleet model (`public/models/fleet/`, nose or bow toward -X, +Y starboard, +Z
up), centred on the model's origin, the model's bounding sphere filling
`FILL` of the cell.

Directions. `d` is the unit vector from the subject to the eye in the
subject's own frame (forward, right, up), the subject lying flat on the
earth: up is the ground's normal, forward its course. Rings of frames lie
the sheet's `ring_step_deg` apart from straight above (ring 0, one frame)
down to its last ring (30 degrees below the horizon for aircraft, the horizon
for vessels). A ring holds the eye's bearings from dead ahead (first frame)
round the starboard side to dead astern (last frame); the port side is the
starboard frame mirrored, which is why the light is symmetric about the
subject's centre plane.

Roll. A frame's image up is where the subject's forward goes under the
smallest rotation that takes "up" to `d`: straight above, the nose points up
the image, and the roll then changes smoothly all the way round and below
(it has no meaning only from straight below, which no ring reaches).

The sprites are neutral (light paint, grey shading, dark glass and a dark
edge) so a layer's tint multiplies them, as it does the flat glyphs; every
pixel's red, green and blue are equal (`"grey": true` in the manifest), as
the renderer keeps the sheet as grey and alpha, and the bake refuses a frame
that is not. Each sheet has its paint ramp (`PAINTS`), and a subject may
have its own. A helicopter's body and blades are painted light as well (its
blades a solid light grey), and its rotor frames share one scale: each rotor
vertex counts at the farthest point of the circle it sweeps about the
rotor's axis. A vessel is cut at its waterline (its origin, z = 0) before it
is rendered, so no hull below the water is drawn and its bounding sphere is
of what floats; a subject's model may be widened across the beam (`beam`)
or squashed above a height (`squash_above`: a sailboat's mast). Thin
subjects are thickened before their edge (`bold_px`), and every cell keeps
`CLEAR_EDGE_PX` clear at its edges for the renderer's mipmaps; the bake
refuses a frame that does not.
"""

import json
import math
import os
import struct
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

# --- The sheets (their layouts mirrored in src/data/viewSheet.js) -----------

# A sheet: its name (the files it writes), its rings of frames (each ring's
# frame count, from dead ahead round starboard to dead astern), its paint,
# whether its models are cut at the waterline, and its subjects, in the order
# of their blocks of frames. A subject is (name, model, options); options:
#   rotor_deg     a helicopter's rotor frame: the rotors turned this far
#   paint         its own paint ramp (a key of PAINTS)
#   bold_px       cell pixels it is thickened by before its edge, so thin
#                 wings, blades and hulls still read 20 to 30 px wide
#   beam          its model scaled across the beam by this much
#   squash_above  [z, k]: its model above z metres scaled up by k
AIRCRAFT = {
    "name": "aircraft-views",
    "ring_step_deg": 7.5,
    "rings": [1, 4, 7, 10, 13, 16, 18, 20, 22, 23, 24, 25, 25, 25, 24, 23, 22],
    "columns": 64,
    "paint": "aircraft",
    "waterline": False,
    "subjects": [
        ("airliner", "aircraft/a320.glb", {}),
        ("widebody", "aircraft/b789.glb", {}),
        ("quadjet", "aircraft/b744.glb", {}),
        ("turboprop", "aircraft/at72.glb", {}),
        ("light", "aircraft/c172.glb", {"bold_px": 0.35}),
        ("glider", "aircraft/glider.glb", {"bold_px": 1.0}),
        ("fastjet", "aircraft/t38.glb", {}),
        ("bizjet", "aircraft/glf4.glb", {}),
        ("uav", "aircraft/mq9.glb", {"bold_px": 1.0}),
        # The helicopter has one block for each rotor frame (rotorFrames.js).
        ("helicopter0", "helicopters/generic_heli.glb", {"rotor_deg": 15, "paint": "helicopter", "bold_px": 0.4}),
        ("helicopter1", "helicopters/generic_heli.glb", {"rotor_deg": 45, "paint": "helicopter", "bold_px": 0.4}),
        ("helicopter2", "helicopters/generic_heli.glb", {"rotor_deg": 75, "paint": "helicopter", "bold_px": 0.4}),
    ],
}

# Vessels: down to the horizon only, as a ship is never seen from below. The
# subjects are the hull kinds of vesselKind (src/data/vesselTypes.js), then
# the dredger (AIS 33) and the pilot boat (pilot, rescue, tender and
# anti-pollution craft).
VESSELS = {
    "name": "vessel-views",
    "ring_step_deg": 7.5,
    "rings": [1, 4, 7, 10, 13, 16, 18, 20, 22, 23, 24, 25, 25],
    "columns": 64,
    "paint": "ship",
    "waterline": True,
    "subjects": [
        ("cargo", "ships/container_ship.glb", {"beam": 1.4, "bold_px": 1.0}),
        ("tanker", "ships/tanker.glb", {"beam": 1.4, "bold_px": 1.0}),
        ("passenger", "ships/cruise_ship.glb", {"beam": 1.4, "bold_px": 0.5}),
        ("highspeed", "ships/fast_ferry.glb", {"beam": 1.2, "bold_px": 0.5}),
        ("fishing", "ships/trawler.glb", {"bold_px": 0.5}),
        ("tug", "ships/tug.glb", {"bold_px": 0.5}),
        ("sailing", "ships/sailboat.glb", {"beam": 1.3, "bold_px": 0.5, "squash_above": [1.2, 0.4]}),
        ("pleasure", "ships/motor_yacht.glb", {"beam": 1.25, "bold_px": 0.5}),
        ("military", "ships/patrol.glb", {"beam": 1.5, "bold_px": 1.0}),
        ("other", "ships/generic_vessel.glb", {"beam": 1.3, "bold_px": 0.5}),
        ("dredger", "ships/dredger.glb", {"beam": 1.3, "bold_px": 0.5}),
        ("pilot", "ships/pilot_boat.glb", {"beam": 1.2, "bold_px": 0.5}),
    ],
}

SHEETS = {"aircraft": AIRCRAFT, "vessels": VESSELS}

# How much of a cell the model's bounding sphere spans.
FILL = 0.92
# Cells keep this many pixels at each edge clear: the renderer samples the
# sheet with mipmaps (to level 1), so a neighbour's pixels must not reach
# into a cell's footprint.
CLEAR_EDGE_PX = 2

FORWARD = Vector((-1.0, 0.0, 0.0))
RIGHT = Vector((0.0, 1.0, 0.0))
UP = Vector((0.0, 0.0, 1.0))


def frame_directions(sheet):
    """Every frame's (ring, index, d) with d in the model's axes."""
    out = []
    for ring, count in enumerate(sheet["rings"]):
        alpha = math.radians(ring * sheet["ring_step_deg"])
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


# --- Scene -------------------------------------------------------------------


def args_after_dashes():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    opts = {
        "sheet": "aircraft",
        "out": "public/sprites",
        "cell": 64,
        "supersample": 4,
        "only": None,
        "preview": None,
        "samples": 48,
    }
    i = 0
    while i < len(argv):
        key = argv[i].lstrip("-")
        if key not in opts:
            raise SystemExit(f"unknown option {argv[i]}")
        opts[key] = argv[i + 1]
        i += 2
    opts["cell"] = int(opts["cell"])
    opts["supersample"] = int(opts["supersample"])
    opts["samples"] = int(opts["samples"])
    if opts["sheet"] not in SHEETS:
        raise SystemExit(f"--sheet is one of {', '.join(SHEETS)}")
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


# Paint by the model's own colour value (its largest channel, linear), as
# (value, grey) stops. Aircraft: glass and tyres stay dark, a livery's accent
# becomes mid grey, and every body colour a light paint, so a tint reads on
# any model. Ships: windows and the darkest fittings stay dark, and hull
# paint, decks and cargo all become light greys a little apart.
PAINTS = {
    "aircraft": [(0.03, 0.07), (0.10, 0.30), (0.26, 0.56), (0.40, 0.76), (0.85, 0.90)],
    "helicopter": [(0.04, 0.07), (0.08, 0.38), (0.39, 0.95)],
    "ship": [(0.0, 0.62), (0.25, 0.78), (0.85, 0.95)],
}
# Glass by its colour, for a paint that lifts even black hull paint: a dark
# colour (value at most `value`) whose blue is at least `blue` and
# `blue_over_red` times its red (the ship models' windows) is painted `grey`.
GLASS = {"ship": {"value": 0.08, "blue": 0.025, "blue_over_red": 2.5, "grey": 0.07}}
SUN_STRENGTH = 1.4
SKY_STRENGTH = 0.38
FILL_STRENGTH = 0.9


def paint_material(paint_ramp, solid=None, glass=None):
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
    if glass is None:
        links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
        return material

    def math_node(operation, a, b, c=None):
        node = nodes.new("ShaderNodeMath")
        node.operation = operation
        for i, x in enumerate((a, b, c)):
            if x is None:
                continue
            if isinstance(x, (int, float)):
                node.inputs[i].default_value = x
            else:
                links.new(x, node.inputs[i])
        return node.outputs[0]

    dark = math_node("LESS_THAN", value.outputs[0], glass["value"] + 1e-4)
    blue = math_node("GREATER_THAN", split.outputs[2], glass["blue"] - 1e-4)
    red_scaled = math_node("MULTIPLY", split.outputs[0], glass["blue_over_red"])
    over_red = math_node(
        "GREATER_THAN", math_node("SUBTRACT", split.outputs[2], red_scaled), -1e-4
    )
    is_glass = math_node("MULTIPLY", math_node("MULTIPLY", dark, blue), over_red)
    ramp_grey = nodes.new("ShaderNodeSeparateColor")
    links.new(ramp.outputs["Color"], ramp_grey.inputs["Color"])
    to_glass = math_node("SUBTRACT", glass["grey"], ramp_grey.outputs[0])
    grey = math_node("MULTIPLY_ADD", is_glass, to_glass, ramp_grey.outputs[0])
    combine = nodes.new("ShaderNodeCombineColor")
    for i in range(3):
        links.new(grey, combine.inputs[i])
    links.new(combine.outputs["Color"], bsdf.inputs["Base Color"])
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


def reshape(mesh, waterline, beam, squash_above):
    """Bring a mesh into the scene's axes, cut away what lies below the
    waterline (z = 0) and scale it across the beam and above a height."""
    world = mesh.matrix_world.copy()
    mesh.parent = None
    mesh.matrix_world = Matrix.Identity(4)
    mesh.data.transform(world)
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    if waterline:
        bmesh.ops.bisect_plane(
            bm,
            geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
            dist=1e-4,
            plane_co=(0.0, 0.0, 0.0),
            plane_no=(0.0, 0.0, 1.0),
            clear_inner=True,
        )
    for vertex in bm.verts:
        vertex.co.y *= beam
        if squash_above and vertex.co.z > squash_above[0]:
            height, k = squash_above
            vertex.co.z = height + (vertex.co.z - height) * k
    bm.to_mesh(mesh.data)
    bm.free()


def load_model(path, material, rotor_deg, rotor_material, waterline=False, options=None):
    options = options or {}
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    objects = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in objects if o.type == "MESH"]
    bpy.context.view_layer.update()
    parts = model_parts(path) if rotor_deg is not None else []
    beam = options.get("beam", 1.0)
    squash_above = options.get("squash_above")
    radius = 0.0
    for mesh in meshes:
        if waterline or beam != 1.0 or squash_above:
            reshape(mesh, waterline, beam, squash_above)
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


# --- Pixels ------------------------------------------------------------------


def read_pixels(path):
    image = bpy.data.images.load(path)
    width, height = image.size
    pixels = np.array(image.pixels[:], dtype=np.float32).reshape(height, width, 4)
    bpy.data.images.remove(image)
    return pixels[::-1]  # top row first


def dilate(alpha, radius):
    out = alpha.copy()
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy > radius * radius or (dx == 0 and dy == 0):
                continue
            shifted = np.zeros_like(alpha)
            ys = slice(max(dy, 0), alpha.shape[0] + min(dy, 0))
            xs = slice(max(dx, 0), alpha.shape[1] + min(dx, 0))
            yd = slice(max(-dy, 0), alpha.shape[0] + min(-dy, 0))
            xd = slice(max(-dx, 0), alpha.shape[1] + min(-dx, 0))
            shifted[ys, xs] = alpha[yd, xd]
            np.maximum(out, shifted, out=out)
    return out


def disk_sum(values, radius):
    """Each pixel's sum of `values` over a disk of `radius` around it."""
    out = values.copy()
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy > radius * radius or (dx == 0 and dy == 0):
                continue
            ys = slice(max(dy, 0), values.shape[0] + min(dy, 0))
            xs = slice(max(dx, 0), values.shape[1] + min(dx, 0))
            yd = slice(max(-dy, 0), values.shape[0] + min(-dy, 0))
            xd = slice(max(-dx, 0), values.shape[1] + min(-dx, 0))
            out[ys, xs] += values[yd, xd]
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
    grey (`"grey": true`), its red channel read as the grey."""
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


# --- Bake --------------------------------------------------------------------


def main():
    opts = args_after_dashes()
    config = SHEETS[opts["sheet"]]
    name_of_sheet = config["name"]
    columns = config["columns"]
    subjects = config["subjects"]
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    models = os.path.join(root, "public", "models", "fleet")
    cell = opts["cell"]
    supersample = opts["supersample"]
    only = set(opts["only"].split(",")) if opts["only"] else None
    scene, camera, fill = setup_scene(cell * supersample, opts["samples"])
    materials = {
        key: paint_material(ramp, glass=GLASS.get(key)) for key, ramp in PAINTS.items()
    }
    rotor_material = paint_material(None, solid=0.82)
    directions = frame_directions(config)
    frames = len(directions)
    tmp = os.path.join(bpy.app.tempdir, "view-frame.png")

    rows = math.ceil(len(subjects) * frames / columns)
    sheet = np.zeros((rows * cell, columns * cell, 4), dtype=np.float32)
    manifest = {
        "image": f"{name_of_sheet}.webp",
        "cellPx": cell,
        "columns": columns,
        "rows": rows,
        "ringStepDeg": config["ring_step_deg"],
        "rings": config["rings"],
        "fill": FILL,
        # Every pixel's red, green and blue are equal.
        "grey": True,
        "subjects": {},
    }

    for index, (name, model, options) in enumerate(subjects):
        first = index * frames
        manifest["subjects"][name] = {"first": first, "model": model}
        if only and name not in only:
            continue
        objects, radius = load_model(
            os.path.join(models, model),
            materials[options.get("paint", config["paint"])],
            options.get("rotor_deg"),
            rotor_material,
            config["waterline"],
            options,
        )
        manifest["subjects"][name]["radiusM"] = round(radius, 3)
        for n, (ring, i, d) in enumerate(directions):
            aim(camera, fill, d, radius)
            scene.render.filepath = tmp
            bpy.ops.render.render(write_still=True)
            frame = finish(read_pixels(tmp), supersample, options.get("bold_px", 0.0))
            check_clear_edge(frame, name, n)
            frame = to_grey(frame, name, n)
            at = first + n
            y = (at // columns) * cell
            x = (at % columns) * cell
            sheet[y : y + cell, x : x + cell] = frame
            if opts["preview"]:
                os.makedirs(opts["preview"], exist_ok=True)
                save_png(
                    os.path.join(opts["preview"], f"{name}-r{ring}-{i:02d}.png"), frame
                )
        for obj in objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        print(f"baked {name}: {frames} frames, radius {radius:.2f} m", flush=True)

    out = os.path.join(root, opts["out"]) if not os.path.isabs(opts["out"]) else opts["out"]
    os.makedirs(out, exist_ok=True)
    save_png(os.path.join(out, f"{name_of_sheet}.png"), sheet)
    with open(os.path.join(out, f"{name_of_sheet}.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    print(f"wrote {out}/{name_of_sheet}.png ({columns * cell}x{rows * cell})")


main()
