/**
 * Custom Building Tool — lets users draw building footprints on the map
 * and create parametric 3D buildings with configurable dimensions.
 *
 * Modes: idle | drawing | rect_first | rect_second | configuring | editing_vertices
 * Drawing sub-modes: freeform (click corners) and rectangle (2-click)
 */
const BuildingTool = {
    // State: 'idle' | 'drawing' | 'rect_first' | 'rect_second' | 'configuring' | 'editing_vertices'
    mode: 'idle',
    drawMode: 'freeform', // 'freeform' | 'rectangle'

    // Drawing state
    _points: [],           // [{lat, lng, cartesian}] — footprint vertices
    _pointEntities: [],    // Cesium point entities for each vertex
    _previewLine: null,    // Live polyline preview entity
    _previewPolygon: null, // Filled polygon preview during drawing
    _mousePosition: null,  // Current mouse cartesian for live preview
    _labelEntities: [],    // Measurement label entities

    // Rectangle drawing state
    _rectStart: null,      // First click position {lat, lng, cartesian}
    _rectEdgeEnd: null,    // Second click for edge direction {lat, lng, cartesian}

    // Vertex editing state
    _vertexHandles: [],    // Cesium entities for draggable vertex handles
    _midpointHandles: [],  // Cesium entities for midpoint insert handles
    _draggedVertex: -1,    // Index of vertex being dragged (-1 = none)
    _editHandler: null,    // ScreenSpaceEventHandler for vertex editing

    // Created buildings
    buildings: [],         // Array of custom building objects
    _nextId: 1,

    // References
    _viewer: null,
    _handler: null,
    _moveHandler: null,

    init(viewer) {
        this._viewer = viewer;
    },

    // ——— Freeform Drawing ———

    activate() {
        if (this.mode !== 'idle') return;
        this.mode = 'drawing';
        this.drawMode = 'freeform';
        this._points = [];
        this._clearPreview();
        this._clearLabels();

        const viewer = this._viewer;
        const canvas = viewer.scene.canvas;
        canvas.style.cursor = 'crosshair';

        this._handler = new Cesium.ScreenSpaceEventHandler(canvas);

        // Left click — add vertex
        this._handler.setInputAction((click) => {
            const cartesian = this._pickPosition(click.position);
            if (!cartesian) return;

            const carto = Cesium.Cartographic.fromCartesian(cartesian);
            const lat = Cesium.Math.toDegrees(carto.latitude);
            const lng = Cesium.Math.toDegrees(carto.longitude);

            this._points.push({ lat, lng, cartesian });
            this._addPointEntity(cartesian);
            this._updatePreview();
            this._updateMeasurements();
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

        // Mouse move — update live preview
        this._handler.setInputAction((movement) => {
            const cartesian = this._pickPosition(movement.endPosition);
            if (cartesian) {
                this._mousePosition = cartesian;
                this._updatePreview();
                this._updateMeasurements();
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        this._fireUpdate();
    },

    // ——— 2-Click Rectangle Mode ———

    activateRectangle() {
        if (this.mode !== 'idle') return;
        this.mode = 'rect_first';
        this.drawMode = 'rectangle';
        this._points = [];
        this._rectStart = null;
        this._rectEdgeEnd = null;
        this._clearPreview();
        this._clearLabels();

        const viewer = this._viewer;
        const canvas = viewer.scene.canvas;
        canvas.style.cursor = 'crosshair';

        this._handler = new Cesium.ScreenSpaceEventHandler(canvas);

        this._handler.setInputAction((click) => {
            const cartesian = this._pickPosition(click.position);
            if (!cartesian) return;

            const carto = Cesium.Cartographic.fromCartesian(cartesian);
            const lat = Cesium.Math.toDegrees(carto.latitude);
            const lng = Cesium.Math.toDegrees(carto.longitude);

            if (this.mode === 'rect_first') {
                // First click — set start corner
                this._rectStart = { lat, lng, cartesian };
                this._addPointEntity(cartesian);
                this.mode = 'rect_second';
                this._fireUpdate();
            } else if (this.mode === 'rect_second') {
                // Second click — set opposite corner, compute rectangle
                this._rectEdgeEnd = { lat, lng, cartesian };
                this._computeRectangle();
                this.completeFootprint();
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Right click — cancel or go back to first click
        this._handler.setInputAction(() => {
            if (this.mode === 'rect_second') {
                // Go back to first click
                this._rectStart = null;
                this._clearPoints();
                this._clearPreview();
                this._clearLabels();
                this.mode = 'rect_first';
                this._fireUpdate();
            } else {
                this.cancel();
            }
        }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

        // Mouse move — show rectangle preview
        this._handler.setInputAction((movement) => {
            const cartesian = this._pickPosition(movement.endPosition);
            if (!cartesian) return;
            this._mousePosition = cartesian;

            if (this.mode === 'rect_second' && this._rectStart) {
                const carto = Cesium.Cartographic.fromCartesian(cartesian);
                const mouseLat = Cesium.Math.toDegrees(carto.latitude);
                const mouseLng = Cesium.Math.toDegrees(carto.longitude);
                this._previewRectangle(mouseLat, mouseLng);
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        this._fireUpdate();
    },

    _previewRectangle(mouseLat, mouseLng) {
        const s = this._rectStart;
        // Axis-aligned rectangle from start corner to mouse position
        const corners = [
            { lat: s.lat, lng: s.lng },
            { lat: s.lat, lng: mouseLng },
            { lat: mouseLat, lng: mouseLng },
            { lat: mouseLat, lng: s.lng }
        ];

        // Update preview
        this._points = corners.map(c => ({
            lat: c.lat,
            lng: c.lng,
            cartesian: Cesium.Cartesian3.fromDegrees(c.lng, c.lat)
        }));

        this._updatePreview();
        this._updateMeasurements();
    },

    _computeRectangle() {
        const s = this._rectStart;
        const e = this._rectEdgeEnd;

        const corners = [
            { lat: s.lat, lng: s.lng },
            { lat: s.lat, lng: e.lng },
            { lat: e.lat, lng: e.lng },
            { lat: e.lat, lng: s.lng }
        ];

        this._clearPoints();
        this._points = corners.map(c => ({
            lat: c.lat,
            lng: c.lng,
            cartesian: Cesium.Cartesian3.fromDegrees(c.lng, c.lat)
        }));

        for (const p of this._points) {
            this._addPointEntity(p.cartesian);
        }
    },

    // ——— Measurement Labels ———

    _updateMeasurements() {
        this._clearLabels();

        const pts = [...this._points];
        if (this._mousePosition && (this.mode === 'drawing' || this.mode === 'rect_second')) {
            const carto = Cesium.Cartographic.fromCartesian(this._mousePosition);
            pts.push({
                lat: Cesium.Math.toDegrees(carto.latitude),
                lng: Cesium.Math.toDegrees(carto.longitude),
                cartesian: this._mousePosition
            });
        }

        if (pts.length < 2) return;

        const viewer = this._viewer;

        // Edge length labels
        const numEdges = pts.length >= 3 ? pts.length : pts.length - 1;
        for (let i = 0; i < numEdges; i++) {
            const j = (i + 1) % pts.length;
            const dist = this._distanceMeters(pts[i], pts[j]);
            if (dist < 0.1) continue;

            const midCart = Cesium.Cartesian3.midpoint(
                pts[i].cartesian, pts[j].cartesian, new Cesium.Cartesian3()
            );

            const label = viewer.entities.add({
                name: 'buildtool_label',
                position: midCart,
                label: {
                    text: dist.toFixed(1) + 'm',
                    font: '12px sans-serif',
                    fillColor: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -14),
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    scale: 1.0
                }
            });
            this._labelEntities.push(label);
        }

        // Angle labels at each vertex (when 3+ points)
        if (pts.length >= 3) {
            for (let i = 0; i < pts.length; i++) {
                const prev = pts[(i - 1 + pts.length) % pts.length];
                const curr = pts[i];
                const next = pts[(i + 1) % pts.length];

                const angle = this._angleDegrees(prev, curr, next);
                if (isNaN(angle)) continue;

                const label = viewer.entities.add({
                    name: 'buildtool_label',
                    position: curr.cartesian,
                    label: {
                        text: Math.round(angle) + '\u00B0',
                        font: '10px sans-serif',
                        fillColor: Cesium.Color.YELLOW,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(12, 12),
                        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        scale: 0.9
                    }
                });
                this._labelEntities.push(label);
            }

            // Area label at centroid
            const dims = this.getFootprintDimensions();
            if (dims.area > 0) {
                const centLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
                const centLng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
                const centCart = Cesium.Cartesian3.fromDegrees(centLng, centLat);

                const label = viewer.entities.add({
                    name: 'buildtool_label',
                    position: centCart,
                    label: {
                        text: dims.area.toFixed(0) + ' m\u00B2',
                        font: 'bold 13px sans-serif',
                        fillColor: Cesium.Color.CYAN,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 3,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(0, 0),
                        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        scale: 1.0
                    }
                });
                this._labelEntities.push(label);
            }
        }
    },

    _distanceMeters(a, b) {
        const DEG_TO_M = 111000;
        const cosLat = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
        const dx = (b.lng - a.lng) * cosLat * DEG_TO_M;
        const dy = (b.lat - a.lat) * DEG_TO_M;
        return Math.sqrt(dx * dx + dy * dy);
    },

    _angleDegrees(a, b, c) {
        const DEG_TO_M = 111000;
        const cosLat = Math.cos(b.lat * Math.PI / 180);
        const ax = (a.lng - b.lng) * cosLat * DEG_TO_M;
        const ay = (a.lat - b.lat) * DEG_TO_M;
        const cx = (c.lng - b.lng) * cosLat * DEG_TO_M;
        const cy = (c.lat - b.lat) * DEG_TO_M;
        const dot = ax * cx + ay * cy;
        const magA = Math.sqrt(ax * ax + ay * ay);
        const magC = Math.sqrt(cx * cx + cy * cy);
        if (magA < 0.01 || magC < 0.01) return NaN;
        const cosAngle = Math.max(-1, Math.min(1, dot / (magA * magC)));
        return Math.acos(cosAngle) * 180 / Math.PI;
    },

    _clearLabels() {
        for (const e of this._labelEntities) {
            this._viewer.entities.remove(e);
        }
        this._labelEntities = [];
    },

    // ——— Orthogonalize (Square) Tool ———

    orthogonalize() {
        if (this._points.length < 3) return;

        const points = this._points;
        const centLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
        const centLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
        const cosLat = Math.cos(centLat * Math.PI / 180);
        const DEG_TO_M = 111000;

        // Convert to local XY meters
        const local = points.map(p => ({
            x: (p.lng - centLng) * cosLat * DEG_TO_M,
            y: (p.lat - centLat) * DEG_TO_M
        }));

        // Find dominant angle from longest edge
        let longestLen = 0, dominantAngle = 0;
        for (let i = 0; i < local.length; i++) {
            const j = (i + 1) % local.length;
            const dx = local[j].x - local[i].x;
            const dy = local[j].y - local[i].y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > longestLen) {
                longestLen = len;
                dominantAngle = Math.atan2(dy, dx);
            }
        }

        // Snap dominant angle to nearest 45 degrees
        const snap45 = Math.round(dominantAngle / (Math.PI / 4)) * (Math.PI / 4);
        const cosA = Math.cos(-snap45), sinA = Math.sin(-snap45);

        // Rotate into aligned coordinate system, compute OBB
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of local) {
            const rx = p.x * cosA - p.y * sinA;
            const ry = p.x * sinA + p.y * cosA;
            minX = Math.min(minX, rx);
            maxX = Math.max(maxX, rx);
            minY = Math.min(minY, ry);
            maxY = Math.max(maxY, ry);
        }

        // For 4-point polygons, try to preserve the rectilinear shape
        // by projecting each vertex to the nearest OBB edge
        const cosR = Math.cos(snap45), sinR = Math.sin(snap45);

        let newLocal;
        if (points.length === 4) {
            // Simple case: snap to oriented bounding box
            const obbCorners = [
                { x: minX, y: minY },
                { x: maxX, y: minY },
                { x: maxX, y: maxY },
                { x: minX, y: maxY }
            ];
            newLocal = obbCorners.map(c => ({
                x: c.x * cosR - c.y * sinR,
                y: c.x * sinR + c.y * cosR
            }));
        } else {
            // For non-4-point polygons, snap each edge angle to the dominant angle or perpendicular
            newLocal = local.map((p, i) => {
                const rx = p.x * cosA - p.y * sinA;
                const ry = p.x * sinA + p.y * cosA;
                // Snap to nearest grid line in the rotated frame
                // Project each point to the nearest axis-aligned position
                // by snapping to the midpoint of the nearest edges
                return {
                    x: rx * cosR - ry * sinR,
                    y: rx * sinR + ry * cosR
                };
            });

            // For polygons with more than 4 vertices, snap each edge to 0/90 degree angles
            for (let iter = 0; iter < 3; iter++) {
                const snapped = [];
                for (let i = 0; i < newLocal.length; i++) {
                    const prev = newLocal[(i - 1 + newLocal.length) % newLocal.length];
                    const curr = newLocal[i];
                    const next = newLocal[(i + 1) % newLocal.length];

                    // Compute angle to next
                    const dx = next.x - curr.x;
                    const dy = next.y - curr.y;
                    const angle = Math.atan2(dy, dx);
                    const snappedAngle = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);

                    // Move current point to make edge angle match snapped angle
                    const len = Math.sqrt(dx * dx + dy * dy);
                    snapped.push({
                        x: curr.x,
                        y: curr.y,
                        nextX: curr.x + len * Math.cos(snappedAngle),
                        nextY: curr.y + len * Math.sin(snappedAngle)
                    });
                }

                // Resolve: average intersection of incoming and outgoing snapped edges
                for (let i = 0; i < newLocal.length; i++) {
                    const incoming = snapped[(i - 1 + snapped.length) % snapped.length];
                    const outgoing = snapped[i];
                    // Simple: just take the average of where incoming ends and outgoing starts
                    newLocal[i] = {
                        x: (incoming.nextX + outgoing.x) / 2,
                        y: (incoming.nextY + outgoing.y) / 2
                    };
                }
            }
        }

        // Convert back to lat/lng
        this._clearPoints();
        this._points = newLocal.map(p => {
            const lng = centLng + p.x / (cosLat * DEG_TO_M);
            const lat = centLat + p.y / DEG_TO_M;
            return {
                lat, lng,
                cartesian: Cesium.Cartesian3.fromDegrees(lng, lat)
            };
        });

        // Rebuild point entities
        for (const p of this._points) {
            this._addPointEntity(p.cartesian);
        }

        this._updatePreview();
        this._updateMeasurements();
        this._fireUpdate();
    },

    // ——— Vertex Editing Mode ———

    activateVertexEditing() {
        if (this._points.length < 3) return;
        if (this.mode === 'editing_vertices') return;

        this.mode = 'editing_vertices';
        const viewer = this._viewer;
        const canvas = viewer.scene.canvas;

        this._clearVertexHandles();
        this._createVertexHandles();

        this._editHandler = new Cesium.ScreenSpaceEventHandler(canvas);

        // Mouse down — check if clicking a vertex handle
        this._editHandler.setInputAction((click) => {
            const picked = viewer.scene.pick(click.position);
            if (!picked || !picked.id) return;

            const name = picked.id.name || '';
            if (name.startsWith('buildtool_vertex_')) {
                this._draggedVertex = parseInt(name.replace('buildtool_vertex_', ''));
                canvas.style.cursor = 'grabbing';
            } else if (name.startsWith('buildtool_midpoint_')) {
                // Insert a new vertex at midpoint
                const midIdx = parseInt(name.replace('buildtool_midpoint_', ''));
                const insertIdx = midIdx + 1;
                const cartesian = picked.id.position.getValue(Cesium.JulianDate.now());
                const carto = Cesium.Cartographic.fromCartesian(cartesian);
                const lat = Cesium.Math.toDegrees(carto.latitude);
                const lng = Cesium.Math.toDegrees(carto.longitude);

                this._points.splice(insertIdx, 0, { lat, lng, cartesian });
                this._rebuildVertexEditing();
            }
        }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

        // Mouse move — drag vertex
        this._editHandler.setInputAction((movement) => {
            if (this._draggedVertex < 0) {
                // Highlight handles on hover
                const picked = viewer.scene.pick(movement.endPosition);
                if (picked && picked.id) {
                    const name = picked.id.name || '';
                    if (name.startsWith('buildtool_vertex_') || name.startsWith('buildtool_midpoint_')) {
                        canvas.style.cursor = 'grab';
                    } else {
                        canvas.style.cursor = '';
                    }
                } else {
                    canvas.style.cursor = '';
                }
                return;
            }

            const cartesian = this._pickPosition(movement.endPosition);
            if (!cartesian) return;

            const carto = Cesium.Cartographic.fromCartesian(cartesian);
            const lat = Cesium.Math.toDegrees(carto.latitude);
            const lng = Cesium.Math.toDegrees(carto.longitude);

            // Update the point
            this._points[this._draggedVertex] = { lat, lng, cartesian };

            // Update the vertex handle position
            const handle = this._vertexHandles[this._draggedVertex];
            if (handle) {
                handle.position = cartesian;
            }

            this._updatePreview();
            this._updateMeasurements();
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        // Mouse up — stop dragging
        this._editHandler.setInputAction(() => {
            if (this._draggedVertex >= 0) {
                this._draggedVertex = -1;
                canvas.style.cursor = '';
                this._rebuildVertexEditing();
                this._fireUpdate();
            }
        }, Cesium.ScreenSpaceEventType.LEFT_UP);

        // Right click on vertex — delete it (if >3 points remain)
        this._editHandler.setInputAction((click) => {
            const picked = viewer.scene.pick(click.position);
            if (!picked || !picked.id) return;

            const name = picked.id.name || '';
            if (name.startsWith('buildtool_vertex_') && this._points.length > 3) {
                const idx = parseInt(name.replace('buildtool_vertex_', ''));
                this._points.splice(idx, 1);
                this._rebuildVertexEditing();
            }
        }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

        this._fireUpdate();
    },

    _createVertexHandles() {
        const viewer = this._viewer;

        // Vertex handles (draggable)
        for (let i = 0; i < this._points.length; i++) {
            const handle = viewer.entities.add({
                name: 'buildtool_vertex_' + i,
                position: this._points[i].cartesian,
                point: {
                    pixelSize: 12,
                    color: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.CYAN,
                    outlineWidth: 3,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                }
            });
            this._vertexHandles.push(handle);
        }

        // Midpoint handles (click to insert)
        for (let i = 0; i < this._points.length; i++) {
            const j = (i + 1) % this._points.length;
            const midCart = Cesium.Cartesian3.midpoint(
                this._points[i].cartesian, this._points[j].cartesian,
                new Cesium.Cartesian3()
            );

            const handle = viewer.entities.add({
                name: 'buildtool_midpoint_' + i,
                position: midCart,
                point: {
                    pixelSize: 8,
                    color: Cesium.Color.CYAN.withAlpha(0.5),
                    outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
                    outlineWidth: 1,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                }
            });
            this._midpointHandles.push(handle);
        }
    },

    _clearVertexHandles() {
        const viewer = this._viewer;
        for (const e of this._vertexHandles) viewer.entities.remove(e);
        for (const e of this._midpointHandles) viewer.entities.remove(e);
        this._vertexHandles = [];
        this._midpointHandles = [];
        this._draggedVertex = -1;
    },

    _rebuildVertexEditing() {
        this._clearVertexHandles();
        // Rebuild point entities
        this._clearPointEntitiesOnly();
        for (const p of this._points) {
            this._addPointEntity(p.cartesian);
        }
        this._createVertexHandles();
        this._updatePreview();
        this._updateMeasurements();
    },

    finishVertexEditing() {
        this._clearVertexHandles();
        if (this._editHandler) {
            this._editHandler.destroy();
            this._editHandler = null;
        }
        this._viewer.scene.canvas.style.cursor = '';
        this.mode = 'configuring';
        this._updatePreview();
        this._updateMeasurements();
        this._fireUpdate();
    },

    // ——— Common Methods ———

    _pickPosition(screenPos) {
        const viewer = this._viewer;
        const ray = viewer.camera.getPickRay(screenPos);
        if (!ray) return null;
        return viewer.scene.globe.pick(ray, viewer.scene);
    },

    _addPointEntity(cartesian) {
        const pointEntity = this._viewer.entities.add({
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
    },

    _updatePreview() {
        const viewer = this._viewer;

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
        const isDrawing = self.mode === 'drawing' || self.mode === 'rect_second';

        const linePositions = new Cesium.CallbackProperty(() => {
            const pts = self._points.map(p => p.cartesian);
            if (self._mousePosition && isDrawing && self.drawMode === 'freeform') {
                pts.push(self._mousePosition);
            }
            if (pts.length > 2) {
                pts.push(pts[0]);
            }
            return pts;
        }, false);

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

        if (this._points.length >= 3) {
            const polyPositions = new Cesium.CallbackProperty(() => {
                const pts = self._points.map(p => p.cartesian);
                if (self._mousePosition && isDrawing && self.drawMode === 'freeform') {
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

    undoPoint() {
        if (this._points.length === 0) return;
        this._points.pop();
        const entity = this._pointEntities.pop();
        if (entity) this._viewer.entities.remove(entity);
        this._updatePreview();
        this._updateMeasurements();
        this._fireUpdate();
    },

    completeFootprint() {
        if (this._points.length < 3) return;

        this.mode = 'configuring';

        if (this._handler) {
            this._handler.destroy();
            this._handler = null;
        }

        this._viewer.scene.canvas.style.cursor = '';
        this._mousePosition = null;
        this._updatePreview();
        this._updateMeasurements();
        this._fireUpdate();
    },

    getFootprintDimensions() {
        if (this._points.length < 3) return { width: 0, depth: 0, area: 0 };

        const points = this._points;
        const centLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
        const centLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
        const cosLat = Math.cos(centLat * Math.PI / 180);

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

        const degToM = 111000;
        const widthM = Math.min(bestW, bestH) * degToM;
        const depthM = Math.max(bestW, bestH) * degToM;

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

    async createBuilding(options = {}) {
        if (this._points.length < 3) return null;

        const viewer = this._viewer;
        const height = options.height || 10;
        const color = options.color || '#5599cc';
        const storeys = options.storeys || Math.round(height / 3.5);

        const centLat = this._points.reduce((s, p) => s + p.lat, 0) / this._points.length;
        const centLng = this._points.reduce((s, p) => s + p.lng, 0) / this._points.length;
        const terrainH = await Buildings.getTerrainHeight(viewer, centLat, centLng);

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

        this._clearPreview();
        this._clearPoints();
        this._clearLabels();
        this.mode = 'idle';
        this._fireUpdate();

        return building;
    },

    updateBuilding(id, options) {
        const building = this.buildings.find(b => b.id === id);
        if (!building) return;

        if (options.height !== undefined) {
            building.height = options.height;
            building.storeys = options.storeys || Math.round(options.height / 3.5);
            building.entity.polygon.extrudedHeight = building.terrainH + options.height;
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

    selectBuilding(entity) {
        const id = entity.properties?.buildingId?.getValue();
        const building = this.buildings.find(b => b.id === id);
        return building || null;
    },

    cancel() {
        if (this._handler) {
            this._handler.destroy();
            this._handler = null;
        }
        if (this._editHandler) {
            this._editHandler.destroy();
            this._editHandler = null;
        }
        this._clearPreview();
        this._clearPoints();
        this._clearLabels();
        this._clearVertexHandles();
        this._viewer.scene.canvas.style.cursor = '';
        this.mode = 'idle';
        this._fireUpdate();
    },

    resetFootprint() {
        this._clearPreview();
        this._clearPoints();
        this._clearLabels();
        this._clearVertexHandles();
        if (this._editHandler) {
            this._editHandler.destroy();
            this._editHandler = null;
        }
        this.mode = 'idle';
        this._fireUpdate();
    },

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

    _clearPoints() {
        for (const e of this._pointEntities) {
            this._viewer.entities.remove(e);
        }
        this._pointEntities = [];
        this._points = [];
    },

    _clearPointEntitiesOnly() {
        for (const e of this._pointEntities) {
            this._viewer.entities.remove(e);
        }
        this._pointEntities = [];
    },

    _fireUpdate() {
        if (this.onUpdate) this.onUpdate(this.mode, this._points.length);
    },

    onUpdate: null
};
