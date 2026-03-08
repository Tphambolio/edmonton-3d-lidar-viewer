#!/usr/bin/env python3
"""
Split Edmonton buildings GeoJSON into spatial grid tiles for web serving.

Each tile is a small JSON file containing buildings within a ~500m grid cell.
A tile index maps cell coordinates to file paths.

Usage:
    python split_buildings.py [--cell-size 0.005] [--output data/building_tiles/]
"""

import json
import os
import argparse
import math
from collections import defaultdict

DEFAULT_INPUT = os.path.expanduser(
    "~/dev/wildfire/wildfire-simulator-v2/data/edmonton_buildings.geojson"
)
DEFAULT_OUTPUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "edmonton-3d-viewer", "data", "building_tiles")


def main():
    parser = argparse.ArgumentParser(description="Split buildings GeoJSON into spatial tiles")
    parser.add_argument("--input", default=DEFAULT_INPUT, help="Input GeoJSON path")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Output directory")
    parser.add_argument("--cell-size", type=float, default=0.005,
                        help="Grid cell size in degrees (~500m at Edmonton latitude)")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)

    print(f"Reading {args.input}...")
    with open(args.input) as f:
        gj = json.load(f)

    features = gj["features"]
    print(f"  {len(features):,} buildings")

    # Assign each building to a grid cell based on centroid
    cells = defaultdict(list)
    for feat in features:
        geom = feat["geometry"]
        if geom["type"] != "Polygon":
            continue
        coords = geom["coordinates"][0]
        clon = sum(c[0] for c in coords) / len(coords)
        clat = sum(c[1] for c in coords) / len(coords)

        col = int(math.floor(clon / args.cell_size))
        row = int(math.floor(clat / args.cell_size))
        cells[(col, row)].append(feat)

    print(f"  {len(cells)} grid cells")

    # Write each cell as a separate JSON file
    index = {}
    total_size = 0
    for (col, row), feats in cells.items():
        filename = f"{col}_{row}.json"
        filepath = os.path.join(args.output, filename)

        # Compute cell bounds
        cell_west = col * args.cell_size
        cell_south = row * args.cell_size
        cell_east = cell_west + args.cell_size
        cell_north = cell_south + args.cell_size

        tile_data = {
            "type": "FeatureCollection",
            "bounds": [cell_west, cell_south, cell_east, cell_north],
            "features": feats
        }

        with open(filepath, 'w') as f:
            json.dump(tile_data, f, separators=(',', ':'))

        sz = os.path.getsize(filepath)
        total_size += sz
        index[f"{col}_{row}"] = {
            "file": filename,
            "bounds": [cell_west, cell_south, cell_east, cell_north],
            "count": len(feats)
        }

    # Write tile index
    index_path = os.path.join(args.output, "index.json")
    index_data = {
        "cell_size": args.cell_size,
        "total_buildings": len(features),
        "total_tiles": len(cells),
        "tiles": index
    }
    with open(index_path, 'w') as f:
        json.dump(index_data, f, indent=2)

    print(f"\nOutput: {args.output}")
    print(f"  {len(cells)} tile files")
    print(f"  Total size: {total_size / 1024 / 1024:.1f} MB")
    print(f"  Index: {index_path}")
    print(f"  Avg buildings/tile: {len(features) / len(cells):.0f}")


if __name__ == "__main__":
    main()
