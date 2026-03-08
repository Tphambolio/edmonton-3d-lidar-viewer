#!/usr/bin/env python3
"""
Extract LiDAR trees + extruded GeoJSON buildings into Collada (.dae) layers.

Produces:
  - {tile}_scene.dae      — combined trees + buildings
  - {tile}_trees.dae       — tree meshes only (from LiDAR class 5)
  - {tile}_buildings.dae   — extruded building footprints (from GeoJSON)

Each building is a separate named <node> (e.g. "bldg_47") so individual
structures can be toggled/deleted in SketchUp.

Usage:
    python extract_scene_dae.py 023_042 [--box 200] [--buildings path/to/buildings.geojson]
"""

import sys
import os
import argparse
import json
import numpy as np
import laspy
from scipy.ndimage import gaussian_filter, label
from scipy.interpolate import griddata
from scipy.spatial import ConvexHull
from skimage.measure import marching_cubes
from pyproj import Transformer

# --- Defaults ---
DEFAULT_BUILDINGS = os.path.expanduser(
    "~/dev/wildfire/wildfire-simulator-v2/data/edmonton_buildings.geojson"
)
LAZ_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(LAZ_DIR, "dae_export")

BOX_SIZE = 200
MIN_TREE_HEIGHT = 3.0
TREE_VOXEL = 0.4
TREE_SIGMA = 1.2
CLUSTER_CELL = 2.5
MIN_CLUSTER_PTS = 80
MAX_TREES = 50

# Building colors by type
BLDG_COLORS = {
    "residential": (210, 190, 165),   # warm beige
    "commercial":  (170, 170, 180),   # cool gray
    "industrial":  (150, 155, 145),   # olive gray
}
BLDG_DEFAULT_COLOR = (190, 185, 175)
WALL_DARKEN = 0.65  # walls darker than roof


# ========== LIDAR LOADING ==========

def load_tile(tile_name, box_size):
    """Load LAZ tile, crop to center box."""
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

    if r.max() > 255:
        r = np.clip(r / 256, 0, 255).astype(np.uint8)
        g = np.clip(g / 256, 0, 255).astype(np.uint8)
        b = np.clip(b / 256, 0, 255).astype(np.uint8)

    print(f"  Cropped to {box_size}m box: {len(x):,} points")
    print(f"  Center EPSG:3776: ({cx:.0f}, {cy:.0f})")

    # Full tile bounds for building query
    tile_bounds_3776 = (las.x.min(), las.y.min(), las.x.max(), las.y.max())

    return x, y, z, cls, r, g, b, cx, cy, tile_bounds_3776


def build_dem(x, y, z, cls, grid_res=2.0):
    """Ground DEM from class 2."""
    gm = cls == 2
    gx, gy, gz = x[gm], y[gm], z[gm]
    gxi = np.arange(x.min(), x.max(), grid_res)
    gyi = np.arange(y.min(), y.max(), grid_res)
    gxx, gyy = np.meshgrid(gxi, gyi)
    dem = griddata((gx, gy), gz, (gxx, gyy), method='linear', fill_value=gz.mean())
    return dem, gxi, gyi, x.min(), y.min()


def sample_hag(px, py, pz, dem, gxi, gyi, xmin, ymin, grid_res=2.0):
    """Height above ground for points."""
    ti = np.clip(((px - xmin) / grid_res).astype(int), 0, len(gxi) - 1)
    tj = np.clip(((py - ymin) / grid_res).astype(int), 0, len(gyi) - 1)
    return pz - dem[tj, ti]


# ========== TREE MESHING (marching cubes) ==========

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
    """Marching cubes with density-weighted color."""
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
    cr_s = np.zeros_like(cr); cg_s = np.zeros_like(cg); cb_s = np.zeros_like(cb)
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


def process_trees(x, y, z, cls, r, g, b, cx, cy, z_base, dem, gxi, gyi, xmin, ymin):
    """Extract and mesh trees from LiDAR class 5."""
    tm = cls == 5
    if tm.sum() == 0:
        print("  No class 5 (tree) points")
        return []

    tree_hag = sample_hag(x[tm], y[tm], z[tm], dem, gxi, gyi, xmin, ymin)
    tall = tree_hag >= MIN_TREE_HEIGHT
    px = x[tm][tall] - cx
    py = y[tm][tall] - cy
    pz = z[tm][tall] - z_base
    pr, pg, pb = r[tm][tall], g[tm][tall], b[tm][tall]
    hag_f = tree_hag[tall]

    if len(px) == 0:
        print("  No trees above height threshold")
        return []

    print(f"  Trees above {MIN_TREE_HEIGHT}m: {len(px):,}")

    labels, n_clusters = cluster_2d(np.column_stack([px, py]), CLUSTER_CELL)
    cluster_ids, cluster_sizes = np.unique(labels, return_counts=True)
    valid = cluster_ids > 0
    cluster_ids, cluster_sizes = cluster_ids[valid], cluster_sizes[valid]
    order = np.argsort(-cluster_sizes)
    cluster_ids = cluster_ids[order][:MAX_TREES]

    all_verts, all_faces, all_colors = [], [], []
    vert_offset = 0
    count = 0

    for cid in cluster_ids:
        mask = labels == cid
        pts = np.column_stack([px[mask], py[mask], pz[mask]])
        rgb = np.column_stack([pr[mask], pg[mask], pb[mask]])
        if len(pts) < MIN_CLUSTER_PTS:
            continue

        h = hag_f[mask].max()
        verts, faces, colors = mesh_colored(pts, rgb, TREE_VOXEL, TREE_SIGMA)
        if verts is None:
            continue

        count += 1
        print(f"    Tree {count}: {len(pts):,} pts, {h:.1f}m -> {len(faces)} faces")
        all_verts.append(verts)
        all_faces.append(faces + vert_offset)
        all_colors.append(colors)
        vert_offset += len(verts)

    if not all_verts:
        return []

    verts = np.vstack(all_verts)
    faces = np.vstack(all_faces)
    colors = np.vstack(all_colors)
    print(f"  Total trees: {count}, {len(faces):,} faces")
    return [("Trees", verts, faces, colors)]


