/**
 * Lot Loader — fetches parcel/lot boundary polygons from Edmonton's
 * ArcGIS REST service and displays them as clickable outlines on the map.
 *
 * Primary: City of Edmonton GIS ArcGIS MapServer (powers SLIM Maps)
 * Fallback: approximate lots from building footprints with setbacks
 *
 * Tries multiple parcel layers in order:
 *   Layer 21 (Parcels), Layer 287 (Title Lots), Layer 285 (Legal Lots)
 */
const LotLoader = {
    // ArcGIS REST endpoints to try (in order)
    PARCEL_URLS: [
        'https://gis.edmonton.ca/site1/rest/services/Overlay_Public/Common_Layers/MapServer/21/query',
        'https://gis.edmonton.ca/site1/rest/services/Overlay_Public/Common_Layers/MapServer/287/query',
        'https://gis.edmonton.ca/site1/rest/services/Overlay_Public/Common_Layers/MapServer/285/query',
    ],

    // State
    _viewer: null,
    _entities: [],
    _lots: [],
    _selectedLot: null,
    _enabled: false,
    _loading: false,
    _lastBbox: null,
    _workingUrl: null,   // cache which URL worked

    // Setbacks for fallback approximation (metres)
    FRONT_SETBACK: 4.5,
    REAR_SETBACK: 10.0,
    SIDE_SETBACK: 1.8,

    init(viewer) {
        this._viewer = viewer;
    },

    /**
     * Load lots around a center point. Tries real GIS data first,
     * falls back to footprint approximation.
     */
    async loadAround(lat, lng, radiusM) {
        if (this._loading) return 0;
        this._loading = true;

        try {
            // Try real parcel data first
            const count = await this._tryRealParcels(lat, lng, radiusM);
            if (count > 0) {
                console.log(`Loaded ${count} real parcel boundaries from Edmonton GIS`);
                return count;
            }

            // Fallback: approximate from building footprints
            console.log('GIS parcel data unavailable, approximating from building footprints');
            return this._approximateFromFootprints();
        } finally {
            this._loading = false;
        }
    },

    /**
     * Try fetching real parcel data from Edmonton's ArcGIS service.
     */
    async _tryRealParcels(lat, lng, radiusM) {
        const latDeg = radiusM / 111000;
        const lngDeg = radiusM / (111000 * Math.cos(lat * Math.PI / 180));
        const south = lat - latDeg;
        const north = lat + latDeg;
        const west = lng - lngDeg;
        const east = lng + lngDeg;

        const bboxKey = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
        if (bboxKey === this._lastBbox && this._lots.length > 0) {
            return this._lots.length;
        }

        const envelope = `${west},${south},${east},${north}`;
        const params = new URLSearchParams({
            where: '1=1',
            geometry: envelope,
            geometryType: 'esriGeometryEnvelope',
            inSR: '4326',
            outSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            outFields: '*',
            returnGeometry: 'true',
            f: 'geojson',
            resultRecordCount: '500'
        });

        // If we already know which URL works, try it first
        const urls = this._workingUrl
            ? [this._workingUrl, ...this.PARCEL_URLS.filter(u => u !== this._workingUrl)]
            : this.PARCEL_URLS;

        for (const baseUrl of urls) {
            try {
                console.log(`Trying parcel endpoint: ${baseUrl.split('/').slice(-3).join('/')}`);
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 8000);

                const resp = await fetch(`${baseUrl}?${params}`, { signal: controller.signal });
                clearTimeout(timeout);

                if (!resp.ok) continue;

                const geojson = await resp.json();
                const features = geojson.features || [];
                if (features.length === 0) continue;

                console.log(`Got ${features.length} parcels from layer ${baseUrl.match(/\/(\d+)\//)?.[1]}`);
                this._workingUrl = baseUrl;
                this._lastBbox = bboxKey;
                this._parseGeoJsonLots(features);
                this._renderLots();
                return this._lots.length;
            } catch (e) {
                console.warn(`Parcel endpoint failed: ${e.message}`);
                continue;
            }
        }

        return 0;
    },

    /**
     * Parse GeoJSON features into internal lot data.
     */
    _parseGeoJsonLots(features) {
        this._lots = [];
        for (const feat of features) {
            if (!feat.geometry) continue;

            const geomType = feat.geometry.type;
            let rings;

            if (geomType === 'Polygon') {
                rings = [feat.geometry.coordinates[0]];
            } else if (geomType === 'MultiPolygon') {
                rings = feat.geometry.coordinates.map(p => p[0]);
            } else {
                continue;
            }

            for (const ring of rings) {
                const polygon = ring.map(coord => ({
                    lng: coord[0],
                    lat: coord[1]
                }));

                if (polygon.length < 3) continue;

                // Remove closing duplicate vertex
                const first = polygon[0];
                const last = polygon[polygon.length - 1];
                if (Math.abs(first.lat - last.lat) < 1e-8 && Math.abs(first.lng - last.lng) < 1e-8) {
                    polygon.pop();
                }

                this._lots.push({
                    id: feat.properties?.OBJECTID || feat.id || this._lots.length,
                    polygon,
                    properties: feat.properties || {}
                });
            }
        }
    },

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

                // Extract positions from hierarchy — handle both PolygonHierarchy and raw array
                let positions;
                const hierProp = entity.polygon.hierarchy;
                if (hierProp) {
                    const val = typeof hierProp.getValue === 'function' ? hierProp.getValue(Cesium.JulianDate.now()) : hierProp;
                    if (val) {
                        positions = val.positions || val;
                        // If it's a PolygonHierarchy, positions is the array
                        if (positions instanceof Cesium.PolygonHierarchy) {
                            positions = positions.positions;
                        }
                    }
                }

                if (!positions || positions.length < 3) {
                    if (i === 0) console.log('First building: no valid positions', typeof positions, positions);
                    continue;
                }

                const coords = [];
                for (const pos of positions) {
                    const carto = Cesium.Cartographic.fromCartesian(pos);
                    coords.push({
                        lng: Cesium.Math.toDegrees(carto.longitude),
                        lat: Cesium.Math.toDegrees(carto.latitude)
                    });
                }

                const lotPolygon = this._computeLotFromFootprint(coords);
                if (!lotPolygon || lotPolygon.length < 4) {
                    if (i === 0) console.log('First building: lot computation failed', coords.length, 'coords');
                    continue;
                }

                this._lots.push({
                    id: i,
                    polygon: lotPolygon,
                    buildingEntity: entity
                });
            } catch (e) {
                if (i === 0) console.error('Error processing building for lot:', e);
            }
        }

        console.log(`Generated ${this._lots.length} approximate lots`);
        this._renderLots();
        return this._lots.length;
    },

    /**
     * Compute an approximate lot polygon from a building footprint.
     */
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

        const corners = [
            { x: center.x + expandW * cos - expandH * sin, y: center.y + expandW * sin + expandH * cos },
            { x: center.x - expandW * cos - expandH * sin, y: center.y - expandW * sin + expandH * cos },
            { x: center.x - expandW * cos + expandH * sin, y: center.y - expandW * sin - expandH * cos },
            { x: center.x + expandW * cos + expandH * sin, y: center.y + expandW * sin - expandH * cos },
        ];

        return corners.map(c => ({
            lng: refLng + c.x / mPerDegLng,
            lat: refLat + c.y / mPerDegLat
        }));
    },

    /**
     * Minimum-area bounding rectangle for a set of 2D points.
     */
    _minAreaBoundingRect(pts) {
        if (pts.length < 3) return null;

        const hull = this._convexHull(pts);
        if (hull.length < 3) return null;

        let bestArea = Infinity;
        let best = null;

        for (let i = 0; i < hull.length; i++) {
            const j = (i + 1) % hull.length;
            const dx = hull[j].x - hull[i].x;
            const dy = hull[j].y - hull[i].y;
            const angle = Math.atan2(dy, dx);
            const cos = Math.cos(-angle);
            const sin = Math.sin(-angle);

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

        const lower = [];
        for (const p of pts) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
                lower.pop();
            lower.push(p);
        }

        const upper = [];
        for (let i = pts.length - 1; i >= 0; i--) {
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0)
                upper.pop();
            upper.push(pts[i]);
        }

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

    getLotPolygon(entity) {
        const lotData = entity?.properties?.lotData?.getValue();
        if (!lotData) return null;
        return lotData.polygon;
    },

    clearEntities() {
        const viewer = this._viewer;
        for (const e of this._entities) {
            viewer.entities.remove(e);
        }
        this._entities = [];
        this._selectedLot = null;
    },

    clear() {
        this.clearEntities();
        this._lots = [];
        this._lastBbox = null;
    },

    isLotEntity(entity) {
        try {
            return entity?.properties?.isLot?.getValue() === true;
        } catch {
            return false;
        }
    }
};

window.LotLoader = LotLoader;
