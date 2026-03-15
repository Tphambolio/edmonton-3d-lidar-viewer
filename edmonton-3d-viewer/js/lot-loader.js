/**
 * Lot Loader — displays parcel/lot boundaries from Edmonton's ArcGIS MapServer
 * as a live imagery overlay, and fetches individual parcel geometry via the
 * identify endpoint when a user clicks on a lot.
 *
 * MapServer: gis.edmonton.ca — Overlay_Public/Common_Layers, Layer 287 (Title Lots)
 * Fallback: approximate lot boundaries from building footprints.
 */
const LotLoader = {
    MAPSERVER_URL: 'https://gis.edmonton.ca/site1/rest/services/Overlay_Public/Common_Layers/MapServer',
    LAYER_ID: '287', // Title Lots

    // State
    _viewer: null,
    _imageryLayer: null,
    _selectedEntity: null,
    _enabled: false,
    _lots: [],        // fallback only
    _entities: [],    // fallback only

    // Setbacks for fallback approximation (metres)
    FRONT_SETBACK: 4.5,
    REAR_SETBACK: 10.0,
    SIDE_SETBACK: 1.8,

    init(viewer) {
        this._viewer = viewer;
    },

    /**
     * Enable lot boundaries — adds ArcGIS imagery layer.
     * Returns a count (1 = imagery loaded, 0 = fell back to footprints).
     */
    async loadAround(lat, lng, radiusM) {
        if (this._imageryLayer) {
            this._imageryLayer.show = true;
            return 1;
        }

        try {
            const provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
                this.MAPSERVER_URL,
                { layers: this.LAYER_ID }
            );
            this._imageryLayer = this._viewer.imageryLayers.addImageryProvider(provider);
            this._imageryLayer.alpha = 0.7;
            this._enabled = true;
            console.log('Lot boundaries: ArcGIS MapServer imagery loaded');
            return 1;
        } catch (e) {
            console.warn('ArcGIS MapServer unavailable, falling back to footprint approximation:', e);
            return this._approximateFromFootprints();
        }
    },

    /**
     * Identify the parcel at a given lat/lng via the MapServer identify endpoint.
     * Returns { polygon: [{lat, lng}, ...], properties: {...} } or null.
     */
    async identifyParcel(lat, lng) {
        const extent = 0.005;
        const mapExtent = `${lng - extent},${lat - extent},${lng + extent},${lat + extent}`;
        const url = `${this.MAPSERVER_URL}/identify`
            + `?geometry=${lng},${lat}`
            + `&geometryType=esriGeometryPoint&sr=4326`
            + `&layers=all:${this.LAYER_ID}`
            + `&tolerance=5`
            + `&mapExtent=${mapExtent}`
            + `&imageDisplay=512,512,96`
            + `&returnGeometry=true&f=json`;

        try {
            const resp = await fetch(url);
            if (!resp.ok) return null;
            const data = await resp.json();

            if (!data.results || data.results.length === 0) return null;

            const result = data.results[0];
            if (!result.geometry?.rings?.length) return null;

            // Convert ESRI rings to polygon array
            const ring = result.geometry.rings[0];
            const polygon = ring.map(coord => ({
                lng: coord[0],
                lat: coord[1]
            }));

            // Remove closing duplicate if present
            if (polygon.length > 1) {
                const first = polygon[0];
                const last = polygon[polygon.length - 1];
                if (Math.abs(first.lat - last.lat) < 1e-8 &&
                    Math.abs(first.lng - last.lng) < 1e-8) {
                    polygon.pop();
                }
            }

            return {
                polygon,
                properties: result.attributes || {}
            };
        } catch (e) {
            console.warn('Parcel identify failed:', e);
            return null;
        }
    },

    /**
     * Show a highlighted polygon entity for the selected parcel.
     */
    showSelectedParcel(polygon, properties) {
        this.clearSelectedParcel();
        if (!polygon || polygon.length < 3) return;

        const positions = [];
        for (const p of polygon) {
            positions.push(p.lng, p.lat);
        }

        const groundH = (Buildings?._terrainHeight || 0) + 0.3;
        this._selectedEntity = this._viewer.entities.add({
            name: `selected_parcel`,
            polygon: {
                hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                height: groundH,
                material: Cesium.Color.YELLOW.withAlpha(0.25),
                outline: true,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.NONE
            },
            properties: {
                isLot: true,
                address: properties.BESTADDRESS || '',
                neighbourhood: properties.NEIGHBOURHOOD_NAME || '',
                legal: properties.SHORT_LEGAL_LABEL || ''
            }
        });
    },

    clearSelectedParcel() {
        if (this._selectedEntity) {
            this._viewer.entities.remove(this._selectedEntity);
            this._selectedEntity = null;
        }
    },

    // Legacy API compatibility
    isLotEntity(entity) {
        try {
            return entity?.properties?.isLot?.getValue() === true;
        } catch {
            return false;
        }
    },

    highlightLot() {},
    unhighlightLot() {},
    getLotPolygon() { return null; },

    /**
     * Fallback: generate approximate lot boundaries from building footprints.
     */
    _approximateFromFootprints() {
        const buildings = Buildings?.entities || [];
        console.log(`Approximating lots from ${buildings.length} buildings`);
        if (buildings.length === 0) return 0;

        this._lots = [];
        this.clearEntities();

        for (let i = 0; i < buildings.length; i++) {
            try {
                const entity = buildings[i];
                if (!entity?.polygon) continue;

                let positions;
                const hierProp = entity.polygon.hierarchy;
                if (hierProp) {
                    const val = typeof hierProp.getValue === 'function'
                        ? hierProp.getValue(Cesium.JulianDate.now()) : hierProp;
                    if (val) {
                        positions = val.positions || val;
                        if (positions instanceof Cesium.PolygonHierarchy) {
                            positions = positions.positions;
                        }
                    }
                }

                if (!positions || positions.length < 3) continue;

                const coords = [];
                for (const pos of positions) {
                    const carto = Cesium.Cartographic.fromCartesian(pos);
                    coords.push({
                        lng: Cesium.Math.toDegrees(carto.longitude),
                        lat: Cesium.Math.toDegrees(carto.latitude)
                    });
                }

                const lotPolygon = this._computeLotFromFootprint(coords);
                if (!lotPolygon || lotPolygon.length < 4) continue;

                this._lots.push({ id: i, polygon: lotPolygon, buildingEntity: entity });
            } catch (e) { /* skip */ }
        }

        console.log(`Generated ${this._lots.length} approximate lots`);
        this._renderFallbackLots();
        return this._lots.length;
    },

    _computeLotFromFootprint(coords) {
        if (coords.length < 3) return null;

        const refLat = coords[0].lat;
        const refLng = coords[0].lng;
        const mPerDegLat = 111000;
        const mPerDegLng = 111000 * Math.cos(refLat * Math.PI / 180);

        const pts = coords.map(c => ({
            x: (c.lng - refLng) * mPerDegLng,
            y: (c.lat - refLat) * mPerDegLat
        }));

        const obb = this._minAreaBoundingRect(pts);
        if (!obb) return null;

        const { center, halfW, halfH, angle } = obb;
        const expandW = halfW + this.SIDE_SETBACK;
        const expandH = halfH + (this.FRONT_SETBACK + this.REAR_SETBACK) / 2;

        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        return [
            { x: center.x + expandW * cos - expandH * sin, y: center.y + expandW * sin + expandH * cos },
            { x: center.x - expandW * cos - expandH * sin, y: center.y - expandW * sin + expandH * cos },
            { x: center.x - expandW * cos + expandH * sin, y: center.y - expandW * sin - expandH * cos },
            { x: center.x + expandW * cos + expandH * sin, y: center.y + expandW * sin - expandH * cos },
        ].map(c => ({
            lng: refLng + c.x / mPerDegLng,
            lat: refLat + c.y / mPerDegLat
        }));
    },

    _minAreaBoundingRect(pts) {
        if (pts.length < 3) return null;
        const hull = this._convexHull(pts);
        if (hull.length < 3) return null;

        let bestArea = Infinity;
        let best = null;

        for (let i = 0; i < hull.length; i++) {
            const j = (i + 1) % hull.length;
            const angle = Math.atan2(hull[j].y - hull[i].y, hull[j].x - hull[i].x);
            const cos = Math.cos(-angle);
            const sin = Math.sin(-angle);

            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const p of hull) {
                const rx = p.x * cos - p.y * sin;
                const ry = p.x * sin + p.y * cos;
                if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
                if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
            }

            const area = (maxX - minX) * (maxY - minY);
            if (area < bestArea) {
                bestArea = area;
                const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
                const cosR = Math.cos(angle), sinR = Math.sin(angle);
                best = {
                    center: { x: cx * cosR - cy * sinR, y: cx * sinR + cy * cosR },
                    halfW: (maxX - minX) / 2,
                    halfH: (maxY - minY) / 2,
                    angle
                };
            }
        }
        return best;
    },

    _convexHull(points) {
        const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
        if (pts.length <= 2) return pts;
        const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

        const lower = [];
        for (const p of pts) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
            lower.push(p);
        }
        const upper = [];
        for (let i = pts.length - 1; i >= 0; i--) {
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
            upper.push(pts[i]);
        }
        lower.pop(); upper.pop();
        return lower.concat(upper);
    },

    _renderFallbackLots() {
        this.clearEntities();
        const viewer = this._viewer;
        const groundH = (Buildings?._terrainHeight || 0) + 0.2;

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

    clearEntities() {
        const viewer = this._viewer;
        for (const e of this._entities) {
            viewer.entities.remove(e);
        }
        this._entities = [];
    },

    clear() {
        this.clearSelectedParcel();
        this.clearEntities();
        this._lots = [];
        if (this._imageryLayer) {
            this._imageryLayer.show = false;
        }
    }
};

window.LotLoader = LotLoader;
