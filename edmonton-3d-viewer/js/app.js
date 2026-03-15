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
    LotLoader.init(viewer);

    // Wire up UI
    setupUI();
    setupBuildingToolUI();
    setupLotUI();
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

    // Apply pre-built model — works on SODA buildings or custom footprints
    applyModelBtn.addEventListener('click', async () => {
        const selectedId = modelSelect.value;
        const model = Buildings.MODEL_CATALOG.find(m => m.id === selectedId);
        if (!selectedId || !model) return;

        applyModelBtn.disabled = true;
        setStatus(`Loading ${model.name}...`);

        try {
            if (Buildings.selectedEntity) {
                // Replace existing SODA building
                await Buildings.replaceWithModel(viewer, Buildings.selectedEntity, model.url, model.scale);
                setStatus(`Replaced building with ${model.name}`);
            } else if (BuildingTool._points.length >= 3 && BuildingTool.mode === 'configuring') {
                // Create a custom building from footprint, then apply model
                const height = parseFloat(document.getElementById('buildHeightSlider').value) || 10;
                const color = document.getElementById('buildColorPicker').value;
                const building = await BuildingTool.createBuilding({ height, color });
                if (building) {
                    await Buildings.replaceWithModel(viewer, building.entity, model.url, model.scale);
                    building.entity.show = false;
                    setStatus(`Placed ${model.name} on custom footprint`);
                }
            } else {
                setStatus('Draw a footprint or select a building first');
            }
            rotateModelBtn.disabled = false;
        } catch (e) {
            setStatus(`Failed to load model: ${e.message}`);
            console.error('Model load error:', e);
        }
        applyModelBtn.disabled = false;
        updateStats();
        updateBuildingList();
    });

    // Model upload (file input) — works on SODA or custom footprint
    modelUpload.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (Buildings.selectedEntity) {
            await handleModelFile(file);
        } else if (BuildingTool._points.length >= 3 && BuildingTool.mode === 'configuring') {
            const height = parseFloat(document.getElementById('buildHeightSlider').value) || 10;
            const color = document.getElementById('buildColorPicker').value;
            const building = await BuildingTool.createBuilding({ height, color });
            if (building) {
                Buildings.select(building.entity);
                await handleModelFile(file);
            }
        }
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
    demolishedBuildings.length = 0;
    updateDemolishedList();

    // Load buildings
    const bldgCount = await Buildings.loadAround(viewer, lat, lng, radiusM);
    setStatus(`Loaded ${bldgCount} buildings`);

    // Load trees
    const treeCount = await Trees.loadAround(viewer, lat, lng, radiusM);
    if (treeCount > 0) {
        setStatus(`Loaded ${bldgCount} buildings, ${treeCount} tree tiles`);
    }

    // Ensure lot overlay is active if enabled
    if (document.getElementById('showLotsCheckbox')?.checked) {
        await LotLoader.loadAround(0, 0, 0);
        const lotStatus = document.getElementById('lotStatus');
        if (lotStatus) lotStatus.textContent = 'Parcel overlay active';
    }

    updateStats();
}

