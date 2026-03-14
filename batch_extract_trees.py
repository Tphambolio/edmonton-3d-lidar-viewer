#!/usr/bin/env python3
"""
Batch extract tree meshes from LiDAR tiles → GLB + tileset.json + index.json.

Produces 3D Tiles-compatible output for the Edmonton 3D Viewer.
Goes directly from LAZ to GLB (no intermediate DAE).

Usage:
    # Process specific tiles
    python batch_extract_trees.py 010_040 023_042

    # Process all tiles in directory
    python batch_extract_trees.py --all

    # Process N tiles starting from offset (for batching)
    python batch_extract_trees.py --all --offset 0 --limit 50

    # Dry run to see which tiles would be processed
    python batch_extract_trees.py --all --dry-run
"""

import sys
import os
import gc
import argparse
import json
import struct
import glob
import time
import numpy as np
import laspy
from scipy.ndimage import gaussian_filter, label
from scipy.interpolate import griddata
from skimage.measure import marching_cubes
from pyproj import Transformer

# --- Config ---
LAZ_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(LAZ_DIR, "edmonton-3d-viewer", "data", "tree_tiles")

BOX_SIZE = 512
MIN_TREE_HEIGHT = 3.0
TREE_VOXEL = 0.4
TREE_SIGMA = 1.2
CLUSTER_CELL = 2.5
MIN_CLUSTER_PTS = 80
MAX_TREES = 200
MAX_VERTS_PER_TILE = 2_000_000  # ~50MB GLB — caps memory at ~4GB per tile

# Trunk generation
TRUNK_N_SIDES = 8          # polygon sides for trunk cylinder
TRUNK_MIN_HEIGHT = 0.5     # minimum trunk height to generate (m)

# CRS transformer: EPSG:3776 (Alberta 3TM 114) → WGS84
transformer = Transformer.from_crs("EPSG:3776", "EPSG:4326", always_xy=True)


# ========== LIDAR LOADING ==========

MAX_POINTS = 3_000_000  # Downsample if tile exceeds this to prevent OOM
MAX_PTS_PER_TREE = 15_000  # Cap points per individual tree to limit mesh_colored memory

def load_tile(tile_name):
    """Load LAZ tile, crop to center box. Returns None if file missing."""
    laz_path = os.path.join(LAZ_DIR, f"{tile_name}.laz")
    if not os.path.exists(laz_path):
        return None

    las = laspy.read(laz_path)

    cx = (las.x.min() + las.x.max()) / 2
    cy = (las.y.min() + las.y.max()) / 2
    half = BOX_SIZE / 2
    box_mask = (
        (las.x >= cx - half) & (las.x <= cx + half) &
        (las.y >= cy - half) & (las.y <= cy + half)
    )

    x = np.array(las.x[box_mask])
    y = np.array(las.y[box_mask])
    z = np.array(las.z[box_mask])
    cls = np.array(las.classification[box_mask])
    r = np.array(las.red[box_mask])
    g = np.array(las.green[box_mask])
    b = np.array(las.blue[box_mask])

    # Free LAZ object immediately
    del las, box_mask
    gc.collect()

    if len(r) == 0 or len(x) == 0:
        return None

    # Downsample if too many points (prevents OOM on dense tiles)
    if len(x) > MAX_POINTS:
        ratio = MAX_POINTS / len(x)
        print(f"  Downsampling: {len(x):,} → {MAX_POINTS:,} points ({ratio:.1%})")
        idx = np.random.default_rng(42).choice(len(x), MAX_POINTS, replace=False)
        idx.sort()
        x, y, z, cls, r, g, b = x[idx], y[idx], z[idx], cls[idx], r[idx], g[idx], b[idx]

    if r.max() > 255:
        r = np.clip(r / 256, 0, 255).astype(np.uint8)
        g = np.clip(g / 256, 0, 255).astype(np.uint8)
        b = np.clip(b / 256, 0, 255).astype(np.uint8)

    return x, y, z, cls, r, g, b, cx, cy


