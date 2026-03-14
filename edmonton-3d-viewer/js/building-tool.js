/**
 * Custom Building Tool — lets users draw building footprints on the map
 * and create parametric 3D buildings with configurable dimensions.
 */
const BuildingTool = {
    // State: 'idle' | 'drawing' | 'configuring'
    mode: 'idle',

    // Drawing state
    _points: [],           // [{lat, lng, cartesian}] — footprint vertices
    _pointEntities: [],    // Cesium point entities for each vertex
    _previewLine: null,    // Live polyline preview entity
    _previewPolygon: null, // Filled polygon preview during drawing
    _mousePosition: null,  // Current mouse cartesian for live preview

    // Created buildings
    buildings: [],         // Array of custom building objects
    _nextId: 1,

    // References
    _viewer: null,
    _handler: null,
    _moveHandler: null,

    /**
     * Initialize the tool with a Cesium viewer reference.
     */
    init(viewer) {
        this._viewer = viewer;
    },

    /**
     * Activate drawing mode — user clicks to place footprint vertices.
     */
    activate() {
        if (this.mode !== 'idle') return;
        this.mode = 'drawing';
        this._points = [];
        this._clearPreview();

        const viewer = this._viewer;
        const canvas = viewer.scene.canvas;
        canvas.style.cursor = 'crosshair';

        // Create a handler for drawing clicks
        this._handler = new Cesium.ScreenSpaceEventHandler(canvas);

        // Left click — add vertex
        this._handler.setInputAction((click) => {
            const cartesian = this._pickPosition(click.position);
            if (!cartesian) return;

            const carto = Cesium.Cartographic.fromCartesian(cartesian);
            const lat = Cesium.Math.toDegrees(carto.latitude);
            const lng = Cesium.Math.toDegrees(carto.longitude);

            this._points.push({ lat, lng, cartesian });

            // Add visible point marker
            const pointEntity = viewer.entities.add({
                name: 'buildtool_point',
                position: cartesian,
                point: {
                    pixelSize: 8,
                    color: Cesium.Color.CYAN,
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 2,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                }
            });
            this._pointEntities.push(pointEntity);

            this._updatePreview();
            this._fireUpdate();
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Double click — complete footprint
        this._handler.setInputAction(() => {
            if (this._points.length >= 3) {
                this.completeFootprint();
            }
        }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

        // Right click — undo last point
        this._handler.setInputAction(() => {
            this.undoPoint();
        }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

        // Mouse move — update live preview line to cursor
        this._handler.setInputAction((movement) => {
            const cartesian = this._pickPosition(movement.endPosition);
            if (cartesian) {
                this._mousePosition = cartesian;
                this._updatePreview();
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        this._fireUpdate();
    },

    /**
     * Pick a position on the globe from a screen coordinate.
     */
    _pickPosition(screenPos) {
        const viewer = this._viewer;
        // Try terrain pick first, fall back to globe pick
        const ray = viewer.camera.getPickRay(screenPos);
        if (!ray) return null;
        return viewer.scene.globe.pick(ray, viewer.scene);
    },

    /**
     * Update the live preview polyline/polygon as user draws.
     */
    _updatePreview() {
        const viewer = this._viewer;

        // Remove old preview entities
        if (this._previewLine) {
            viewer.entities.remove(this._previewLine);
            this._previewLine = null;
        }
        if (this._previewPolygon) {
            viewer.entities.remove(this._previewPolygon);
            this._previewPolygon = null;
        }

        if (this._points.length === 0) return;

        const self = this;

        // Build positions array: all placed points + mouse position
        const linePositions = new Cesium.CallbackProperty(() => {
            const pts = self._points.map(p => p.cartesian);
            if (self._mousePosition && self.mode === 'drawing') {
                pts.push(self._mousePosition);
            }
            if (pts.length > 2) {
                pts.push(pts[0]); // close the loop
            }
            return pts;
        }, false);

        // Preview polyline
        this._previewLine = viewer.entities.add({
            name: 'buildtool_preview_line',
            polyline: {
                positions: linePositions,
                width: 2,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: Cesium.Color.CYAN.withAlpha(0.8),
                    dashLength: 12
                }),
                clampToGround: true
            }
        });

        // Preview filled polygon (when 3+ points)
        if (this._points.length >= 3) {
            const polyPositions = new Cesium.CallbackProperty(() => {
                const pts = self._points.map(p => p.cartesian);
                if (self._mousePosition && self.mode === 'drawing') {
                    pts.push(self._mousePosition);
                }
                return new Cesium.PolygonHierarchy(pts);
            }, false);

            this._previewPolygon = viewer.entities.add({
                name: 'buildtool_preview_poly',
                polygon: {
                    hierarchy: polyPositions,
                    material: Cesium.Color.CYAN.withAlpha(0.15),
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
                }
            });
        }
    },

    /**
     * Undo the last placed point.
     */
    undoPoint() {
        if (this._points.length === 0) return;
        this._points.pop();
        const entity = this._pointEntities.pop();
        if (entity) this._viewer.entities.remove(entity);
        this._updatePreview();
        this._fireUpdate();
    },

    /**
     * Complete the footprint — transition from drawing to configuring.
     */
    completeFootprint() {
        if (this._points.length < 3) return;

        this.mode = 'configuring';

        // Stop handling clicks for drawing
        if (this._handler) {
            this._handler.destroy();
            this._handler = null;
        }

        this._viewer.scene.canvas.style.cursor = '';

        // Remove the mouse-follow preview and rebuild as static
        this._mousePosition = null;
        this._updatePreview();

        this._fireUpdate();
    },

    /**
     * Calculate footprint dimensions using oriented bounding box.
     * Returns {width, depth, area} in meters.
     */
    getFootprintDimensions() {
        if (this._points.length < 3) return { width: 0, depth: 0, area: 0 };

        const points = this._points;
        const centLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
        const centLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
        const cosLat = Math.cos(centLat * Math.PI / 180);

        // Minimum-area oriented bounding box (same algorithm as Buildings module)
        let bestAngle = 0, bestArea = Infinity, bestW = 0, bestH = 0;
        for (let i = 0; i < points.length; i++) {
            const j = (i + 1) % points.length;
            const edx = (points[j].lng - points[i].lng) * cosLat;
            const edy = points[j].lat - points[i].lat;
            const angle = Math.atan2(edx, edy);
            const cosA = Math.cos(-angle), sinA = Math.sin(-angle);
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const p of points) {
                const px = (p.lng - centLng) * cosLat;
                const py = p.lat - centLat;
                const rx = px * cosA - py * sinA;
                const ry = px * sinA + py * cosA;
                if (rx < minX) minX = rx;
                if (rx > maxX) maxX = rx;
                if (ry < minY) minY = ry;
                if (ry > maxY) maxY = ry;
            }
            const w = maxX - minX;
            const h = maxY - minY;
            const area = w * h;
            if (area < bestArea) {
                bestArea = area;
                bestAngle = angle;
                bestW = w;
                bestH = h;
            }
        }

        // Convert from degrees to meters (approximate)
        const degToM = 111000;
        const widthM = Math.min(bestW, bestH) * degToM;
        const depthM = Math.max(bestW, bestH) * degToM;

        // Calculate actual polygon area using shoelace formula
        let areaSum = 0;
        for (let i = 0; i < points.length; i++) {
            const j = (i + 1) % points.length;
            const xi = (points[i].lng - centLng) * cosLat * degToM;
            const yi = (points[i].lat - centLat) * degToM;
            const xj = (points[j].lng - centLng) * cosLat * degToM;
            const yj = (points[j].lat - centLat) * degToM;
            areaSum += xi * yj - xj * yi;
        }
        const areaM2 = Math.abs(areaSum) / 2;

        return {
            width: Math.round(widthM * 10) / 10,
            depth: Math.round(depthM * 10) / 10,
            area: Math.round(areaM2 * 10) / 10
        };
    },

    /**
     * Create the 3D building from the drawn footprint.
     */
    async createBuilding(options = {}) {
        if (this._points.length < 3) return null;

        const viewer = this._viewer;
        const height = options.height || 10;
        const color = options.color || '#5599cc';
        const storeys = options.storeys || Math.round(height / 3.5);

        // Get terrain height at centroid
        const centLat = this._points.reduce((s, p) => s + p.lat, 0) / this._points.length;
        const centLng = this._points.reduce((s, p) => s + p.lng, 0) / this._points.length;
        const terrainH = await Buildings.getTerrainHeight(viewer, centLat, centLng);

        // Build positions array for Cesium
        const positions = [];
        for (const p of this._points) {
            positions.push(p.lng, p.lat);
        }

        const cesiumColor = Cesium.Color.fromCssColorString(color);
        const dims = this.getFootprintDimensions();

        const id = 'custom_build_' + this._nextId++;

        const entity = viewer.entities.add({
            name: id,
            polygon: {
                hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                height: terrainH + 0.5,
                extrudedHeight: terrainH + height,
                material: cesiumColor.withAlpha(0.85),
                outline: true,
                outlineColor: Cesium.Color.BLACK.withAlpha(0.3),
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.NONE
            },
            properties: {
                customBuilding: true,
                buildingId: id,
                height: height,
                storeys: storeys,
                width: dims.width,
                depth: dims.depth,
                area_m2: dims.area,
                color: color
            }
        });

        const building = {
            id,
            entity,
            footprint: this._points.map(p => ({ lat: p.lat, lng: p.lng })),
            height,
            storeys,
            width: dims.width,
            depth: dims.depth,
            area: dims.area,
            color,
            terrainH
        };

        this.buildings.push(building);

        // Clean up drawing artifacts
        this._clearPreview();
        this._clearPoints();
        this.mode = 'idle';
        this._fireUpdate();

        return building;
    },

    /**
     * Update an existing custom building's properties.
     */
    updateBuilding(id, options) {
        const building = this.buildings.find(b => b.id === id);
        if (!building) return;

        if (options.height !== undefined) {
            building.height = options.height;
            building.storeys = options.storeys || Math.round(options.height / 3.5);
            building.entity.polygon.extrudedHeight = building.terrainH + options.height;

            // Update stored properties
            building.entity.properties.height = options.height;
            building.entity.properties.storeys = building.storeys;
        }

        if (options.color !== undefined) {
            building.color = options.color;
            const cesiumColor = Cesium.Color.fromCssColorString(options.color);
            building.entity.polygon.material = cesiumColor.withAlpha(0.85);
            building.entity.properties.color = options.color;
        }
    },

    /**
     * Delete a custom building (and its 3D model entity if present).
     */
    deleteBuilding(id) {
        const idx = this.buildings.findIndex(b => b.id === id);
        if (idx === -1) return;

        const building = this.buildings[idx];
        this._viewer.entities.remove(building.entity);
        if (building.modelEntity) {
            this._viewer.entities.remove(building.modelEntity);
        }
        if (building.glbUrl) {
            URL.revokeObjectURL(building.glbUrl);
        }
        this.buildings.splice(idx, 1);
        this._fireUpdate();
    },

    /**
     * Select a custom building (highlight it).
     */
    selectBuilding(entity) {
        const id = entity.properties?.buildingId?.getValue();
        const building = this.buildings.find(b => b.id === id);
        return building || null;
    },

    /**
     * Cancel current drawing and return to idle.
     */
    cancel() {
        if (this._handler) {
            this._handler.destroy();
            this._handler = null;
        }
        this._clearPreview();
        this._clearPoints();
        this._viewer.scene.canvas.style.cursor = '';
        this.mode = 'idle';
        this._fireUpdate();
    },

    /**
     * Reset footprint (go back to drawing from configuring).
     */
    resetFootprint() {
        this._clearPreview();
        this._clearPoints();
        this.mode = 'idle';
        this._fireUpdate();
    },

    /**
     * Clear preview line and polygon entities.
     */
    _clearPreview() {
        if (this._previewLine) {
            this._viewer.entities.remove(this._previewLine);
            this._previewLine = null;
        }
        if (this._previewPolygon) {
            this._viewer.entities.remove(this._previewPolygon);
            this._previewPolygon = null;
        }
    },

    /**
     * Clear vertex point entities.
     */
    _clearPoints() {
        for (const e of this._pointEntities) {
            this._viewer.entities.remove(e);
        }
        this._pointEntities = [];
        this._points = [];
    },

    /**
     * Fire an update callback (for UI refresh).
     */
    _fireUpdate() {
        if (this.onUpdate) this.onUpdate(this.mode, this._points.length);
    },

    // Callback set by app.js
    onUpdate: null
};
