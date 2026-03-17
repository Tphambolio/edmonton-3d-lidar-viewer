/**
 * Tree Points Layer — loads Edmonton tree inventory as clickable dots.
 *
 * Data source: City of Edmonton Open Data (Socrata API)
 * Dataset: Trees (eecg-fc54)
 * https://data.edmonton.ca/Environmental-Services/Trees/eecg-fc54
 */
const TreePoints = {
    API_BASE: 'https://data.edmonton.ca/resource/eecg-fc54.json',
    APP_TOKEN: '',  // public access (rate-limited)

    _viewer: null,
    _entities: [],
    _dataSource: null,
    _visible: false,
    _loaded: false,
    _lastCenter: null,
    _treeData: [],    // raw tree records

    // Genus → color mapping for dots
    GENUS_COLORS: {
        'Picea':   '#1a6b1a',  // spruce — dark green
        'Pinus':   '#2d8a2d',  // pine — green
        'Abies':   '#1f7a1f',  // fir — dark green
        'Larix':   '#7ab648',  // larch — yellow-green
        'Thuja':   '#2e7d32',  // cedar — green
        'Populus': '#8bc34a',  // poplar — light green
        'Fraxinus':'#66bb6a',  // ash — medium green
        'Ulmus':   '#4caf50',  // elm — green
        'Acer':    '#ff9800',  // maple — orange
        'Betula':  '#e8d44d',  // birch — yellow
        'Quercus': '#795548',  // oak — brown
        'Salix':   '#aed581',  // willow — light green
        'Malus':   '#f06292',  // apple/crab — pink
        'Prunus':  '#ec407a',  // cherry/plum — pink
        'Tilia':   '#81c784',  // linden — green
        'Sorbus':  '#ef5350',  // mountain ash — red
    },
    DEFAULT_COLOR: '#43a047',

    init(viewer) {
        this._viewer = viewer;
    },

    /**
     * Load tree points around a location from the Socrata API.
     * Uses $where=within_circle for spatial filtering.
     */
    async loadAround(lat, lng, radiusM) {
        if (!this._viewer) return 0;

        // Don't reload if same area
        if (this._lastCenter &&
            Math.abs(this._lastCenter.lat - lat) < 0.001 &&
            Math.abs(this._lastCenter.lng - lng) < 0.001) {
            return this._treeData.length;
        }

        this.clear();
        this._lastCenter = { lat, lng };

        try {
            // Socrata within_circle on geometry_point field
            const where = `within_circle(geometry_point, ${lat}, ${lng}, ${radiusM})`;
            const fields = 'latitude,longitude,species,species_botanical,genus,diameter_breast_height,condition_percent,planted_date,location_type,neighbourhood_name,owner,bears_edible_fruit';
            const url = `${this.API_BASE}?$where=${encodeURIComponent(where)}&$select=${fields}&$limit=5000`;

            const resp = await fetch(url);
            if (!resp.ok) {
                console.warn('Tree points API error:', resp.status);
                return 0;
            }

            this._treeData = await resp.json();
            console.log(`Tree points: loaded ${this._treeData.length} trees`);

            if (this._visible) {
                this._renderPoints();
            }

            this._loaded = true;
            return this._treeData.length;
        } catch (e) {
            console.warn('Tree points load failed:', e);
            return 0;
        }
    },

    /**
     * Render tree points as Cesium entities (billboards).
     */
    _renderPoints() {
        this._clearEntities();
        if (!this._treeData.length) return;

        const viewer = this._viewer;
        for (const tree of this._treeData) {
            const lat = parseFloat(tree.latitude);
            const lng = parseFloat(tree.longitude);
            if (isNaN(lat) || isNaN(lng)) continue;

            const genus = tree.genus || '';
            const colorHex = this.GENUS_COLORS[genus] || this.DEFAULT_COLOR;
            const color = Cesium.Color.fromCssColorString(colorHex);

            const species = tree.species || tree.species_botanical || 'Unknown';
            const dbh = tree.diameter_breast_height || '?';

            const entity = viewer.entities.add({
                name: `tree_${species}`,
                position: Cesium.Cartesian3.fromDegrees(lng, lat, 0),
                point: {
                    pixelSize: 8,
                    color: color,
                    outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
                    outlineWidth: 1,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 800)
                },
                properties: {
                    isTreePoint: true,
                    species: species,
                    species_botanical: tree.species_botanical || '',
                    genus: genus,
                    dbh: dbh,
                    condition: tree.condition_percent || '',
                    planted_date: tree.planted_date || '',
                    location_type: tree.location_type || '',
                    neighbourhood: tree.neighbourhood_name || '',
                    owner: tree.owner || '',
                    edible_fruit: tree.bears_edible_fruit || ''
                }
            });

            this._entities.push(entity);
        }
    },

    /**
     * Show/hide tree point entities.
     */
    setVisible(visible) {
        this._visible = visible;
        if (visible && this._loaded && this._entities.length === 0) {
            this._renderPoints();
        }
        for (const e of this._entities) {
            e.show = visible;
        }
    },

    /**
     * Get tree info for display when clicked.
     */
    getTreeInfo(entity) {
        try {
            const props = entity.properties;
            if (!props?.isTreePoint?.getValue()) return null;
            return {
                species: props.species?.getValue() || 'Unknown',
                species_botanical: props.species_botanical?.getValue() || '',
                genus: props.genus?.getValue() || '',
                dbh: props.dbh?.getValue() || '?',
                condition: props.condition?.getValue() || '',
                planted_date: props.planted_date?.getValue() || '',
                location_type: props.location_type?.getValue() || '',
                neighbourhood: props.neighbourhood?.getValue() || '',
                owner: props.owner?.getValue() || '',
                edible_fruit: props.edible_fruit?.getValue() || ''
            };
        } catch {
            return null;
        }
    },

    /**
     * Find the nearest tree point entity to a screen click position.
     * Returns entity if within pixelRadius, null otherwise.
     */
    findNearestAt(screenPosition, pixelRadius = 12) {
        if (!this._visible || !this._entities.length) return null;
        const now = Cesium.JulianDate.now();
        let best = null;
        let bestDist = pixelRadius * pixelRadius;
        for (const entity of this._entities) {
            if (!entity.show) continue;
            const pos = entity.position.getValue(now);
            if (!pos) continue;
            const sp = Cesium.SceneTransforms.wgs84ToWindowCoordinates(this._viewer.scene, pos);
            if (!sp) continue;
            const dx = sp.x - screenPosition.x;
            const dy = sp.y - screenPosition.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestDist) {
                bestDist = d2;
                best = entity;
            }
        }
        return best;
    },

    _clearEntities() {
        for (const e of this._entities) {
            this._viewer.entities.remove(e);
        }
        this._entities = [];
    },

    clear() {
        this._clearEntities();
        this._treeData = [];
        this._loaded = false;
        this._lastCenter = null;
    }
};

window.TreePoints = TreePoints;
