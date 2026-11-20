"""Build an original, articulation-ready Tiangong (T-configuration) model in Blender and export it as GLB.

Run headless with Blender 5.3, from the repository root:
    blender -b --python scripts/build-tiangong-model.py -- [out_dir]
out_dir defaults to tiangong-model/ under the system's temporary directory; copy
tiangong.glb from there to public/models/.

Every dimension below is written in the *scene frame of the exported glTF* (metres):
    +X = port (left when looking forward), +Y = zenith (away from Earth), +Z = forward (direction of flight).
Blender is Z-up; the glTF exporter (export_yup=True) maps Blender +Z -> glTF +Y and Blender +Y -> glTF -Z,
so a glTF point (x, y, z) is built in Blender at (x, -z, y). The helper B() does that conversion and
nothing else in this file thinks in Blender axes.

All geometry is made from Blender primitives here; nothing is imported. All textures are generated
procedurally with numpy (see TEXTURES below), written as PNG to textures/ and re-encoded to WebP by the
exporter. No third-party image, model, insignia or lettering is used.
"""
import json
import math
import os
import struct
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
HERE = os.path.abspath(_ARGS[0]) if _ARGS else os.path.join(tempfile.gettempdir(), "tiangong-model")
os.makedirs(HERE, exist_ok=True)
GLB = os.path.join(HERE, "tiangong.glb")
BLEND = os.path.join(HERE, "tiangong.blend")
JOINTS_JSON = os.path.join(HERE, "joints.json")
STATS_JSON = os.path.join(HERE, "build_stats.json")
TEX_DIR = os.path.join(HERE, "textures")
ISS_REFERENCE = os.path.join(ROOT, "public", "models", "iss.glb")   # read only, for preview_iss_reference.png
PREVIEW_SAMPLES = 48


def log(*a):
    print("[tiangong]", *a)
    sys.stdout.flush()


# --------------------------------------------------------------------------------------- frame helpers
def B(v):
    """glTF scene coords (x port, y zenith, z forward) -> Blender coords (Z-up)."""
    return Vector((v[0], -v[2], v[1]))


def Bsize(s):
    """Box dimensions glTF (sx, sy, sz) -> Blender (sx, sz, sy)."""
    return (abs(s[0]), abs(s[2]), abs(s[1]))


def V(*a):
    return Vector(a)


def unit(v):
    v = Vector(v)
    return list(round(c, 6) for c in v.normalized())


# --------------------------------------------------------------------------------------- scene reset
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0

coll = bpy.data.collections.new("Tiangong")
scene.collection.children.link(coll)
layer_coll = bpy.context.view_layer.layer_collection.children[coll.name]
bpy.context.view_layer.active_layer_collection = layer_coll

# ======================================================================================= TEXTURES
# All maps are square, tileable, and drawn in display (sRGB) values 0..1 straight into byte images.
# metallicRoughness maps follow glTF: R unused (1), G = roughness, B = metallic.
os.makedirs(TEX_DIR, exist_ok=True)
TEX_FILES = {}


def fbm(n, octaves=5, base=4, seed=0, persistence=0.5):
    """Periodic value noise in [0,1], n x n, tileable."""
    rng = np.random.default_rng(seed)
    out = np.zeros((n, n), np.float32)
    amp, total, freq = 1.0, 0.0, base
    for _ in range(octaves):
        g = rng.random((freq, freq)).astype(np.float32)
        t = np.arange(n) * freq / n
        i0 = np.floor(t).astype(int) % freq
        i1 = (i0 + 1) % freq
        f = (t - np.floor(t)).astype(np.float32)
        s = f * f * (3 - 2 * f)
        a, b, c, d = g[i0][:, i0], g[i0][:, i1], g[i1][:, i0], g[i1][:, i1]
        v = (a * (1 - s)[None, :] + b * s[None, :]) * (1 - s)[:, None] + (c * (1 - s)[None, :] + d * s[None, :]) * s[:, None]
        out += amp * v
        total += amp
        amp *= persistence
        freq *= 2
    return out / total