# ========== DEM + HEIGHT ABOVE GROUND ==========

def build_dem(x, y, z, cls, grid_res=2.0):
    gm = cls == 2
    gx, gy, gz = x[gm], y[gm], z[gm]
    if len(gx) < 10:
        return None, None, None, None, None
    gxi = np.arange(x.min(), x.max(), grid_res)
    gyi = np.arange(y.min(), y.max(), grid_res)
    gxx, gyy = np.meshgrid(gxi, gyi)
    dem = griddata((gx, gy), gz, (gxx, gyy), method='linear', fill_value=gz.mean())
    return dem, gxi, gyi, x.min(), y.min()


def sample_hag(px, py, pz, dem, gxi, gyi, xmin, ymin, grid_res=2.0):
    ti = np.clip(((px - xmin) / grid_res).astype(int), 0, len(gxi) - 1)
    tj = np.clip(((py - ymin) / grid_res).astype(int), 0, len(gyi) - 1)
    return pz - dem[tj, ti]


# ========== TREE MESHING ==========

def cluster_2d(xy, cell_size):
    xy_min = xy.min(axis=0)
    grid_idx = np.floor((xy - xy_min) / cell_size).astype(int)
    grid_shape = grid_idx.max(axis=0) + 1
    occupied = np.zeros(grid_shape, dtype=bool)
    occupied[grid_idx[:, 0], grid_idx[:, 1]] = True
    labeled, n = label(occupied)
    point_labels = labeled[grid_idx[:, 0], grid_idx[:, 1]]
    return point_labels, n


def mesh_colored(pts, rgb, voxel, sigma):
    if len(pts) < 20:
        return None, None, None

    pmin = pts.min(axis=0) - voxel * 3
    pmax = pts.max(axis=0) + voxel * 3
    grid_shape = np.ceil((pmax - pmin) / voxel).astype(int) + 1

    density = np.zeros(grid_shape, dtype=np.float32)
    cr = np.zeros(grid_shape, dtype=np.float64)
    cg = np.zeros(grid_shape, dtype=np.float64)
    cb = np.zeros(grid_shape, dtype=np.float64)

    idx = np.floor((pts - pmin) / voxel).astype(int)
    idx = np.clip(idx, 0, np.array(grid_shape) - 1)

    np.add.at(density, (idx[:, 0], idx[:, 1], idx[:, 2]), 1.0)
    np.add.at(cr, (idx[:, 0], idx[:, 1], idx[:, 2]), rgb[:, 0].astype(float))
    np.add.at(cg, (idx[:, 0], idx[:, 1], idx[:, 2]), rgb[:, 1].astype(float))
    np.add.at(cb, (idx[:, 0], idx[:, 1], idx[:, 2]), rgb[:, 2].astype(float))

    occ = density > 0
    cr[occ] /= density[occ]
    cg[occ] /= density[occ]
    cb[occ] /= density[occ]

    density_smooth = gaussian_filter(density, sigma=sigma)

    cs = sigma * 0.8
    cr_w = gaussian_filter(cr * density, sigma=cs)
    cg_w = gaussian_filter(cg * density, sigma=cs)
    cb_w = gaussian_filter(cb * density, sigma=cs)
    d_c = gaussian_filter(density, sigma=cs)
    cm = d_c > 0.01
    cr_s = np.zeros_like(cr)
    cg_s = np.zeros_like(cg)
    cb_s = np.zeros_like(cb)
    cr_s[cm] = cr_w[cm] / d_c[cm]
    cg_s[cm] = cg_w[cm] / d_c[cm]
    cb_s[cm] = cb_w[cm] / d_c[cm]

    threshold = density_smooth.max() * 0.06
    if threshold < 0.01:
        return None, None, None

    try:
        verts, faces, _, _ = marching_cubes(density_smooth, level=threshold)
    except Exception:
        return None, None, None

    vi = np.clip(np.round(verts).astype(int), 0, np.array(grid_shape) - 1)
    vert_colors = np.zeros((len(verts), 3), dtype=np.uint8)
    vert_colors[:, 0] = np.clip(cr_s[vi[:, 0], vi[:, 1], vi[:, 2]], 0, 255).astype(np.uint8)
    vert_colors[:, 1] = np.clip(cg_s[vi[:, 0], vi[:, 1], vi[:, 2]], 0, 255).astype(np.uint8)
    vert_colors[:, 2] = np.clip(cb_s[vi[:, 0], vi[:, 1], vi[:, 2]], 0, 255).astype(np.uint8)

    verts_real = verts * voxel + pmin
    return verts_real, faces, vert_colors