function selectBuilding(entity) {
    Buildings.select(entity);
    const selectedDiv = document.getElementById('selectedBuilding');
    const infoBox = document.getElementById('infoBox');
    const rotateModelBtn = document.getElementById('rotateModelBtn');

    if (entity) {
        const props = entity.properties;
        const id = props?.buildingId?.getValue() || '?';
        const type = props?.type?.getValue() || '?';
        const height = props?.height?.getValue() || '?';
        const area = props?.area_m2?.getValue() || 0;

        // Show selected building bar in the building tool panel
        selectedDiv.classList.remove('hidden');
        selectedDiv.innerHTML = `#${id} &middot; ${type} &middot; ${height}m &middot; ${area.toFixed ? area.toFixed(0) : area}m&sup2; <span class="demolish-link" onclick="demolishBuilding(Buildings.selectedEntity)">Demolish</span>`;

        rotateModelBtn.disabled = !Buildings.customModels[id];

        // Show info box
        document.getElementById('infoContent').innerHTML = `
            <table>
                <tr><td>ID</td><td>${id}</td></tr>
                <tr><td>Type</td><td>${type}</td></tr>
                <tr><td>Height</td><td>${height}m</td></tr>
                <tr><td>Area</td><td>${area.toFixed ? area.toFixed(0) : area} m&sup2;</td></tr>
            </table>
            <button onclick="demolishBuilding(Buildings.selectedEntity)" style="margin-top:8px;padding:6px 12px;border:none;border-radius:4px;background:#c0392b;color:white;cursor:pointer;font-size:12px;width:100%;font-weight:600;">Demolish</button>`;
        infoBox.classList.remove('hidden');

        // Extract footprint from the SODA building polygon and populate building tool
        try {
            const hierarchy = entity.polygon.hierarchy.getValue();
            if (hierarchy && hierarchy.positions) {
                const points = [];
                for (const pos of hierarchy.positions) {
                    const carto = Cesium.Cartographic.fromCartesian(pos);
                    points.push({
                        lat: Cesium.Math.toDegrees(carto.latitude),
                        lng: Cesium.Math.toDegrees(carto.longitude),
                        cartesian: pos
                    });
                }
                if (points.length >= 3) {
                    BuildingTool.cancel();
                    BuildingTool._points = points;
                    BuildingTool.mode = 'configuring';

                    // Set height to match existing building
                    const numHeight = parseFloat(height) || 10;
                    const slider = document.getElementById('buildHeightSlider');
                    if (slider) {
                        slider.value = numHeight;
                        document.getElementById('heightValue').textContent = numHeight + 'm';
                    }

                    BuildingTool._fireUpdate();
                }
            }
        } catch (e) {
            console.warn('Could not extract building footprint:', e);
        }
    } else {
        selectedDiv.classList.add('hidden');
        selectedDiv.innerHTML = '';
        rotateModelBtn.disabled = true;
        document.getElementById('modelSelect').value = '';
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
window._editingBuildingId = null;

// Demolished buildings tracker
const demolishedBuildings = [];

function demolishBuilding(entity) {
    if (!entity) return;
    const props = entity.properties;
    const id = props?.buildingId?.getValue();
    const type = props?.type?.getValue() || '?';
    const height = props?.height?.getValue() || '?';
    const area = props?.area_m2?.getValue() || 0;

    entity.show = false;
    demolishedBuildings.push({
        entity,
        id,
        type,
        height,
        area
    });

    // Also hide any custom model that was on this building
    if (Buildings.customModels[id]) {
        Buildings.customModels[id].show = false;
    }

    selectBuilding(null);
    updateDemolishedList();
    updateStats();
    setStatus(`Demolished building #${id} (${type}, ${height}m)`);
}

function restoreBuilding(index) {
    if (index < 0 || index >= demolishedBuildings.length) return;
    const item = demolishedBuildings[index];
    item.entity.show = true;

    // Restore custom model if any
    if (Buildings.customModels[item.id]) {
        Buildings.customModels[item.id].show = true;
    }

    demolishedBuildings.splice(index, 1);
    updateDemolishedList();
    updateStats();
    setStatus(`Restored building #${item.id}`);
}

function restoreAllBuildings() {
    for (const item of demolishedBuildings) {
        item.entity.show = true;
        if (Buildings.customModels[item.id]) {
            Buildings.customModels[item.id].show = true;
        }
    }
    demolishedBuildings.length = 0;
    updateDemolishedList();
    updateStats();
    setStatus('Restored all demolished buildings');
}

function updateDemolishedList() {
    const listDiv = document.getElementById('demolishedList');
    if (!listDiv) return;

    if (demolishedBuildings.length === 0) {
        listDiv.classList.add('hidden');
        return;
    }

    listDiv.classList.remove('hidden');
    const itemsDiv = document.getElementById('demolishedItems');
    itemsDiv.innerHTML = demolishedBuildings.map((b, i) => `
        <div class="demolished-item">
            <span class="item-info">#${b.id} (${b.type}, ${b.height}m, ${typeof b.area === 'number' ? b.area.toFixed(0) : b.area} m²)</span>
            <button class="restore-btn" onclick="restoreBuilding(${i})" title="Undo demolish">&#8634;</button>
        </div>
    `).join('');
    itemsDiv.innerHTML += `<button class="restore-all-btn" onclick="restoreAllBuildings()">Restore All</button>`;
}

/**
 * Placement mode: user clicks the map to place a rectangular building
 * with the given width and depth (in meters).
 */
let _placementHandler = null;
let _placementPreview = null;
let _placementMoveHandler = null;

function startPlacementMode(widthM, depthM) {
    if (BuildingTool.mode !== 'idle') return;

    const canvas = viewer.scene.canvas;
    canvas.style.cursor = 'crosshair';
    setStatus(`Click on the map to place ${widthM}m × ${depthM}m building`);

    // Show idle UI as "placing" state
    document.getElementById('buildToolIdle').querySelector('.idle-buttons').innerHTML = `
        <button id="cancelPlaceBtn" class="btn-draw btn-cancel" style="flex:1">Cancel Placement</button>
    `;
    document.getElementById('cancelPlaceBtn').addEventListener('click', () => cancelPlacementMode());

    // Convert meters to degrees (approximate)
    const DEG_PER_M = 1 / 111000;
    const halfW = (widthM / 2) * DEG_PER_M;
    const halfD = (depthM / 2) * DEG_PER_M;

    // Mouse move — show preview rectangle
    _placementHandler = new Cesium.ScreenSpaceEventHandler(canvas);

    _placementHandler.setInputAction((movement) => {
        const ray = viewer.camera.getPickRay(movement.endPosition);
        if (!ray) return;
        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!cartesian) return;

        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        const lng = Cesium.Math.toDegrees(carto.longitude);
        const cosLat = Math.cos(carto.latitude);

        const halfWLng = halfW / cosLat;

        // Update or create preview polygon
        const corners = Cesium.Cartesian3.fromDegreesArray([
            lng - halfWLng, lat - halfD,
            lng + halfWLng, lat - halfD,
            lng + halfWLng, lat + halfD,
            lng - halfWLng, lat + halfD
        ]);

        if (_placementPreview) {
            viewer.entities.remove(_placementPreview);
        }
        _placementPreview = viewer.entities.add({
            name: 'placement_preview',
            polygon: {
                hierarchy: corners,
                material: Cesium.Color.CYAN.withAlpha(0.2),
                outline: true,
                outlineColor: Cesium.Color.CYAN.withAlpha(0.8),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
            }
        });
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // Left click — place the building
    _placementHandler.setInputAction((click) => {
        const ray = viewer.camera.getPickRay(click.position);
        if (!ray) return;
        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!cartesian) return;

        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        const lng = Cesium.Math.toDegrees(carto.longitude);
        const cosLat = Math.cos(carto.latitude);
        const halfWLng = halfW / cosLat;

        // Create footprint points for BuildingTool
        const footprint = [
            { lat: lat - halfD, lng: lng - halfWLng },
            { lat: lat - halfD, lng: lng + halfWLng },
            { lat: lat + halfD, lng: lng + halfWLng },
            { lat: lat + halfD, lng: lng - halfWLng }
        ];

        // Inject footprint into BuildingTool and go to config mode
        BuildingTool._points = footprint.map(p => ({
            lat: p.lat,
            lng: p.lng,
            cartesian: Cesium.Cartesian3.fromDegrees(p.lng, p.lat)
        }));
        BuildingTool.mode = 'configuring';

        // Clean up placement mode
        cleanupPlacement();

        // Fire update to show config panel
        BuildingTool._fireUpdate();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function cleanupPlacement() {
    if (_placementHandler) {
        _placementHandler.destroy();
        _placementHandler = null;
    }
    if (_placementPreview) {
        viewer.entities.remove(_placementPreview);
        _placementPreview = null;
    }
    viewer.scene.canvas.style.cursor = '';
    restorePlacementUI();
}

function cancelPlacementMode() {
    cleanupPlacement();
    setStatus('');
}

function restorePlacementUI() {
    const idleBtns = document.getElementById('buildToolIdle').querySelector('.idle-buttons');
    if (idleBtns) {
        idleBtns.innerHTML = `
            <button id="placeBuildingBtn" class="btn-draw">Place on Map</button>
            <button id="rectDrawBtn" class="btn-draw btn-rect" title="Draw rectangle: click two opposite corners">Rectangle</button>
            <button id="drawBuildingBtn" class="btn-draw btn-draw-alt" title="Freeform polygon: click each corner">Draw</button>
        `;
        // Re-attach event listeners
        document.getElementById('placeBuildingBtn').addEventListener('click', () => {
            const w = parseFloat(document.getElementById('inputWidth').value) || 12;
            const d = parseFloat(document.getElementById('inputDepth').value) || 10;
            startPlacementMode(w, d);
        });
        document.getElementById('rectDrawBtn').addEventListener('click', () => {
            BuildingTool.activateRectangle();
        });
        document.getElementById('drawBuildingBtn').addEventListener('click', () => {
            BuildingTool.activate();
        });
    }
}

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

    // Place by dimensions — click map to place a rectangle
    const placeBtn = document.getElementById('placeBuildingBtn');
    const inputWidth = document.getElementById('inputWidth');
    const inputDepth = document.getElementById('inputDepth');

    placeBtn.addEventListener('click', () => {
        const w = parseFloat(inputWidth.value) || 12;
        const d = parseFloat(inputDepth.value) || 10;
        startPlacementMode(w, d);
    });

    // Draw button — activate freeform drawing mode
    drawBtn.addEventListener('click', () => {
        BuildingTool.activate();
    });

    // Rectangle draw button — 2-click rectangle mode
    const rectBtn = document.getElementById('rectDrawBtn');
    rectBtn.addEventListener('click', () => {
        BuildingTool.activateRectangle();
    });

    // Orthogonalize button — snap polygon to right angles
    const orthBtn = document.getElementById('orthogonalizeBtn');
    orthBtn.addEventListener('click', () => {
        BuildingTool.orthogonalize();
    });

    // Edit Vertices button — enter vertex editing mode
    const editVertBtn = document.getElementById('editVerticesBtn');
    editVertBtn.addEventListener('click', () => {
        if (BuildingTool.mode === 'editing_vertices') {
            BuildingTool.finishVertexEditing();
            editVertBtn.classList.remove('active');
            editVertBtn.textContent = 'Edit Vertices';
        } else {
            BuildingTool.activateVertexEditing();
            editVertBtn.classList.add('active');
            editVertBtn.textContent = 'Done Editing';
        }
    });

    // Keyboard shortcut: Q for orthogonalize
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        if (e.key === 'q' || e.key === 'Q') {
            if (BuildingTool.mode === 'configuring' || BuildingTool.mode === 'editing_vertices') {
                BuildingTool.orthogonalize();
            }
        }
        // Ctrl+C — copy selected custom building
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            if (selectedCustomBuilding) {
                e.preventDefault();
                BuildingTool.copyBuilding(selectedCustomBuilding.id);
                document.getElementById('pasteBtn').disabled = false;
                setStatus(`Copied building ${selectedCustomBuilding.id}`);
            }
        }
        // Ctrl+V — enter paste placement mode
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
            if (BuildingTool.hasClipboard() && BuildingTool.mode === 'idle') {
                e.preventDefault();
                startPasteMode();
            }
        }
        // Escape — cancel paste mode
        if (e.key === 'Escape' && _pasteHandler) {
            cancelPasteMode();
        }
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

    // ——— Advanced config: Windows & Doors ———

    // Toggle advanced panel
    const advancedToggle = document.getElementById('advancedToggle');
    const advancedConfig = document.getElementById('advancedConfig');
    advancedToggle.addEventListener('click', () => {
        advancedToggle.classList.toggle('open');
        advancedConfig.classList.toggle('hidden');
    });

    // Slider value display helpers
    const sliderDisplay = (sliderId, displayId, suffix) => {
        const slider = document.getElementById(sliderId);
        const display = document.getElementById(displayId);
        slider.addEventListener('input', () => {
            display.textContent = slider.value + suffix;
        });
    };
    sliderDisplay('winWidthSlider', 'winWidthVal', 'm');
    sliderDisplay('winHeightSlider', 'winHeightVal', 'm');
    sliderDisplay('winSillSlider', 'winSillVal', 'm');
    sliderDisplay('doorWidthSlider', 'doorWidthVal', 'm');
    sliderDisplay('doorHeightSlider', 'doorHeightVal', 'm');
    sliderDisplay('parapetHeightSlider', 'parapetHeightVal', 'm');

    // Roof type buttons
    window._roofType = 'flat';
    document.querySelectorAll('.roof-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.roof-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            window._roofType = btn.dataset.roof;

            // Show/hide pitch slider and parapet based on roof type
            const pitchRow = document.getElementById('roofPitchRow');
            const roofColorRow = document.getElementById('roofColorRow');
            const parapetRow = document.getElementById('parapetRow');
            const isPitched = btn.dataset.roof !== 'flat';
            pitchRow.style.display = isPitched ? 'flex' : 'none';
            roofColorRow.style.display = isPitched ? 'flex' : 'none';
            parapetRow.style.display = isPitched ? 'none' : 'flex';
        });
    });

    // Roof pitch slider
    const roofPitchSlider = document.getElementById('roofPitchSlider');
    const roofPitchVal = document.getElementById('roofPitchVal');
    roofPitchSlider.addEventListener('input', () => {
        roofPitchVal.textContent = roofPitchSlider.value + '°';
    });
    // Initially hide pitch/color since default is flat
    document.getElementById('roofPitchRow').style.display = 'none';
    document.getElementById('roofColorRow').style.display = 'none';

    // Window offset slider
    const winOffsetSlider = document.getElementById('winOffsetSlider');
    const winOffsetVal = document.getElementById('winOffsetVal');
    winOffsetSlider.addEventListener('input', () => {
        winOffsetVal.textContent = parseFloat(winOffsetSlider.value).toFixed(1) + 'm';
    });

    // Window count slider (0 = auto)
    const winCountSlider = document.getElementById('winCountSlider');
    const winCountVal = document.getElementById('winCountVal');
    winCountSlider.addEventListener('input', () => {
        winCountVal.textContent = winCountSlider.value === '0' ? 'auto' : winCountSlider.value;
    });

    // Door wall slider
    const doorWallSlider = document.getElementById('doorWallSlider');
    const doorWallVal = document.getElementById('doorWallVal');
    doorWallSlider.addEventListener('input', () => {
        doorWallVal.textContent = parseInt(doorWallSlider.value) + 1;
    });

    // Door position slider
    const doorPosSlider = document.getElementById('doorPosSlider');
    const doorPosVal = document.getElementById('doorPosVal');
    doorPosSlider.addEventListener('input', () => {
        doorPosVal.textContent = doorPosSlider.value + '%';
    });

    // Floor tabs — dynamically generated based on storey count
    const updateFloorTabs = () => {
        const storeys = Math.round(parseFloat(heightSlider.value) / 3.5);
        const floorTabs = document.getElementById('floorTabs');
        floorTabs.innerHTML = '<button class="floor-tab active" data-floor="all">All</button>';
        for (let i = 0; i < Math.min(storeys, 20); i++) {
            const btn = document.createElement('button');
            btn.className = 'floor-tab';
            btn.dataset.floor = i;
            btn.textContent = i + 1;
            floorTabs.appendChild(btn);
        }
        // Update door wall slider max based on footprint points
        if (BuildingTool._points.length > 0) {
            doorWallSlider.max = BuildingTool._points.length - 1;
        }
        setupFloorTabListeners();
        setupWallTabs();
    };

    heightSlider.addEventListener('change', updateFloorTabs);

    // Track current floor/wall selection for per-floor/wall config
    window._currentFloor = 'all';
    window._currentWall = 'all';
    window._floorConfigs = {}; // keyed by "floor:wall"

    const setupFloorTabListeners = () => {
        document.querySelectorAll('.floor-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.floor-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                window._currentFloor = tab.dataset.floor;
                loadConfigForSelection();
            });
        });
    };

    const setupWallTabs = () => {
        const wallTabs = document.getElementById('wallTabs');
        wallTabs.innerHTML = '<button class="wall-tab active" data-wall="all">All</button>';
        const numWalls = BuildingTool._points.length || 4;
        for (let i = 0; i < numWalls; i++) {
            const btn = document.createElement('button');
            btn.className = 'wall-tab';
            btn.dataset.wall = i;
            btn.textContent = i + 1;
            wallTabs.appendChild(btn);
        }
        document.querySelectorAll('.wall-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.wall-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                window._currentWall = tab.dataset.wall;
                loadConfigForSelection();
            });
        });
    };

    // Save current slider values to the current floor:wall config
    const saveConfigForSelection = () => {
        const key = `${window._currentFloor}:${window._currentWall}`;
        window._floorConfigs[key] = {
            count: parseInt(winCountSlider.value),
            width: parseFloat(document.getElementById('winWidthSlider').value),
            height: parseFloat(document.getElementById('winHeightSlider').value),
            sillHeight: parseFloat(document.getElementById('winSillSlider').value),
            offset: parseFloat(winOffsetSlider.value)
        };
    };

    // Load config for the selected floor:wall into sliders
    const loadConfigForSelection = () => {
        const key = `${window._currentFloor}:${window._currentWall}`;
        const cfg = window._floorConfigs[key] || window._floorConfigs['all:all'] || {};
        if (cfg.count !== undefined) { winCountSlider.value = cfg.count; winCountVal.textContent = cfg.count === 0 ? 'auto' : cfg.count; }
        if (cfg.width !== undefined) { document.getElementById('winWidthSlider').value = cfg.width; document.getElementById('winWidthVal').textContent = cfg.width + 'm'; }
        if (cfg.height !== undefined) { document.getElementById('winHeightSlider').value = cfg.height; document.getElementById('winHeightVal').textContent = cfg.height + 'm'; }
        if (cfg.sillHeight !== undefined) { document.getElementById('winSillSlider').value = cfg.sillHeight; document.getElementById('winSillVal').textContent = cfg.sillHeight + 'm'; }
        if (cfg.offset !== undefined) { winOffsetSlider.value = cfg.offset; winOffsetVal.textContent = parseFloat(cfg.offset).toFixed(1) + 'm'; }
    };

    // Auto-save when any window slider changes
    [winCountSlider, document.getElementById('winWidthSlider'), document.getElementById('winHeightSlider'),
     document.getElementById('winSillSlider'), winOffsetSlider].forEach(slider => {
        slider.addEventListener('change', saveConfigForSelection);
    });

    // Generate 3D Model button
    const generateBtn = document.getElementById('generateModelBtn');

    // Enable generate button when BuildingGenerator is ready
    window.addEventListener('building-generator-ready', () => {
        console.log('BuildingGenerator ready');
        generateBtn.disabled = false;
        generateBtn.title = '';
    });

    // Check periodically in case the event was missed or module is loading slowly
    const checkGeneratorReady = () => {
        if (window.BuildingGenerator) {
            generateBtn.title = '';
            return;
        }
        if (window._buildingGeneratorError) {
            generateBtn.title = 'Three.js failed to load: ' + window._buildingGeneratorError;
            console.error('BuildingGenerator load error:', window._buildingGeneratorError);
            return;
        }
        setTimeout(checkGeneratorReady, 2000);
    };
    setTimeout(checkGeneratorReady, 3000);

    generateBtn.addEventListener('click', async () => {
        if (!window.BuildingGenerator) {
            setStatus('3D generator still loading...');
            return;
        }

        // Check if we're editing an existing building or creating new
        const editingId = window._editingBuildingId;
        const existingBuilding = editingId ? BuildingTool.buildings.find(b => b.id === editingId) : null;

        if (!existingBuilding && BuildingTool._points.length < 3) {
            setStatus('Draw a footprint first');
            return;
        }

        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating...';
        setStatus('Generating 3D building model...');

        try {
            // Save current config before generating
            saveConfigForSelection();

            // Ensure all:all has defaults if not set
            if (!window._floorConfigs['all:all']) {
                window._floorConfigs['all:all'] = {
                    count: parseInt(winCountSlider.value),
                    width: parseFloat(document.getElementById('winWidthSlider').value),
                    height: parseFloat(document.getElementById('winHeightSlider').value),
                    sillHeight: parseFloat(document.getElementById('winSillSlider').value),
                    offset: parseFloat(winOffsetSlider.value)
                };
            }

            const height = parseFloat(heightSlider.value);
            const storeys = Math.round(height / 3.5);
            const floorHeight = height / storeys;

            const addDoor = document.getElementById('addDoorChk').checked;
            const door = addDoor ? {
                width: parseFloat(document.getElementById('doorWidthSlider').value),
                height: parseFloat(document.getElementById('doorHeightSlider').value),
                wallIndex: parseInt(doorWallSlider.value),
                position: parseInt(doorPosSlider.value) / 100
            } : null;

            // Use existing footprint for regeneration, or current points for new
            const footprint = existingBuilding
                ? existingBuilding.footprint
                : BuildingTool._points.map(p => ({ lat: p.lat, lng: p.lng }));

            const config = {
                footprint: footprint,
                numFloors: storeys,
                floorHeight: floorHeight,
                colors: {
                    wall: colorPicker.value,
                    glass: document.getElementById('glassColorPicker').value,
                    frame: document.getElementById('frameColorPicker').value,
                    roof: document.getElementById('roofColorPicker').value
                },
                floorConfigs: { ...window._floorConfigs },
                door: door,
                roofType: window._roofType || 'flat',
                roofPitch: parseFloat(document.getElementById('roofPitchSlider').value),
                parapet: document.getElementById('addParapetChk').checked,
                parapetHeight: parseFloat(document.getElementById('parapetHeightSlider').value)
            };

            const glbUrl = await window.BuildingGenerator.generate(config);

            let building;

            if (existingBuilding) {
                // --- Regeneration: update existing building ---
                building = existingBuilding;

                // Remove old model entity
                if (building.modelEntity) {
                    viewer.entities.remove(building.modelEntity);
                }
                if (building.glbUrl) {
                    URL.revokeObjectURL(building.glbUrl);
                }

                // Update building properties
                building.height = height;
                building.storeys = storeys;
                building.color = colorPicker.value;
                building.glbUrl = glbUrl;

                // Update flat extrusion (hidden but keeps metadata)
                building.entity.polygon.extrudedHeight = building.terrainH + height;
                building.entity.polygon.material = Cesium.Color.fromCssColorString(colorPicker.value).withAlpha(0.85);
                building.entity.show = false;
            } else {
                // --- New building ---
                building = await BuildingTool.createBuilding({
                    height, color: colorPicker.value, storeys
                });
                if (!building) throw new Error('Failed to create building entity');
                building.entity.show = false;
                building.glbUrl = glbUrl;
            }

            // Place/replace GLB model at building centroid
            const centLat = building.footprint.reduce((s, p) => s + p.lat, 0) / building.footprint.length;
            const centLng = building.footprint.reduce((s, p) => s + p.lng, 0) / building.footprint.length;
            const terrainH = await Buildings.getTerrainHeight(viewer, centLat, centLng);

            const position = Cesium.Cartesian3.fromDegrees(centLng, centLat, terrainH);
            // CesiumJS Entity API maps model +X to North with heading=0.
            // Our model is built with +X=East, so rotate 90° CW to align correctly.
            const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.PI_OVER_TWO, 0, 0);
            const orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);

            const modelEntity = viewer.entities.add({
                name: building.id + '_model',
                position: position,
                orientation: orientation,
                model: {
                    uri: glbUrl,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    scale: 1.0
                }
            });
            building.modelEntity = modelEntity;

            // Store generation config for future editing
            building.generationConfig = {
                floorConfigs: { ...window._floorConfigs },
                door: door,
                colors: { ...config.colors },
                roofType: config.roofType,
                roofPitch: config.roofPitch,
                parapet: config.parapet,
                parapetHeight: config.parapetHeight
            };

            const action = existingBuilding ? 'Regenerated' : 'Created';
            setStatus(`${action} 3D building (${building.width}m × ${building.depth}m, ${storeys} floors)`);

            // Clear edit mode
            window._editingBuildingId = null;

        } catch (e) {
            setStatus('Error generating model: ' + e.message);
            console.error('Generate error:', e);
        }

        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate 3D Model';
        updateStats();
        updateBuildingList();
    });

    // Save Template button
    const saveTemplateBtn = document.getElementById('saveTemplateBtn');
    saveTemplateBtn.addEventListener('click', () => {
        const name = prompt('Template name:');
        if (!name || !name.trim()) return;
        if (BuildingTool.saveTemplate(name.trim())) {
            setStatus(`Saved template "${name.trim()}"`);
            renderTemplateList();
        }
    });

    // Paste button
    const pasteBtn = document.getElementById('pasteBtn');
    pasteBtn.addEventListener('click', () => {
        if (BuildingTool.hasClipboard() && BuildingTool.mode === 'idle') {
            startPasteMode();
        }
    });

    // Initial template list render
    renderTemplateList();

    // Listen for BuildingTool state changes
    BuildingTool.onUpdate = (mode, pointCount) => {
        const idleDiv = document.getElementById('buildToolIdle');
        const drawDiv = document.getElementById('buildToolDrawing');
        const configDiv = document.getElementById('buildToolConfig');
        const pointCountEl = document.getElementById('pointCount');
        const drawingHint = document.getElementById('drawingHint');

        const isDrawing = mode === 'drawing' || mode === 'rect_first' || mode === 'rect_second';
        const isConfig = mode === 'configuring' || mode === 'editing_vertices';

        idleDiv.classList.toggle('hidden', mode !== 'idle');
        drawDiv.classList.toggle('hidden', !isDrawing);
        configDiv.classList.toggle('hidden', !isConfig);

        if (isDrawing) {
            if (mode === 'rect_first') {
                drawingHint.innerHTML = 'Click to set the <b>first corner</b> of the rectangle.';
                pointCountEl.textContent = 'Rectangle mode';
                undoBtn.disabled = true;
                doneBtn.disabled = true;
            } else if (mode === 'rect_second') {
                drawingHint.innerHTML = 'Click to set the <b>opposite corner</b>. Right-click to restart.';
                pointCountEl.textContent = 'Rectangle mode';
                undoBtn.disabled = true;
                doneBtn.disabled = true;
            } else {
                drawingHint.innerHTML = 'Click on the map to place corners.<br>Double-click or press Done to finish.';
                pointCountEl.textContent = `Points: ${pointCount}`;
                undoBtn.disabled = pointCount === 0;
                doneBtn.disabled = pointCount < 3;
            }
        }

        if (isConfig) {
            const dims = BuildingTool.getFootprintDimensions();
            document.getElementById('customWidth').textContent = dims.width + 'm';
            document.getElementById('customDepth').textContent = dims.depth + 'm';
            document.getElementById('customArea').textContent = dims.area + ' m²';

            // Enable generate button if BuildingGenerator is loaded
            if (window.BuildingGenerator) {
                generateBtn.disabled = false;
            } else {
                generateBtn.disabled = true;
                generateBtn.title = 'Loading 3D generator...';
            }

            // Update floor tabs and wall tabs
            updateFloorTabs();

            // Reset floor configs for new building (only on first enter)
            if (mode === 'configuring') {
                window._floorConfigs = {};
                window._currentFloor = 'all';
                window._currentWall = 'all';
                window._editingBuildingId = null;
                generateBtn.textContent = 'Generate 3D Model';
            }

            // Update edit vertices button state
            const editVertBtn = document.getElementById('editVerticesBtn');
            if (mode === 'editing_vertices') {
                editVertBtn.classList.add('active');
                editVertBtn.textContent = 'Done Editing';
            } else {
                editVertBtn.classList.remove('active');
                editVertBtn.textContent = 'Edit Vertices';
            }
        }

        if (mode === 'idle') {
            generateBtn.disabled = true;
            // Refresh paste button state
            const pasteBtn = document.getElementById('pasteBtn');
            if (pasteBtn) pasteBtn.disabled = !BuildingTool.hasClipboard();
        }

        updateBuildingList();
        updateStats();
    };
}

