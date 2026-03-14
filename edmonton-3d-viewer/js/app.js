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

// 3D model conversion service URL (unified gateway for all formats)
const CONVERT_API = new URLSearchParams(window.location.search).get('convertApi') || '';
const NATIVE_3D_FORMATS = ['.glb', '.gltf'];
const CONVERTIBLE_FORMATS = ['.obj', '.fbx', '.dae', '.3ds', '.stl', '.ply', '.usd'];
const SKP_FORMAT = '.skp';

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

    // Initialize custom building tool
    BuildingTool.init(viewer);

    // Wire up UI
    setupUI();
    setupBuildingToolUI();
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
        // Don't intercept clicks when BuildingTool is drawing
        if (BuildingTool.mode === 'drawing') return;

        const picked = viewer.scene.pick(click.position);
        console.log('Picked:', picked);
        if (Cesium.defined(picked)) {
            // Entity pick (buildings)
            if (picked.id && picked.id.name?.startsWith('bldg_')) {
                selectBuilding(picked.id);
                return;
            }
            // Custom building pick
            if (picked.id && picked.id.name?.startsWith('custom_build_')) {
                selectCustomBuilding(picked.id);
                return;
            }
            // 3D Tileset pick (trees) — ignore, don't deselect
            if (picked instanceof Cesium.Cesium3DTileFeature) {
                console.log('Clicked tree tileset — ignoring');
                return;
            }
        }
        selectBuilding(null);
        selectCustomBuilding(null);
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
    const ext = '.' + file.name.split('.').pop().toLowerCase();

    if (NATIVE_3D_FORMATS.includes(ext)) {
        // Direct load — GLB/glTF
        const url = URL.createObjectURL(file);
        await Buildings.replaceWithModel(viewer, Buildings.selectedEntity, url);
        setStatus(`Replaced building with ${file.name}`);
    } else if (ext === SKP_FORMAT) {
        // SKP → GLB via SketchUp 8 + Blender pipeline
        if (!CONVERT_API) {
            setStatus('Conversion service not configured. Add ?convertApi=URL to page URL.');
            return;
        }
        setStatus(`Converting SketchUp file ${file.name}... (this may take a minute)`);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const resp = await fetch(`${CONVERT_API}/convert/skp`, {
                method: 'POST',
                body: formData,
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: resp.statusText }));
                const detail = err.detail || err.error || `HTTP ${resp.status}`;
                const msg = typeof detail === 'object' ? (detail.error || detail.hint || JSON.stringify(detail)) : detail;
                throw new Error(msg);
            }
            const glbBlob = await resp.blob();
            const url = URL.createObjectURL(glbBlob);
            await Buildings.replaceWithModel(viewer, Buildings.selectedEntity, url);
            setStatus(`Converted and applied ${file.name}`);
        } catch (e) {
            setStatus(`SKP conversion error: ${e.message}`);
            console.error('SKP conversion error:', e);
            return;
        }
    } else if (CONVERTIBLE_FORMATS.includes(ext)) {
        // Convert via Blender API then load
        if (!CONVERT_API) {
            setStatus('Conversion service not configured. Add ?convertApi=URL to page URL.');
            return;
        }
        setStatus(`Converting ${file.name} to GLB...`);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const resp = await fetch(`${CONVERT_API}/convert`, {
                method: 'POST',
                body: formData,
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: resp.statusText }));
                throw new Error(err.error || `HTTP ${resp.status}`);
            }
            const glbBlob = await resp.blob();
            const url = URL.createObjectURL(glbBlob);
            await Buildings.replaceWithModel(viewer, Buildings.selectedEntity, url);
            setStatus(`Converted and applied ${file.name}`);
        } catch (e) {
            setStatus(`Conversion error: ${e.message}`);
            console.error('Model conversion error:', e);
            return;
        }
    } else {
        setStatus(`Unsupported format: ${ext}. Use .glb, .skp, .obj, .fbx, .dae, or .stl`);
        return;
    }
    updateStats();
}