def classify_tree(rgb):
    """Compute conifer score (0=deciduous, 1=conifer) from point RGB.

    Conifers (spruce, pine): darker, more blue-green.
    Deciduous (poplar, elm, ash): lighter, more yellow-green.
    """
    cr, cg, cb = rgb[:, 0].mean(), rgb[:, 1].mean(), rgb[:, 2].mean()
    total = cr + cg + cb
    if total == 0:
        return 0.0

    # Darkness (conifers are darker overall)
    brightness = total / (255 * 3)
    dark_score = np.clip((0.28 - brightness) / 0.08, 0, 1)

    # Blue/Red ratio (conifers more blue-green)
    br = cb / max(cr, 1)
    br_score = np.clip((br - 0.75) / 0.20, 0, 1)

    # Green dominance — conifers have less red relative to green
    rg_ratio = cr / max(cg, 1)
    rg_score = np.clip((0.92 - rg_ratio) / 0.10, 0, 1)

    return float(np.clip(dark_score * 0.5 + br_score * 0.3 + rg_score * 0.2, 0, 1))


def tint_tree_colors(colors, conifer_score):
    """Tint and correct vertex colors for natural-looking foliage.

    Raw aerial RGB has harsh shadows (near-black) and bright sunlit patches,
    giving a camouflage look. This function:
      1. Lifts shadows (raises floor brightness)
      2. Compresses contrast (softens harsh light/dark transitions)
      3. Boosts green saturation for natural foliage appearance
      4. Applies conifer/deciduous tint for variety
    """
    c = colors.astype(np.float32)

    # --- Step 1: Lift only the deepest shadows, keep dark greens rich ---
    # Only lift the blackest pixels (< 35), preserve the rest.
    # This keeps dark foliage dark (= rich) while removing harsh black.
    floor_val = 40.0
    c = np.maximum(c, floor_val)

    # --- Step 2: Strong saturation boost + green channel push ---
    # Aerial canopy RGB is grey-olive due to mixed pixels and sensor response.
    # Aggressively boost saturation and push green to get vibrant foliage.
    grey = 0.299 * c[:, 0] + 0.587 * c[:, 1] + 0.114 * c[:, 2]
    sat_boost = 1.80  # 80% more saturated — makes greens pop
    for ch in range(3):
        c[:, ch] = grey + (c[:, ch] - grey) * sat_boost

    # Strong green push, suppress red and blue for rich foliage
    c[:, 1] *= 1.25   # 25% green boost
    c[:, 0] *= 0.78   # 22% red reduction (removes grey/brown cast)
    c[:, 2] *= 0.72   # 28% blue reduction (removes mint/cool cast)

    # --- Step 3: Apply conifer/deciduous tint (subtle) ---
    if conifer_score > 0.4:
        # Conifer: slightly cooler, deeper
        t = (conifer_score - 0.4) / 0.6
        c[:, 0] *= (1.0 - 0.08 * t)   # slightly less red
        c[:, 2] *= (1.0 + 0.05 * t)   # touch more blue
        c *= (1.0 - 0.05 * t)         # slightly darker
    else:
        # Deciduous: slightly warmer
        t = (0.4 - conifer_score) / 0.4
        c[:, 0] *= (1.0 + 0.05 * t)   # touch warmer
        c[:, 2] *= (1.0 - 0.04 * t)   # touch less blue
        c *= (1.0 + 0.03 * t)         # slightly brighter

    return np.clip(c, 0, 255).astype(np.uint8)


