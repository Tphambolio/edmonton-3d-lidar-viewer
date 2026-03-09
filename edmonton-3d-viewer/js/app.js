/**
 * Edmonton 3D Tree & Building Viewer — Main Application
 *
 * CesiumJS globe with address search, building extrusion from GeoJSON tiles,
 * LiDAR tree mesh loading, and custom building model upload.
 *
 * Uses Cesium Ion for World Terrain (free tier).
 */

let viewer;
let currentLocation = null;
let searchMarker = null;
let osmLayer = null;
let satelliteLayer = null;

async function init() {
    // Set Cesium Ion access token for World Terrain
    Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIxNWY5NWZiZi0yOWViLTQ4NWMtYTk4NS1jNjZkMzZiYmNlNDEiLCJpZCI6NDAwNDM0LCJpYXQiOjE3NzMwMDYzODB9.Ga_Zl92AgOgkzaPUOWaSlQVK2s-PJMlFfuXUJ7LHv4o';

    // Create viewer with Cesium World Terrain
    viewer = new Cesium.Viewer('cesiumContainer', {
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        selectionIndicator: true,
        infoBox: false,
        terrain: Cesium.Terrain.fromWorldTerrain(),
        baseLayer: new Cesium.ImageryLayer(
            new Cesium.UrlTemplateImageryProvider({
                url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                maximumLevel: 19,
                credit: 'OpenStreetMap contributors'
            })
        )
    });

    // Store OSM layer reference and prepare satellite layer
    osmLayer = viewer.imageryLayers.get(0);
    satelliteLayer = viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            maximumLevel: 19,
            credit: 'Esri, Maxar, Earthstar Geographics'
        })
    );
    satelliteLayer.show = false;

    // Set initial view to Edmonton immediately
    viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(-113.49, 53.54, 15000),
        orientation: {
            heading: 0,
            pitch: Cesium.Math.toRadians(-50),
            roll: 0
        }
    });

    // Enable depth test against terrain so objects behind terrain are hidden
    viewer.scene.globe.depthTestAgainstTerrain = true;

    // Load building tile index
    await Buildings.loadIndex();
    await Trees.loadIndex();

    // Wire up UI
    setupUI();
    updateStats();
}