// ——— Custom Building Tool UI ———

let selectedCustomBuilding = null;

function setupBuildingToolUI() {
    const drawBtn = document.getElementById('drawBuildingBtn');
    const cancelBtn = document.getElementById('cancelDrawBtn');
    const undoBtn = document.getElementById('undoPointBtn');
    const doneBtn = document.getElementById('doneDrawBtn');
    const createBtn = document.getElementById('createBuildingBtn');
    const resetBtn = document.getElementById('resetFootprintBtn');
    const heightSlider = document.getElementById('buildHeightSlider');
    const heightValue = document.getElementById('heightValue');
    const colorPicker = document.getElementById('buildColorPicker');

    // Draw button — activate drawing mode
    drawBtn.addEventListener('click', () => {
        BuildingTool.activate();
    });

    // Cancel drawing
    cancelBtn.addEventListener('click', () => {
        BuildingTool.cancel();
    });

    // Undo last point
    undoBtn.addEventListener('click', () => {
        BuildingTool.undoPoint();
    });

    // Done drawing
    doneBtn.addEventListener('click', () => {
        BuildingTool.completeFootprint();
    });

    // Height slider
    heightSlider.addEventListener('input', () => {
        const h = parseFloat(heightSlider.value);
        heightValue.textContent = h + 'm';

        // Update storey button highlights
        const storeys = Math.round(h / 3.5);
        document.querySelectorAll('.storey-btn').forEach(btn => {
            const s = parseInt(btn.dataset.storeys);
            btn.classList.toggle('active', s === storeys || (s === 6 && storeys >= 6));
        });

        // Live-update if editing an existing custom building
        if (selectedCustomBuilding) {
            BuildingTool.updateBuilding(selectedCustomBuilding.id, { height: h, storeys: Math.round(h / 3.5) });
        }
    });

    // Storey quick-select buttons
    document.querySelectorAll('.storey-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const storeys = parseInt(btn.dataset.storeys);
            const height = storeys * 3.5;
            heightSlider.value = height;
            heightValue.textContent = height + 'm';
            document.querySelectorAll('.storey-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (selectedCustomBuilding) {
                BuildingTool.updateBuilding(selectedCustomBuilding.id, { height, storeys });
            }
        });
    });

    // Color picker
    colorPicker.addEventListener('input', () => {
        if (selectedCustomBuilding) {
            BuildingTool.updateBuilding(selectedCustomBuilding.id, { color: colorPicker.value });
        }
    });

    // Create building
    createBtn.addEventListener('click', async () => {
        const height = parseFloat(heightSlider.value);
        const color = colorPicker.value;
        const storeys = Math.round(height / 3.5);
        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';
        try {
            const building = await BuildingTool.createBuilding({ height, color, storeys });
            if (building) {
                setStatus(`Created custom building (${building.width}m × ${building.depth}m × ${building.height}m)`);
            }
        } catch (e) {
            setStatus('Error creating building: ' + e.message);
            console.error('Create building error:', e);
        }
        createBtn.disabled = false;
        createBtn.textContent = 'Create Building';
        updateStats();
        updateBuildingList();
    });

    // Reset footprint
    resetBtn.addEventListener('click', () => {
        BuildingTool.resetFootprint();
    });

    // Listen for BuildingTool state changes
    BuildingTool.onUpdate = (mode, pointCount) => {
        const idleDiv = document.getElementById('buildToolIdle');
        const drawDiv = document.getElementById('buildToolDrawing');
        const configDiv = document.getElementById('buildToolConfig');
        const pointCountEl = document.getElementById('pointCount');

        idleDiv.classList.toggle('hidden', mode !== 'idle');
        drawDiv.classList.toggle('hidden', mode !== 'drawing');
        configDiv.classList.toggle('hidden', mode !== 'configuring');

        if (mode === 'drawing') {
            pointCountEl.textContent = `Points: ${pointCount}`;
            undoBtn.disabled = pointCount === 0;
            doneBtn.disabled = pointCount < 3;
        }

        if (mode === 'configuring') {
            const dims = BuildingTool.getFootprintDimensions();
            document.getElementById('customWidth').textContent = dims.width + 'm';
            document.getElementById('customDepth').textContent = dims.depth + 'm';
            document.getElementById('customArea').textContent = dims.area + ' m²';
        }

        updateBuildingList();
        updateStats();
    };
}

