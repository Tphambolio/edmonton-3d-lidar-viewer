# Edmonton 3D LiDAR Viewer

Interactive 3D viewer for Edmonton, Alberta combining CesiumJS terrain, building footprints from the City's Open Data API, and LiDAR-derived tree canopy meshes.

## Features

- **3D Buildings** — loaded dynamically from Edmonton's SODA API with height extrusion
- **LiDAR Tree Canopies** — classified point clouds from the City's VegLiDAR dataset, converted to 3D meshes (GLB) and loaded as Cesium 3D Tilesets
- **Address Search** — geocoding via Nominatim with automatic camera fly-to
- **Custom Models** — drag-and-drop GLB upload to replace individual buildings
- **Adjustable Parameters** — search radius, tree height offset, layer toggles

## Live Demo

[https://tphambolio.github.io/edmonton-3d-lidar-viewer/](https://tphambolio.github.io/edmonton-3d-lidar-viewer/)

> **Note:** The live demo loads buildings and terrain but tree canopy meshes (~50GB total) require a local or CDN-hosted tile server. See [GLB Hosting](#glb-hosting) below.

## Local Development

```bash
cd edmonton-3d-viewer
python3 -m http.server 8000
# Open http://localhost:8000
```

## GLB Hosting

Tree canopy GLB files are too large for GitHub Pages. The viewer supports a configurable tile base URL:

```
# Default: loads from relative data/tree_tiles/ path (local dev)
http://localhost:8000

# With external CDN:
https://tphambolio.github.io/edmonton-3d-lidar-viewer/?tileBase=https://cdn.example.com/tree_tiles/
```

## Data Sources

- **Buildings:** [City of Edmonton Open Data — Building Footprints](https://data.edmonton.ca/Geospatial-Boundaries/City-of-Edmonton-3D-Building-Model-Footprints/nq7h-bnia)
- **Tree LiDAR:** [City of Edmonton — Vegetation LiDAR](https://data.edmonton.ca/Environmental/LiDAR-Vegetation-Edmonton/uqhr-fgxf)
- **Terrain:** Cesium World Terrain

## Architecture

```
edmonton-3d-viewer/
├── index.html              # Main viewer page
├── css/style.css            # UI styling
├── js/
│   ├── app.js               # CesiumJS init, search, UI wiring
│   ├── buildings.js          # SODA API building loader
│   ├── geocoder.js           # Nominatim geocoding
│   └── trees.js              # 3D Tileset tree mesh loader
└── data/tree_tiles/
    ├── index.json            # Tile index (centers, metadata)
    └── *_tileset.json        # Per-tile 3D Tileset descriptors
```

## Processing Pipeline

1. Download VegLiDAR LAZ tiles from Edmonton Open Data
2. Extract classified vegetation points, build tree meshes (`extract_scene_dae.py`)
3. Convert DAE to GLB (`batch_dae_to_glb.sh`)
4. Generate tileset.json wrappers for CesiumJS positioning
5. Build index.json with tile centers and metadata

## License

Data sourced from the City of Edmonton Open Data Portal under the [City of Edmonton Open Data Terms of Use](https://data.edmonton.ca/stories/s/City-of-Edmonton-Open-Data-Terms-of-Use/msh8-if28/).
