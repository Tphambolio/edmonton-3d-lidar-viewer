/**
 * Lot Loader — fetches parcel/lot boundary polygons from Edmonton's
 * ArcGIS REST service and displays them as clickable outlines on the map.
 *
 * Data source: City of Edmonton GIS
 * https://gis.edmonton.ca/site1/rest/services/Overlay_Public/Common_Layers/MapServer
 * Layer 21 = Parcels
 */
const LotLoader = {
    // ArcGIS REST endpoint for parcels layer
    PARCELS_URL: 'https://gis.edmonton.ca/site1/rest/services/Overlay_Public/Common_Layers/MapServer/21/query',

    // State
    _viewer: null,
    _entities: [],       // Cesium entities for lot outlines
    _lots: [],           // Parsed lot data [{id, polygon: [{lat,lng}], address, ...}]
    _selectedLot: null,  // Currently highlighted lot entity
    _enabled: false,
    _loading: false,
    _lastBbox: null,     // Last queried bounding box to avoid redundant fetches

    init(viewer) {
        this._viewer = viewer;
    },

    /**
     * Fetch lot polygons within a bounding box from Edmonton's ArcGIS service.
     * Returns GeoJSON features with polygon geometries.
     */
    async _fetchLots(south, west, north, east) {
        // ArcGIS envelope geometry in Web Mercator (4326 input, request outSR=4326)
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

        const resp = await fetch(`${this.PARCELS_URL}?${params}`);
        if (!resp.ok) throw new Error(`ArcGIS query failed: ${resp.status}`);
        return await resp.json();
    },

    /**
     * Load lots around a center point within a radius.
     */
    async loadAround(lat, lng, radiusM) {
        if (this._loading) return 0;
        this._loading = true;

        const latDeg = radiusM / 111000;
        const lngDeg = radiusM / (111000 * Math.cos(lat * Math.PI / 180));
        const south = lat - latDeg;
        const north = lat + latDeg;
        const west = lng - lngDeg;
        const east = lng + lngDeg;

        // Skip if we already loaded this area
        const bboxKey = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
        if (bboxKey === this._lastBbox) {
            this._loading = false;
            return this._lots.length;
        }

        try {
            console.log('Fetching lot boundaries from Edmonton GIS...');
            const geojson = await this._fetchLots(south, west, north, east);
            const features = geojson.features || [];
            console.log(`Received ${features.length} lot boundaries`);

            this._lastBbox = bboxKey;
            this._parseLots(features);
            this._renderLots();

            return this._lots.length;
        } catch (e) {
            console.error('Lot fetch failed:', e);
            return 0;
        } finally {
            this._loading = false;
        }
    },

    /**
     * Parse GeoJSON features into internal lot data.
     */
    _parseLots(features) {
        this._lots = [];
        for (const feat of features) {
            if (!feat.geometry) continue;

            const geomType = feat.geometry.type;
            let rings;

            if (geomType === 'Polygon') {
                rings = [feat.geometry.coordinates[0]]; // outer ring only
            } else if (geomType === 'MultiPolygon') {
                rings = feat.geometry.coordinates.map(p => p[0]);
            } else {
                continue;
            }

            for (const ring of rings) {
                // GeoJSON coordinates are [lng, lat]
                const polygon = ring.map(coord => ({
                    lng: coord[0],
                    lat: coord[1]
                }));

                // Skip degenerate polygons
                if (polygon.length < 3) continue;

                // Remove closing duplicate vertex if present
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
     * Render lot outlines as Cesium polygon entities.
     */
    _renderLots() {
        this.clearEntities();
        const viewer = this._viewer;

        for (const lot of this._lots) {
            const positions = [];
            for (const p of lot.polygon) {
                positions.push(p.lng, p.lat);
            }

            const entity = viewer.entities.add({
                name: `lot_${lot.id}`,
                polygon: {
                    hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                    height: 0,
                    material: Cesium.Color.CYAN.withAlpha(0.08),
                    outline: true,
                    outlineColor: Cesium.Color.CYAN.withAlpha(0.6),
                    outlineWidth: 2,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    classificationType: Cesium.ClassificationType.TERRAIN
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
        entity.polygon.material = Cesium.Color.CYAN.withAlpha(0.3);
        entity.polygon.outlineColor = Cesium.Color.WHITE;
    },

    unhighlightLot() {
        if (this._selectedLot) {
            this._selectedLot.polygon.material = Cesium.Color.CYAN.withAlpha(0.08);
            this._selectedLot.polygon.outlineColor = Cesium.Color.CYAN.withAlpha(0.6);
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
        this._lastBbox = null;
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