def wrap_idx(n, pos, w):
    return (int(round(pos)) + np.arange(-(w // 2), w - w // 2)) % n


def hline(img, y, w, col, alpha=1.0, x0=0, x1=None):
    """Horizontal line at pixel row y (wraps), width w, over columns x0..x1."""
    n = img.shape[0]
    x1 = n if x1 is None else x1
    rows = wrap_idx(n, y, w)
    img[rows[:, None], np.arange(x0, x1)[None, :]] = img[rows[:, None], np.arange(x0, x1)[None, :]] * (1 - alpha) + np.asarray(col, np.float32) * alpha


def vline(img, x, w, col, alpha=1.0, y0=0, y1=None):
    n = img.shape[0]
    y1 = n if y1 is None else y1
    cols = wrap_idx(n, x, w)
    img[np.arange(y0, y1)[:, None], cols[None, :]] = img[np.arange(y0, y1)[:, None], cols[None, :]] * (1 - alpha) + np.asarray(col, np.float32) * alpha


def rect(img, x0, y0, x1, y1, col, alpha=1.0):
    img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - alpha) + np.asarray(col, np.float32) * alpha


def disc(img, cx, cy, r, col, alpha=1.0):
    n = img.shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    m = ((xx - cx) ** 2 + (yy - cy) ** 2) <= r * r
    img[m] = img[m] * (1 - alpha) + np.asarray(col, np.float32) * alpha


def solid(n, col):
    return np.ones((n, n, 3), np.float32) * np.asarray(col, np.float32)


def save_tex(name, arr, noncolor=False):
    """Write an (n, n, 3) float array as PNG and return the Blender image."""
    n = arr.shape[0]
    rgba = np.ones((n, n, 4), np.float32)
    rgba[..., :3] = np.clip(arr, 0, 1)
    img = bpy.data.images.new(name, n, n, alpha=True)
    if noncolor:
        img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(rgba.ravel())
    path = os.path.join(TEX_DIR, name + ".png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    TEX_FILES[name] = os.path.getsize(path)
    return img


def tex_hull(n=512, tile=4.0, seed=1):
    """Off-white thermal blankets: 1 m panel seams, quilting, patches, vents, handrail rows. tile = metres per repeat."""
    ppm = n / tile
    base = np.asarray((0.82, 0.82, 0.80), np.float32)
    lum = 1.0 + 0.05 * (fbm(n, 4, 4, seed) - 0.5) + 0.03 * (fbm(n, 2, 32, seed + 1) - 0.5)
    d = solid(n, base) * lum[..., None]
    mr = solid(n, (1.0, 0.56, 0.03))
    mr[..., 1] += 0.08 * (fbm(n, 3, 8, seed + 2) - 0.5)
    q = int(ppm * 0.25)
    for k in range(int(tile / 0.25)):                       # quilting
        hline(d, k * q, 1, (0.7, 0.7, 0.68), 0.25)
        vline(d, k * q, 1, (0.7, 0.7, 0.68), 0.25)
    for k in range(int(tile)):                              # panel seams every metre
        p = int(k * ppm)
        hline(d, p, 2, (0.56, 0.56, 0.55), 0.9)
        vline(d, p, 2, (0.56, 0.56, 0.55), 0.9)
        hline(d, p + 2, 1, (0.9, 0.9, 0.88), 0.5)
        vline(d, p + 2, 1, (0.9, 0.9, 0.88), 0.5)
        hline(mr, p, 2, (1.0, 0.68, 0.0))
        vline(mr, p, 2, (1.0, 0.68, 0.0))
    # radiator-like dark strips, equipment plates, vents (metres within the tile; nothing crosses the border)
    def m(x):
        return int(x * ppm)
    for (x0, y0, x1, y1) in ((0.35, 0.2, 1.75, 0.58), (2.3, 2.3, 3.7, 2.68)):
        rect(d, m(x0), m(y0), m(x1), m(y1), (0.40, 0.42, 0.45))
        rect(mr, m(x0), m(y0), m(x1), m(y1), (1.0, 0.42, 0.45))
        for yy in range(m(y0) + 3, m(y1) - 2, 4):
            hline(d, yy, 1, (0.52, 0.54, 0.57), 1.0, m(x0) + 2, m(x1) - 2)
    for (x0, y0, x1, y1, c) in ((1.2, 3.05, 1.55, 3.35, (0.32, 0.32, 0.34)), (2.65, 0.75, 2.85, 1.15, (0.55, 0.55, 0.57)),
                                (0.4, 1.3, 0.7, 1.5, (0.62, 0.6, 0.55)), (3.15, 3.2, 3.55, 3.4, (0.5, 0.5, 0.52))):
        rect(d, m(x0), m(y0), m(x1), m(y1), c)
        rect(mr, m(x0), m(y0), m(x1), m(y1), (1.0, 0.45, 0.5))
        hline(d, m(y0), 1, (0.25, 0.25, 0.26), 1.0, m(x0), m(x1))
        hline(d, m(y1), 1, (0.25, 0.25, 0.26), 1.0, m(x0), m(x1))
    for (cx, cy, r) in ((3.2, 1.1, 0.08), (0.7, 2.6, 0.06), (1.9, 1.6, 0.05)):
        disc(d, m(cx), m(cy), m(r), (0.2, 0.2, 0.21))
        disc(d, m(cx), m(cy), m(r) - 2, (0.12, 0.12, 0.13))
        disc(mr, m(cx), m(cy), m(r), (1.0, 0.4, 0.7))
    # handrails: rows along v at u = 0.9 and 3.1 m, segments 0.9 m with 0.3 m gaps; one cross rail
    rail = (0.46, 0.46, 0.49)
    endc = (0.26, 0.26, 0.28)
    for u in (0.9, 3.1):
        for k in range(int(tile / 1.2)):
            y0, y1 = m(k * 1.2 + 0.15), m(k * 1.2 + 1.05)
            vline(d, m(u), 4, rail, 1.0, y0, y1)
            vline(mr, m(u), 4, (1.0, 0.45, 0.6), 1.0, y0, y1)
            rect(d, m(u) - 4, y0, m(u) + 4, y0 + 5, endc)
            rect(d, m(u) - 4, y1 - 5, m(u) + 4, y1, endc)
    hline(d, m(2.0), 4, rail, 1.0, m(1.3), m(2.9))
    hline(mr, m(2.0), 4, (1.0, 0.45, 0.6), 1.0, m(1.3), m(2.9))
    rect(d, m(1.3), m(2.0) - 4, m(1.3) + 5, m(2.0) + 4, endc)
    rect(d, m(2.9) - 5, m(2.0) - 4, m(2.9), m(2.0) + 4, endc)
    return d, mr


def tex_mli(n=512, tile=2.0, seed=7):
    """Gold multi-layer insulation with wrinkles, olive patches, blanket seams and tape."""
    ppm = n / tile
    w = fbm(n, 6, 6, seed, 0.6)
    crinkle = fbm(n, 3, 48, seed + 1, 0.5)
    lum = np.clip(0.82 + 0.45 * (w - 0.5) + 0.3 * (crinkle - 0.5), 0.4, 1.15)
    gold = np.asarray((0.80, 0.62, 0.30), np.float32)
    olive = np.asarray((0.66, 0.62, 0.40), np.float32)
    zone = 0.6 * np.clip((fbm(n, 2, 2, seed + 2) - 0.6) * 5, 0, 1)
    col = gold[None, None, :] * (1 - zone[..., None]) + olive[None, None, :] * zone[..., None]
    d = col * lum[..., None]
    mr = solid(n, (1.0, 0.36, 0.62))
    mr[..., 1] = np.clip(0.36 + 0.22 * (w - 0.5) + 0.1 * (crinkle - 0.5), 0.22, 0.55)
    for k in range(int(tile)):
        p = int(k * ppm)
        hline(d, p, 2, (0.35, 0.27, 0.12), 0.85)
        vline(d, p, 2, (0.35, 0.27, 0.12), 0.85)
        hline(mr, p, 2, (1.0, 0.6, 0.3))
        vline(mr, p, 2, (1.0, 0.6, 0.3))
    def m(x):
        return int(x * ppm)
    for (x0, y0, x1, y1) in ((0.3, 1.4, 0.95, 1.46), (1.2, 0.3, 1.26, 0.9), (1.5, 1.6, 1.85, 1.66), (0.55, 0.55, 0.61, 0.95)):
        rect(d, m(x0), m(y0), m(x1), m(y1), (0.55, 0.43, 0.2), 0.8)
        rect(mr, m(x0), m(y0), m(x1), m(y1), (1.0, 0.5, 0.4))
    return d, mr


def tex_solar(n=512, tile=2.0, cells=16, seed=3):
    """Dark blue-black cell grid with silver gaps and busbars, a hinge/fold strip every 8 cells (1 m)."""
    rng = np.random.default_rng(seed)
    cp = n // cells
    d = np.zeros((n, n, 3), np.float32)
    mr = solid(n, (1.0, 0.28, 0.65))
    yy, xx = np.mgrid[0:n, 0:n]
    fy, fx = (yy % cp) / cp, (xx % cp) / cp
    cellv = rng.uniform(0.85, 1.15, (cells, cells)).astype(np.float32)
    per_cell = cellv[(yy // cp) % cells, (xx // cp) % cells]
    navy = np.asarray((0.06, 0.08, 0.15), np.float32)
    gold = np.asarray((0.10, 0.075, 0.03), np.float32)
    sheen = (0.5 * fx + 0.5 * fy)[..., None]
    d[:] = navy[None, None, :] * per_cell[..., None] + gold[None, None, :] * sheen
    d += 0.02 * (fbm(n, 2, 64, seed + 1)[..., None] - 0.5)
    mr[..., 1] = 0.26 + 0.06 * (per_cell - 0.85) / 0.3
    gap = ((xx % cp) < 2) | ((yy % cp) < 2)
    d[gap] = (0.62, 0.63, 0.66)
    mr[gap] = (1.0, 0.55, 0.35)
    bus = (((xx % cp) == cp // 3) | ((xx % cp) == 2 * cp // 3)) & ~gap
    d[bus] = (0.44, 0.46, 0.52)
    mr[bus] = (1.0, 0.38, 0.55)
    for k in range(int(tile)):
        p = int(k * n / tile)
        hline(d, p, 5, (0.72, 0.70, 0.64))
        hline(d, p - 3, 1, (0.3, 0.3, 0.32))
        hline(d, p + 3, 1, (0.3, 0.3, 0.32))
        hline(mr, p, 5, (1.0, 0.6, 0.15))
    return d, mr


def tex_solar_back(n=256, tile=2.0, seed=5):
    """Back of the flexible blanket: grey-gold with fold lines every metre and faint seams."""
    ppm = n / tile
    lum = 0.9 + 0.2 * fbm(n, 4, 4, seed)
    d = solid(n, (0.54, 0.50, 0.42)) * lum[..., None]
    for k in range(int(tile / 0.25)):
        hline(d, int(k * ppm * 0.25), 1, (0.42, 0.39, 0.33), 0.5)
    for k in range(int(tile)):
        hline(d, int(k * ppm), 3, (0.33, 0.30, 0.25), 0.9)
    return d


def tex_radiator(n=256, tile=1.0, seed=9):
    """White/light grey with fine horizontal fin lines (every ~3 cm) and a stronger line every 0.25 m."""
    lum = 0.97 + 0.06 * fbm(n, 3, 4, seed)
    d = solid(n, (0.80, 0.82, 0.84)) * lum[..., None]
    for y in range(0, n, 8):
        hline(d, y, 1, (0.62, 0.64, 0.67), 0.9)
    for y in range(0, n, 64):
        hline(d, y, 2, (0.5, 0.52, 0.55), 1.0)
    return d


def tex_metal(n=256, base=(0.30, 0.30, 0.32), rough=0.45, metal=0.9, seed=11, panel=True):
    """Brushed dark metal with panel lines and rivets."""
    lum = 0.85 + 0.3 * fbm(n, 5, 4, seed)
    s = fbm(n, 4, 4, seed + 1)
    streak = np.mean([np.roll(s, k, axis=1) for k in range(-12, 12)], axis=0)   # periodic horizontal blur
    lum = lum * (0.92 + 0.16 * streak)
    d = solid(n, base) * lum[..., None]
    mr = solid(n, (1.0, rough, metal))
    mr[..., 1] = np.clip(rough + 0.18 * (fbm(n, 4, 6, seed + 2) - 0.5), 0.15, 0.9)
    if panel:
        dark = tuple(c * 0.55 for c in base)
        light = tuple(min(1, c * 1.5) for c in base)
        for p in (0, n // 2):
            hline(d, p, 1, dark)
            vline(d, p, 1, dark)
            for k in range(8, n, 32):
                disc(d, k, p + 5, 1.5, light)
                disc(d, p + 5, k, 1.5, light)
    return d, mr


def tex_arm(n=256, tile=1.0, seed=13):
    """White arm boom: a dark ring every metre, faint seams, two small dark plates (no lettering)."""
    lum = 0.98 + 0.04 * fbm(n, 3, 4, seed)
    d = solid(n, (0.88, 0.88, 0.87)) * lum[..., None]
    hline(d, 0, 10, (0.14, 0.14, 0.15))
    hline(d, 7, 2, (0.5, 0.5, 0.52))
    for k in range(4):
        hline(d, k * n // 4, 1, (0.7, 0.7, 0.7), 0.5)
    rect(d, 70, 100, 100, 125, (0.12, 0.12, 0.13))
    rect(d, 150, 160, 190, 175, (0.12, 0.12, 0.13))
    return d


log("generating textures")
IMG = {}
IMG["hull_d"], IMG["hull_mr"] = tex_hull()
IMG["mli_d"], IMG["mli_mr"] = tex_mli()
IMG["solar_d"], IMG["solar_mr"] = tex_solar()
IMG["solar_back_d"] = tex_solar_back()
IMG["radiator_d"] = tex_radiator()
IMG["truss_d"], IMG["truss_mr"] = tex_metal(base=(0.30, 0.30, 0.32), rough=0.5, metal=0.9, seed=11)
IMG["fitting_d"], IMG["fitting_mr"] = tex_metal(base=(0.50, 0.50, 0.52), rough=0.45, metal=0.85, seed=17)
IMG["dock_d"], IMG["dock_mr"] = tex_metal(base=(0.58, 0.58, 0.60), rough=0.32, metal=0.95, seed=23, panel=False)
IMG["arm_d"] = tex_arm()
BIMG = {}
for k, arr in IMG.items():
    BIMG[k] = save_tex(f"tiangong_{k}", arr, noncolor=k.endswith("_mr"))
log("textures written to", TEX_DIR, {k: v for k, v in TEX_FILES.items()})

# --------------------------------------------------------------------------------------- materials
MATS = {}
MAT_TILE = {}   # material -> (metres per texture repeat in u, in v)


def material(name, rgb, metallic=0.0, roughness=0.6, diffuse=None, mr=None, tile=(1.0, 1.0)):
    """Principled material. diffuse/mr = Blender images (metallicRoughness via the Separate Color pattern
    the glTF exporter recognises: G -> Roughness, B -> Metallic)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if diffuse is not None:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = diffuse
        t.location = (-500, 300)
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    if mr is not None:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = mr
        t.location = (-500, -100)
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        sep.location = (-200, -100)
        nt.links.new(t.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    m.use_backface_culling = True  # -> glTF doubleSided: false
    m.diffuse_color = (*rgb, 1.0)
    m.metallic = metallic
    m.roughness = roughness
    MATS[name] = m
    MAT_TILE[name] = tile
    return m


material("HULL", (0.82, 0.82, 0.80), 0.0, 0.55, BIMG["hull_d"], BIMG["hull_mr"], (4.0, 4.0))        # white thermal blankets
material("MLI", (0.75, 0.58, 0.28), 0.6, 0.36, BIMG["mli_d"], BIMG["mli_mr"], (2.0, 2.0))           # gold foil
material("ARRAY", (0.08, 0.10, 0.17), 0.65, 0.28, BIMG["solar_d"], BIMG["solar_mr"], (2.0, 2.0))    # cell side
material("ARRAY_BACK", (0.52, 0.48, 0.40), 0.25, 0.65, BIMG["solar_back_d"], None, (2.0, 2.0))      # blanket back
material("ARRAY_FRAME", (0.12, 0.12, 0.13), 0.5, 0.5)                                                # masts, rails
material("TRUSS", (0.30, 0.30, 0.32), 0.9, 0.5, BIMG["truss_d"], BIMG["truss_mr"], (1.0, 1.0))      # trusses, drive housings
material("FITTING", (0.50, 0.50, 0.52), 0.85, 0.45, BIMG["fitting_d"], BIMG["fitting_mr"], (1.0, 1.0))  # grey fittings, handrails
material("DOCK", (0.58, 0.58, 0.60), 0.95, 0.32, BIMG["dock_d"], BIMG["dock_mr"], (1.0, 1.0))       # docking rings, nozzles
material("RADIATOR", (0.80, 0.82, 0.84), 0.0, 0.7, BIMG["radiator_d"], None, (1.0, 1.0))
material("ARM_WHITE", (0.88, 0.88, 0.87), 0.0, 0.5, BIMG["arm_d"], None, (1.0, 1.0))                # arm booms
material("ARM_JOINT", (0.06, 0.06, 0.07), 0.4, 0.35)                                                 # black joint housings
material("CAPSULE", (0.36, 0.31, 0.28), 0.1, 0.75)                                                   # Shenzhou re-entry capsule

# --------------------------------------------------------------------------------------- UV projection
# UVs are metres / MAT_TILE so every texture keeps the same texel density. Cylinders get a cylindrical
# projection with an integer number of repeats around (no seam mismatch), boxes a tri-planar one, wings a
# planar one along the wing axes.
TWO_PI = 2 * math.pi


def _loops_world(o):
    me = o.data
    loc = Vector(o.location)
    vs = [v.co + loc for v in me.vertices]
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    return me, vs, me.uv_layers.active.data


def _perp(d):
    e1 = d.cross(V(0, 0, 1))
    if e1.length < 1e-3:
        e1 = d.cross(V(1, 0, 0))
    e1.normalize()
    return e1, d.cross(e1)


def uv_cyl(o, mat, center, direction):
    """Cylindrical projection about the axis (center, direction) (glTF coords), v along the axis."""
    tu, tv = MAT_TILE[mat]
    c = B(center)
    d = B(direction).normalized()
    e1, e2 = _perp(d)
    me, vs, uv = _loops_world(o)
    rmax = max(((p - c) - (p - c).dot(d) * d).length for p in vs)
    circ = TWO_PI * rmax
    wraps = max(1, round(circ / tu))
    small = circ < 0.5 * tu
    for poly in me.polygons:
        pts = [vs[me.loops[li].vertex_index] - c for li in poly.loop_indices]
        if abs(poly.normal.dot(d)) > 0.9:  # cap: planar
            for li, p in zip(poly.loop_indices, pts):
                uv[li].uv = (p.dot(e1) / tu, p.dot(e2) / tv)
            continue
        angs = [math.atan2(p.dot(e2), p.dot(e1)) for p in pts]
        if max(angs) - min(angs) > math.pi:
            angs = [a + TWO_PI if a < 0 else a for a in angs]
        for li, p, a in zip(poly.loop_indices, pts, angs):
            u = a * rmax / tu if small else a / TWO_PI * wraps
            uv[li].uv = (u, p.dot(d) / tv)


def uv_box(o, mat):
    """Tri-planar projection by dominant face normal (Blender world coords, metres / tile)."""
    tu, tv = MAT_TILE[mat]
    me, vs, uv = _loops_world(o)
    for poly in me.polygons:
        n = poly.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        i, j = [k for k in range(3) if k != ax]
        for li in poly.loop_indices:
            p = vs[me.loops[li].vertex_index]
            uv[li].uv = (p[i] / tu, p[j] / tv)


def uv_planar(o, mat, origin, eu, ev):
    """Planar projection: u along eu, v along ev (glTF coords, metres / tile)."""
    tu, tv = MAT_TILE[mat]
    c = B(origin)
    bu = B(eu).normalized()
    bv = B(ev).normalized()
    me, vs, uv = _loops_world(o)
    for poly in me.polygons:
        for li in poly.loop_indices:
            p = vs[me.loops[li].vertex_index] - c
            uv[li].uv = (p.dot(bu) / tu, p.dot(bv) / tv)


# --------------------------------------------------------------------------------------- primitives
WORLD = {}  # object name -> world translation (Blender coords) at build time (root at origin)
ALL_MESHES = []
VEHICLE_MESHES = []


def _apply_rot_scale(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def _set_mat(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(MATS[mat])


def _rot_for(direction):
    """Euler that turns Blender +Z onto the Blender image of a glTF direction."""
    d = B(direction).normalized()
    return V(0, 0, 1).rotation_difference(d).to_euler()


def box(center, size, mat):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=B(center))
    o = bpy.context.active_object
    o.scale = Bsize(size)
    _apply_rot_scale(o)
    _set_mat(o, mat)
    uv_box(o, mat)
    return o


def cyl(center, direction, radius, length, mat, segs=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=segs, radius=radius, depth=length,
                                        location=B(center), rotation=_rot_for(direction))
    o = bpy.context.active_object
    _apply_rot_scale(o)
    _set_mat(o, mat)
    uv_cyl(o, mat, center, direction)
    return o


def cyl_from(start, direction, radius, length, mat, segs=24):
    """Cylinder whose base is at `start` and which extends `length` along `direction`."""
    d = Vector(direction).normalized()
    c = Vector(start) + d * (length / 2)
    return cyl(c, d, radius, length, mat, segs)


def cone_from(start, direction, r1, r2, length, mat, segs=24):
    """Frustum from radius r1 at `start` to r2 at start + direction*length."""
    d = Vector(direction).normalized()
    c = Vector(start) + d * (length / 2)
    bpy.ops.mesh.primitive_cone_add(vertices=segs, radius1=r1, radius2=r2, depth=length,
                                    location=B(c), rotation=_rot_for(d))
    o = bpy.context.active_object
    _apply_rot_scale(o)
    _set_mat(o, mat)
    uv_cyl(o, mat, c, d)
    return o


def sphere(center, radius, mat, segs=32, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=radius, location=B(center))
    o = bpy.context.active_object
    _apply_rot_scale(o)
    _set_mat(o, mat)
    uv_cyl(o, mat, center, (0, 1, 0))
    return o


def ring(center, direction, R, r, mat, segs=24, msegs=6):
    """Torus (hatch ring / port collar) with its axis along `direction`."""
    bpy.ops.mesh.primitive_torus_add(major_segments=segs, minor_segments=msegs, major_radius=R, minor_radius=r,
                                     location=B(center), rotation=_rot_for(direction))
    o = bpy.context.active_object
    _apply_rot_scale(o)
    _set_mat(o, mat)
    uv_box(o, mat)
    return o


def band(center, direction, R, mat, width=0.1, lip=0.035, segs=48):
    """Cheap hull band: a short cylinder standing `lip` proud of a hull of radius R (replaces a torus collar)."""
    return cyl(center, direction, R + lip, width, mat, segs)


def handrail(start, direction, length, up, mat="FITTING", r=0.02, standoff=0.08):
    """Thin rail `length` long from `start` along `direction`, held `standoff` off the surface by two posts (`up` = surface normal)."""
    d = Vector(direction).normalized()
    u = Vector(up).normalized()
    c = Vector(start) + d * (length / 2) + u * standoff
    size = [2 * r] * 3
    for i in range(3):
        if abs(d[i]) > 0.5:
            size[i] = length
    parts = [box(c, size, mat)]
    for t in (0.1, length - 0.1):
        pc = Vector(start) + d * t + u * (standoff / 2)
        ps = [2 * r] * 3
        for i in range(3):
            if abs(u[i]) > 0.5:
                ps[i] = standoff
        parts.append(box(pc, ps, mat))
    return parts


def wing_panel(center, size, length_dir, width_dir, normal_dir):
    """Thin solar blanket box: cell texture on the `normal_dir` face, blanket back elsewhere, planar UVs in
    metres so the 0.125 m cell grid never stretches."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=B(center))
    o = bpy.context.active_object
    o.scale = Bsize(size)
    _apply_rot_scale(o)
    o.data.materials.clear()
    o.data.materials.append(MATS["ARRAY"])
    o.data.materials.append(MATS["ARRAY_BACK"])
    nb = B(normal_dir).normalized()
    for poly in o.data.polygons:
        poly.material_index = 0 if poly.normal.dot(nb) > 0.5 else 1
    uv_planar(o, "ARRAY", center, width_dir, length_dir)
    return o


def shade_smooth(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(32))
    except Exception:  # noqa: BLE001
        try:
            bpy.ops.object.shade_smooth()
            o.data.set_sharp_from_angle(angle=math.radians(32))
        except Exception as e:  # noqa: BLE001
            log("smooth shading unavailable:", repr(e))


def finish(parts, name, origin, parent=None, vehicle=False):
    """Join `parts` into one mesh object `name`, put its origin at glTF point `origin`, parent it."""
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    o.data.name = name
    shade_smooth(o)
    # vehicles carry array joints: their node must stay in the root frame (identity), like the joints
    scene.cursor.location = B((0, 0, 0) if vehicle else origin)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    attach(o, parent)
    ALL_MESHES.append(o)
    if vehicle:
        VEHICLE_MESHES.append(o)
    return o


def attach(obj, parent):
    """Parent with an identity parent-inverse so the glTF local transform is a plain translation."""
    world = Vector(obj.location) if obj.parent is None else WORLD[obj.name]
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse.identity()
        obj.location = world - WORLD[parent.name]
    WORLD[obj.name] = world


def empty(name, pos, parent=None, size=0.5):
    """pos = glTF point, or None for an identity node sitting on its parent's origin."""
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = "PLAIN_AXES"
    e.empty_display_size = size
    coll.objects.link(e)
    e.location = B(pos) if pos is not None else WORLD[parent.name].copy()
    attach(e, parent)
    return e


JOINTS = []
DRIVEN_KINDS = {"alpha", "beta", "arm", "antenna"}


def joint(name, pivot, axis, kind, range_deg, approximate, parent):
    # Driven joints follow the ISS file's convention: the node's rest transform is the identity (so its
    # frame is the root frame) and the app replaces its matrix with a rotation about `pivot`, which is
    # therefore given in root-frame coordinates. Dock markers are not driven; they sit at the port face.
    e = empty(name, None if kind in DRIVEN_KINDS else pivot, parent)
    piv = [round(float(c), 4) for c in pivot]
    ax = unit(axis)
    e["pivot"] = piv
    e["axis"] = ax
    e["kind"] = kind
    e["rangeDeg"] = [float(range_deg[0]), float(range_deg[1])] if range_deg else [0.0, 0.0]
    e["approximate"] = bool(approximate)
    JOINTS.append({"node": name, "pivot": piv, "axis": ax, "kind": kind,
                   "rangeDeg": list(range_deg) if range_deg else None, "approximate": bool(approximate),
                   "parent": parent.name if parent else None})
    return e


# ======================================================================================= ROOT
root = empty("tiangong", (0, 0, 0), None, size=2.0)

# ======================================================================================= TIANHE
# Layout along Z (forward +Z -> aft -Z); total 16.6 m: forward dock face z=+8.3, aft dock face z=-8.3.
NODE_C = V(0, 0, 6.4)      # node sphere centre; the labs' axis passes through here
NODE_R = 1.45              # ~2.9 m diameter (approximate)
Z_FWD = 8.3
Z_AFT = -8.3

# --- node: sphere + 5 ports
parts = [sphere(NODE_C, NODE_R, "HULL", 40, 20)]
parts.append(cyl_from(NODE_C + V(0, 0, 1.1), (0, 0, 1), 0.75, Z_FWD - (NODE_C.z + 1.1), "HULL", 32))   # forward port tube
parts.append(cyl_from((0, 0, Z_FWD - 0.15), (0, 0, 1), 0.92, 0.15, "DOCK", 32))                        # forward docking ring
parts.append(cyl_from(NODE_C + V(0, -1.1, 0), (0, -1, 0), 0.75, 0.9, "HULL", 32))                       # nadir port tube -> y=-2.0
parts.append(cyl_from((0, -2.0 + 0.15, NODE_C.z), (0, -1, 0), 0.92, 0.15, "DOCK", 32))
parts.append(cyl_from(NODE_C + V(0, 1.1, 0), (0, 1, 0), 0.75, 0.9, "HULL", 32))                        # zenith hatch tube -> y=+2.0
parts.append(cyl_from((0, 2.0 - 0.15, NODE_C.z), (0, 1, 0), 0.92, 0.15, "DOCK", 32))
parts.append(cyl_from(NODE_C + V(1.1, 0, 0), (1, 0, 0), 0.95, 1.0, "HULL", 32))                        # port berth -> x=+2.1
parts.append(cyl_from(NODE_C + V(-1.1, 0, 0), (-1, 0, 0), 0.95, 1.0, "HULL", 32))                      # starboard berth -> x=-2.1
# detail: hatch rings on the three free ports, collars where the tubes leave the sphere, camera/equipment boxes
parts.append(ring((0, 0, Z_FWD - 0.08), (0, 0, 1), 0.78, 0.06, "DOCK"))
parts.append(ring((0, -2.0 + 0.08, NODE_C.z), (0, -1, 0), 0.78, 0.06, "DOCK"))
parts.append(ring((0, 2.0 - 0.08, NODE_C.z), (0, 1, 0), 0.78, 0.06, "DOCK"))
parts.append(band(NODE_C + V(0, 0, 1.3), (0, 0, 1), 0.75, "FITTING", 0.12, 0.04, 32))
parts.append(band(NODE_C + V(0, 1.3, 0), (0, 1, 0), 0.75, "FITTING", 0.12, 0.04, 32))
parts.append(band(NODE_C + V(0, -1.3, 0), (0, -1, 0), 0.75, "FITTING", 0.12, 0.04, 32))
parts.append(box(NODE_C + V(0.75, 1.05, 0.75), (0.3, 0.25, 0.3), "FITTING"))
parts.append(box(NODE_C + V(-0.75, 1.05, 0.75), (0.3, 0.25, 0.3), "FITTING"))
parts.append(box(NODE_C + V(0.0, -1.1, 0.9), (0.35, 0.2, 0.25), "FITTING"))
finish(parts, "TIANHE_NODE", NODE_C, root)

# --- small cylinder (life support), 2.8 m diameter, from the node sphere to the cone
SC_R = 1.4
z_sc0 = NODE_C.z - NODE_R          # 4.95
z_sc1 = 2.1
parts = [cyl_from((0, 0, z_sc0), (0, 0, -1), SC_R, z_sc0 - z_sc1, "HULL", 48)]
parts.append(cone_from((0, 0, z_sc1), (0, 0, -1), SC_R, 2.1, 0.6, "MLI", 48))   # transition to 4.2 m
parts.append(band((0, 0, z_sc0 - 0.06), (0, 0, 1), SC_R, "FITTING"))                                   # collar at the node
for sx in (1, -1):
    parts += handrail((sx * 0.9, math.sqrt(SC_R ** 2 - 0.81) - 0.02, 4.7), (0, 0, -1), 1.4, (0, 1, 0))
    parts += handrail((sx * (math.sqrt(SC_R ** 2 - 0.25) - 0.02), 0.5, 4.6), (0, 0, -1), 2.2, (sx, 0, 0))
parts.append(box((-0.9, -math.sqrt(SC_R ** 2 - 0.81) - 0.1, 3.4), (0.4, 0.3, 0.6), "FITTING"))      # equipment box, nadir side
finish(parts, "TIANHE_SMALL_CYLINDER", (0, 0, (z_sc0 + z_sc1) / 2), root)

# --- large cylinder (living section), 4.2 m diameter
LC_R = 2.1
z_lc0 = 1.5
z_lc1 = -5.0
parts = [cyl_from((0, 0, z_lc0), (0, 0, -1), LC_R, z_lc0 - z_lc1, "HULL", 48)]
# a few handrails along the top (cheap)
for zz in (0.0, -2.5):
    parts.append(box((0.9, LC_R + 0.08, zz), (0.05, 0.05, 1.6), "FITTING"))
    parts.append(box((-0.9, LC_R + 0.08, zz), (0.05, 0.05, 1.6), "FITTING"))
# detail: panel-joint bands, side handrails, equipment boxes, GNSS patches
for zz in (-0.6, -3.2):
    parts.append(band((0, 0, zz), (0, 0, 1), LC_R, "FITTING"))
for sx in (1, -1):
    for z0 in (1.2, -1.2, -3.6):
        parts += handrail((sx * (math.sqrt(LC_R ** 2 - 0.36) - 0.02), 0.6, z0), (0, 0, -1), 1.4, (sx, 0, 0))
    parts.append(box((sx * (LC_R - 0.05), -0.8, -1.5), (0.5, 0.45, 0.9), "FITTING"))
    parts.append(box((sx * 0.5, LC_R - 0.02, 0.9), (0.28, 0.08, 0.28), "FITTING"))
    parts.append(box((sx * 1.6, -(LC_R - 0.05), -4.0), (0.4, 0.3, 0.6), "FITTING"))
parts.append(cyl_from((0, LC_R - 0.05, -4.3), (0, 1, 0), 0.03, 0.6, "FITTING", 6))                   # whip antenna
finish(parts, "TIANHE_LARGE_CYLINDER", (0, 0, (z_lc0 + z_lc1) / 2), root)

# --- resource / service section (approximate 2.8 m diameter) with the aft port and the HGA mast
RS_R = 1.4
z_rs0 = -5.6
z_rs1 = -7.9
parts = [cone_from((0, 0, z_lc1), (0, 0, -1), LC_R, RS_R, abs(z_lc1 - z_rs0), "MLI", 48)]
parts.append(cyl_from((0, 0, z_rs0), (0, 0, -1), RS_R, z_rs0 - z_rs1, "MLI", 48))
parts.append(cyl_from((0, 0, z_rs1), (0, 0, -1), 0.75, z_rs1 - Z_AFT, "HULL", 32))                   # aft port tube
parts.append(cyl_from((0, 0, Z_AFT + 0.15), (0, 0, -1), 0.92, 0.15, "DOCK", 32))                      # aft docking ring
HGA_Z = -6.0
parts.append(cyl_from((0, RS_R - 0.1, HGA_Z), (0, 1, 0), 0.08, 1.1, "FITTING", 12))                   # HGA mast (fixed)
for sx in (1, -1):  # solar wing drive housings on the hull
    parts.append(cyl_from((sx * (RS_R - 0.2), 0, -6.7), (sx, 0, 0), 0.3, 0.45, "FITTING", 16))
# detail: collar rings, hatch ring, aft thruster quads, tank domes under the blankets, antennas
parts.append(band((0, 0, z_rs0 - 0.06), (0, 0, 1), RS_R, "FITTING"))
parts.append(band((0, 0, z_rs1 + 0.06), (0, 0, 1), RS_R, "FITTING"))
parts.append(ring((0, 0, Z_AFT + 0.08), (0, 0, -1), 0.78, 0.06, "DOCK"))
parts.append(band((0, 0, z_rs1 - 0.08), (0, 0, 1), 0.75, "FITTING", 0.12, 0.05, 32))
for (dx, dy) in ((0.95, 0.95), (-0.95, 0.95), (0.95, -0.95), (-0.95, -0.95)):                      # aft thruster pods
    parts.append(box((dx, dy, z_rs1 - 0.05), (0.26, 0.26, 0.3), "FITTING"))
    parts.append(cone_from((dx, dy, z_rs1 - 0.15), (0, 0, -1), 0.06, 0.11, 0.25, "DOCK", 10))
parts.append(cyl_from((0, -(RS_R - 0.05), -6.3), (0, -1, 0), 0.03, 0.7, "FITTING", 6))
parts.append(cyl_from((RS_R - 0.05, 0.5, -5.9), (1, 0, 0), 0.025, 0.5, "FITTING", 6))
finish(parts, "TIANHE_RESOURCE", (0, 0, (z_lc1 + Z_AFT) / 2), root)

# --- Tianhe solar wings: one-axis alpha drives, 12.6 m per wing (design paper), ~2.5 m wide (approx.)
TH_WING_L = 12.6
TH_WING_W = 2.5
TH_WING_Z = -6.7
for tag, sx in (("PORT", 1), ("STBD", -1)):
    pivot = V(sx * RS_R, 0, TH_WING_Z)
    j = joint(f"TIANHE_ARRAY_{tag}_ALPHA", pivot, (sx, 0, 0), "alpha", (-180, 180), False, root)
    x0 = sx * (RS_R + 0.25)
    parts = [cyl_from(pivot, (sx, 0, 0), 0.09, TH_WING_L + 0.3, "ARRAY_FRAME", 10)]                   # boom
    pc = V(sx * (RS_R + 0.25 + TH_WING_L / 2), 0, TH_WING_Z)
    parts.append(wing_panel(pc, (TH_WING_L, 0.05, TH_WING_W), (sx, 0, 0), (0, 0, 1), (0, 1, 0)))
    for dz in (TH_WING_W / 2, -TH_WING_W / 2):
        parts.append(box((sx * (RS_R + 0.25 + TH_WING_L / 2), 0, TH_WING_Z + dz), (TH_WING_L, 0.08, 0.08), "ARRAY_FRAME"))
    # tension frame: cross bars on the back every 2.1 m, tip bar, root fitting
    for k in range(7):
        xx = sx * (RS_R + 0.25 + k * 2.1)
        parts.append(box((xx, -0.06, TH_WING_Z), (0.06, 0.06, TH_WING_W), "ARRAY_FRAME"))
    parts.append(box((sx * (RS_R + 0.25 + TH_WING_L), 0, TH_WING_Z), (0.08, 0.1, TH_WING_W + 0.08), "ARRAY_FRAME"))
    parts.append(cyl_from(pivot, (sx, 0, 0), 0.14, 0.3, "ARM_JOINT", 12))
    finish(parts, f"TIANHE_ARRAY_{tag}", pivot, j)

# --- steerable relay dish (approximate position; 2 implied gimbal axes, boresight +Y at rest)
hga_pivot = V(0, RS_R + 1.0, HGA_Z)
j = joint("TIANHE_HGA", hga_pivot, (0, 1, 0), "antenna", (-90, 90), True, root)
parts = [sphere(hga_pivot, 0.14, "ARM_JOINT", 12, 8)]
parts.append(cone_from(hga_pivot + V(0, 0.1, 0), (0, 1, 0), 0.12, 0.65, 0.32, "HULL", 32))             # dish
parts.append(cyl_from(hga_pivot + V(0, 0.42, 0), (0, 1, 0), 0.03, 0.4, "FITTING", 8))                  # feed
parts.append(ring(hga_pivot + V(0, 0.42, 0), (0, 1, 0), 0.62, 0.025, "FITTING", 32, 5))                # dish rim
parts.append(cone_from(hga_pivot + V(0, 0.82, 0), (0, 1, 0), 0.03, 0.08, 0.05, "FITTING", 10))        # feed horn
finish(parts, "TIANHE_HGA_DISH", hga_pivot, j)

# --- small antennas on the node (cheap)
parts = []
for (x, y, z, d) in ((0.9, 0.9, 7.0, (0, 1, 0)), (-0.9, 0.9, 7.0, (0, 1, 0)), (0, -0.4, 7.9, (0, 0, 1))):
    parts.append(cyl_from((x, y, z), d, 0.025, 1.0, "FITTING", 6))
    parts.append(cyl_from((x, y, z), d, 0.06, 0.12, "ARM_JOINT", 8))                                  # base
parts.append(cone_from((0.95, 0.95, 6.1), (0.7, 0.7, 0), 0.03, 0.2, 0.12, "HULL", 16))                 # small horn/dish
finish(parts, "TIANHE_ANTENNAS", NODE_C, root)

# ======================================================================================= DOCKING PORTS (informational empties)
joint("DOCK_FORWARD", (0, 0, Z_FWD), (0, 0, 1), "dock", None, False, root)
joint("DOCK_AFT", (0, 0, Z_AFT), (0, 0, -1), "dock", None, False, root)
joint("DOCK_NADIR", (0, -2.0, NODE_C.z), (0, -1, 0), "dock", None, True, root)
joint("DOCK_ZENITH", (0, 2.0, NODE_C.z), (0, 1, 0), "dock", None, True, root)
joint("BERTH_PORT", (2.1, 0, NODE_C.z), (1, 0, 0), "dock", None, True, root)
joint("BERTH_STBD", (-2.1, 0, NODE_C.z), (-1, 0, 0), "dock", None, True, root)

# ======================================================================================= LABS (Wentian -X, Mengtian +X)
LAB_LEN = 17.9
LAB_R = 2.1
LAB_RS_R = 1.4
LAB_Z = NODE_C.z
LAB_WING_L = 27.0
LAB_WING_W = 4.0


def lab(prefix, sx):
    """sx = -1 for Wentian (starboard), +1 for Mengtian (port). Returns the truss x."""
    x_in = sx * 2.1                     # berth face
    x_work = sx * 11.0                  # end of the working section
    x_cone = sx * 11.6
    x_res = sx * 17.8                   # end of the resource section
    x_tip = sx * (2.1 + LAB_LEN)        # 20.0: outboard end of the truss
    out = (sx, 0, 0)

    # body: working section + cone + resource section
    parts = [cyl_from((x_in, 0, LAB_Z), out, LAB_R, abs(x_work - x_in), "HULL", 48)]
    parts.append(cone_from((x_work, 0, LAB_Z), out, LAB_R, LAB_RS_R, abs(x_cone - x_work), "MLI", 48))
    parts.append(cyl_from((x_cone, 0, LAB_Z), out, LAB_RS_R, abs(x_res - x_cone), "MLI", 48))
    parts.append(cyl_from((x_res, 0, LAB_Z), out, 0.8, 0.5, "FITTING", 16))                           # resource-section end cap
    for zz in (LAB_Z + 0.8, LAB_Z - 0.8):                                                              # handrails
        parts.append(box((sx * 6.5, LAB_R + 0.08, zz), (6.0, 0.05, 0.05), "FITTING"))
    # detail: collar rings, more handrails (nadir side and flanks), equipment boxes, thruster quads, antennas
    parts.append(band((x_in + sx * 0.06, 0, LAB_Z), out, LAB_R, "FITTING"))
    parts.append(band((sx * 6.6, 0, LAB_Z), out, LAB_R, "FITTING"))
    parts.append(band((x_work - sx * 0.06, 0, LAB_Z), out, LAB_R, "FITTING"))
    parts.append(band((x_res - sx * 0.06, 0, LAB_Z), out, LAB_RS_R, "FITTING"))
    for x0 in (3.2, 5.0, 7.6):
        parts += handrail((sx * x0, -(math.sqrt(LAB_R ** 2 - 0.25) - 0.02), LAB_Z + 0.5), (sx, 0, 0), 1.4, (0, -1, 0))
        parts += handrail((sx * x0, 0.4, LAB_Z + math.sqrt(LAB_R ** 2 - 0.16) - 0.02), (sx, 0, 0), 1.4, (0, 0, 1))
        parts += handrail((sx * x0, -0.4, LAB_Z - math.sqrt(LAB_R ** 2 - 0.16) + 0.02), (sx, 0, 0), 1.4, (0, 0, -1))
    parts.append(box((sx * 4.2, -0.9, LAB_Z + LAB_R - 0.05), (0.9, 0.5, 0.45), "FITTING"))
    parts.append(box((sx * 9.3, 0.9, LAB_Z - LAB_R + 0.05), (0.7, 0.45, 0.4), "FITTING"))
    parts.append(box((sx * 8.5, -(LAB_R - 0.05), LAB_Z - 0.9), (0.6, 0.4, 0.5), "FITTING"))
    parts.append(box((sx * 3.4, LAB_R - 0.03, LAB_Z - 1.1), (0.3, 0.08, 0.3), "FITTING"))             # GNSS patch
    for (dy, dz) in ((0.95, 0.95), (-0.95, 0.95), (0.95, -0.95), (-0.95, -0.95)):                  # thruster pods
        parts.append(box((x_res - sx * 0.1, dy, LAB_Z + dz), (0.3, 0.25, 0.25), "FITTING"))
        parts.append(cone_from((x_res + sx * 0.05, dy, LAB_Z + dz), out, 0.05, 0.1, 0.28, "DOCK", 10))
    parts.append(cyl_from((sx * 15.0, LAB_RS_R - 0.05, LAB_Z), (0, 1, 0), 0.03, 0.7, "FITTING", 6))
    parts.append(cyl_from((sx * 13.0, -(LAB_RS_R - 0.05), LAB_Z), (0, -1, 0), 0.03, 0.6, "FITTING", 6))
    finish(parts, f"{prefix}_BODY", ((x_in + x_res) / 2, 0, LAB_Z), root)

    # truss / boom carrying the two alpha drives
    parts = [box(((x_res + x_tip) / 2, 0, LAB_Z), (abs(x_tip - x_res), 0.9, 0.9), "TRUSS")]
    parts.append(box(((x_res + x_tip) / 2, 0, LAB_Z), (1.2, 0.3, 2.6), "TRUSS"))                       # cross beam fwd/aft
    # detail: longerons along the truss edges and a tip plate
    for (dy, dz) in ((0.45, 0.45), (-0.45, 0.45), (0.45, -0.45), (-0.45, -0.45)):
        parts.append(box(((x_res + x_tip) / 2, dy, LAB_Z + dz), (abs(x_tip - x_res) + 0.04, 0.1, 0.1), "FITTING"))
    parts.append(box((x_tip - sx * 0.03, 0, LAB_Z), (0.06, 1.0, 1.0), "FITTING"))
    parts.append(ring((x_res + sx * 0.05, 0, LAB_Z), out, 0.62, 0.05, "FITTING", 20, 6))
    finish(parts, f"{prefix}_TRUSS", ((x_res + x_tip) / 2, 0, LAB_Z), root)

    # radiator: flat panel aft (-Z) of the resource section
    rad_c = (sx * 14.6, 0, LAB_Z - LAB_RS_R - 0.12)
    parts = [box(rad_c, (4.8, 2.4, 0.05), "RADIATOR")]
    parts.append(box((rad_c[0], 0, LAB_Z - LAB_RS_R + 0.02), (4.6, 0.1, 0.2), "FITTING"))
    # detail: frame bars around the panel and two struts to the hull
    for dy in (1.2, -1.2):
        parts.append(box((rad_c[0], dy, rad_c[2]), (4.84, 0.06, 0.08), "FITTING"))
    for dx in (2.4, -2.4):
        parts.append(box((rad_c[0] + dx, 0, rad_c[2]), (0.06, 2.4, 0.08), "FITTING"))
    for dx in (1.6, -1.6):
        parts.append(box((rad_c[0] + dx, 0, LAB_Z - LAB_RS_R + 0.05), (0.08, 0.6, 0.12), "FITTING"))
    finish(parts, f"{prefix}_RADIATOR", rad_c, root)

    # two large wings: alpha about X at the truss, beta about the wing's own axis Z
    xt = (x_res + x_tip) / 2
    for tag, sz in (("FWD", 1), ("AFT", -1)):
        a_piv = V(xt, 0, LAB_Z + sz * 0.5)
        a = joint(f"{prefix}_ARRAY_{tag}_ALPHA", a_piv, (sx, 0, 0), "alpha", (-180, 180), False, root)
        parts = [cyl_from(a_piv, (0, 0, sz), 0.4, 0.8, "TRUSS", 24)]                                   # alpha drive housing
        parts.append(ring(a_piv + V(0, 0, sz * 0.4), (0, 0, sz), 0.4, 0.04, "ARM_JOINT", 20, 6))
        finish(parts, f"{prefix}_ARRAY_{tag}_DRIVE", a_piv, a)
        b_piv = a_piv + V(0, 0, sz * 0.8)
        b = joint(f"{prefix}_ARRAY_{tag}_BETA", b_piv, (0, 0, sz), "beta", (-180, 180), False, a)
        parts = [box(b_piv + V(0, 0, sz * (LAB_WING_L + 0.3) / 2), (0.35, 0.35, LAB_WING_L + 0.3), "ARRAY_FRAME")]   # mast
        pc = b_piv + V(0, 0, sz * (0.3 + LAB_WING_L / 2))
        parts.append(wing_panel(pc, (LAB_WING_W, 0.06, LAB_WING_L), (0, 0, sz), (1, 0, 0), (0, 1, 0)))
        for dx in (LAB_WING_W / 2, -LAB_WING_W / 2):
            parts.append(box(pc + V(dx, 0, 0), (0.1, 0.12, LAB_WING_L), "ARRAY_FRAME"))
        # tension frame: cross bars on the back every 3 m, tip bar, beta drive collar
        for k in range(9):
            zz = b_piv.z + sz * (0.3 + k * 3.0)
            parts.append(box((xt, -0.08, zz), (LAB_WING_W, 0.06, 0.06), "ARRAY_FRAME"))
        parts.append(box((xt, 0, b_piv.z + sz * (0.3 + LAB_WING_L - 0.05)), (LAB_WING_W + 0.1, 0.12, 0.1), "ARRAY_FRAME"))
        parts.append(cyl_from(b_piv, (0, 0, sz), 0.3, 0.3, "ARM_JOINT", 20))
        finish(parts, f"{prefix}_ARRAY_{tag}", b_piv, b)
    return xt


# Wentian (starboard, -X): body + EVA airlock bulge + small arm (EMM)
lab("WENTIAN", -1)
air_c = V(-12.9, 1.8, LAB_Z)
parts = [cyl_from((-11.7, 1.8, LAB_Z), (-1, 0, 0), 1.0, 2.4, "HULL", 32)]
parts.append(cyl_from((-14.1, 1.8, LAB_Z), (-1, 0, 0), 0.6, 0.25, "DOCK", 24))                         # EVA hatch
parts.append(box((-12.9, 0.9, LAB_Z), (2.0, 0.6, 1.6), "HULL"))                                        # saddle to the hull
parts.append(ring((-14.3, 1.8, LAB_Z), (-1, 0, 0), 0.5, 0.05, "FITTING", 24, 6))                       # hatch ring
parts.append(band((-11.78, 1.8, LAB_Z), (-1, 0, 0), 1.0, "FITTING", 0.1, 0.035, 32))                  # collar
parts += handrail((-12.2, 2.70, LAB_Z + 0.4), (-1, 0, 0), 1.4, (0, 1, 0))
parts += handrail((-12.2, 2.70, LAB_Z - 0.4), (-1, 0, 0), 1.4, (0, 1, 0))
parts.append(box((-12.9, 1.9, LAB_Z + 1.0), (0.5, 0.35, 0.3), "FITTING"))                              # EVA light/camera box
finish(parts, "WENTIAN_AIRLOCK", air_c, root)

# Mengtian (port, +X): body + payload airlock (cargo airlock, nadir side)
lab("MENGTIAN", 1)
pa_c = V(12.9, -1.5, LAB_Z)
parts = [box(pa_c, (2.6, 1.9, 2.4), "HULL")]
parts.append(box((12.9, -2.5, LAB_Z), (2.2, 0.1, 2.0), "DOCK"))                                        # outer hatch
for dx in (1.15, -1.15):                                                                               # hatch frame
    parts.append(box((12.9 + dx, -2.46, LAB_Z), (0.12, 0.1, 2.3), "FITTING"))
for dz in (1.15, -1.15):
    parts.append(box((12.9, -2.46, LAB_Z + dz), (2.4, 0.1, 0.12), "FITTING"))
for dz in (0.9, -0.9):                                                                                 # edge rails
    parts.append(box((12.9, -0.9, LAB_Z + dz * 1.33), (2.6, 0.08, 0.08), "FITTING"))
parts += handrail((14.18, -1.2, LAB_Z - 0.7), (0, 0, 1), 1.4, (1, 0, 0))
finish(parts, "MENGTIAN_PAYLOAD_AIRLOCK", pa_c, root)

# ======================================================================================= ARMS
ARM_RANGE = (-270, 270)


def housing(center, axis, r, length):
    return cyl(center, axis, r, length, "ARM_JOINT", 16)


def boom(start, direction, r, length, segs=12):
    """White boom with black end caps."""
    d = Vector(direction).normalized()
    s = Vector(start)
    cap = min(0.12, length * 0.2)
    return [cyl_from(s, d, r, length, "ARM_WHITE", segs),
            cyl_from(s, d, r + 0.015, cap, "ARM_JOINT", segs),
            cyl_from(s + d * (length - cap), d, r + 0.015, cap, "ARM_JOINT", segs)]


# --- CMM: Tianhe's 10 m arm, base on the small cylinder near the node (zenith side), folded back along the hull
cx, cz = 0.5, 3.6
y_hull = math.sqrt(SC_R ** 2 - cx ** 2)
parts = [cyl_from((cx, y_hull - 0.1, cz), (0, 1, 0), 0.32, 1.9 - (y_hull - 0.1), "FITTING", 20)]
parts.append(ring((cx, 1.85, cz), (0, 1, 0), 0.3, 0.04, "ARM_JOINT", 20, 6))
parts.append(ring((cx, y_hull + 0.05, cz), (0, 1, 0), 0.34, 0.05, "ARM_JOINT", 20, 6))
finish(parts, "CMM_BASE", (cx, y_hull, cz), root)

p = V(cx, 1.9, cz)
shr = joint("CMM_SHR", p, (0, 1, 0), "arm", ARM_RANGE, True, root)
finish([housing(p + V(0, 0.2, 0), (0, 1, 0), 0.28, 0.4)], "CMM_SEG_SHR", p, shr)

p = V(cx, 2.3, cz)
shy = joint("CMM_SHY", p, (0, 0, 1), "arm", ARM_RANGE, True, shr)
finish([housing(p, (0, 0, 1), 0.28, 0.55), cyl_from(p, (0, 1, 0), 0.17, 0.4, "ARM_WHITE", 12)], "CMM_SEG_SHY", p, shy)

p = V(cx, 2.7, cz)
shp = joint("CMM_SHP", p, (1, 0, 0), "arm", ARM_RANGE, True, shy)
parts = [housing(p, (1, 0, 0), 0.28, 0.55)] + boom(p, (0, 0, -1), 0.17, 4.5)                          # boom 1 (aft)
finish(parts, "CMM_BOOM_1", p, shp)

p = V(cx, 2.7, cz - 4.5)
ep = joint("CMM_EP", p, (1, 0, 0), "arm", ARM_RANGE, True, shp)
parts = [housing(p, (1, 0, 0), 0.3, 0.6), cyl_from(p, (0, 1, 0), 0.17, 0.6, "ARM_WHITE", 12),
         housing(p + V(0, 0.6, 0), (1, 0, 0), 0.3, 0.6)] + boom(p + V(0, 0.6, 0), (0, 0, 1), 0.17, 4.5)  # boom 2 (fwd)
finish(parts, "CMM_BOOM_2", p, ep)

p = V(cx, 3.3, cz)
wp = joint("CMM_WP", p, (1, 0, 0), "arm", ARM_RANGE, True, ep)
finish([housing(p, (1, 0, 0), 0.28, 0.55), cyl_from(p, (0, 0, 1), 0.15, 0.5, "ARM_WHITE", 12)], "CMM_SEG_WP", p, wp)

p = V(cx, 3.3, cz + 0.5)
wy = joint("CMM_WY", p, (0, 1, 0), "arm", ARM_RANGE, True, wp)
finish([housing(p, (0, 1, 0), 0.28, 0.55), cyl_from(p, (0, 0, 1), 0.15, 0.5, "ARM_WHITE", 12)], "CMM_SEG_WY", p, wy)

p = V(cx, 3.3, cz + 1.0)
wr = joint("CMM_WR", p, (0, 0, 1), "arm", ARM_RANGE, True, wy)
finish([cyl_from(p, (0, 0, 1), 0.26, 0.8, "FITTING", 20), cyl_from(p + V(0, 0, 0.8), (0, 0, 1), 0.2, 0.15, "DOCK", 20),
        ring(p + V(0, 0, 0.4), (0, 0, 1), 0.26, 0.03, "ARM_JOINT", 20, 6),
        box(p + V(0.3, 0, 0.35), (0.14, 0.14, 0.3), "ARM_JOINT")],                                     # camera/light unit
       "CMM_END_EFFECTOR", p, wr)

# --- EMM: Wentian's 5 m arm, base on the working section (zenith side), folded along the lab
ex, ez = -6.0, LAB_Z
parts = [cyl_from((ex, LAB_R - 0.1, ez), (0, 1, 0), 0.2, 0.4, "FITTING", 16)]
parts.append(ring((ex, LAB_R + 0.25, ez), (0, 1, 0), 0.19, 0.03, "ARM_JOINT", 16, 6))
finish(parts, "EMM_BASE", (ex, LAB_R, ez), root)

p = V(ex, 2.3, ez)
eshr = joint("EMM_SHR", p, (0, 1, 0), "arm", ARM_RANGE, True, root)
finish([housing(p + V(0, 0.125, 0), (0, 1, 0), 0.17, 0.25)], "EMM_SEG_SHR", p, eshr)

p = V(ex, 2.55, ez)
eshy = joint("EMM_SHY", p, (1, 0, 0), "arm", ARM_RANGE, True, eshr)
finish([housing(p, (1, 0, 0), 0.17, 0.35), cyl_from(p, (0, 1, 0), 0.1, 0.3, "ARM_WHITE", 10)], "EMM_SEG_SHY", p, eshy)

p = V(ex, 2.85, ez)
eshp = joint("EMM_SHP", p, (0, 0, 1), "arm", ARM_RANGE, True, eshy)
finish([housing(p, (0, 0, 1), 0.17, 0.35)] + boom(p, (-1, 0, 0), 0.1, 2.0, 10), "EMM_BOOM_1", p, eshp)

p = V(ex - 2.0, 2.85, ez)
eep = joint("EMM_EP", p, (0, 0, 1), "arm", ARM_RANGE, True, eshp)
parts = [housing(p, (0, 0, 1), 0.18, 0.38), cyl_from(p, (0, 1, 0), 0.1, 0.35, "ARM_WHITE", 10),
         housing(p + V(0, 0.35, 0), (0, 0, 1), 0.18, 0.38)] + boom(p + V(0, 0.35, 0), (1, 0, 0), 0.1, 2.0, 10)
finish(parts, "EMM_BOOM_2", p, eep)

p = V(ex, 3.2, ez)
ewp = joint("EMM_WP", p, (0, 0, 1), "arm", ARM_RANGE, True, eep)
finish([housing(p, (0, 0, 1), 0.17, 0.35), cyl_from(p, (1, 0, 0), 0.09, 0.3, "ARM_WHITE", 10)], "EMM_SEG_WP", p, ewp)

p = V(ex + 0.3, 3.2, ez)
ewy = joint("EMM_WY", p, (0, 1, 0), "arm", ARM_RANGE, True, ewp)
finish([housing(p, (0, 1, 0), 0.17, 0.35), cyl_from(p, (1, 0, 0), 0.09, 0.3, "ARM_WHITE", 10)], "EMM_SEG_WY", p, ewy)

p = V(ex + 0.6, 3.2, ez)
ewr = joint("EMM_WR", p, (1, 0, 0), "arm", ARM_RANGE, True, ewy)
finish([cyl_from(p, (1, 0, 0), 0.15, 0.5, "FITTING", 16), cyl_from(p + V(0.5, 0, 0), (1, 0, 0), 0.12, 0.1, "DOCK", 16),
        ring(p + V(0.25, 0, 0), (1, 0, 0), 0.15, 0.02, "ARM_JOINT", 16, 6)],
       "EMM_END_EFFECTOR", p, ewr)

# ======================================================================================= VISITING VEHICLES
class Frame:
    """Local vehicle frame: ea = vehicle axis pointing away from the station, ex = array direction (+X side), et = ex x ea."""

    def __init__(self, origin, ea, ex=(1, 0, 0)):
        self.o = Vector(origin)
        self.ea = Vector(ea)
        self.ex = Vector(ex)
        self.et = self.ex.cross(self.ea)

    def pt(self, x, t, a):
        return self.o + self.ex * x + self.et * t + self.ea * a

    def size(self, sx, st, sa):
        # frames here are axis-aligned (signed permutations), so sizes just permute
        v = Vector((abs(self.ex.x) * sx + abs(self.et.x) * st + abs(self.ea.x) * sa,
                    abs(self.ex.y) * sx + abs(self.et.y) * st + abs(self.ea.y) * sa,
                    abs(self.ex.z) * sx + abs(self.et.z) * st + abs(self.ea.z) * sa))
        return v

    def cell_side(self):
        """Which side of a vehicle wing carries the cells: prefer zenith, then forward, then port."""
        return self.et if self.et.dot(V(0.3, 1.0, 0.6)) > 0 else -self.et


def vehicle_wing(f, piv, sx, wl, width, root_gap, frame_r=0.06):
    """Common vehicle wing: boom, blanket (cells on f.cell_side()), rails, cross bars, root drive collar."""
    # the blanket is wl along f.ex, `width` along f.ea and 0.04 thick along f.et (its normal)
    parts = [cyl_from(piv, f.ex * sx, frame_r, wl + root_gap, "ARRAY_FRAME", 8)]
    pc = f.pt(sx * (1.4 + root_gap + wl / 2), 0, piv_a(f, piv))
    parts.append(wing_panel(pc, f.size(wl, 0.04, width), f.ex * sx, f.ea, f.cell_side()))
    parts.append(box(pc, f.size(wl + 0.05, 0.08, 0.08), "ARRAY_FRAME"))
    back = -f.cell_side()
    for da in (width / 2, -width / 2):
        parts.append(box(pc + f.ea * da, f.size(wl + 0.05, 0.06, 0.06), "ARRAY_FRAME"))
    nbar = int(wl / 1.5)
    for k in range(nbar + 1):
        c = f.pt(sx * (1.4 + root_gap + k * wl / nbar), 0, piv_a(f, piv)) + back * 0.025
        parts.append(box(c, f.size(0.04, 0.03, width), "ARRAY_FRAME"))
    parts.append(cyl_from(piv, f.ex * sx, 0.12, 0.2, "ARM_JOINT", 10))
    return parts


def piv_a(f, piv):
    return (Vector(piv) - f.o).dot(f.ea)


def shenzhou(name, frame):
    """Shenzhou: 9.25 m long, 2.8 m diameter, 17 m array span. Stack from the docking face: orbital module,
    return capsule, service module (+ engine). Module proportions approximate."""
    f = frame
    A = f.ea
    parts = [cyl_from(f.pt(0, 0, 0), A, 0.9, 0.35, "DOCK", 32)]                           # docking collar
    parts.append(cyl_from(f.pt(0, 0, 0.35), A, 1.12, 2.45, "HULL", 32))                    # orbital module (to 2.8)
    parts.append(cone_from(f.pt(0, 0, 2.8), A, 0.85, 1.25, 1.6, "CAPSULE", 32))            # return capsule (bell)
    parts.append(cyl_from(f.pt(0, 0, 4.4), A, 1.25, 0.6, "FITTING", 32))                   # heat shield rim
    parts.append(cyl_from(f.pt(0, 0, 5.0), A, 1.4, 3.6, "HULL", 32))                       # service module (to 8.6)
    parts.append(cone_from(f.pt(0, 0, 8.6), A, 1.4, 1.1, 0.3, "MLI", 32))
    parts.append(cone_from(f.pt(0, 0, 8.9), A, 0.25, 0.4, 0.35, "DOCK", 16))              # main engine (to 9.25)
    # detail: hatch ring on the collar, MLI collar on the orbital module, capsule band, thrusters, antennas
    parts.append(ring(f.pt(0, 0, 0.08), -A, 0.78, 0.06, "DOCK"))
    parts.append(cyl_from(f.pt(0, 0, 0.35), A, 1.13, 0.4, "MLI", 32))
    parts.append(band(f.pt(0, 0, 2.85), A, 0.86, "FITTING", 0.1, 0.03, 32))
    parts.append(band(f.pt(0, 0, 5.06), A, 1.4, "FITTING", 0.12, 0.035, 32))
    for (dx, dt) in ((1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)):
        parts.append(box(f.pt(dx, dt, 8.3), (0.22, 0.22, 0.22), "FITTING"))
        parts.append(cone_from(f.pt(dx, dt, 8.4), A, 0.04, 0.08, 0.25, "DOCK", 8))
    parts.append(cyl_from(f.pt(0, 1.1, 1.6), f.et, 0.025, 0.6, "FITTING", 6))
    parts.append(box(f.pt(0.6, -1.05, 1.8), (0.3, 0.3, 0.3), "FITTING"))
    body = finish(parts, name, f.pt(0, 0, 0), root, vehicle=True)
    # arrays: pivot on the service module hull, axis along the array (X), 2 wings, ~7.1 m x 1.9 m each
    a_mid = 6.8
    for tag, sx in (("PORT", 1), ("STBD", -1)):
        piv = f.pt(sx * 1.4, 0, a_mid)
        j = joint(f"{name}_ARRAY_{tag}_ALPHA", piv, f.ex * sx, "alpha", (-180, 180), True, body)
        wl = (17.0 - 2.8) / 2
        finish(vehicle_wing(f, piv, sx, wl, 1.9, 0.2), f"{name}_ARRAY_{tag}", piv, j)
    return body


def tianzhou(name, frame):
    """Tianzhou: 10.6 m long, 3.35 m diameter, 14.9 m array span. Cargo module then propulsion module. Approximate."""
    f = frame
    A = f.ea
    parts = [cyl_from(f.pt(0, 0, 0), A, 0.9, 0.35, "DOCK", 32)]
    parts.append(cone_from(f.pt(0, 0, 0.35), A, 1.2, 1.675, 0.6, "MLI", 48))
    parts.append(cyl_from(f.pt(0, 0, 0.95), A, 1.675, 5.3, "HULL", 48))                   # cargo module (to 6.25)
    parts.append(cone_from(f.pt(0, 0, 6.25), A, 1.675, 1.4, 0.55, "MLI", 48))
    parts.append(cyl_from(f.pt(0, 0, 6.8), A, 1.4, 3.4, "MLI", 32))                       # propulsion module (to 10.2)
    parts.append(cone_from(f.pt(0, 0, 10.2), A, 1.4, 1.0, 0.2, "FITTING", 32))
    for (dx, dt) in ((0.6, 0.6), (-0.6, 0.6), (0.6, -0.6), (-0.6, -0.6)):
        parts.append(cone_from(f.pt(dx, dt, 10.3), A, 0.12, 0.22, 0.3, "DOCK", 12))       # 4 engines (to 10.6)
    # detail: hatch ring, collar rings, handrails on the cargo module, thruster pods, antenna
    parts.append(ring(f.pt(0, 0, 0.08), -A, 0.78, 0.06, "DOCK"))
    parts.append(band(f.pt(0, 0, 1.01), A, 1.675, "FITTING"))
    parts.append(band(f.pt(0, 0, 6.19), A, 1.675, "FITTING"))
    parts.append(band(f.pt(0, 0, 3.6), A, 1.675, "FITTING", 0.08, 0.03))
    for ang in (45, 135, 225, 315):
        a = math.radians(ang)
        off = f.ex * (1.66 * math.cos(a)) + f.et * (1.66 * math.sin(a))
        nrm = (f.ex * math.cos(a) + f.et * math.sin(a))
        parts += handrail(f.pt(0, 0, 2.0) + off, A, 1.4, nrm)
        parts += handrail(f.pt(0, 0, 4.3) + off, A, 1.4, nrm)
    for (dx, dt) in ((1.3, 1.3), (-1.3, 1.3), (1.3, -1.3), (-1.3, -1.3)):
        parts.append(box(f.pt(dx, dt, 9.6), (0.26, 0.26, 0.26), "FITTING"))
        parts.append(cone_from(f.pt(dx, dt, 9.75), A, 0.05, 0.09, 0.25, "DOCK", 8))
    parts.append(cyl_from(f.pt(0, 1.65, 1.5), f.et, 0.025, 0.4, "FITTING", 6))
    body = finish(parts, name, f.pt(0, 0, 0), root, vehicle=True)
    a_mid = 8.3
    for tag, sx in (("PORT", 1), ("STBD", -1)):
        piv = f.pt(sx * 1.4, 0, a_mid)
        j = joint(f"{name}_ARRAY_{tag}_ALPHA", piv, f.ex * sx, "alpha", (-180, 180), True, body)
        wl = (14.9 - 3.35) / 2
        finish(vehicle_wing(f, piv, sx, wl, 2.3, 0.3), f"{name}_ARRAY_{tag}", piv, j)
    return body


shenzhou("SHENZHOU_FORWARD", Frame((0, 0, Z_FWD), (0, 0, 1)))
shenzhou("SHENZHOU_NADIR", Frame((0, -2.0, NODE_C.z), (0, -1, 0)))
tianzhou("TIANZHOU_AFT", Frame((0, 0, Z_AFT), (0, 0, -1)))

# ======================================================================================= CENTRE THE STATION
def world_bbox(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


bpy.context.view_layer.update()


def _parents(o):
    out = []
    while o.parent is not None:
        o = o.parent
        out.append(o)
    return out


def is_vehicle_part(o):
    return o in VEHICLE_MESHES or any(p in VEHICLE_MESHES for p in _parents(o))


station = [o for o in ALL_MESHES if not is_vehicle_part(o)]
lo_b, hi_b = world_bbox(station)
centre_b = (lo_b + hi_b) / 2
root.location = -centre_b
bpy.context.view_layer.update()
lo_all, hi_all = world_bbox(ALL_MESHES)


def g(v):  # Blender -> glTF for reporting
    return [round(v.x, 3), round(v.z, 3), round(-v.y, 3)]


def g_box(lo, hi):
    a, b = g(lo), g(hi)
    return {"min": [min(x, y) for x, y in zip(a, b)], "max": [max(x, y) for x, y in zip(a, b)]}


station_box = g_box(lo_b, hi_b)
all_box = g_box(lo_all, hi_all)
root_translation = g(root.location)
log("station bbox (glTF, before centring):", station_box)
log("root translation (glTF):", root_translation)

# triangle count
tris = 0
for o in ALL_MESHES:
    o.data.calc_loop_triangles()
    tris += len(o.data.loop_triangles)
log("meshes:", len(ALL_MESHES), "joints/empties:", len(JOINTS), "triangles:", tris)

# ======================================================================================= EXPORT
bpy.ops.object.select_all(action="DESELECT")
export_kwargs = dict(
    filepath=GLB,
    export_format="GLB",
    export_yup=True,
    export_extras=True,
    export_apply=True,
    export_animations=False,
    export_skins=False,
    export_cameras=False,
    export_lights=False,
    export_materials="EXPORT",
    export_normals=True,
    export_tangents=False,
    export_texcoords=True,
    export_image_format="WEBP",
    export_image_quality=82,
    use_selection=False,
    use_active_collection=True,
    export_draco_mesh_compression_enable=True,     # like iss.glb (KHR_draco_mesh_compression)
    export_draco_mesh_compression_level=6,
    export_draco_position_quantization=14,
    export_draco_normal_quantization=10,
    export_draco_texcoord_quantization=14,
)
try:
    bpy.ops.export_scene.gltf(**export_kwargs)
except TypeError as e:
    log("export kwargs rejected, retrying without the unknown ones:", e)
    props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    bpy.ops.export_scene.gltf(**{k: v for k, v in export_kwargs.items() if k in props})


def glb_fix_extras(path):
    """IDProperties cannot hold null: rewrite rangeDeg to null on dock nodes, as the contract asks."""
    with open(path, "rb") as fh:
        data = fh.read()
    magic, version, length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67
    json_len, json_type = struct.unpack_from("<II", data, 12)
    assert json_type == 0x4E4F534A
    js = json.loads(data[20:20 + json_len].decode("utf-8"))
    rest = data[20 + json_len:]
    changed = 0
    for n in js.get("nodes", []):
        ex = n.get("extras")
        if ex and ex.get("kind") == "dock" and ex.get("rangeDeg") is not None:
            ex["rangeDeg"] = None
            changed += 1
    # the exporter writes an empty extras dict for some nodes; drop the asset generator tag noise too
    body = json.dumps(js, separators=(",", ":")).encode("utf-8")
    body += b" " * ((4 - len(body) % 4) % 4)
    out = struct.pack("<III", magic, version, 12 + 8 + len(body) + len(rest)) + struct.pack("<II", len(body), json_type) + body + rest
    with open(path, "wb") as fh:
        fh.write(out)
    return changed, js


changed, gltf_json = glb_fix_extras(GLB)
log("GLB written:", GLB, os.path.getsize(GLB), "bytes;", changed, "dock nodes given rangeDeg=null")

with open(JOINTS_JSON, "w", encoding="utf-8") as fh:
    json.dump(JOINTS, fh, indent=1)
images_out = []
for im in gltf_json.get("images", []):
    bv = gltf_json["bufferViews"][im["bufferView"]]
    images_out.append({"name": im.get("name"), "mimeType": im.get("mimeType"), "bytes": bv["byteLength"]})
stats = {
    "triangles_blender": tris,
    "meshes": len(ALL_MESHES),
    "joint_nodes": len(JOINTS),
    "glb_bytes": os.path.getsize(GLB),
    "station_bbox_gltf_before_centring": station_box,
    "all_bbox_gltf_after_centring": all_box,
    "root_translation_gltf": root_translation,
    "gltf_nodes": len(gltf_json.get("nodes", [])),
    "gltf_materials": [m["name"] for m in gltf_json.get("materials", [])],
    "gltf_images": images_out,
    "gltf_extensions": gltf_json.get("extensionsUsed", []),
    "texture_png_bytes": TEX_FILES,
}
with open(STATS_JSON, "w", encoding="utf-8") as fh:
    json.dump(stats, fh, indent=1)

bpy.ops.wm.save_as_mainfile(filepath=BLEND)
log("saved", BLEND)

# ======================================================================================= PREVIEWS (EEVEE: sun + low ambient)
try:
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    try:
        scene.eevee.taa_render_samples = PREVIEW_SAMPLES
        scene.eevee.use_shadows = True
        scene.eevee.use_raytracing = True
    except Exception as e:  # noqa: BLE001
        log("eevee settings:", repr(e))
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.exposure = 0.3
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception as e:  # noqa: BLE001
        log("view settings:", repr(e))

    # world: dark space below, faint grey-blue "earthshine" above, so metals have something to reflect
    world = bpy.data.worlds.new("Preview")
    world.use_nodes = True
    wn = world.node_tree
    bg = wn.nodes["Background"]
    tc = wn.nodes.new("ShaderNodeTexCoord")
    sep = wn.nodes.new("ShaderNodeSeparateXYZ")
    mr = wn.nodes.new("ShaderNodeMapRange")
    mix = wn.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    wn.links.new(tc.outputs["Generated"], sep.inputs["Vector"])
    wn.links.new(sep.outputs["Z"], mr.inputs["Value"])
    mr.inputs["From Min"].default_value = 0.1
    mr.inputs["From Max"].default_value = 1.0
    wn.links.new(mr.outputs["Result"], mix.inputs["Factor"])
    mix.inputs[6].default_value = (0.006, 0.007, 0.012, 1)
    mix.inputs[7].default_value = (0.11, 0.13, 0.17, 1)
    wn.links.new(mix.outputs[2], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world

    def sun(name, direction_gltf, strength, angle_deg):
        """Sun light shining *from* direction_gltf towards the origin."""
        d = B(direction_gltf).normalized()
        l = bpy.data.lights.new(name, "SUN")
        l.energy = strength
        l.angle = math.radians(angle_deg)
        o = bpy.data.objects.new(name, l)
        scene.collection.objects.link(o)
        o.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
        return o

    key = sun("Sun", (0.55, 1.0, -0.15), 5.0, 1.0)
    fill = sun("Fill", (1.0, 0.5, 1.0), 1.0, 10.0)

    cam_data = bpy.data.cameras.new("PreviewCam")
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    def shoot(filename, location_gltf, ortho_scale=None, up_hint=None, target_gltf=(0, 0, 0), lens=35):
        loc = B(location_gltf)
        cam.location = loc
        if up_hint is None:
            cam.rotation_euler = (B(target_gltf) - loc).to_track_quat("-Z", "Y").to_euler()
        else:
            cam.rotation_euler = up_hint
        if ortho_scale is None:
            cam_data.type = "PERSP"
            cam_data.lens = lens
        else:
            cam_data.type = "ORTHO"
            cam_data.ortho_scale = ortho_scale
        cam_data.clip_end = 1000
        scene.render.filepath = os.path.join(HERE, filename)
        bpy.ops.render.render(write_still=True)
        log("rendered", scene.render.filepath)

    # from the front-port side, above (glTF +X, +Y, +Z octant)
    shoot("preview_iso.png", (70, 55, 80), 88)
    # straight down from zenith: image right = forward (+Z), image up = port (+X)
    shoot("preview_top.png", (0, 120, 0), 78, up_hint=(0, 0, -math.pi / 2))
    # from forward, looking aft: image right = port (+X), image up = zenith
    shoot("preview_front.png", (0, 0, 120), 50, up_hint=(math.pi / 2, 0, 0))
    # close-up: Tianhe hull with the CMM on top, the Tianhe port wing root behind, labs to the sides
    rt = Vector(root_translation)
    shoot("preview_closeup.png", tuple(V(9.5, 6.5, 6.0) + rt), None, target_gltf=tuple(V(0.8, 1.2, -2.0) + rt), lens=40)

    # the ISS file the app already uses, same camera direction and lighting, framed to its larger size
    try:
        layer_coll.exclude = True
        iss_coll = bpy.data.collections.new("ISS_reference")
        scene.collection.children.link(iss_coll)
        bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection.children[iss_coll.name]
        bpy.ops.import_scene.gltf(filepath=ISS_REFERENCE)
        for o in iss_coll.all_objects:
            for slot in o.material_slots:
                if slot.material:
                    slot.material.use_backface_culling = False
        shoot("preview_iss_reference.png", (70, 55, 80), 120)
    except Exception as e:  # noqa: BLE001
        log("ISS reference render failed (skipped):", repr(e))
except Exception as e:  # noqa: BLE001
    log("preview rendering failed (skipped):", repr(e))

log("done")
