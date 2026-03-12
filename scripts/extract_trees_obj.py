#!/usr/bin/env python3
"""
Extract trees from Edmonton LiDAR tile, mesh with marching cubes,
export as OBJ with vertex colors in EPSG:3776 coordinates for
ArcGIS Pro import.

Usage:
    python3 scripts/extract_trees_obj.py 032_054
    python3 scripts/extract_trees_obj.py 032_054 --box 400
"""

import sys
import os
import argparse
import numpy as np
import laspy
from scipy.ndimage import gaussian_filter, label
from scipy.interpolate import griddata
from skimage.measure import marching_cubes

# --- Parameters ---
MIN_TREE_HEIGHT = 3.0
TREE_VOXEL = 0.4
TREE_SIGMA = 1.2
CLUSTER_CELL = 2.5
MIN_CLUSTER_PTS = 80
MAX_TREES = 300       # more trees for larger area

LAZ_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_DIR = os.path.join(LAZ_DIR, "obj_export")

# EPSG:3776 WKT — NAD83 3TM 114 (Alberta)
# ESRI wkid 3776 / 102187 = NAD83(CSRS) 3TM ref merid 114 W
PRJ_WKT = (
    'PROJCS["NAD83_3TM_114",'
    'GEOGCS["GCS_North_American_1983",'
    'DATUM["D_North_American_1983",'
    'SPHEROID["GRS_1980",6378137.0,298.257222101]],'
    'PRIMEM["Greenwich",0.0],'
    'UNIT["Degree",0.0174532925199433]],'
    'PROJECTION["Transverse_Mercator"],'
    'PARAMETER["False_Easting",0.0],'
    'PARAMETER["False_Northing",0.0],'
    'PARAMETER["Central_Meridian",-114.0],'
    'PARAMETER["Scale_Factor",0.9999],'
    'PARAMETER["Latitude_Of_Origin",0.0],'
    'UNIT["Meter",1.0]]'
)


def load_tile(tile_name, box_size):
    """Load LAZ tile, crop to center box. Returns coords in native EPSG:3776."""
    laz_path = os.path.join(LAZ_DIR, f"{tile_name}.laz")
    if not os.path.exists(laz_path):
        print(f"ERROR: {laz_path} not found")
        sys.exit(1)

    print(f"Reading {laz_path}...")
    las = laspy.read(laz_path)

    cx = (las.x.min() + las.x.max()) / 2
    cy = (las.y.min() + las.y.max()) / 2
    half = box_size / 2
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

    if r.max() > 255:
        r = np.clip(r / 256, 0, 255).astype(np.uint8)
        g = np.clip(g / 256, 0, 255).astype(np.uint8)
        b = np.clip(b / 256, 0, 255).astype(np.uint8)

    print(f"  Cropped to {box_size}m box: {len(x):,} points")
    print(f"  Center EPSG:3776: ({cx:.1f}, {cy:.1f})")
    return x, y, z, cls, r, g, b, cx, cy


def build_dem(x, y, z, cls, grid_res=2.0):
    """Build ground DEM from class 2 points."""
    gm = cls == 2
    gx, gy, gz = x[gm], y[gm], z[gm]
    if len(gx) < 10:
        print("  WARNING: very few ground points")
        return np.full((1, 1), gz.mean() if len(gz) > 0 else 0), \
               np.array([x.min()]), np.array([y.min()]), x.min(), y.min()
    gxi = np.arange(x.min(), x.max(), grid_res)
    gyi = np.arange(y.min(), y.max(), grid_res)
    gxx, gyy = np.meshgrid(gxi, gyi)
    dem = griddata((gx, gy), gz, (gxx, gyy), method='linear', fill_value=gz.mean())
    return dem, gxi, gyi, x.min(), y.min()


def sample_hag(px, py, pz, dem, gxi, gyi, xmin, ymin, grid_res=2.0):
    """Sample height above ground for arbitrary points."""
    ti = np.clip(((px - xmin) / grid_res).astype(int), 0, len(gxi) - 1)
    tj = np.clip(((py - ymin) / grid_res).astype(int), 0, len(gyi) - 1)
    return pz - dem[tj, ti]


def cluster_2d(xy, cell_size):
    """2D grid clustering."""
    xy_min = xy.min(axis=0)
    grid_idx = np.floor((xy - xy_min) / cell_size).astype(int)
    grid_shape = grid_idx.max(axis=0) + 1
    occupied = np.zeros(grid_shape, dtype=bool)
    occupied[grid_idx[:, 0], grid_idx[:, 1]] = True
    labeled, n = label(occupied)
    point_labels = labeled[grid_idx[:, 0], grid_idx[:, 1]]
    return point_labels, n


def mesh_colored(pts, rgb, voxel, sigma):
    """Marching cubes with density-weighted color propagation."""
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
        verts, faces, normals, _ = marching_cubes(density_smooth, level=threshold)
    except Exception:
        return None, None, None

    vi = np.clip(np.round(verts).astype(int), 0, np.array(grid_shape) - 1)
    vert_colors = np.zeros((len(verts), 3), dtype=np.uint8)
    vert_colors[:, 0] = np.clip(cr_s[vi[:, 0], vi[:, 1], vi[:, 2]], 0, 255).astype(np.uint8)
    vert_colors[:, 1] = np.clip(cg_s[vi[:, 0], vi[:, 1], vi[:, 2]], 0, 255).astype(np.uint8)
    vert_colors[:, 2] = np.clip(cb_s[vi[:, 0], vi[:, 1], vi[:, 2]], 0, 255).astype(np.uint8)

    verts_real = verts * voxel + pmin
    return verts_real, faces, vert_colors


