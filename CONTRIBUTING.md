# Contributing to Edmonton 3D LiDAR Viewer

Thanks for your interest in contributing! This project combines CesiumJS, LiDAR processing, and 3D model conversion to create an interactive viewer for Edmonton's urban tree canopy and buildings.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/edmonton-3d-lidar-viewer.git`
3. Create a feature branch: `git checkout -b feature/your-feature`
4. Make your changes
5. Push and open a Pull Request

## Development Setup

### Viewer (frontend)

```bash
cd edmonton-3d-viewer
python3 -m http.server 8000
# Open http://localhost:8000
```

No build tools required — the viewer is vanilla HTML/JS using CesiumJS from CDN.

### Conversion Services (backend)

```bash
# Blender conversion service (OBJ/FBX/STL → GLB)
pip install flask flask-cors
python3 scripts/convert_service.py

# SKP conversion service (requires Docker)
cd scripts
docker compose build skp-converter
docker compose up skp-converter
```

### LiDAR Processing

Requires: Python 3.10+, laspy, open3d, scipy, numpy

```bash
pip install laspy open3d scipy numpy
python3 batch_extract_trees.py --help
```

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `edmonton-3d-viewer/` | Frontend viewer (deployed to GitHub Pages) |
| `scripts/` | Backend conversion services and utilities |
| `scripts/skp-converter/` | Dockerized SKP → GLB conversion service |
| `scripts/blender-converter/` | Dockerized Blender conversion service |

## Code Style

- JavaScript: vanilla ES6+, no framework, no transpiler
- Python: follow existing conventions, use type hints where helpful
- Keep dependencies minimal — the viewer intentionally has zero npm dependencies

## Pull Request Guidelines

- One feature/fix per PR
- Update the README if you add a user-facing feature
- Test your changes locally before submitting
- Include a screenshot for UI changes

## Reporting Issues

Open an issue with:
- What you expected to happen
- What actually happened
- Browser/OS information (for viewer issues)
- Steps to reproduce

## Data Sources

This project uses open data from the City of Edmonton. Please respect the
[City of Edmonton Open Data Terms of Use](https://data.edmonton.ca/stories/s/City-of-Edmonton-Open-Data-Terms-of-Use/msh8-if28/).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