def generate_trunk_mesh(centroid_x, centroid_y, trunk_top_z, ground_z,
                        tree_height, conifer_score, canopy_radius=2.0):
    """Generate a tapered brown cylinder from ground to canopy bottom.

    Returns (verts, faces, colors) in the same local coordinate frame as the
    canopy mesh, or None if the trunk would be too short.

    ground_z: actual ground elevation at tree location in local coords
              (pz - hag), NOT z=0 which is tile minimum elevation.
    trunk_top_z: canopy bottom in local coords (lowest tree point).

    Trunk radius is scaled to ~12-18% of canopy radius so trunks are visible
    at typical viewer zoom levels (realistic DBH is subpixel at 512m tile scale).
    """
    trunk_height = trunk_top_z - ground_z
    if trunk_height < TRUNK_MIN_HEIGHT:
        return None

    n = TRUNK_N_SIDES

    # Visual trunk radius: fraction of canopy spread (not allometric DBH)
    if conifer_score > 0.4:
        r_base = np.clip(canopy_radius * 0.12, 0.15, 1.2)  # conifer: thinner
        taper = 0.55
        base_color = np.array([90, 60, 35], dtype=np.float64)
    else:
        r_base = np.clip(canopy_radius * 0.18, 0.20, 1.5)  # deciduous: thicker
        taper = 0.70
        base_color = np.array([110, 80, 45], dtype=np.float64)

    r_top = r_base * taper

    # Vertex rings
    angles = np.linspace(0, 2 * np.pi, n, endpoint=False)
    cos_a = np.cos(angles)
    sin_a = np.sin(angles)

    # Bottom ring at ground_z, top ring at trunk_top_z, bottom center for cap
    bottom = np.column_stack([
        centroid_x + r_base * cos_a,
        centroid_y + r_base * sin_a,
        np.full(n, ground_z)
    ])
    top = np.column_stack([
        centroid_x + r_top * cos_a,
        centroid_y + r_top * sin_a,
        np.full(n, trunk_top_z)
    ])
    center = np.array([[centroid_x, centroid_y, ground_z]])

    verts = np.vstack([bottom, top, center])  # indices: 0..n-1, n..2n-1, 2n

    # Faces: cylinder sides + bottom cap
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, j, n + j])          # lower tri
        faces.append([i, n + j, n + i])      # upper tri
        faces.append([2 * n, j, i])           # bottom cap
    faces = np.array(faces, dtype=np.int32)

    # Brown color with per-tree variation and vertical gradient
    seed = int(abs(centroid_x * 1000 + centroid_y * 1000)) % (2**31)
    rng = np.random.default_rng(seed)
    variation = rng.integers(-12, 13, size=3).astype(np.float64)
    trunk_rgb = np.clip(base_color + variation, 0, 255)

    # Vertical gradient: darker at base, lighter near canopy
    heights = verts[:, 2] - ground_z
    t = heights / max(trunk_height, 0.01)
    colors = np.zeros((len(verts), 3), dtype=np.uint8)
    for ch in range(3):
        colors[:, ch] = np.clip(trunk_rgb[ch] * (1.0 + 0.15 * t), 0, 255).astype(np.uint8)

    return verts, faces, colors


