# Edmonton 3D LiDAR Viewer

Interactive 3D viewer for Edmonton, Alberta combining CesiumJS terrain, building footprints from the City's Open Data API, and LiDAR-derived tree canopy meshes.

## Live Demo

**[tphambolio.github.io/edmonton-3d-lidar-viewer](https://tphambolio.github.io/edmonton-3d-lidar-viewer/)**

> Tree canopy meshes are served from Cloudflare R2. Building footprints load from Edmonton's SODA API.

## Features

- **3D Buildings** -- loaded dynamically from Edmonton's SODA API with height extrusion
- **LiDAR Tree Canopies** -- classified vegetation points from the City's VegLiDAR dataset, converted to 3D meshes with RGB color, trunks, and canopy proportions; loaded as Cesium 3D Tilesets
- **Parcel/Lot Boundaries** -- live overlay from Edmonton's ArcGIS MapServer (Title Lots layer 287) with click-to-identify for individual parcel geometry and attributes
- **Building Tool** -- place, draw, or select lots for custom buildings with configurable height, storeys, windows, doors, roof types, and wall colors
- **Address Search** -- geocoding via Nominatim with camera fly-to
- **Custom Model Upload** -- drag-and-drop to replace individual buildings with 3D models
- **Format Conversion** -- upload OBJ, FBX, STL, DAE, PLY, USD, or SKP files; server-side conversion to GLB
- **Satellite/OSM Toggle** -- switch between OpenStreetMap and Esri satellite imagery
- **Auto Elevation Alignment** -- per-tile terrain sampling with z_base_offset correction eliminates manual height adjustment

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
│   ├── building-tool.js      Building placement/drawing tool
│   ├── building-generator.js Procedural building mesh generation (Three.js)
│   ├── geocoder.js           Nominatim geocoding
│   ├── lot-loader.js         Live ArcGIS MapServer parcel overlay + identify
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
pip install laspy open3d scipy trimesh numpy scipy geopandas shapely

# Process all tiles (3,233 tiles, ~7 days)
python3 batch_extract_trees.py --all

# Process a single tile
python3 batch_extract_trees.py 012_045

# Process and sync to Cloudflare R2
bash run_batch_and_sync.sh
```

Each 512m tile produces a GLB mesh and tileset.json for CesiumJS positioning.

### Tree Extraction Pipeline

1. **LiDAR classification** -- separate tree points (class 3/4/5) from ground (class 2)
2. **Watershed segmentation** -- split overlapping canopies into individual trees using local maxima detection
3. **Trunk generation** -- synthetic trunk cylinders from canopy base to ground DEM, with RGB bark color derived from point cloud
4. **Canopy proportions** -- species-appropriate crown ratios (conifers: conical 60-80% of height, deciduous: spherical 40-60%)
5. **Road offset** -- trunk positions pushed perpendicular off road centerlines (from Edmonton road GeoPackage) to prevent trees growing through roads
6. **Per-tile z_base_offset** -- records the LiDAR elevation baseline so the viewer can auto-align meshes to Cesium terrain without manual adjustment

## Tile Grid

The LiDAR dataset covers Edmonton in a 512m × 512m grid (EPSG:3776), totalling 3,233 tiles. Tile names follow the pattern `{row}_{col}` (e.g., `024_045`).

- **Origin:** E=18749, N=5911424 (EPSG:3776)
- **Tile size:** 512m × 512m
- **Max trees per tile:** 200
- **GLB size:** 15–70 MB each (avg ~35 MB)
- **Total:** ~100 GB across all tiles

## GLB Hosting

Tree GLB files are hosted on Cloudflare R2 and auto-synced during batch processing. Configure via URL parameter:

```
?tileBase=https://your-r2-bucket.r2.dev/tree_tiles/
```

## Data Sources

| Dataset | Source | License |
|---------|--------|---------|
| Building Footprints | [Edmonton Open Data](https://data.edmonton.ca/Geospatial-Boundaries/City-of-Edmonton-3D-Building-Model-Footprints/nq7h-bnia) | [Edmonton Open Data Terms](https://data.edmonton.ca/stories/s/City-of-Edmonton-Open-Data-Terms-of-Use/msh8-if28/) |
| Vegetation LiDAR | [Edmonton Open Data](https://data.edmonton.ca/Environmental/LiDAR-Vegetation-Edmonton/uqhr-fgxf) | Edmonton Open Data Terms |
| Parcel Boundaries | [Edmonton ArcGIS MapServer](https://gis.edmonton.ca/site1/rest/services/Overlay_Public/Common_Layers/MapServer) (Layer 287 - Title Lots) | City of Edmonton |
| Road Centerlines | [Edmonton Open Data](https://data.edmonton.ca/Geospatial-Boundaries/Road-Centreline/9j8t-zm52) | Edmonton Open Data Terms |
| Terrain | [Cesium World Terrain](https://cesium.com/platform/cesium-ion/) | Cesium Ion free tier |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License. See [LICENSE](LICENSE).

Data sourced from the City of Edmonton Open Data Portal under the [City of Edmonton Open Data Terms of Use](https://data.edmonton.ca/stories/s/City-of-Edmonton-Open-Data-Terms-of-Use/msh8-if28/).
