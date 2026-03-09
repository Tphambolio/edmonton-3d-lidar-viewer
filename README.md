# Edmonton 3D LiDAR Viewer

Interactive 3D viewer for Edmonton, Alberta combining CesiumJS terrain, building footprints from the City's Open Data API, and LiDAR-derived tree canopy meshes.

## Live Demo

**[tphambolio.github.io/edmonton-3d-lidar-viewer](https://tphambolio.github.io/edmonton-3d-lidar-viewer/)**

> Tree canopy meshes are served from Cloudflare R2. Building footprints load from Edmonton's SODA API.

## Features

- **3D Buildings** -- loaded dynamically from Edmonton's SODA API with height extrusion
- **LiDAR Tree Canopies** -- classified vegetation points from the City's VegLiDAR dataset, converted to 3D meshes and loaded as Cesium 3D Tilesets
- **Address Search** -- geocoding via Nominatim with camera fly-to
- **Custom Model Upload** -- drag-and-drop to replace individual buildings with 3D models
- **Format Conversion** -- upload OBJ, FBX, STL, DAE, PLY, USD, or SKP files; server-side conversion to GLB
- **Satellite/OSM Toggle** -- switch between OpenStreetMap and Esri satellite imagery
- **Adjustable Parameters** -- search radius, tree height offset, layer toggles

## Quick Start

```bash
git clone https://github.com/Tphambolio/edmonton-3d-lidar-viewer.git
cd edmonton-3d-lidar-viewer/edmonton-3d-viewer
python3 -m http.server 8000
# Open http://localhost:8000
```

No build tools required -- the viewer is vanilla HTML/JS using CesiumJS from CDN.

## Architecture

```
edmonton-3d-viewer/           Frontend (CesiumJS, vanilla JS)
├── index.html
├── css/style.css
├── js/
│   ├── app.js                Main application, search, UI
│   ├── buildings.js          SODA API building loader + model replacement
│   ├── geocoder.js           Nominatim geocoding
│   └── trees.js              3D Tileset tree mesh loader
└── data/tree_tiles/
    └── index.json            Tile index (centers, metadata)

scripts/                      Backend services & processing
├── convert_service.py        Blender conversion API (OBJ/FBX/STL → GLB)
├── blender_convert.py        Blender Python script for format conversion
├── convert_service.service   systemd unit for Blender service
├── docker-compose.yml        Docker Compose for all services
├── nginx.conf                Nginx gateway config
├── skp-converter/            SKP → GLB conversion service (Docker)
│   ├── Dockerfile            Ubuntu + Wine + Xvfb + SketchUp 8 + Blender
│   ├── server.py             FastAPI service
│   └── scripts/              Ruby templates, Blender scripts
└── blender-converter/        Blender conversion service (Docker)
    └── Dockerfile

batch_extract_trees.py        LiDAR → tree mesh batch processor
extract_scene_dae.py          Single-tile tree extraction
run_batch_and_sync.sh         Batch processing + R2 sync wrapper
```

## Conversion Services

Two backend services convert uploaded 3D models to GLB for CesiumJS:

### Blender Service (port 5000)

Converts OBJ, FBX, DAE, 3DS, STL, PLY, USD to GLB using Blender 4.3 headless.

```bash
# Run directly
python3 scripts/convert_service.py --port 5000

# Or via Docker
docker compose -f scripts/docker-compose.yml up blender-converter
```

### SKP Service (port 5001)

Converts SketchUp (.skp) files via Wine + SketchUp 8 + Blender pipeline.

```bash
docker compose -f scripts/docker-compose.yml build skp-converter
docker compose -f scripts/docker-compose.yml up skp-converter
```

Pipeline: SKP → DAE (SketchUp 8 Ruby export under Wine/Xvfb) → GLB (Blender)

> **Note:** SketchUp 8 supports SKP files up to version 13 (SketchUp 2013). Newer files return a clear error with instructions.

### Unified Gateway (port 5050)

Nginx routes requests to the appropriate service:

```bash
docker compose -f scripts/docker-compose.yml up
# POST /convert     → Blender service
# POST /convert/skp → SKP service
```

Expose publicly via Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:5050
```

Then open the viewer with `?convertApi=https://your-tunnel-url.trycloudflare.com`.

## LiDAR Processing

Process Edmonton's VegLiDAR dataset into 3D tree meshes:

```bash
# Prerequisites
pip install laspy open3d scipy numpy

# Process all tiles (3,232 tiles, ~7 days)
python3 batch_extract_trees.py --all

# Process a single tile
python3 batch_extract_trees.py --tile 012_045

# Process and sync to Cloudflare R2
bash run_batch_and_sync.sh
```

Each 512m tile produces a GLB mesh and tileset.json for CesiumJS positioning.

## GLB Hosting

Tree GLB files (~50GB total) are hosted on Cloudflare R2. Configure via URL parameter:

```
?tileBase=https://your-r2-bucket.r2.dev/tree_tiles/
```

## Data Sources

| Dataset | Source | License |
|---------|--------|---------|
| Building Footprints | [Edmonton Open Data](https://data.edmonton.ca/Geospatial-Boundaries/City-of-Edmonton-3D-Building-Model-Footprints/nq7h-bnia) | [Edmonton Open Data Terms](https://data.edmonton.ca/stories/s/City-of-Edmonton-Open-Data-Terms-of-Use/msh8-if28/) |
| Vegetation LiDAR | [Edmonton Open Data](https://data.edmonton.ca/Environmental/LiDAR-Vegetation-Edmonton/uqhr-fgxf) | Edmonton Open Data Terms |
| Terrain | [Cesium World Terrain](https://cesium.com/platform/cesium-ion/) | Cesium Ion free tier |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License. See [LICENSE](LICENSE).

Data sourced from the City of Edmonton Open Data Portal under the [City of Edmonton Open Data Terms of Use](https://data.edmonton.ca/stories/s/City-of-Edmonton-Open-Data-Terms-of-Use/msh8-if28/).