function selectCustomBuilding(entity) {
    // Deselect previous SODA building selection
    selectBuilding(null);

    if (!entity) {
        selectedCustomBuilding = null;
        document.getElementById('infoBox').classList.add('hidden');
        return;
    }

    const building = BuildingTool.selectBuilding(entity);
    if (!building) return;
    selectedCustomBuilding = building;

    // Show properties in info box
    document.getElementById('infoContent').innerHTML = `
        <table>
            <tr><td>ID</td><td>${building.id}</td></tr>
            <tr><td>Width</td><td>${building.width}m</td></tr>
            <tr><td>Depth</td><td>${building.depth}m</td></tr>
            <tr><td>Height</td><td>${building.height}m</td></tr>
            <tr><td>Storeys</td><td>${building.storeys}</td></tr>
            <tr><td>Area</td><td>${building.area} m&sup2;</td></tr>
        </table>
        <button onclick="deleteSelectedCustomBuilding()" style="margin-top:8px;padding:5px 12px;border:none;border-radius:4px;background:#c0392b;color:white;cursor:pointer;font-size:12px;width:100%;">Delete Building</button>`;
    document.getElementById('infoBox').classList.remove('hidden');

    // Sync config panel to this building's values
    document.getElementById('buildHeightSlider').value = building.height;
    document.getElementById('heightValue').textContent = building.height + 'm';
    document.getElementById('buildColorPicker').value = building.color;
    document.querySelectorAll('.storey-btn').forEach(btn => {
        const s = parseInt(btn.dataset.storeys);
        btn.classList.toggle('active', s === building.storeys || (s === 6 && building.storeys >= 6));
    });
}

function deleteSelectedCustomBuilding() {
    if (!selectedCustomBuilding) return;
    BuildingTool.deleteBuilding(selectedCustomBuilding.id);
    selectedCustomBuilding = null;
    document.getElementById('infoBox').classList.add('hidden');
    updateBuildingList();
    updateStats();
}

function updateBuildingList() {
    const listDiv = document.getElementById('customBuildingList');
    const itemsDiv = document.getElementById('customBuildingItems');

    if (BuildingTool.buildings.length === 0) {
        listDiv.classList.add('hidden');
        return;
    }

    listDiv.classList.remove('hidden');
    itemsDiv.innerHTML = BuildingTool.buildings.map(b => `
        <div class="custom-building-item" onclick="flyToCustomBuilding('${b.id}')">
            <div class="color-swatch" style="background:${b.color}"></div>
            <span class="item-info">${b.width}m × ${b.depth}m × ${b.height}m</span>
            <button class="delete-btn" onclick="event.stopPropagation(); BuildingTool.deleteBuilding('${b.id}'); updateBuildingList(); updateStats();">&times;</button>
        </div>
    `).join('');
}

function flyToCustomBuilding(id) {
    const building = BuildingTool.buildings.find(b => b.id === id);
    if (!building || !building.entity) return;
    viewer.flyTo(building.entity, { duration: 1 });
}

function setStatus(msg) {
    document.getElementById('searchStatus').textContent = msg;
}

function updateStats() {
    const stats = document.getElementById('stats');
    stats.textContent = `Buildings: ${Buildings.entities.length} | ` +
        `Tree tilesets: ${Trees.loadedTiles.size} | ` +
        `Custom models: ${Object.keys(Buildings.customModels).length} | ` +
        `Custom buildings: ${BuildingTool.buildings.length}`;
}

// Close info box
document.getElementById('closeInfo')?.addEventListener('click', () => {
    document.getElementById('infoBox').classList.add('hidden');
});

// Start
init();
