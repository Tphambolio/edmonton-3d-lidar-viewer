#!/usr/bin/env python3
"""
Extract trees AND buildings from Edmonton citywide veglidar tile,
mesh with marching cubes, export as separate Collada (.dae) layers
with RGB vertex colors for SketchUp import.
"""

import sys
import os
import numpy as np
import laspy
from scipy.ndimage import gaussian_filter, label
from scipy.interpolate import griddata
from scipy.spatial import ConvexHull
from skimage.measure import marching_cubes

TILE = sys.argv[1] if len(sys.argv) > 1 else "010_040"
LAZ_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(LAZ_DIR, "dae_export")
os.makedirs(OUTPUT_DIR, exist_ok=True)

BOX_SIZE = 200
MIN_TREE_HEIGHT = 3.0
MIN_BLDG_HEIGHT = 2.5
TREE_VOXEL = 0.4
TREE_SIGMA = 1.2
BLDG_VOXEL = 0.3
BLDG_SIGMA = 0.6       # less smoothing for sharp building edges
CLUSTER_CELL = 2.5
MIN_CLUSTER_PTS = 80
MAX_TREES = 50
MAX_BLDGS = 30


def load_tile(tile_name, box_size=BOX_SIZE):
    """Load tile, crop to center box."""
    laz_path = os.path.join(LAZ_DIR, f"{tile_name}.laz")
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
    num_returns = np.array(las.number_of_returns[box_mask])

    if r.max() > 255:
        r = np.clip(r / 256, 0, 255).astype(np.uint8)
        g = np.clip(g / 256, 0, 255).astype(np.uint8)
        b = np.clip(b / 256, 0, 255).astype(np.uint8)

    print(f"  Cropped to {box_size}m box: {len(x):,} points")
    print(f"  Center: ({cx:.0f}, {cy:.0f})")
    return x, y, z, cls, r, g, b, num_returns, cx, cy


def build_dem(x, y, z, cls, grid_res=2.0):
    """Build ground DEM from class 2 points."""
    gm = cls == 2
    gx, gy, gz = x[gm], y[gm], z[gm]
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

    # Density-weighted color smoothing to prevent dilution
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