# ========== BUILDING EXTRUSION ==========

def triangulate_polygon(coords_2d):
    """Simple ear-clipping triangulation for a convex-ish polygon.
    For complex concave polygons, falls back to fan triangulation from centroid.
    Returns face indices into the coords array.
    """
    n = len(coords_2d)
    if n < 3:
        return np.array([], dtype=int).reshape(0, 3)

    # Fan triangulation from vertex 0 — works well for convex footprints
    faces = []
    for i in range(1, n - 1):
        faces.append([0, i, i + 1])
    return np.array(faces, dtype=int)


def extrude_building(footprint_xy, ground_z, height, roof_color, wall_color):
    """Extrude a 2D polygon footprint into a 3D solid.

    Returns (vertices, faces, colors) for the building.
    Vertices are in local coordinates (already transformed).
    """
    fp = np.array(footprint_xy)
    # Close polygon if not closed
    if not np.allclose(fp[0], fp[-1]):
        fp = np.vstack([fp, fp[0:1]])
    # Remove closing vertex for mesh generation
    fp = fp[:-1]
    n = len(fp)
    if n < 3:
        return None, None, None

    roof_z = ground_z + height
    rc = np.array(roof_color, dtype=np.uint8)
    wc = np.array(wall_color, dtype=np.uint8)

    # --- Vertices ---
    # Floor vertices: 0..n-1
    # Roof vertices: n..2n-1
    floor_verts = np.column_stack([fp, np.full(n, ground_z)])
    roof_verts = np.column_stack([fp, np.full(n, roof_z)])
    verts = np.vstack([floor_verts, roof_verts])

    # --- Colors ---
    floor_colors = np.tile(wc, (n, 1))
    roof_colors = np.tile(rc, (n, 1))
    colors = np.vstack([floor_colors, roof_colors])

    # --- Faces ---
    faces = []

    # Roof (fan triangulation, vertices n..2n-1)
    for i in range(1, n - 1):
        faces.append([n, n + i, n + i + 1])

    # Floor (reverse winding for outward normals)
    for i in range(1, n - 1):
        faces.append([0, i + 1, i])

    # Walls: each edge becomes a quad (2 triangles)
    for i in range(n):
        j = (i + 1) % n
        # Floor i, Floor j, Roof j, Roof i
        fi, fj = i, j
        ri, rj = n + i, n + j
        faces.append([fi, fj, rj])
        faces.append([fi, rj, ri])

    return verts, np.array(faces, dtype=int), colors


