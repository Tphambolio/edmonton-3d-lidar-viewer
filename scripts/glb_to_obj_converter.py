#!/usr/bin/env python3
"""
Convert tree tile GLBs to georeferenced OBJ files for ArcGIS Pro.

Reads GLB files (Y-up, relative to tile center), reverses the coordinate
transform to EPSG:3776 (Alberta 3TM 114), and writes OBJ with vertex
colors + companion .prj file.

Requires augmented index.json (run augment_index.py first).

Usage:
    # Convert specific tiles
    python3 scripts/glb_to_obj_converter.py 032_054 010_040

    # Convert tiles near an address
    python3 scripts/glb_to_obj_converter.py --address "14237 106B Ave NW, Edmonton"

    # Convert with custom radius (number of tiles around center)
    python3 scripts/glb_to_obj_converter.py --address "Jasper Ave, Edmonton" --radius 2
"""

import sys
import os
import json
import argparse
import numpy as np
import trimesh
import requests

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLB_DIR = os.path.join(PROJECT_DIR, "edmonton-3d-viewer", "data", "tree_tiles")
INDEX_PATH = os.path.join(GLB_DIR, "index.json")
OUTPUT_DIR = os.path.join(PROJECT_DIR, "obj_export")

TILE_SIZE = 512  # metres

# EPSG:3776 WKT — NAD83 3TM 114 (Alberta)
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


def load_index():
    """Load tile index with EPSG:3776 metadata."""
    with open(INDEX_PATH) as f:
        index = json.load(f)
    tiles = index.get("tiles", {})

    # Count augmented tiles
    aug_count = sum(1 for t in tiles.values() if "cx_3776" in t)
    if aug_count == 0:
        print("ERROR: index.json not augmented. Run augment_index.py first.")
        sys.exit(1)
    print(f"Index loaded: {len(tiles)} tiles ({aug_count} augmented)")

    return tiles


def geocode_address(address):
    """Geocode an address using Nominatim. Returns (lat, lng)."""
    url = "https://nominatim.openstreetmap.org/search"
    params = {
        "q": address,
        "format": "json",
        "limit": 1,
        "countrycodes": "ca"
    }
    headers = {"User-Agent": "Edmonton-LiDAR-TreeLoader/1.0"}
    resp = requests.get(url, params=params, headers=headers)
    resp.raise_for_status()
    results = resp.json()
    if not results:
        print(f"ERROR: Address not found: {address}")
        sys.exit(1)
    lat = float(results[0]["lat"])
    lng = float(results[0]["lon"])
    print(f"Geocoded: {results[0]['display_name']}")
    print(f"  WGS84: ({lat:.6f}, {lng:.6f})")
    return lat, lng


def latlng_to_3776(lat, lng):
    """Convert WGS84 lat/lng to EPSG:3776 easting/northing."""
    from pyproj import Transformer
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3776", always_xy=True)
    easting, northing = transformer.transform(lng, lat)
    return easting, northing


def find_tiles_near(tiles, easting, northing, radius=1):
    """Find tile IDs within radius tiles of a location.
    radius=0: just the covering tile
    radius=1: 3x3 grid (9 tiles)
    radius=2: 5x5 grid (25 tiles)
    """
    matches = []
    threshold = TILE_SIZE * (radius + 0.5)

    for tile_id, meta in tiles.items():
        cx = meta.get("cx_3776")
        cy = meta.get("cy_3776")
        if cx is None or cy is None:
            continue
        if abs(cx - easting) <= threshold and abs(cy - northing) <= threshold:
            dist = ((cx - easting)**2 + (cy - northing)**2) ** 0.5
            matches.append((tile_id, dist))

    matches.sort(key=lambda x: x[1])
    return [m[0] for m in matches]