def write_dae(filepath, layers):
    """Write Collada DAE with multiple named layers (geometry nodes).
    layers: list of (name, vertices, faces, colors)
    """
    geom_sections = []
    node_sections = []

    for name, vertices, faces, colors in layers:
        nv = len(vertices)
        nf = len(faces)
        colors_f = colors.astype(np.float32) / 255.0

        pos_str = " ".join(f"{v[0]:.4f} {v[1]:.4f} {v[2]:.4f}" for v in vertices)
        col_str = " ".join(f"{c[0]:.4f} {c[1]:.4f} {c[2]:.4f} 1.0" for c in colors_f)

        v0 = vertices[faces[:, 0]]
        v1 = vertices[faces[:, 1]]
        v2 = vertices[faces[:, 2]]
        fn = np.cross(v1 - v0, v2 - v0)
        norms = np.linalg.norm(fn, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        fn = fn / norms
        norm_str = " ".join(f"{n[0]:.4f} {n[1]:.4f} {n[2]:.4f}" for n in fn)

        p_parts = []
        for fi, face in enumerate(faces):
            p_parts.append(f"{face[0]} {fi} {face[0]} {face[1]} {fi} {face[1]} {face[2]} {fi} {face[2]}")
        p_str = " ".join(p_parts)

        gid = name.lower().replace(" ", "_")
        geom_sections.append(f"""
    <geometry id="{gid}-mesh" name="{name}">
      <mesh>
        <source id="{gid}-positions">
          <float_array id="{gid}-positions-array" count="{nv*3}">{pos_str}</float_array>
          <technique_common>
            <accessor source="#{gid}-positions-array" count="{nv}" stride="3">
              <param name="X" type="float"/>
              <param name="Y" type="float"/>
              <param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="{gid}-normals">
          <float_array id="{gid}-normals-array" count="{nf*3}">{norm_str}</float_array>
          <technique_common>
            <accessor source="#{gid}-normals-array" count="{nf}" stride="3">
              <param name="X" type="float"/>
              <param name="Y" type="float"/>
              <param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="{gid}-colors">
          <float_array id="{gid}-colors-array" count="{nv*4}">{col_str}</float_array>
          <technique_common>
            <accessor source="#{gid}-colors-array" count="{nv}" stride="4">
              <param name="R" type="float"/>
              <param name="G" type="float"/>
              <param name="B" type="float"/>
              <param name="A" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="{gid}-verts">
          <input semantic="POSITION" source="#{gid}-positions"/>
        </vertices>
        <triangles count="{nf}">
          <input semantic="VERTEX" source="#{gid}-verts" offset="0"/>
          <input semantic="NORMAL" source="#{gid}-normals" offset="1"/>
          <input semantic="COLOR" source="#{gid}-colors" offset="2"/>
          <p>{p_str}</p>
        </triangles>
      </mesh>
    </geometry>""")

        node_sections.append(f"""
      <node id="{gid}" name="{name}" type="NODE">
        <instance_geometry url="#{gid}-mesh"/>
      </node>""")

    dae = f"""<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <created>2026-03-08</created>
    <unit name="meter" meter="1"/>
    <up_axis>Z_UP</up_axis>
  </asset>
  <library_geometries>{"".join(geom_sections)}
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">{"".join(node_sections)}
    </visual_scene>
  </library_visual_scenes>
  <scene>
    <instance_visual_scene url="#Scene"/>
  </scene>
</COLLADA>"""

    with open(filepath, 'w') as f:
        f.write(dae)


def process_layer(name, px, py, pz, hag, pr, pg, pb, cx, cy, z_base,
                  min_height, voxel, sigma, cell_size, min_pts, max_clusters):
    """Process a point set into clustered colored meshes."""
    tall = hag >= min_height
    px, py, pz = px[tall], py[tall], pz[tall]
    pr, pg, pb = pr[tall], pg[tall], pb[tall]
    hag_f = hag[tall]

    if len(px) == 0:
        print(f"  No {name} points above {min_height}m")
        return None, None, None

    print(f"  {name} above {min_height}m: {len(px):,}")

    px_c = px - cx
    py_c = py - cy
    pz_c = pz - z_base

    labels, n_clusters = cluster_2d(np.column_stack([px_c, py_c]), cell_size)
    print(f"  {n_clusters} {name.lower()} clusters")

    cluster_ids, cluster_sizes = np.unique(labels, return_counts=True)
    valid = cluster_ids > 0
    cluster_ids, cluster_sizes = cluster_ids[valid], cluster_sizes[valid]
    order = np.argsort(-cluster_sizes)
    cluster_ids = cluster_ids[order][:max_clusters]

    all_verts, all_faces, all_colors = [], [], []
    vert_offset = 0

    for i, cid in enumerate(cluster_ids):
        mask = labels == cid
        pts = np.column_stack([px_c[mask], py_c[mask], pz_c[mask]])
        rgb = np.column_stack([pr[mask], pg[mask], pb[mask]])

        if len(pts) < min_pts:
            continue

        h = hag_f[mask].max()
        print(f"    {name} {i+1}: {len(pts):,} pts, {h:.1f}m", end="")

        verts, faces, colors = mesh_colored(pts, rgb, voxel, sigma)
        if verts is None:
            print(" - failed")
            continue

        print(f" -> {len(faces)} faces")
        all_verts.append(verts)
        all_faces.append(faces + vert_offset)
        all_colors.append(colors)
        vert_offset += len(verts)

    if not all_verts:
        return None, None, None

    return np.vstack(all_verts), np.vstack(all_faces), np.vstack(all_colors)


def main():
    x, y, z, cls, r, g, b, num_returns, cx, cy = load_tile(TILE)

    # Build DEM
    dem, gxi, gyi, xmin, ymin = build_dem(x, y, z, cls)

    # Z baseline for export
    gm = cls == 2
    z_base = z[gm].min()

    # --- TREES (class 5) ---
    print("\n=== TREES ===")
    tm = cls == 5
    tree_hag = sample_hag(x[tm], y[tm], z[tm], dem, gxi, gyi, xmin, ymin)
    tree_v, tree_f, tree_c = process_layer(
        "Tree", x[tm], y[tm], z[tm], tree_hag, r[tm], g[tm], b[tm],
        cx, cy, z_base, MIN_TREE_HEIGHT, TREE_VOXEL, TREE_SIGMA,
        CLUSTER_CELL, MIN_CLUSTER_PTS, MAX_TREES)

    # --- BUILDINGS (class 1, single return, above ground) ---
    print("\n=== BUILDINGS ===")
    bm = (cls == 1) & (num_returns == 1)
    if bm.sum() > 0:
        bldg_hag = sample_hag(x[bm], y[bm], z[bm], dem, gxi, gyi, xmin, ymin)
        bldg_v, bldg_f, bldg_c = process_layer(
            "Building", x[bm], y[bm], z[bm], bldg_hag, r[bm], g[bm], b[bm],
            cx, cy, z_base, MIN_BLDG_HEIGHT, BLDG_VOXEL, BLDG_SIGMA,
            3.0, 50, MAX_BLDGS)
    else:
        bldg_v = None

    # --- EXPORT ---
    layers = []
    if tree_v is not None:
        layers.append(("Trees", tree_v, tree_f, tree_c))
        print(f"\n  Trees: {len(tree_f)} total faces")
    if bldg_v is not None:
        layers.append(("Buildings", bldg_v, bldg_f, bldg_c))
        print(f"  Buildings: {len(bldg_f)} total faces")

    if layers:
        # Combined file with both layers
        out_path = os.path.join(OUTPUT_DIR, f"{TILE}_scene.dae")
        write_dae(out_path, layers)
        size_mb = os.path.getsize(out_path) / 1024 / 1024
        print(f"\nExported -> {out_path} ({size_mb:.1f} MB)")

        # Also export individual layers
        for name, v, f, c in layers:
            layer_path = os.path.join(OUTPUT_DIR, f"{TILE}_{name.lower()}.dae")
            write_dae(layer_path, [(name, v, f, c)])
            sz = os.path.getsize(layer_path) / 1024 / 1024
            print(f"  {name} layer -> {layer_path} ({sz:.1f} MB)")
    else:
        print("\nNo data exported.")


if __name__ == "__main__":
    main()
