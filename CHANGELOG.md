# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- SKP conversion service — SketchUp files converted via Wine + SketchUp 8 + Blender pipeline
- Docker Compose setup for running conversion services (Blender + SKP converter + Nginx gateway)
- Drag-and-drop support for OBJ, FBX, DAE, 3DS, STL, PLY, USD model uploads
- Blender-based conversion service for non-GLB 3D formats
- Cloudflare Tunnel integration for exposing conversion services
- SKP file version detection with clear error messages for unsupported versions
- Full 512m tile coverage for tree canopy processing (was 200m, leaving gaps)

### Changed
- Batch tree processing now uses BOX_SIZE=512 and MAX_TREES=200 for full tile coverage
- Tileset bounding sphere radius increased from 200m to 400m
- Frontend accepts `.skp` in file picker and drag-drop zone

### Fixed
- Trees not appearing at searched addresses due to 200m BOX_SIZE leaving 312m gaps

## [1.0.0] - 2025-03-08

### Added
- CesiumJS 3D globe with OpenStreetMap and satellite imagery toggle
- Address search with Nominatim geocoding and camera fly-to
- Building footprints loaded from Edmonton SODA API with height extrusion
- LiDAR tree canopy meshes loaded as Cesium 3D Tilesets from Cloudflare R2
- Building click selection with property info panel
- Custom 3D model upload (GLB/glTF) to replace individual buildings
- Pre-built model catalog (apartment, 8-plex, skinny houses)
- Rotate model 90 degrees button
- Adjustable search radius (100–500m)
- Tree height offset slider for terrain alignment
- GitHub Pages deployment via GitHub Actions