// ——— Paste Placement Mode ———

let _pasteHandler = null;
let _pastePreview = null;

function startPasteMode() {
    if (!BuildingTool.hasClipboard() || BuildingTool.mode !== 'idle') return;

    const canvas = viewer.scene.canvas;
    canvas.style.cursor = 'crosshair';
    setStatus('Click to paste building. Press Escape to cancel.');

    _pasteHandler = new Cesium.ScreenSpaceEventHandler(canvas);

    // Mouse move — show preview of pasted footprint
    _pasteHandler.setInputAction((movement) => {
        const ray = viewer.camera.getPickRay(movement.endPosition);
        if (!ray) return;
        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!cartesian) return;

        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        const lng = Cesium.Math.toDegrees(carto.longitude);

        const clipboard = BuildingTool.getClipboard();
        const positions = clipboard.relativeFootprint.map(rp =>
            Cesium.Cartesian3.fromDegrees(lng + rp.dLng, lat + rp.dLat)
        );

        if (_pastePreview) viewer.entities.remove(_pastePreview);
        _pastePreview = viewer.entities.add({
            name: 'paste_preview',
            polygon: {
                hierarchy: positions,
                material: Cesium.Color.fromCssColorString(clipboard.color || '#5599cc').withAlpha(0.3),
                outline: true,
                outlineColor: Cesium.Color.CYAN.withAlpha(0.8),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
            }
        });
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // Left click — place
    _pasteHandler.setInputAction((click) => {
        const ray = viewer.camera.getPickRay(click.position);
        if (!ray) return;
        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!cartesian) return;

        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        const lng = Cesium.Math.toDegrees(carto.longitude);

        const clipboard = BuildingTool.getClipboard();

        cleanupPasteMode();
        BuildingTool.pasteFootprintAt(lat, lng);

        // Apply clipboard config to UI
        if (clipboard.height) {
            document.getElementById('buildHeightSlider').value = clipboard.height;
            document.getElementById('heightValue').textContent = clipboard.height + 'm';
        }
        if (clipboard.color) {
            document.getElementById('buildColorPicker').value = clipboard.color;
        }
        if (clipboard.generationConfig) {
            window._floorConfigs = { ...clipboard.generationConfig.floorConfigs };
            if (clipboard.generationConfig.door) {
                document.getElementById('addDoorChk').checked = true;
                document.getElementById('doorWidthSlider').value = clipboard.generationConfig.door.width;
                document.getElementById('doorHeightSlider').value = clipboard.generationConfig.door.height;
            }
            if (clipboard.generationConfig.colors) {
                document.getElementById('glassColorPicker').value = clipboard.generationConfig.colors.glass || '#446688';
                document.getElementById('frameColorPicker').value = clipboard.generationConfig.colors.frame || '#888888';
            }
            if (clipboard.generationConfig.roofType) {
                window._roofType = clipboard.generationConfig.roofType;
                document.querySelectorAll('.roof-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.roof === clipboard.generationConfig.roofType);
                });
            }
        }

        setStatus('Footprint pasted — configure and generate');
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Right click — cancel
    _pasteHandler.setInputAction(() => {
        cancelPasteMode();
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
}

function cleanupPasteMode() {
    if (_pasteHandler) {
        _pasteHandler.destroy();
        _pasteHandler = null;
    }
    if (_pastePreview) {
        viewer.entities.remove(_pastePreview);
        _pastePreview = null;
    }
    viewer.scene.canvas.style.cursor = '';
}

function cancelPasteMode() {
    cleanupPasteMode();
    setStatus('');
}

// ——— Template List Rendering ———

function renderTemplateList() {
    const list = document.getElementById('templateList');
    if (!list) return;

    const templates = BuildingTool.templates;
    if (templates.length === 0) {
        list.innerHTML = '<span style="font-size:10px;color:#666;">No templates saved</span>';
        return;
    }

    list.innerHTML = templates.map(t => `
        <span class="template-chip${t.builtIn ? ' builtin' : ''}" data-template="${t.name}" title="${t.name}${t.height ? ' (' + t.height + 'm, ' + (t.storeys || '?') + 'F)' : ''}">
            <span class="chip-color" style="background:${t.color || '#888'}"></span>
            <span>${t.name}</span>
            ${!t.builtIn ? '<span class="chip-delete" data-del="' + t.name + '">&times;</span>' : ''}
        </span>
    `).join('');

    // Click template chip → enter paste mode with that template
    list.querySelectorAll('.template-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
            // Ignore if clicking delete button
            if (e.target.classList.contains('chip-delete')) return;

            const name = chip.dataset.template;
            if (BuildingTool.applyTemplate(name)) {
                document.getElementById('pasteBtn').disabled = false;

                const template = BuildingTool.templates.find(t => t.name === name);
                // Apply template config to UI sliders
                if (template && template.height) {
                    document.getElementById('buildHeightSlider').value = template.height;
                    document.getElementById('heightValue').textContent = template.height + 'm';
                }
                if (template && template.color) {
                    document.getElementById('buildColorPicker').value = template.color;
                }

                if (BuildingTool.mode === 'idle') {
                    startPasteMode();
                }
            }
        });
    });

    // Delete template
    list.querySelectorAll('.chip-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const name = btn.dataset.del;
            if (BuildingTool.deleteTemplate(name)) {
                renderTemplateList();
                setStatus(`Deleted template "${name}"`);
            }
        });
    });
}

