/**
 * Lot Loader — generates approximate lot boundary polygons from loaded
 * building footprints using oriented bounding rectangles with typical
 * Edmonton residential setbacks.
 *
 * Note: Edmonton stopped publishing parcel boundary polygon data publicly
 * in 2021. This module approximates lots from building footprints instead.
 */
const LotLoader = {
    _viewer: null,
    _entities: [],       // Cesium entities for lot outlines
    _lots: [],           // Parsed lot data [{id, polygon: [{lat,lng}]}]
    _selectedLot: null,
    _enabled: false,

    // Typical Edmonton setbacks (metres)
    FRONT_SETBACK: 4.5,
    REAR_SETBACK: 10.0,
    SIDE_SETBACK: 1.8,

    init(viewer) {
        this._viewer = viewer;
    },

    /**
     * Generate lot boundaries from building footprints already loaded
     * in Buildings.entities.
     */
    loadAround(lat, lng, radiusM) {
        const buildings = window.Buildings?.entities || [];
        if (buildings.length === 0) return 0;

        this._lots = [];
        this.clearEntities();

        for (let i = 0; i < buildings.length; i++) {
            const entity = buildings[i];
            if (!entity?.polygon) continue;

            // Get the polygon positions
            const hierarchy = entity.polygon.hierarchy?.getValue();
            if (!hierarchy) continue;
            const positions = hierarchy.positions || hierarchy;
            if (!positions || positions.length < 3) continue;

            // Convert Cartesian3 to lat/lng
            const coords = [];
            for (const pos of positions) {
                const carto = Cesium.Cartographic.fromCartesian(pos);
                coords.push({
                    lng: Cesium.Math.toDegrees(carto.longitude),
                    lat: Cesium.Math.toDegrees(carto.latitude)
                });
            }

            // Compute oriented bounding rectangle expanded by setbacks
            const lotPolygon = this._computeLotFromFootprint(coords);
            if (!lotPolygon || lotPolygon.length < 4) continue;

            this._lots.push({
                id: i,
                polygon: lotPolygon,
                buildingEntity: entity
            });
        }

        this._renderLots();
        return this._lots.length;
    },

    /**
     * Compute an approximate lot polygon from a building footprint.
     * Uses the minimum-area bounding rectangle and expands it by setbacks.
     */
    _computeLotFromFootprint(coords) {
        if (coords.length < 3) return null;

        // Use metres for computation (approximate flat-earth at Edmonton's latitude)
        const refLat = coords[0].lat;
        const refLng = coords[0].lng;
        const mPerDegLat = 111000;
        const mPerDegLng = 111000 * Math.cos(refLat * Math.PI / 180);

        // Convert to local XY metres
        const pts = coords.map(c => ({
            x: (c.lng - refLng) * mPerDegLng,
            y: (c.lat - refLat) * mPerDegLat
        }));

        // Find minimum-area bounding rectangle using rotating calipers
        const obb = this._minAreaBoundingRect(pts);
        if (!obb) return null;

        // Determine which axis is likely the "front" (shorter side = width)
        // and expand by setbacks
        const { center, halfW, halfH, angle } = obb;

        // Expand: add side setback to width, front+rear to depth
        const expandW = halfW + this.SIDE_SETBACK;
        const expandH = halfH + (this.FRONT_SETBACK + this.REAR_SETBACK) / 2;

        // Generate the 4 corners of the expanded rectangle
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const corners = [
            { x: center.x + expandW * cos - expandH * sin, y: center.y + expandW * sin + expandH * cos },
            { x: center.x - expandW * cos - expandH * sin, y: center.y - expandW * sin + expandH * cos },
            { x: center.x - expandW * cos + expandH * sin, y: center.y - expandW * sin - expandH * cos },
            { x: center.x + expandW * cos + expandH * sin, y: center.y + expandW * sin - expandH * cos },
        ];

        // Convert back to lat/lng
        return corners.map(c => ({
            lng: refLng + c.x / mPerDegLng,
            lat: refLat + c.y / mPerDegLat
        }));
    },

    /**
     * Minimum-area bounding rectangle for a set of 2D points.
     * Returns { center, halfW, halfH, angle }.
     */
    _minAreaBoundingRect(pts) {
        if (pts.length < 3) return null;

        // Compute convex hull (Graham scan)
        const hull = this._convexHull(pts);
        if (hull.length < 3) return null;

        let bestArea = Infinity;
        let best = null;

        // Try each edge of the convex hull as the base
        for (let i = 0; i < hull.length; i++) {
            const j = (i + 1) % hull.length;
            const dx = hull[j].x - hull[i].x;
            const dy = hull[j].y - hull[i].y;
            const angle = Math.atan2(dy, dx);
            const cos = Math.cos(-angle);
            const sin = Math.sin(-angle);

            // Rotate all points so this edge is axis-aligned
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            for (const p of hull) {
                const rx = p.x * cos - p.y * sin;
                const ry = p.x * sin + p.y * cos;
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
                // Compute center in rotated space then rotate back
                const cx = (minX + maxX) / 2;
                const cy = (minY + maxY) / 2;
                const cosR = Math.cos(angle);
                const sinR = Math.sin(angle);
                best = {
                    center: { x: cx * cosR - cy * sinR, y: cx * sinR + cy * cosR },
                    halfW: w / 2,
                    halfH: h / 2,
                    angle: angle
                };
            }
        }

        return best;
    },

    /**
     * Graham scan convex hull.
     */
    _convexHull(points) {
        const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
        if (pts.length <= 2) return pts;

        const cross = (o, a, b) =>
            (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

        // Lower hull
        const lower = [];
        for (const p of pts) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
                lower.pop();
            lower.push(p);
        }

        // Upper hull
        const upper = [];
        for (let i = pts.length - 1; i >= 0; i--) {
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0)
                upper.pop();
            upper.push(pts[i]);
        }

        // Remove last point of each half because it's repeated
        lower.pop();
        upper.pop();
        return lower.concat(upper);
    },

    /**
     * Render lot outlines as Cesium polygon entities.
     */
    _renderLots() {
        this.clearEntities();
        const viewer = this._viewer;
        const groundH = (window.Buildings?._terrainHeight || 0) + 0.2;

        for (const lot of this._lots) {
            const positions = [];
            for (const p of lot.polygon) {
                positions.push(p.lng, p.lat);
            }

            const entity = viewer.entities.add({
                name: `lot_${lot.id}`,
                polygon: {
                    hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                    height: groundH,
                    material: Cesium.Color.YELLOW.withAlpha(0.06),
                    outline: true,
                    outlineColor: Cesium.Color.YELLOW.withAlpha(0.5),
                    outlineWidth: 2,
                    heightReference: Cesium.HeightReference.NONE
                },
                properties: {
                    isLot: true,
                    lotId: lot.id,
                    lotData: lot
                }
            });

            lot.entity = entity;
            this._entities.push(entity);
        }
    },

    /**
     * Highlight a lot when hovered/selected.
     */
    highlightLot(entity) {
        this.unhighlightLot();
        if (!entity) return;
        this._selectedLot = entity;
        entity.polygon.material = Cesium.Color.YELLOW.withAlpha(0.25);
        entity.polygon.outlineColor = Cesium.Color.WHITE;
    },

    unhighlightLot() {
        if (this._selectedLot) {
            this._selectedLot.polygon.material = Cesium.Color.YELLOW.withAlpha(0.06);
            this._selectedLot.polygon.outlineColor = Cesium.Color.YELLOW.withAlpha(0.5);
            this._selectedLot = null;
        }
    },

    /**
     * Get the lot polygon for a given lot entity.
     * Returns [{lat, lng}] suitable for the building tool.
     */
    getLotPolygon(entity) {
        const lotData = entity?.properties?.lotData?.getValue();
        if (!lotData) return null;
        return lotData.polygon;
    },

    /**
     * Remove all lot entities from the map.
     */
    clearEntities() {
        const viewer = this._viewer;
        for (const e of this._entities) {
            viewer.entities.remove(e);
        }
        this._entities = [];
        this._selectedLot = null;
    },

    /**
     * Full clear including cached data.
     */
    clear() {
        this.clearEntities();
        this._lots = [];
    },

    /**
     * Check if an entity is a lot.
     */
    isLotEntity(entity) {
        try {
            return entity?.properties?.isLot?.getValue() === true;
        } catch {
            return false;
        }
    }
};

window.LotLoader = LotLoader;
