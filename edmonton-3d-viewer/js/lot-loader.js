/**
 * Lot Loader — loads parcel/lot boundary polygons from pre-tiled GeoJSON
 * hosted on Cloudflare R2, with fallback to approximation from building
 * footprints.
 *
 * Tile grid: 0.005° cells (~550m × 335m at Edmonton's latitude)
 * Files: parcels/parcels_{lat}_{lng}.geojson + parcels/index.json
 */
const LotLoader = {
    // R2 base URL for parcel tiles (same bucket as 3D models)
    PARCELS_BASE: 'https://pub-e37d9167d0644b6fb71d37ada161e611.r2.dev/parcels',

    // Tile grid size must match the download script
    TILE_SIZE: 0.005,

    // State
    _viewer: null,
    _entities: [],
    _lots: [],
    _selectedLot: null,
    _enabled: false,
    _loading: false,
    _loadedTiles: new Set(),  // track which tiles are already loaded
    _tileIndex: null,         // cached index.json

    // Setbacks for fallback approximation (metres)
    FRONT_SETBACK: 4.5,
    REAR_SETBACK: 10.0,
    SIDE_SETBACK: 1.8,

    init(viewer) {
        this._viewer = viewer;
    },

    /**
     * Load lots around a center point within a radius.
     */
    async loadAround(lat, lng, radiusM) {
        if (this._loading) return this._lots.length;
        this._loading = true;

        try {
            // Try loading from R2 tiles
            const count = await this._loadFromTiles(lat, lng, radiusM);
            if (count > 0) return count;

            // Fallback: approximate from building footprints
            console.log('Parcel tiles unavailable, approximating from building footprints');
            return this._approximateFromFootprints();
        } finally {
            this._loading = false;
        }
    },

    /**
     * Determine which tiles overlap the search area and fetch them from R2.
     */
    async _loadFromTiles(lat, lng, radiusM) {
        const latDeg = radiusM / 111000;
        const lngDeg = radiusM / (111000 * Math.cos(lat * Math.PI / 180));
        const south = lat - latDeg;
        const north = lat + latDeg;
        const west = lng - lngDeg;
        const east = lng + lngDeg;

        // Compute which tile keys overlap this area
        const neededTiles = [];
        for (let tLat = Math.floor(south / this.TILE_SIZE) * this.TILE_SIZE;
             tLat <= north; tLat += this.TILE_SIZE) {
            for (let tLng = Math.floor(west / this.TILE_SIZE) * this.TILE_SIZE;
                 tLng <= east; tLng += this.TILE_SIZE) {
                const key = `${tLat.toFixed(3)}_${tLng.toFixed(3)}`;
                if (!this._loadedTiles.has(key)) {
                    neededTiles.push(key);
                }
            }
        }

        if (neededTiles.length === 0 && this._lots.length > 0) {
            // Already loaded all needed tiles
            return this._lots.length;
        }

        // Fetch new tiles in parallel
        let newFeatures = 0;
        const promises = neededTiles.map(async (key) => {
            try {
                const url = `${this.PARCELS_BASE}/parcels_${key}.geojson`;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 6000);

                const resp = await fetch(url, { signal: controller.signal });
                clearTimeout(timeout);

                if (!resp.ok) return 0;

                const geojson = await resp.json();
                const features = geojson.features || [];

                this._loadedTiles.add(key);

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

                        // Remove closing duplicate
                        const first = polygon[0];
                        const last = polygon[polygon.length - 1];
                        if (Math.abs(first.lat - last.lat) < 1e-8 &&
                            Math.abs(first.lng - last.lng) < 1e-8) {
                            polygon.pop();
                        }

                        this._lots.push({
                            id: feat.properties?.OBJECTID || this._lots.length,
                            polygon,
                            properties: feat.properties || {}
                        });
                        newFeatures++;
                    }
                }

                return features.length;
            } catch (e) {
                // Tile doesn't exist or failed — that's OK
                this._loadedTiles.add(key); // don't retry
                return 0;
            }
        });

        await Promise.all(promises);

        if (newFeatures > 0 || this._lots.length > 0) {
            console.log(`Loaded ${this._lots.length} parcels from R2 tiles (${neededTiles.length} new tiles)`);
            this._renderLots();
            return this._lots.length;
        }

        return 0;
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

                this._lots.push({
                    id: i,
                    polygon: lotPolygon,
                    buildingEntity: entity
                });
            } catch (e) {
                // skip this building
            }
        }

        console.log(`Generated ${this._lots.length} approximate lots`);
        this._renderLots();
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
        this._loadedTiles.clear();
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