// Make renderTemplateList available globally for when templates change
window.renderTemplateList = renderTemplateList;

function setupLotUI() {
    const checkbox = document.getElementById('showLotsCheckbox');
    const lotStatus = document.getElementById('lotStatus');

    checkbox.addEventListener('change', async () => {
        if (checkbox.checked) {
            lotStatus.textContent = 'Loading...';
            const count = await LotLoader.loadAround(0, 0, 0);
            lotStatus.textContent = count > 0 ? 'Parcel overlay active' : 'No lots found';
        } else {
            LotLoader.clear();
            lotStatus.textContent = '';
        }
    });

    // Handle lot clicks — identify parcel at click point, populate building tool
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction(async (click) => {
        if (!checkbox.checked) return;
        // Don't interfere with building tool drawing
        if (BuildingTool.mode === 'drawing') return;

        // Get lat/lng from click position
        const ray = viewer.camera.getPickRay(click.position);
        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!cartesian) return;
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        const lng = Cesium.Math.toDegrees(carto.longitude);

        // Check if we clicked a building or existing entity first
        const picked = viewer.scene.pick(click.position);
        if (picked?.id && !LotLoader.isLotEntity(picked.id)) return;

        lotStatus.textContent = 'Identifying...';
        const result = await LotLoader.identifyParcel(lat, lng);
        if (!result) {
            lotStatus.textContent = 'No parcel found';
            setTimeout(() => { lotStatus.textContent = 'Parcel overlay active'; }, 2000);
            return;
        }

        // Show highlighted parcel
        LotLoader.showSelectedParcel(result.polygon, result.properties);
        const address = result.properties.BESTADDRESS || 'Unknown';
        lotStatus.textContent = address;

        // Feed polygon to BuildingTool
        BuildingTool.cancel();
        BuildingTool._points = result.polygon.map(p => ({
            lat: p.lat,
            lng: p.lng,
            cartesian: Cesium.Cartesian3.fromDegrees(p.lng, p.lat)
        }));
        BuildingTool.mode = 'configuring';
        BuildingTool._fireUpdate();

        setStatus(`Lot: ${address}`);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function selectCustomBuilding(entity) {
    // Deselect previous SODA building selection
    selectBuilding(null);

    if (!entity) {
        selectedCustomBuilding = null;
        document.getElementById('infoBox').classList.add('hidden');
        // Hide edit panel when deselecting
        document.getElementById('editPanel')?.classList.add('hidden');
        return;
    }

    let building = BuildingTool.selectBuilding(entity);
    // If clicking the 3D model entity, find the building by matching modelEntity or name
    if (!building) {
        const entityName = entity.name || '';
        building = BuildingTool.buildings.find(b =>
            b.modelEntity === entity || entityName === b.id + '_model'
        );
    }
    if (!building) return;
    selectedCustomBuilding = building;

    // Show properties in info box with edit + copy + delete buttons
    const has3D = !!building.modelEntity;
    document.getElementById('infoContent').innerHTML = `
        <table>
            <tr><td>ID</td><td>${building.id}</td></tr>
            <tr><td>Width</td><td>${building.width}m</td></tr>
            <tr><td>Depth</td><td>${building.depth}m</td></tr>
            <tr><td>Height</td><td>${building.height}m</td></tr>
            <tr><td>Storeys</td><td>${building.storeys}</td></tr>
            <tr><td>Area</td><td>${building.area} m&sup2;</td></tr>
            <tr><td>Model</td><td>${has3D ? '3D generated' : 'Flat extrusion'}</td></tr>
        </table>
        <div style="display:flex;gap:4px;margin-top:8px;">
            <button onclick="editSelectedCustomBuilding()" style="flex:1;padding:5px 8px;border:none;border-radius:4px;background:#2a9d8f;color:white;cursor:pointer;font-size:11px;">Edit</button>
            <button onclick="copySelectedCustomBuilding()" class="btn-copy-building" style="flex:1;padding:5px 8px;font-size:11px;">Copy</button>
            <button onclick="saveSelectedAsTemplate()" style="flex:1;padding:5px 8px;border:none;border-radius:4px;background:#8B6914;color:white;cursor:pointer;font-size:11px;">Template</button>
            <button onclick="deleteSelectedCustomBuilding()" style="flex:1;padding:5px 8px;border:none;border-radius:4px;background:#c0392b;color:white;cursor:pointer;font-size:11px;">Delete</button>
        </div>`;
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

function editSelectedCustomBuilding() {
    if (!selectedCustomBuilding) return;
    const building = selectedCustomBuilding;

    // Show the config panel in edit mode
    const configDiv = document.getElementById('buildToolConfig');
    const idleDiv = document.getElementById('buildToolIdle');
    const drawDiv = document.getElementById('buildToolDrawing');

    idleDiv.classList.add('hidden');
    drawDiv.classList.add('hidden');
    configDiv.classList.remove('hidden');

    // Load building dimensions
    document.getElementById('customWidth').textContent = building.width + 'm';
    document.getElementById('customDepth').textContent = building.depth + 'm';
    document.getElementById('customArea').textContent = building.area + ' m²';
    document.getElementById('buildHeightSlider').value = building.height;
    document.getElementById('heightValue').textContent = building.height + 'm';
    document.getElementById('buildColorPicker').value = building.color;

    const storeys = building.storeys;
    document.querySelectorAll('.storey-btn').forEach(btn => {
        const s = parseInt(btn.dataset.storeys);
        btn.classList.toggle('active', s === storeys || (s === 6 && storeys >= 6));
    });

    // Restore saved generation config if available
    if (building.generationConfig) {
        window._floorConfigs = { ...building.generationConfig.floorConfigs };
        if (building.generationConfig.door) {
            document.getElementById('addDoorChk').checked = true;
            document.getElementById('doorWidthSlider').value = building.generationConfig.door.width;
            document.getElementById('doorWidthVal').textContent = building.generationConfig.door.width + 'm';
            document.getElementById('doorHeightSlider').value = building.generationConfig.door.height;
            document.getElementById('doorHeightVal').textContent = building.generationConfig.door.height + 'm';
            document.getElementById('doorWallSlider').value = building.generationConfig.door.wallIndex;
            document.getElementById('doorWallVal').textContent = building.generationConfig.door.wallIndex + 1;
            document.getElementById('doorPosSlider').value = building.generationConfig.door.position * 100;
            document.getElementById('doorPosVal').textContent = Math.round(building.generationConfig.door.position * 100) + '%';
        }
        if (building.generationConfig.colors) {
            document.getElementById('glassColorPicker').value = building.generationConfig.colors.glass || '#446688';
            document.getElementById('frameColorPicker').value = building.generationConfig.colors.frame || '#888888';
        }
        document.getElementById('addParapetChk').checked = building.generationConfig.parapet !== false;
        if (building.generationConfig.parapetHeight) {
            document.getElementById('parapetHeightSlider').value = building.generationConfig.parapetHeight;
            document.getElementById('parapetHeightVal').textContent = building.generationConfig.parapetHeight + 'm';
        }
        // Restore roof settings
        const roofType = building.generationConfig.roofType || 'flat';
        window._roofType = roofType;
        document.querySelectorAll('.roof-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.roof === roofType);
        });
        const isPitched = roofType !== 'flat';
        document.getElementById('roofPitchRow').style.display = isPitched ? 'flex' : 'none';
        document.getElementById('roofColorRow').style.display = isPitched ? 'flex' : 'none';
        document.getElementById('parapetRow').style.display = isPitched ? 'none' : 'flex';
        if (building.generationConfig.roofPitch) {
            document.getElementById('roofPitchSlider').value = building.generationConfig.roofPitch;
            document.getElementById('roofPitchVal').textContent = building.generationConfig.roofPitch + '°';
        }
        if (building.generationConfig.colors?.roof) {
            document.getElementById('roofColorPicker').value = building.generationConfig.colors.roof;
        }
        // Load the current floor:wall config into sliders
        window._currentFloor = 'all';
        window._currentWall = 'all';
        const cfg = window._floorConfigs['all:all'] || {};
        if (cfg.count !== undefined) { document.getElementById('winCountSlider').value = cfg.count; document.getElementById('winCountVal').textContent = cfg.count === 0 ? 'auto' : cfg.count; }
        if (cfg.width !== undefined) { document.getElementById('winWidthSlider').value = cfg.width; document.getElementById('winWidthVal').textContent = cfg.width + 'm'; }
        if (cfg.height !== undefined) { document.getElementById('winHeightSlider').value = cfg.height; document.getElementById('winHeightVal').textContent = cfg.height + 'm'; }
        if (cfg.sillHeight !== undefined) { document.getElementById('winSillSlider').value = cfg.sillHeight; document.getElementById('winSillVal').textContent = cfg.sillHeight + 'm'; }
        if (cfg.offset !== undefined) { document.getElementById('winOffsetSlider').value = cfg.offset; document.getElementById('winOffsetVal').textContent = parseFloat(cfg.offset).toFixed(1) + 'm'; }
    }

    // Update floor/wall tabs based on building footprint
    const floorTabs = document.getElementById('floorTabs');
    floorTabs.innerHTML = '<button class="floor-tab active" data-floor="all">All</button>';
    for (let i = 0; i < storeys; i++) {
        const btn = document.createElement('button');
        btn.className = 'floor-tab';
        btn.dataset.floor = i;
        btn.textContent = i + 1;
        floorTabs.appendChild(btn);
    }

    const wallTabs = document.getElementById('wallTabs');
    wallTabs.innerHTML = '<button class="wall-tab active" data-wall="all">All</button>';
    for (let i = 0; i < building.footprint.length; i++) {
        const btn = document.createElement('button');
        btn.className = 'wall-tab';
        btn.dataset.wall = i;
        btn.textContent = i + 1;
        wallTabs.appendChild(btn);
    }
    document.getElementById('doorWallSlider').max = building.footprint.length - 1;

    // Enable generate button for regeneration
    const generateBtn = document.getElementById('generateModelBtn');
    generateBtn.textContent = 'Regenerate 3D';
    if (window.BuildingGenerator) generateBtn.disabled = false;

    // Mark that we're in edit mode
    window._editingBuildingId = building.id;

    setStatus('Editing building — use Arrow keys to nudge position');
}

/**
 * Nudge a custom building's position by a lat/lng delta.
 * Updates footprint, flat extrusion entity, and 3D model entity.
 */
async function nudgeBuilding(building, dLat, dLng) {
    // Update footprint coordinates
    for (const p of building.footprint) {
        p.lat += dLat;
        p.lng += dLng;
    }

    // Rebuild flat extrusion positions
    const positions = [];
    for (const p of building.footprint) {
        positions.push(p.lng, p.lat);
    }
    building.entity.polygon.hierarchy = Cesium.Cartesian3.fromDegreesArray(positions);

    // Update terrain height at new centroid
    const centLat = building.footprint.reduce((s, p) => s + p.lat, 0) / building.footprint.length;
    const centLng = building.footprint.reduce((s, p) => s + p.lng, 0) / building.footprint.length;
    const terrainH = await Buildings.getTerrainHeight(viewer, centLat, centLng);
    building.terrainH = terrainH;
    building.entity.polygon.height = terrainH + 0.5;
    building.entity.polygon.extrudedHeight = terrainH + building.height;

    // Move the 3D model entity if present
    if (building.modelEntity) {
        const newPos = Cesium.Cartesian3.fromDegrees(centLng, centLat, terrainH);
        building.modelEntity.position = newPos;
        const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.PI_OVER_TWO, 0, 0);
        building.modelEntity.orientation = Cesium.Transforms.headingPitchRollQuaternion(newPos, hpr);
    }
}

// Arrow key handler for nudging buildings in edit mode
document.addEventListener('keydown', (e) => {
    if (!window._editingBuildingId || !selectedCustomBuilding) return;

    // Don't intercept if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    const step = e.shiftKey ? 0.00005 : 0.00001; // ~5.5m or ~1.1m
    let dLat = 0, dLng = 0;

    switch (e.key) {
        case 'ArrowUp':    dLat = step;  break;
        case 'ArrowDown':  dLat = -step; break;
        case 'ArrowLeft':  dLng = -step; break;
        case 'ArrowRight': dLng = step;  break;
        default: return;
    }

    e.preventDefault();
    nudgeBuilding(selectedCustomBuilding, dLat, dLng);
});

function copySelectedCustomBuilding() {
    if (!selectedCustomBuilding) return;
    BuildingTool.copyBuilding(selectedCustomBuilding.id);
    document.getElementById('pasteBtn').disabled = false;
    setStatus(`Copied ${selectedCustomBuilding.id} — click Paste or Ctrl+V to place`);
}

function saveSelectedAsTemplate() {
    if (!selectedCustomBuilding) return;
    const name = prompt('Template name:');
    if (!name || !name.trim()) return;
    if (BuildingTool.saveTemplateFromBuilding(selectedCustomBuilding.id, name.trim())) {
        setStatus(`Saved "${name.trim()}" as template`);
        renderTemplateList();
    }
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
    const demolished = demolishedBuildings.length;
    stats.textContent = `Buildings: ${Buildings.entities.length} | ` +
        `Tree tilesets: ${Trees.loadedTiles.size} | ` +
        `Custom models: ${Object.keys(Buildings.customModels).length} | ` +
        `Custom buildings: ${BuildingTool.buildings.length}` +
        (demolished ? ` | Demolished: ${demolished}` : '');
}

// Close info box
document.getElementById('closeInfo')?.addEventListener('click', () => {
    document.getElementById('infoBox').classList.add('hidden');
});

// Start
init();