def extract_trees(x, y, z, cls, r, g, b, cx, cy, z_base, dem, gxi, gyi, xmin, ymin):
    """Extract tree meshes. Returns (verts, faces, colors) or None."""
    tm = cls == 5
    if tm.sum() == 0:
        return None

    tree_hag = sample_hag(x[tm], y[tm], z[tm], dem, gxi, gyi, xmin, ymin)
    tall = tree_hag >= MIN_TREE_HEIGHT
    px = x[tm][tall] - cx
    py = y[tm][tall] - cy
    pz = z[tm][tall] - z_base
    pr, pg, pb = r[tm][tall], g[tm][tall], b[tm][tall]
    hag_f = tree_hag[tall]

    if len(px) == 0:
        return None

    labels, n_clusters = cluster_2d(np.column_stack([px, py]), CLUSTER_CELL)
    cluster_ids, cluster_sizes = np.unique(labels, return_counts=True)
    valid = cluster_ids > 0
    cluster_ids, cluster_sizes = cluster_ids[valid], cluster_sizes[valid]
    order = np.argsort(-cluster_sizes)
    cluster_ids = cluster_ids[order][:MAX_TREES]

    all_verts, all_faces, all_colors = [], [], []
    vert_offset = 0
    count = 0
    n_conifer = 0
    n_deciduous = 0

    for cid in cluster_ids:
        mask = labels == cid
        pts = np.column_stack([px[mask], py[mask], pz[mask]])
        rgb = np.column_stack([pr[mask], pg[mask], pb[mask]])
        if len(pts) < MIN_CLUSTER_PTS:
            continue

        # Downsample large individual trees to cap voxel grid memory
        if len(pts) > MAX_PTS_PER_TREE:
            idx = np.random.default_rng(42).choice(len(pts), MAX_PTS_PER_TREE, replace=False)
            pts, rgb = pts[idx], rgb[idx]

        # Classify tree type from point colors
        conifer_score = classify_tree(rgb)
        if conifer_score > 0.4:
            n_conifer += 1
        else:
            n_deciduous += 1

        verts, faces, colors = mesh_colored(pts, rgb, TREE_VOXEL, TREE_SIGMA)
        if verts is None:
            continue

        # Tint vertex colors based on classification
        colors = tint_tree_colors(colors, conifer_score)

        # Generate trunk cylinder from ground to canopy bottom
        # Compute actual ground level at tree position from HAG
        tree_hag_vals = hag_f[mask]
        if len(pts) != len(tree_hag_vals):
            # After downsampling, recompute from pts directly
            tree_ground_z = pts[:, 2].min() - 3.0  # approximate
        else:
            tree_ground_z = np.median(pz[mask] - hag_f[mask])
        # Estimate canopy radius from point spread
        canopy_r = max(pts[:, 0].max() - pts[:, 0].min(),
                       pts[:, 1].max() - pts[:, 1].min()) / 2.0
        # Use 25th percentile of z — extends trunk well into canopy body
        # to bridge gap from marching cubes surface (voxel padding + smoothing)
        canopy_penetration_z = np.percentile(pts[:, 2], 25)
        trunk = generate_trunk_mesh(
            centroid_x=pts[:, 0].mean(),
            centroid_y=pts[:, 1].mean(),
            trunk_top_z=canopy_penetration_z,
            ground_z=tree_ground_z,
            tree_height=pts[:, 2].max() - tree_ground_z,
            conifer_score=conifer_score,
            canopy_radius=canopy_r
        )
        if trunk is not None:
            t_verts, t_faces, t_colors = trunk
            t_faces = t_faces + len(verts)
            verts = np.vstack([verts, t_verts])
            faces = np.vstack([faces, t_faces])
            colors = np.vstack([colors, t_colors])

        count += 1
        all_verts.append(verts)
        all_faces.append(faces + vert_offset)
        all_colors.append(colors)
        vert_offset += len(verts)

        # Cap total vertices to prevent OOM on dense tiles
        if vert_offset >= MAX_VERTS_PER_TILE:
            print(f"    Vertex cap reached ({vert_offset:,} verts) after {count} trees — stopping early")
            break

    if not all_verts:
        return None

    verts = np.vstack(all_verts)
    faces = np.vstack(all_faces)
    colors = np.vstack(all_colors)
    print(f"    {count} trees ({n_conifer} conifer, {n_deciduous} deciduous), {len(verts):,} verts, {len(faces):,} faces")
    return verts, faces, colors