function setupUI() {
    const searchBtn = document.getElementById('searchBtn');
    const addressInput = document.getElementById('addressInput');
    const showBuildings = document.getElementById('showBuildings');
    const showTrees = document.getElementById('showTrees');
    const radiusSlider = document.getElementById('radiusSlider');
    const radiusLabel = document.getElementById('radiusLabel');
    const modelUpload = document.getElementById('modelUpload');
    const showSatellite = document.getElementById('showSatellite');

    // Search
    searchBtn.addEventListener('click', () => doSearch());
    addressInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') doSearch();
    });

    // Toggles
    showBuildings.addEventListener('change', () => {
        Buildings.entities.forEach(e => e.show = showBuildings.checked);
    });
    showTrees.addEventListener('change', () => {
        Trees.tilesets.forEach(ts => ts.show = showTrees.checked);
    });
    showSatellite.addEventListener('change', () => {
        osmLayer.show = !showSatellite.checked;
        satelliteLayer.show = showSatellite.checked;
    });

    // Tree height offset slider
    const treeOffsetSlider = document.getElementById('treeOffsetSlider');
    const treeOffsetLabel = document.getElementById('treeOffsetLabel');
    treeOffsetSlider.addEventListener('input', () => {
        const val = parseInt(treeOffsetSlider.value);
        treeOffsetLabel.textContent = val + 'm';
        Trees.setHeightOffset(val);
    });

    // Radius slider
    radiusSlider.addEventListener('input', () => {
        radiusLabel.textContent = radiusSlider.value + 'm';
    });
    radiusSlider.addEventListener('change', () => {
        if (currentLocation) {
            loadScene(currentLocation.lat, currentLocation.lng, parseInt(radiusSlider.value));
        }
    });

    // Building click handler
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click) => {
        const picked = viewer.scene.pick(click.position);
        console.log('Picked:', picked);
        if (Cesium.defined(picked)) {
            // Entity pick (buildings)
            if (picked.id && picked.id.name?.startsWith('bldg_')) {
                selectBuilding(picked.id);
                return;
            }
            // 3D Tileset pick (trees) — ignore, don't deselect
            if (picked instanceof Cesium.Cesium3DTileFeature) {
                console.log('Clicked tree tileset — ignoring');
                return;
            }
        }
        selectBuilding(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Populate model dropdown from catalog
    const modelSelect = document.getElementById('modelSelect');
    const applyModelBtn = document.getElementById('applyModelBtn');
    for (const model of Buildings.MODEL_CATALOG) {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.textContent = model.name;
        opt.title = model.description;
        modelSelect.appendChild(opt);
    }

    // Rotate model 90°
    const rotateModelBtn = document.getElementById('rotateModelBtn');
    rotateModelBtn.addEventListener('click', () => {
        if (!Buildings.selectedEntity) return;
        const bldgId = Buildings.selectedEntity.properties?.buildingId?.getValue();
        if (bldgId !== undefined && Buildings.customModels[bldgId]) {
            Buildings.rotateModel(viewer, bldgId);
        }
    });

    // Apply pre-built model
    applyModelBtn.addEventListener('click', async () => {
        const selectedId = modelSelect.value;
        if (!selectedId || !Buildings.selectedEntity) return;
        const model = Buildings.MODEL_CATALOG.find(m => m.id === selectedId);
        if (!model) return;
        setStatus(`Loading ${model.name}...`);
        applyModelBtn.disabled = true;
        try {
            await Buildings.replaceWithModel(viewer, Buildings.selectedEntity, model.url, model.scale);
            setStatus(`Replaced building with ${model.name}`);
            rotateModelBtn.disabled = false;
        } catch (e) {
            setStatus(`Failed to load model: ${e.message}`);
            console.error('Model load error:', e);
        }
        applyModelBtn.disabled = false;
        updateStats();
    });

    // Model upload (file input)
    modelUpload.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file || !Buildings.selectedEntity) return;
        await handleModelFile(file);
    });

    // Model upload (drag & drop)
    const dropZone = document.getElementById('dropZone');
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (!file || !Buildings.selectedEntity) {
            setStatus('Select a building first');
            return;
        }
        await handleModelFile(file);
    });
}

async function doSearch() {
    const address = document.getElementById('addressInput').value.trim();
    if (!address) return;

    setStatus('Searching...');
    try {
        const result = await Geocoder.geocode(address);
        if (!result) {
            setStatus('Address not found');
            return;
        }

        setStatus(`Found: ${result.display}`);
        currentLocation = { lat: result.lat, lng: result.lng };

        // Drop a search marker at the geocoded location
        if (searchMarker) viewer.entities.remove(searchMarker);
        searchMarker = viewer.entities.add({
            name: 'searchMarker',
            position: Cesium.Cartesian3.fromDegrees(result.lng, result.lat),
            point: {
                pixelSize: 14,
                color: Cesium.Color.RED,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 3,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            },
            ellipse: {
                semiMajorAxis: 25,
                semiMinorAxis: 25,
                material: Cesium.Color.RED.withAlpha(0.2),
                outline: true,
                outlineColor: Cesium.Color.RED.withAlpha(0.8),
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
            },
            label: {
                text: address,
                font: '13px sans-serif',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -20),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });

        // Fly to location above terrain
        const heading = Cesium.Math.toRadians(0);
        const pitch = Cesium.Math.toRadians(-45);
        const range = 500; // meters from target

        // Sample terrain height first so camera doesn't go underground
        const carto = [Cesium.Cartographic.fromDegrees(result.lng, result.lat)];
        let terrainH = 0;
        try {
            const sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, carto);
            terrainH = sampled[0].height || 0;
        } catch (e) {
            console.warn('Terrain sample failed for flyTo:', e);
        }

        const target = Cesium.Cartesian3.fromDegrees(result.lng, result.lat, terrainH);
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(result.lng, result.lat, terrainH + range),
            orientation: {
                heading: heading,
                pitch: pitch,
                roll: 0
            },
            duration: 2,
            complete: function() {
                viewer.camera.lookAt(target,
                    new Cesium.HeadingPitchRange(heading, pitch, range)
                );
                viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            }
        });

        // Load scene after camera arrives
        setTimeout(() => {
            const radius = parseInt(document.getElementById('radiusSlider').value);
            loadScene(result.lat, result.lng, radius);
        }, 2500);

    } catch (e) {
        setStatus('Geocoding error: ' + e.message);
        console.error('Geocode error:', e);
    }
}

