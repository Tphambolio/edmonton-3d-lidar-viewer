/**
 * Building loader — fetches buildings from City of Edmonton Open Data (SODA API)
 * with real LiDAR-derived heights, then extrudes them in CesiumJS.
 *
 * Data source: City of Edmonton Rooflines (2019)
 * https://data.edmonton.ca/resource/jpxi-a9a5.geojson
 * 384,228 buildings with actual building_height from LiDAR.
 */
const Buildings = {
    // City of Edmonton SODA API — GeoJSON endpoint with real heights
    SODA_URL: 'https://data.edmonton.ca/resource/jpxi-a9a5.geojson',

    // Pre-built model catalog (served from Cloudflare R2)
    MODEL_CATALOG: [
        { id: '8plex', name: '8-Plex Residential', description: '14m × 24m, 3 storeys (s-RML)',
          url: 'https://pub-e37d9167d0644b6fb71d37ada161e611.r2.dev/models/8plex.glb', scale: 1.0 },
        { id: 'skinny_houses', name: '2 Skinny Houses', description: '2 × 5.5m infill on 50ft lot',
          url: 'https://pub-e37d9167d0644b6fb71d37ada161e611.r2.dev/models/skinny_houses.glb', scale: 1.0 },
        { id: 'apartment', name: 'Apartment (6-storey)', description: '20m × 30m, 6 storeys',
          url: 'https://pub-e37d9167d0644b6fb71d37ada161e611.r2.dev/models/apartment.glb', scale: 1.0 },
    ],

    entities: [],
    selectedEntity: null,
    customModels: {},

    async loadIndex() {
        // No pre-built index needed — SODA API handles spatial queries directly
        console.log('Buildings: using SODA API (no index needed)');
    },

    COLORS: {
        tall:    Cesium.Color.fromCssColorString('#8899AA'),   // steel blue-gray for tall buildings
        medium:  Cesium.Color.fromCssColorString('#AAB0B8'),   // cool gray
        low:     Cesium.Color.fromCssColorString('#D2BE9A'),   // warm beige for houses
        default: Cesium.Color.fromCssColorString('#BEB9A8')
    },

    /**
     * Sample terrain height at a location.
     */
    async getTerrainHeight(viewer, lat, lng) {
        try {
            const positions = [Cesium.Cartographic.fromDegrees(lng, lat)];
            const sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions);
            return sampled[0].height || 0;
        } catch (e) {
            return 0;
        }
    },

    /**
     * Load buildings within a radius of a location using SODA spatial query.
     */
    async loadAround(viewer, lat, lng, radiusM) {
        // Build bounding box for SODA $where clause
        const latDeg = radiusM / 111000;
        const lngDeg = radiusM / (111000 * Math.cos(lat * Math.PI / 180));
        const south = lat - latDeg;
        const north = lat + latDeg;
        const west = lng - lngDeg;
        const east = lng + lngDeg;

        // Sample terrain height at search center for building placement
        this._terrainHeight = await this.getTerrainHeight(viewer, lat, lng);
        console.log(`Building terrain height: ${this._terrainHeight.toFixed(1)}m`);

        // SODA within_box spatial query
        const params = new URLSearchParams({
            '$where': `within_box(the_geom, ${north}, ${west}, ${south}, ${east})`,
            '$limit': '2000'
        });

        console.log(`Fetching buildings from Edmonton Open Data...`);
        try {
            const resp = await fetch(`${this.SODA_URL}?${params}`);
            if (!resp.ok) throw new Error(`SODA API: ${resp.status}`);
            const data = await resp.json();

            const features = data.features || [];
            console.log(`Received ${features.length} buildings with real LiDAR heights`);

            let count = 0;
            for (const feat of features) {
                count += this.extrudeBuilding(viewer, feat);
            }
            return count;
        } catch (e) {
            console.error('Building fetch failed:', e);
            return 0;
        }
    },

    /**
     * Extrude a single building feature as a CesiumJS entity.
     */
    extrudeBuilding(viewer, feature) {
        const props = feature.properties;
        const geom = feature.geometry;
        if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return 0;

        const height = parseFloat(props.building_height) || 3.0;
        if (height < 1.0) return 0;  // skip trivially small

        const area = parseFloat(props.area) || 0;
        const groundElev = parseFloat(props.elevation_ground) || 0;
        const roofElev = parseFloat(props.elevation_rooftop) || 0;

        // Get outer ring coordinates
        let ring;
        if (geom.type === 'MultiPolygon') {
            ring = geom.coordinates[0][0];  // first polygon, outer ring
        } else {
            ring = geom.coordinates[0];  // outer ring
        }

        // Flatten for Cesium
        const positions = [];
        for (const c of ring) {
            positions.push(c[0], c[1]);
        }

        // Color by height
        let color;
        if (height > 15) color = this.COLORS.tall;
        else if (height > 6) color = this.COLORS.medium;
        else color = this.COLORS.low;

        // Use a counter-based ID since this dataset doesn't have stable IDs
        const bldgId = this.entities.length;

        // Use absolute heights (terrain + building) so polygons stay pickable
        const groundH = this._terrainHeight || 0;

        const entity = viewer.entities.add({
            name: `bldg_${bldgId}`,
            polygon: {
                hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                perPositionHeight: false,
                height: groundH + 0.5,
                extrudedHeight: groundH + height,
                material: color.withAlpha(0.85),
                outline: true,
                outlineColor: Cesium.Color.BLACK.withAlpha(0.3),
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.NONE
            },
            properties: {
                buildingId: bldgId,
                height: height,
                area_m2: area,
                groundElev: groundElev,
                roofElev: roofElev,
                type: height > 15 ? 'commercial' : 'residential'
            }
        });

        this.entities.push(entity);
        return 1;
    },

    /**
     * Clear all loaded buildings.
     */
    clear(viewer) {
        for (const e of this.entities) {
            viewer.entities.remove(e);
        }
        this.entities = [];
    },

    /**
     * Select a building entity.
     */
    select(entity) {
        if (this.selectedEntity && this.selectedEntity.polygon) {
            // Restore previous color
            const h = this.selectedEntity.properties?.height?.getValue() || 6;
            let color;
            if (h > 15) color = this.COLORS.tall;
            else if (h > 6) color = this.COLORS.medium;
            else color = this.COLORS.low;
            this.selectedEntity.polygon.material = color.withAlpha(0.85);
        }

        this.selectedEntity = entity;
        if (entity && entity.polygon) {
            entity.polygon.material = Cesium.Color.YELLOW.withAlpha(0.7);
        }
    },

    /**
     * Replace a building with a GLB model, aligned to the footprint's longest edge.
     */
    async replaceWithModel(viewer, entity, glbUrl, scale) {
        if (!entity) return;
        const bldgId = entity.properties?.buildingId?.getValue();

        const hierarchy = entity.polygon.hierarchy.getValue();
        const positions = hierarchy.positions;

        // Compute centroid and collect cartographic positions
        let sumLat = 0, sumLng = 0;
        const cartos = [];
        for (const pos of positions) {
            const carto = Cesium.Cartographic.fromCartesian(pos);
            const lat = Cesium.Math.toDegrees(carto.latitude);
            const lng = Cesium.Math.toDegrees(carto.longitude);
            sumLat += lat;
            sumLng += lng;
            cartos.push({ lat, lng });
        }
        const centLat = sumLat / positions.length;
        const centLng = sumLng / positions.length;

        // Find heading from longest polygon edge
        let maxDist = 0, heading = 0;
        for (let i = 0; i < cartos.length - 1; i++) {
            const dx = (cartos[i + 1].lng - cartos[i].lng) * Math.cos(centLat * Math.PI / 180);
            const dy = cartos[i + 1].lat - cartos[i].lat;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > maxDist) {
                maxDist = dist;
                heading = Math.atan2(dx, dy) + Math.PI / 2;
            }
        }

        entity.show = false;

        if (this.customModels[bldgId]) {
            viewer.entities.remove(this.customModels[bldgId]);
        }

        const position = Cesium.Cartesian3.fromDegrees(centLng, centLat);
        const hpr = new Cesium.HeadingPitchRoll(heading, 0, 0);
        const orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);

        const modelEntity = viewer.entities.add({
            name: `custom_bldg_${bldgId}`,
            position: position,
            orientation: orientation,
            model: {
                uri: glbUrl,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                scale: scale || 1.0
            }
        });

        this.customModels[bldgId] = modelEntity;
        return modelEntity;
    }
};
