#!/usr/bin/env python3
"""
Augment tree tile index.json with EPSG:3776 tile centers and z_base.

Reads LAZ file headers to extract cx_3776, cy_3776 (tile center in
EPSG:3776) and z_base (minimum ground elevation). These are needed
by the GLB→OBJ converter to reverse the Y-up coordinate transform.

Usage:
    python3 scripts/augment_index.py
"""

import json
import os
import sys
import laspy
import numpy as np

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAZ_DIR = PROJECT_DIR
INDEX_PATH = os.path.join(PROJECT_DIR, "edmonton-3d-viewer", "data", "tree_tiles", "index.json")


def augment_tile(tile_name):
    """Read LAZ header + ground class to get cx, cy, z_base."""
    laz_path = os.path.join(LAZ_DIR, f"{tile_name}.laz")
    if not os.path.exists(laz_path):
        return None

    with laspy.open(laz_path) as f:
        header = f.header
        cx = (header.x_min + header.x_max) / 2
        cy = (header.y_min + header.y_max) / 2

    # Read classification + z to get ground min (class 2)
    las = laspy.read(laz_path)
    gm = las.classification == 2
    if gm.sum() > 0:
        z_base = float(np.array(las.z[gm]).min())
    else:
        z_base = float(np.array(las.z).min())

    return {
        "cx_3776": round(cx, 2),
        "cy_3776": round(cy, 2),
        "z_base": round(z_base, 2)
    }


def main():
    with open(INDEX_PATH) as f:
        index = json.load(f)

    tiles = index.get("tiles", {})
    total = len(tiles)
    augmented = 0
    skipped = 0

    print(f"Augmenting {total} tiles in index.json...")

    for i, (tile_name, meta) in enumerate(tiles.items()):
        if "cx_3776" in meta:
            skipped += 1
            continue

        result = augment_tile(tile_name)
        if result:
            meta.update(result)
            augmented += 1
        else:
            skipped += 1

        if (i + 1) % 100 == 0 or i == total - 1:
            print(f"  {i+1}/{total} processed ({augmented} augmented, {skipped} skipped)",
                  flush=True)

    # Write back
    backup_path = INDEX_PATH + ".bak"
    if not os.path.exists(backup_path):
        import shutil
        shutil.copy2(INDEX_PATH, backup_path)
        print(f"Backup: {backup_path}")

    with open(INDEX_PATH, 'w') as f:
        json.dump(index, f, indent=2)

    print(f"\nDone: {augmented} tiles augmented, {skipped} skipped")
    print(f"Updated: {INDEX_PATH}")


if __name__ == "__main__":
    main()