def write_obj(filepath, vertices, faces, colors):
    """Write OBJ file with vertex colors (v x y z r g b format).

    Coordinates are kept in EPSG:3776 so the file is georeferenced.
    Vertex colors are normalized to 0-1 range.
    """
    nv = len(vertices)
    nf = len(faces)
    colors_f = colors.astype(np.float32) / 255.0

    print(f"  Writing OBJ: {nv:,} vertices, {nf:,} faces...")

    with open(filepath, 'w') as f:
        f.write(f"# Trees extracted from Edmonton LiDAR\n")
        f.write(f"# CRS: EPSG:3776 (NAD83 CSRS / MTM zone 12)\n")
        f.write(f"# Vertices: {nv}  Faces: {nf}\n")
        f.write(f"# Coordinates are in metres (EPSG:3776 easting, northing, elevation)\n\n")

        # Vertices with RGB colors
        for i in range(nv):
            f.write(f"v {vertices[i, 0]:.4f} {vertices[i, 1]:.4f} {vertices[i, 2]:.4f} "
                    f"{colors_f[i, 0]:.4f} {colors_f[i, 1]:.4f} {colors_f[i, 2]:.4f}\n")

        f.write(f"\n# Faces\n")

        # Faces (OBJ uses 1-based indexing)
        for i in range(nf):
            f.write(f"f {faces[i, 0]+1} {faces[i, 1]+1} {faces[i, 2]+1}\n")


def main():
    parser = argparse.ArgumentParser(description="Extract trees from LiDAR tile to OBJ")
    parser.add_argument('tile', help='Tile ID (e.g., 032_054)')
    parser.add_argument('--box', type=int, default=400, help='Crop box size in metres (default: 400)')
    args = parser.parse_args()

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Load tile — coordinates stay in EPSG:3776
    x, y, z, cls, r, g, b, cx, cy = load_tile(args.tile, args.box)

    # Build DEM
    dem, gxi, gyi, xmin, ymin = build_dem(x, y, z, cls)

    # Extract vegetation (class 5)
    print("\n=== TREES ===")
    tm = cls == 5
    if tm.sum() == 0:
        print("  No vegetation (class 5) points found!")
        sys.exit(1)

    tree_hag = sample_hag(x[tm], y[tm], z[tm], dem, gxi, gyi, xmin, ymin)
    tall = tree_hag >= MIN_TREE_HEIGHT
    tx, ty, tz = x[tm][tall], y[tm][tall], z[tm][tall]
    tr, tg, tb = r[tm][tall], g[tm][tall], b[tm][tall]
    tree_hag = tree_hag[tall]

    if len(tx) == 0:
        print(f"  No trees above {MIN_TREE_HEIGHT}m")
        sys.exit(1)

    print(f"  Trees above {MIN_TREE_HEIGHT}m: {len(tx):,} points")

    # Cluster trees (use absolute coordinates for OBJ — no centering)
    labels, n_clusters = cluster_2d(np.column_stack([tx, ty]), CLUSTER_CELL)
    print(f"  {n_clusters} tree clusters")

    cluster_ids, cluster_sizes = np.unique(labels, return_counts=True)
    valid = cluster_ids > 0
    cluster_ids, cluster_sizes = cluster_ids[valid], cluster_sizes[valid]
    order = np.argsort(-cluster_sizes)
    cluster_ids = cluster_ids[order][:MAX_TREES]

    all_verts, all_faces, all_colors = [], [], []
    vert_offset = 0

    for i, cid in enumerate(cluster_ids):
        mask = labels == cid
        pts = np.column_stack([tx[mask], ty[mask], tz[mask]])
        rgb = np.column_stack([tr[mask], tg[mask], tb[mask]])

        if len(pts) < MIN_CLUSTER_PTS:
            continue

        h = tree_hag[mask].max()
        if i < 20 or i % 50 == 0:
            print(f"    Tree {i+1}: {len(pts):,} pts, {h:.1f}m", end="")

        verts, faces, colors = mesh_colored(pts, rgb, TREE_VOXEL, TREE_SIGMA)
        if verts is None:
            if i < 20 or i % 50 == 0:
                print(" - failed")
            continue

        if i < 20 or i % 50 == 0:
            print(f" -> {len(faces)} faces")

        all_verts.append(verts)
        all_faces.append(faces + vert_offset)
        all_colors.append(colors)
        vert_offset += len(verts)

    if not all_verts:
        print("\nNo trees could be meshed!")
        sys.exit(1)

    vertices = np.vstack(all_verts)
    faces = np.vstack(all_faces)
    colors = np.vstack(all_colors)

    print(f"\n  Total: {len(vertices):,} vertices, {len(faces):,} faces")

    # Write OBJ
    obj_path = os.path.join(OUTPUT_DIR, f"{args.tile}_trees.obj")
    write_obj(obj_path, vertices, faces, colors)
    size_mb = os.path.getsize(obj_path) / 1024 / 1024
    print(f"\n  -> {obj_path} ({size_mb:.1f} MB)")

    # Write .prj companion file
    prj_path = os.path.join(OUTPUT_DIR, f"{args.tile}_trees.prj")
    with open(prj_path, 'w') as f:
        f.write(PRJ_WKT)
    print(f"  -> {prj_path}")

    # Summary
    print(f"\nBounds (EPSG:3776):")
    print(f"  X: {vertices[:, 0].min():.1f} - {vertices[:, 0].max():.1f}")
    print(f"  Y: {vertices[:, 1].min():.1f} - {vertices[:, 1].max():.1f}")
    print(f"  Z: {vertices[:, 2].min():.1f} - {vertices[:, 2].max():.1f}")


if __name__ == "__main__":
    main()