# ========== GLB WRITER ==========

def write_glb(filepath, verts, faces, colors):
    """Write a GLB file directly from mesh data.

    Produces a Y-up GLB (glTF standard).

    Input mesh is Z-up: (east, north, height).
    glTF is Y-up, and CesiumJS applies an internal Y→Z rotation
    that maps (x, y, z) → (x, -z, y). To compensate, we negate
    the north axis so CesiumJS's rotation restores it:
    GLB (east, height, -north) → CesiumJS (east, north, height) ✓
    """
    # Swap axes: Z-up (east,north,height) → Y-up (east,height,-north)
    verts_yup = np.column_stack([
        verts[:, 0],    # X = east (unchanged)
        verts[:, 2],    # Y = height (was Z)
        -verts[:, 1],   # Z = -north (negated to compensate CesiumJS rotation)
    ]).astype(np.float32)

    # Face indices as uint32
    faces_flat = faces.astype(np.uint32).flatten()

    # Vertex colors as RGBA uint8 (glTF COLOR_0)
    alpha = np.full((len(colors), 1), 255, dtype=np.uint8)
    colors_rgba = np.hstack([colors.astype(np.uint8), alpha])

    # Compute bounds
    pos_min = verts_yup.min(axis=0).tolist()
    pos_max = verts_yup.max(axis=0).tolist()

    # Build binary buffer
    pos_bytes = verts_yup.tobytes()
    color_bytes = colors_rgba.tobytes()
    idx_bytes = faces_flat.tobytes()

    # Align each section to 4-byte boundary
    def pad4(data):
        remainder = len(data) % 4
        if remainder:
            data += b'\x00' * (4 - remainder)
        return data

    pos_bytes_padded = pad4(pos_bytes)
    color_bytes_padded = pad4(color_bytes)
    idx_bytes_padded = pad4(idx_bytes)

    buffer_data = pos_bytes_padded + color_bytes_padded + idx_bytes_padded
    total_buffer_len = len(buffer_data)

    pos_offset = 0
    pos_length = len(pos_bytes)
    color_offset = len(pos_bytes_padded)
    color_length = len(color_bytes)
    idx_offset = len(pos_bytes_padded) + len(color_bytes_padded)
    idx_length = len(idx_bytes)

    num_verts = len(verts_yup)
    num_indices = len(faces_flat)

    gltf = {
        "asset": {"version": "2.0", "generator": "edmonton-3d-lidar-batch"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "trees"}],
        "materials": [{
            "pbrMetallicRoughness": {
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0
            },
            "doubleSided": True
        }],
        "meshes": [{
            "primitives": [{
                "attributes": {
                    "POSITION": 0,
                    "COLOR_0": 1
                },
                "indices": 2,
                "material": 0,
                "mode": 4  # TRIANGLES
            }]
        }],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,  # FLOAT
                "count": num_verts,
                "type": "VEC3",
                "min": pos_min,
                "max": pos_max
            },
            {
                "bufferView": 1,
                "componentType": 5121,  # UNSIGNED_BYTE
                "count": num_verts,
                "type": "VEC4",
                "normalized": True
            },
            {
                "bufferView": 2,
                "componentType": 5125,  # UNSIGNED_INT
                "count": num_indices,
                "type": "SCALAR"
            }
        ],
        "bufferViews": [
            {
                "buffer": 0,
                "byteOffset": pos_offset,
                "byteLength": pos_length,
                "target": 34962  # ARRAY_BUFFER
            },
            {
                "buffer": 0,
                "byteOffset": color_offset,
                "byteLength": color_length,
                "target": 34962  # ARRAY_BUFFER
            },
            {
                "buffer": 0,
                "byteOffset": idx_offset,
                "byteLength": idx_length,
                "target": 34963  # ELEMENT_ARRAY_BUFFER
            }
        ],
        "buffers": [{
            "byteLength": total_buffer_len
        }]
    }

    # Encode JSON chunk
    json_str = json.dumps(gltf, separators=(',', ':'))
    # Pad JSON to 4-byte alignment with spaces
    while len(json_str.encode('utf-8')) % 4 != 0:
        json_str += ' '
    json_bytes = json_str.encode('utf-8')

    # GLB structure
    # Header: magic(4) + version(4) + length(4) = 12 bytes
    # JSON chunk: length(4) + type(4) + data
    # BIN chunk: length(4) + type(4) + data
    total_length = 12 + 8 + len(json_bytes) + 8 + len(buffer_data)

    with open(filepath, 'wb') as f:
        # GLB header
        f.write(b'glTF')
        f.write(struct.pack('<I', 2))  # version
        f.write(struct.pack('<I', total_length))

        # JSON chunk
        f.write(struct.pack('<I', len(json_bytes)))
        f.write(b'JSON')
        f.write(json_bytes)

        # BIN chunk
        f.write(struct.pack('<I', len(buffer_data)))
        f.write(b'BIN\x00')
        f.write(buffer_data)

    return os.path.getsize(filepath)