async function loadScene(lat, lng, radiusM) {
    setStatus('Loading buildings...');

    // Clear previous data
    Buildings.clear(viewer);
    Trees.clear(viewer);

    // Load buildings
    const bldgCount = await Buildings.loadAround(viewer, lat, lng, radiusM);
    setStatus(`Loaded ${bldgCount} buildings`);

    // Load trees
    const treeCount = await Trees.loadAround(viewer, lat, lng, radiusM);
    if (treeCount > 0) {
        setStatus(`Loaded ${bldgCount} buildings, ${treeCount} tree tiles`);
    }

    updateStats();
}

function selectBuilding(entity) {
    Buildings.select(entity);
    const uploadInput = document.getElementById('modelUpload');
    const selectedDiv = document.getElementById('selectedBuilding');
    const infoBox = document.getElementById('infoBox');
    const modelSelect = document.getElementById('modelSelect');
    const applyModelBtn = document.getElementById('applyModelBtn');
    const rotateModelBtn = document.getElementById('rotateModelBtn');

    if (entity) {
        const props = entity.properties;
        const id = props?.buildingId?.getValue() || '?';
        const type = props?.type?.getValue() || '?';
        const height = props?.height?.getValue() || '?';
        const area = props?.area_m2?.getValue() || 0;

        selectedDiv.textContent = `Selected: #${id} (${type}, ${height}m)`;
        uploadInput.disabled = false;
        modelSelect.disabled = false;
        applyModelBtn.disabled = false;
        rotateModelBtn.disabled = !Buildings.customModels[id];

        document.getElementById('infoContent').innerHTML = `
            <table>
                <tr><td>ID</td><td>${id}</td></tr>
                <tr><td>Type</td><td>${type}</td></tr>
                <tr><td>Height</td><td>${height}m</td></tr>
                <tr><td>Area</td><td>${area.toFixed ? area.toFixed(0) : area} m&sup2;</td></tr>
            </table>`;
        infoBox.classList.remove('hidden');
    } else {
        selectedDiv.textContent = 'No building selected';
        uploadInput.disabled = true;
        modelSelect.disabled = true;
        applyModelBtn.disabled = true;
        rotateModelBtn.disabled = true;
        modelSelect.value = '';
        infoBox.classList.add('hidden');
    }
}

async function handleModelFile(file) {
    const url = URL.createObjectURL(file);
    await Buildings.replaceWithModel(viewer, Buildings.selectedEntity, url);
    setStatus(`Replaced building with ${file.name}`);
    updateStats();
}

function setStatus(msg) {
    document.getElementById('searchStatus').textContent = msg;
}

function updateStats() {
    const stats = document.getElementById('stats');
    stats.textContent = `Buildings: ${Buildings.entities.length} | ` +
        `Tree tilesets: ${Trees.loadedTiles.size} | ` +
        `Custom models: ${Object.keys(Buildings.customModels).length}`;
}

// Close info box
document.getElementById('closeInfo')?.addEventListener('click', () => {
    document.getElementById('infoBox').classList.add('hidden');
});

// Start
init();
