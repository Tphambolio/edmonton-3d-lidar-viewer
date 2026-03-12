"""
Edmonton LiDAR Tree Loader for ArcGIS Pro
==========================================
Paste this into an ArcGIS Pro Python Notebook.

Geocodes an Edmonton address, finds nearby tree tiles, downloads
OBJ files from Google Drive, and imports them into the current 3D scene.

Dependencies: arcpy, numpy, requests (all built-in to ArcGIS Pro)
"""

import arcpy
import os
import sys
import json
import requests
import tempfile

# ============================================================
# CONFIGURATION — Edit these values
# ============================================================

# Google Drive shared folder containing OBJ files + index.json
# Set to your shared folder's base URL, or use R2 URL below
GOOGLE_DRIVE_FOLDER_ID = ""  # Fill in your Google Drive folder ID

# Cloudflare R2 fallback (public, no auth needed)
R2_BASE = "https://pub-e37d9167d0644b6fb71d37ada161e611.r2.dev"

# Local download directory
DOWNLOAD_DIR = os.path.join(arcpy.env.scratchFolder or tempfile.gettempdir(),
                            "edmonton_tree_tiles")

# How many tiles around the center to load
# 0 = just the covering tile, 1 = 3x3 grid (~1.5km), 2 = 5x5 grid (~2.5km)
SEARCH_RADIUS = 1

# Tile grid size in metres
TILE_SIZE = 512

# ============================================================
# FUNCTIONS
# ============================================================


def geocode_address(address):
    """Geocode an address using Nominatim. Returns (lat, lng)."""
    url = "https://nominatim.openstreetmap.org/search"
    params = {
        "q": f"{address}, Edmonton, Alberta, Canada",
        "format": "json",
        "limit": 1,
        "countrycodes": "ca"
    }
    headers = {"User-Agent": "Edmonton-LiDAR-TreeLoader/1.0"}
    resp = requests.get(url, params=params, headers=headers, timeout=10)
    resp.raise_for_status()
    results = resp.json()
    if not results:
        raise ValueError(f"Address not found: {address}")
    lat = float(results[0]["lat"])
    lng = float(results[0]["lon"])
    display = results[0].get("display_name", address)
    print(f"Found: {display}")
    print(f"  WGS84: ({lat:.6f}, {lng:.6f})")
    return lat, lng


def to_epsg3776(lat, lng):
    """Convert WGS84 lat/lng to EPSG:3776 (NAD83 3TM 114) using arcpy."""
    sr_wgs84 = arcpy.SpatialReference(4326)
    sr_3776 = arcpy.SpatialReference(3776)
    pt = arcpy.PointGeometry(arcpy.Point(lng, lat), sr_wgs84)
    pt_proj = pt.projectAs(sr_3776)
    easting = pt_proj.firstPoint.X
    northing = pt_proj.firstPoint.Y
    print(f"  EPSG:3776: ({easting:.1f}, {northing:.1f})")
    return easting, northing


def download_index():
    """Download or load cached tile index."""
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    index_path = os.path.join(DOWNLOAD_DIR, "index.json")

    # Download fresh index if not cached (or older than 1 day)
    download = True
    if os.path.exists(index_path):
        age_hours = (os.path.getmtime(index_path) - os.path.getctime(index_path)) / 3600
        if age_hours < 24:
            download = False

    if download:
        if GOOGLE_DRIVE_FOLDER_ID:
            # Try Google Drive manifest first
            manifest_path = os.path.join(DOWNLOAD_DIR, "manifest.json")
            url = _gdrive_url(GOOGLE_DRIVE_FOLDER_ID, "index.json")
            _download_file(url, index_path)
        else:
            url = f"{R2_BASE}/obj/index.json"
            _download_file(url, index_path)

    with open(index_path) as f:
        index = json.load(f)
    return index.get("tiles", {})


def find_tiles(tiles, easting, northing, radius=SEARCH_RADIUS):
    """Find tile IDs near a location in EPSG:3776 coordinates."""
    matches = []
    threshold = TILE_SIZE * (radius + 0.5)

    for tile_id, meta in tiles.items():
        cx = meta.get("cx_3776")
        cy = meta.get("cy_3776")
        if cx is None or cy is None:
            continue
        if abs(cx - easting) <= threshold and abs(cy - northing) <= threshold:
            dist = ((cx - easting)**2 + (cy - northing)**2) ** 0.5
            matches.append((tile_id, dist, meta))

    matches.sort(key=lambda x: x[1])
    return matches