# ========== TILESET.JSON WRITER ==========

def write_tileset_json(filepath, glb_filename):
    """Write a minimal tileset.json referencing the GLB."""
    tileset = {
        "asset": {"version": "1.0"},
        "geometricError": 500,
        "root": {
            "boundingVolume": {"sphere": [0, 0, 0, 400]},
            "geometricError": 400,
            "content": {"uri": glb_filename},
            "transform": [
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ],
            "refine": "ADD"
        }
    }
    with open(filepath, 'w') as f:
        json.dump(tileset, f, indent=2)


# ========== MAIN PROCESSING ==========

def process_tile(tile_name):
    """Process a single tile. Returns tile metadata dict or None."""
    t0 = time.time()
    print(f"\n--- {tile_name} ---")

    # Load
    result = load_tile(tile_name)
    if result is None:
        print(f"  SKIP: LAZ file not found or empty")
        return None
    x, y, z, cls, r, g, b, cx, cy = result

    # Check for ground + tree points
    gm = cls == 2
    tm = cls == 5
    if gm.sum() < 10:
        print(f"  SKIP: too few ground points ({gm.sum()})")
        return None
    if tm.sum() < 100:
        print(f"  SKIP: too few tree points ({tm.sum()})")
        return None

    # Build DEM
    dem, gxi, gyi, xmin, ymin = build_dem(x, y, z, cls)
    if dem is None:
        print(f"  SKIP: DEM failed")
        return None

    z_base = z[gm].min()

    # Ground elevation at tile center (for z_base_offset)
    z_center = griddata(
        (x[gm], y[gm]), z[gm], (cx, cy), method='linear'
    )
    if np.isnan(z_center):
        z_center = z[gm].mean()
    z_base_offset = float(z_center - z_base)

    # Extract trees
    print(f"  Tree points: {tm.sum():,}, ground: {gm.sum():,}")
    mesh_result = extract_trees(x, y, z, cls, r, g, b, cx, cy, z_base,
                                dem, gxi, gyi, xmin, ymin)

    # Free raw point cloud and DEM — no longer needed
    del x, y, z, cls, r, g, b, dem, gxi, gyi, gm, tm
    gc.collect()

    if mesh_result is None:
        print(f"  SKIP: no meshable trees")
        return None

    verts, faces, colors = mesh_result

    # Convert center to WGS84
    center_lng, center_lat = transformer.transform(cx, cy)

    # Write GLB
    glb_filename = f"{tile_name}_trees.glb"
    glb_path = os.path.join(OUTPUT_DIR, glb_filename)
    file_size = write_glb(glb_path, verts, faces, colors)
    size_mb = file_size / 1024 / 1024

    # Write tileset.json
    tileset_path = os.path.join(OUTPUT_DIR, f"{tile_name}_tileset.json")
    write_tileset_json(tileset_path, glb_filename)

    elapsed = time.time() - t0
    print(f"  -> {glb_filename} ({size_mb:.1f} MB) in {elapsed:.1f}s")

    num_faces = len(faces)

    # Free memory — dense tiles can use several GB
    del verts, faces, colors
    gc.collect()

    return {
        "file": glb_filename,
        "center_lat": round(center_lat, 6),
        "center_lng": round(center_lng, 6),
        "size_mb": round(size_mb, 1),
        "z_base_offset": round(z_base_offset, 2),
        "num_faces": num_faces,
        "num_trees": MAX_TREES
    }