def convert_glb_to_obj(tile_id, meta):
    """Convert a single GLB to georeferenced OBJ in EPSG:3776."""
    glb_path = os.path.join(GLB_DIR, meta["file"])
    if not os.path.exists(glb_path):
        print(f"  SKIP: {glb_path} not found")
        return None

    cx = meta["cx_3776"]
    cy = meta["cy_3776"]
    z_base = meta["z_base"]

    # Load GLB
    scene = trimesh.load(glb_path)
    if isinstance(scene, trimesh.Scene):
        meshes = [g for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            print(f"  SKIP: no mesh geometry in {tile_id}")
            return None
        mesh = trimesh.util.concatenate(meshes)
    else:
        mesh = scene

    glb_verts = mesh.vertices  # (N, 3) in GLB Y-up: (east_rel, height_rel, -north_rel)
    faces = mesh.faces

    # Extract vertex colors
    if hasattr(mesh.visual, 'vertex_colors') and mesh.visual.vertex_colors is not None:
        colors = mesh.visual.vertex_colors[:, :3]  # RGB uint8
    else:
        colors = np.full((len(glb_verts), 3), 100, dtype=np.uint8)

    # Reverse Y-up transform → EPSG:3776 absolute coordinates
    # GLB: (glb_x, glb_y, glb_z) = (east_rel, height_rel, -north_rel)
    # Reverse: east = glb_x + cx, north = -glb_z + cy, elev = glb_y + z_base
    east = glb_verts[:, 0] + cx
    north = -glb_verts[:, 2] + cy
    elev = glb_verts[:, 1] + z_base

    vertices = np.column_stack([east, north, elev])

    # Write OBJ
    obj_path = os.path.join(OUTPUT_DIR, f"{tile_id}_trees.obj")
    colors_f = colors.astype(np.float32) / 255.0
    nv = len(vertices)
    nf = len(faces)

    with open(obj_path, 'w') as f:
        f.write(f"# Tree mesh from LiDAR tile {tile_id}\n")
        f.write(f"# CRS: EPSG:3776 (NAD83 3TM 114)\n")
        f.write(f"# Vertices: {nv}  Faces: {nf}\n\n")
        for i in range(nv):
            f.write(f"v {vertices[i,0]:.4f} {vertices[i,1]:.4f} {vertices[i,2]:.4f} "
                    f"{colors_f[i,0]:.4f} {colors_f[i,1]:.4f} {colors_f[i,2]:.4f}\n")
        f.write(f"\n# Faces\n")
        for i in range(nf):
            f.write(f"f {faces[i,0]+1} {faces[i,1]+1} {faces[i,2]+1}\n")

    # Write PRJ
    prj_path = os.path.join(OUTPUT_DIR, f"{tile_id}_trees.prj")
    with open(prj_path, 'w') as f:
        f.write(PRJ_WKT)

    size_mb = os.path.getsize(obj_path) / 1024 / 1024
    print(f"  {tile_id}: {nv:,} verts, {nf:,} faces -> {obj_path} ({size_mb:.1f} MB)")

    return obj_path


def main():
    parser = argparse.ArgumentParser(description="Convert GLB tree tiles to OBJ for ArcGIS Pro")
    parser.add_argument('tiles', nargs='*', help='Tile IDs to convert (e.g., 032_054)')
    parser.add_argument('--all', action='store_true', help='Convert ALL augmented tiles')
    parser.add_argument('--address', '-a', help='Edmonton address to find tiles near')
    parser.add_argument('--radius', '-r', type=int, default=1,
                        help='Tile search radius (0=1 tile, 1=3x3, 2=5x5). Default: 1')
    parser.add_argument('--skip-existing', action='store_true', default=True,
                        help='Skip tiles that already have OBJ files (default: True)')
    args = parser.parse_args()

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    tiles_index = load_index()

    # Determine which tiles to convert
    tile_ids = list(args.tiles)

    if args.all:
        tile_ids = [tid for tid, meta in tiles_index.items() if "cx_3776" in meta]
        print(f"Converting ALL {len(tile_ids)} augmented tiles")

    if args.address:
        lat, lng = geocode_address(args.address)
        easting, northing = latlng_to_3776(lat, lng)
        print(f"  EPSG:3776: ({easting:.1f}, {northing:.1f})")
        nearby = find_tiles_near(tiles_index, easting, northing, args.radius)
        print(f"  Found {len(nearby)} tiles within radius {args.radius}")
        tile_ids.extend(nearby)

    if not tile_ids:
        if args.address:
            print("No tiles found near that address. Try a different address or specify tile IDs.")
        else:
            parser.print_help()
        sys.exit(1)

    # Remove duplicates, preserve order
    seen = set()
    unique_ids = []
    for t in tile_ids:
        if t not in seen:
            seen.add(t)
            unique_ids.append(t)
    tile_ids = unique_ids

    print(f"\nConverting {len(tile_ids)} tiles: {', '.join(tile_ids[:10])}"
          f"{'...' if len(tile_ids) > 10 else ''}\n")

    converted = []
    skipped = 0
    for i, tile_id in enumerate(tile_ids):
        if tile_id not in tiles_index:
            print(f"  SKIP: {tile_id} not in index")
            skipped += 1
            continue
        meta = tiles_index[tile_id]
        if "cx_3776" not in meta:
            print(f"  SKIP: {tile_id} missing EPSG:3776 metadata (run augment_index.py)")
            skipped += 1
            continue
        # Skip existing OBJ files
        if args.skip_existing:
            obj_path = os.path.join(OUTPUT_DIR, f"{tile_id}_trees.obj")
            if os.path.exists(obj_path) and os.path.getsize(obj_path) > 100:
                skipped += 1
                if (i + 1) % 100 == 0:
                    print(f"  Progress: {i+1}/{len(tile_ids)} ({len(converted)} converted, {skipped} skipped)")
                continue
        result = convert_glb_to_obj(tile_id, meta)
        if result:
            converted.append(result)
        if (i + 1) % 50 == 0:
            print(f"  Progress: {i+1}/{len(tile_ids)} ({len(converted)} converted, {skipped} skipped)")

    print(f"\nConverted {len(converted)} tiles to {OUTPUT_DIR}")
    if converted:
        # Print bounds summary
        print(f"\nTo import in ArcGIS Pro:")
        print(f"  1. Copy .obj + .prj files to ArcGIS Pro machine")
        print(f"  2. In ArcGIS Pro: Analysis > Tools > Import 3D Files")
        print(f"  3. Or drag .obj into a 3D Local Scene")


if __name__ == "__main__":
    main()