def load_buildings_for_tile(buildings_path, tile_bounds_3776, cx, cy, z_base,
                            dem, gxi, gyi, xmin, ymin):
    """Load and extrude buildings from GeoJSON within tile bounds.

    Returns list of (name, verts, faces, colors) — one per building.
    """
    # Transform tile bounds to WGS84 for spatial query
    t_to_wgs = Transformer.from_crs(3776, 4326, always_xy=True)
    t_to_3776 = Transformer.from_crs(4326, 3776, always_xy=True)

    xmin_t, ymin_t, xmax_t, ymax_t = tile_bounds_3776
    lon_min, lat_min = t_to_wgs.transform(xmin_t, ymin_t)
    lon_max, lat_max = t_to_wgs.transform(xmax_t, ymax_t)

    # Add small buffer
    buf = 0.001  # ~100m
    lon_min -= buf; lat_min -= buf
    lon_max += buf; lat_max += buf

    print(f"  Loading buildings from {os.path.basename(buildings_path)}...")
    print(f"  Query bbox: ({lon_min:.4f}, {lat_min:.4f}) - ({lon_max:.4f}, {lat_max:.4f})")

    with open(buildings_path) as f:
        gj = json.load(f)

    # Filter buildings within bbox
    candidates = []
    for feat in gj["features"]:
        props = feat["properties"]
        geom = feat["geometry"]
        if geom["type"] != "Polygon":
            continue

        # Quick centroid check
        coords = geom["coordinates"][0]  # outer ring
        lons = [c[0] for c in coords]
        lats = [c[1] for c in coords]
        clon = sum(lons) / len(lons)
        clat = sum(lats) / len(lats)

        if lon_min <= clon <= lon_max and lat_min <= clat <= lat_max:
            candidates.append(feat)

    print(f"  Found {len(candidates)} buildings in tile area")

    # Extrude each building
    building_layers = []
    for feat in candidates:
        props = feat["properties"]
        bldg_id = props.get("id", "unknown")
        bldg_type = props.get("type", "unknown")
        height = props.get("height", 6.0)
        if height < 2.0:
            height = 3.0  # minimum visible height

        # Get footprint coordinates and reproject to EPSG:3776
        coords_wgs = feat["geometry"]["coordinates"][0]
        lons = np.array([c[0] for c in coords_wgs])
        lats = np.array([c[1] for c in coords_wgs])
        xs, ys = t_to_3776.transform(lons, lats)

        # Convert to local coordinates (centered on tile center)
        xs_local = xs - cx
        ys_local = ys - cy

        # Sample ground elevation at building centroid
        bcx = np.mean(xs)
        bcy = np.mean(ys)
        ti = int(np.clip((bcx - xmin) / 2.0, 0, len(gxi) - 1))
        tj = int(np.clip((bcy - ymin) / 2.0, 0, len(gyi) - 1))
        if tj < dem.shape[0] and ti < dem.shape[1]:
            ground_z = dem[tj, ti] - z_base
        else:
            ground_z = 0.0

        # Colors by building type
        base_color = BLDG_COLORS.get(bldg_type, BLDG_DEFAULT_COLOR)
        wall_color = tuple(int(c * WALL_DARKEN) for c in base_color)

        footprint_xy = list(zip(xs_local, ys_local))
        verts, faces, colors = extrude_building(
            footprint_xy, ground_z, height, base_color, wall_color
        )
        if verts is None:
            continue

        node_name = f"bldg_{bldg_id}_{bldg_type}"
        building_layers.append((node_name, verts, faces, colors))

    print(f"  Extruded {len(building_layers)} buildings")
    return building_layers


# ========== COLLADA EXPORT ==========

def write_dae(filepath, layers):
    """Write Collada DAE with multiple named layers.
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

        gid = name.lower().replace(" ", "_").replace("-", "_")
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


# ========== MAIN ==========

def main():
    parser = argparse.ArgumentParser(description="Export LiDAR trees + extruded buildings as COLLADA")
    parser.add_argument("tile", help="Tile name e.g. 023_042")
    parser.add_argument("--box", type=int, default=BOX_SIZE, help="Crop box size in meters")
    parser.add_argument("--buildings", default=DEFAULT_BUILDINGS, help="Path to buildings GeoJSON")
    args = parser.parse_args()

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Load LiDAR
    x, y, z, cls, r, g, b, cx, cy, tile_bounds = load_tile(args.tile, args.box)

    # Build DEM
    dem, gxi, gyi, xmin_dem, ymin_dem = build_dem(x, y, z, cls)
    gm = cls == 2
    z_base = z[gm].min()

    # --- Trees ---
    print("\n=== TREES (LiDAR class 5, marching cubes) ===")
    tree_layers = process_trees(x, y, z, cls, r, g, b, cx, cy, z_base,
                                dem, gxi, gyi, xmin_dem, ymin_dem)

    # --- Buildings ---
    print("\n=== BUILDINGS (GeoJSON footprints, extruded) ===")
    if os.path.exists(args.buildings):
        building_layers = load_buildings_for_tile(
            args.buildings, tile_bounds, cx, cy, z_base,
            dem, gxi, gyi, xmin_dem, ymin_dem
        )
    else:
        print(f"  Buildings file not found: {args.buildings}")
        building_layers = []

    # --- Export ---
    print(f"\n=== EXPORT ===")

    # Individual trees layer
    if tree_layers:
        path = os.path.join(OUTPUT_DIR, f"{args.tile}_trees.dae")
        write_dae(path, tree_layers)
        sz = os.path.getsize(path) / 1024 / 1024
        print(f"  Trees -> {path} ({sz:.1f} MB)")

    # Individual buildings layer (all buildings in one file, each as separate node)
    if building_layers:
        path = os.path.join(OUTPUT_DIR, f"{args.tile}_buildings.dae")
        write_dae(path, building_layers)
        sz = os.path.getsize(path) / 1024 / 1024
        print(f"  Buildings ({len(building_layers)} structures) -> {path} ({sz:.1f} MB)")

    # Combined scene
    all_layers = tree_layers + building_layers
    if all_layers:
        path = os.path.join(OUTPUT_DIR, f"{args.tile}_scene.dae")
        write_dae(path, all_layers)
        sz = os.path.getsize(path) / 1024 / 1024
        print(f"  Combined scene -> {path} ({sz:.1f} MB)")
    else:
        print("  No data to export.")


if __name__ == "__main__":
    main()