def get_all_tiles():
    """Get sorted list of all LAZ tile names."""
    laz_files = glob.glob(os.path.join(LAZ_DIR, "*.laz"))
    tiles = [os.path.splitext(os.path.basename(f))[0] for f in laz_files]
    return sorted(tiles)


def update_index(new_tiles):
    """Merge new tile metadata into index.json."""
    index_path = os.path.join(OUTPUT_DIR, "index.json")
    if os.path.exists(index_path):
        with open(index_path) as f:
            index = json.load(f)
    else:
        index = {"tiles": {}}

    for tile_name, meta in new_tiles.items():
        index["tiles"][tile_name] = meta

    # Sort by tile name
    index["tiles"] = dict(sorted(index["tiles"].items()))

    with open(index_path, 'w') as f:
        json.dump(index, f, indent=2)
    print(f"\nUpdated {index_path}: {len(index['tiles'])} tiles total")


def main():
    parser = argparse.ArgumentParser(description="Batch extract tree meshes from LiDAR")
    parser.add_argument("tiles", nargs="*", help="Tile names to process (e.g., 010_040)")
    parser.add_argument("--all", action="store_true", help="Process all LAZ tiles")
    parser.add_argument("--offset", type=int, default=0, help="Skip first N tiles")
    parser.add_argument("--limit", type=int, default=0, help="Process at most N tiles")
    parser.add_argument("--dry-run", action="store_true", help="List tiles without processing")
    parser.add_argument("--skip-existing", action="store_true", help="Skip tiles with existing GLBs")
    args = parser.parse_args()

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if args.all:
        tiles = get_all_tiles()
    elif args.tiles:
        tiles = args.tiles
    else:
        parser.print_help()
        sys.exit(1)

    # Apply offset/limit
    if args.offset:
        tiles = tiles[args.offset:]
    if args.limit:
        tiles = tiles[:args.limit]

    # Skip existing
    if args.skip_existing:
        existing = set()
        for t in tiles:
            glb = os.path.join(OUTPUT_DIR, f"{t}_trees.glb")
            if os.path.exists(glb):
                existing.add(t)
        if existing:
            print(f"Skipping {len(existing)} tiles with existing GLBs")
            tiles = [t for t in tiles if t not in existing]

    print(f"Processing {len(tiles)} tiles")

    if args.dry_run:
        for t in tiles:
            print(f"  {t}")
        return

    # Process
    new_tiles = {}
    success = 0
    skipped = 0
    t_start = time.time()

    for i, tile_name in enumerate(tiles):
        print(f"\n[{i+1}/{len(tiles)}]", end="")
        meta = process_tile(tile_name)
        if meta:
            new_tiles[tile_name] = meta
            success += 1
        else:
            skipped += 1

    elapsed = time.time() - t_start

    # Update index
    if new_tiles:
        update_index(new_tiles)

    print(f"\n{'='*50}")
    print(f"Done: {success} processed, {skipped} skipped in {elapsed:.0f}s")
    if success > 0:
        total_mb = sum(m['size_mb'] for m in new_tiles.values())
        print(f"Total output: {total_mb:.1f} MB")


if __name__ == "__main__":
    main()