def download_tile(tile_id):
    """Download OBJ + PRJ for a tile. Returns local OBJ path or None."""
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    obj_name = f"{tile_id}_trees.obj"
    prj_name = f"{tile_id}_trees.prj"
    obj_path = os.path.join(DOWNLOAD_DIR, obj_name)
    prj_path = os.path.join(DOWNLOAD_DIR, prj_name)

    # Skip if already downloaded
    if os.path.exists(obj_path) and os.path.getsize(obj_path) > 100:
        print(f"  {tile_id}: cached ({os.path.getsize(obj_path) / 1024 / 1024:.1f} MB)")
        return obj_path

    # Download OBJ
    if GOOGLE_DRIVE_FOLDER_ID:
        obj_url = _gdrive_download_url(tile_id, "obj")
        prj_url = _gdrive_download_url(tile_id, "prj")
    else:
        obj_url = f"{R2_BASE}/obj/{obj_name}"
        prj_url = f"{R2_BASE}/obj/{prj_name}"

    try:
        _download_file(obj_url, obj_path)
        _download_file(prj_url, prj_path)
        size_mb = os.path.getsize(obj_path) / 1024 / 1024
        print(f"  {tile_id}: downloaded ({size_mb:.1f} MB)")
        return obj_path
    except Exception as e:
        print(f"  {tile_id}: download failed - {e}")
        return None


def _download_file(url, dest):
    """Download a file from URL to local path."""
    resp = requests.get(url, stream=True, timeout=120)
    resp.raise_for_status()
    with open(dest, 'wb') as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)


def _gdrive_url(folder_id, filename):
    """Construct Google Drive download URL.
    Requires a manifest.json mapping filenames to file IDs.
    """
    manifest_path = os.path.join(DOWNLOAD_DIR, "manifest.json")
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
        file_id = manifest.get(filename)
        if file_id:
            return f"https://drive.google.com/uc?export=download&id={file_id}"
    # Fallback to R2
    return f"{R2_BASE}/obj/{filename}"


def _gdrive_download_url(tile_id, ext):
    """Get Google Drive download URL for a tile file."""
    filename = f"{tile_id}_trees.{ext}"
    return _gdrive_url("", filename)


def import_to_scene(obj_paths, scene_name=None):
    """Import OBJ files as multipatch features in the current ArcGIS Pro scene."""
    aprx = arcpy.mp.ArcGISProject("CURRENT")
    sr = arcpy.SpatialReference(3776)

    # Find the 3D scene
    maps = aprx.listMaps()
    scene = None
    for m in maps:
        if m.mapType == "SCENE" or (scene_name and m.name == scene_name):
            scene = m
            break

    if scene is None:
        print("WARNING: No 3D scene found. Creating layers in default GDB.")

    gdb = arcpy.env.scratchGDB or arcpy.env.workspace

    imported = []
    for obj_path in obj_paths:
        tile_name = os.path.basename(obj_path).replace("_trees.obj", "")
        fc_name = f"trees_{tile_name}"

        # Check if already imported
        fc_path = os.path.join(gdb, fc_name)
        if arcpy.Exists(fc_path):
            print(f"  {tile_name}: already in geodatabase")
            imported.append(fc_path)
            continue

        try:
            result = arcpy.ddd.Import3DFiles(
                in_files=obj_path,
                out_featureClass=fc_path,
                spatial_reference=sr
            )
            print(f"  {tile_name}: imported as {fc_name}")
            imported.append(fc_path)
        except Exception as e:
            print(f"  {tile_name}: import failed - {e}")
            # Fallback: try adding directly as a layer
            try:
                if scene:
                    scene.addDataFromPath(obj_path)
                    print(f"  {tile_name}: added directly to scene")
                    imported.append(obj_path)
            except Exception as e2:
                print(f"  {tile_name}: direct add also failed - {e2}")

    # Add to scene if not already there
    if scene and imported:
        for fc_path in imported:
            try:
                scene.addDataFromPath(fc_path)
            except Exception:
                pass  # May already be added

    return imported


# ============================================================
# MAIN — Run this cell to load trees
# ============================================================

def load_trees(address, radius=SEARCH_RADIUS):
    """Main entry point: geocode address and load surrounding tree tiles."""
    print(f"=== Edmonton LiDAR Tree Loader ===\n")

    # 1. Geocode
    print("1. Geocoding address...")
    lat, lng = geocode_address(address)

    # 2. Convert to EPSG:3776
    print("\n2. Converting to EPSG:3776...")
    easting, northing = to_epsg3776(lat, lng)

    # 3. Find tiles
    print("\n3. Finding tiles...")
    tiles = download_index()
    matches = find_tiles(tiles, easting, northing, radius)
    if not matches:
        print("  No tiles found near this location!")
        return

    print(f"  Found {len(matches)} tiles:")
    for tile_id, dist, meta in matches:
        print(f"    {tile_id} ({dist:.0f}m away, {meta.get('size_mb', '?')} MB GLB)")

    # 4. Download OBJ files
    print(f"\n4. Downloading OBJ files...")
    obj_paths = []
    for tile_id, dist, meta in matches:
        path = download_tile(tile_id)
        if path:
            obj_paths.append(path)

    if not obj_paths:
        print("  No tiles could be downloaded!")
        return

    # 5. Import to ArcGIS Pro
    print(f"\n5. Importing {len(obj_paths)} tiles into ArcGIS Pro...")
    imported = import_to_scene(obj_paths)

    print(f"\n=== Done! Loaded {len(imported)} tree tile(s) ===")
    return imported


# ============================================================
# USAGE — Edit the address and run
# ============================================================

# load_trees("14237 106B Ave NW")
# load_trees("10230 Jasper Ave")
# load_trees("Hawrelak Park")
