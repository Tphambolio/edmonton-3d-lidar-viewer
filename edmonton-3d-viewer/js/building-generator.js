/**
 * Procedural 3D Building Generator
 *
 * Uses Three.js to generate building geometry with walls, windows, doors,
 * floor plates, and parapets, then exports as GLB for loading into CesiumJS.
 *
 * ES Module — loaded via importmap.
 */
let THREE, GLTFExporter;
try {
    THREE = await import('three');
    const exporter = await import('three/addons/exporters/GLTFExporter.js');
    GLTFExporter = exporter.GLTFExporter;
} catch (e) {
    console.error('Failed to load Three.js modules:', e);
    // Surface the error to the UI
    window._buildingGeneratorError = e.message;
    throw e;
}

const BuildingGenerator = {

    /**
     * Generate a GLB blob URL for a procedural building.
     *
     * @param {Object} config
     * @param {Array<{lat,lng}>} config.footprint - Polygon vertices (counter-clockwise)
     * @param {number} config.numFloors - Number of floors
     * @param {number} config.floorHeight - Height per floor in meters
     * @param {Object} config.colors - {wall, glass, frame} hex strings
     * @param {Object} config.floorConfigs - Per-floor window overrides keyed by "floor:wall"
     *   e.g. { "all:all": {count:0, width:1.2, ...}, "0:0": {count:3, offset:0.5} }
     * @param {Object|null} config.door - {width, height, wallIndex, position(0-1)} or null
     * @param {boolean} config.parapet - Whether to add parapet
     * @param {number} config.parapetHeight - Parapet height in meters
     * @returns {Promise<string>} Blob URL to generated GLB
     */
    async generate(config) {
        const scene = new THREE.Scene();

        // Convert footprint to local meters (centered at centroid, Y-up)
        const localPts = this._footprintToLocal(config.footprint);

        // Ensure counter-clockwise winding (for outward normals)
        if (this._isClockwise(localPts)) {
            localPts.reverse();
        }

        // Materials — DoubleSide so walls are visible from both sides
        const wallMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(config.colors?.wall || '#CCBBAA'),
            roughness: 0.85,
            metalness: 0.05,
            side: THREE.DoubleSide
        });
        const glassMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(config.colors?.glass || '#446688'),
            roughness: 0.1,
            metalness: 0.3,
            transparent: true,
            opacity: 0.6,
            side: THREE.DoubleSide
        });
        const frameMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(config.colors?.frame || '#888888'),
            roughness: 0.5,
            metalness: 0.2,
            side: THREE.DoubleSide
        });
        const slabMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(config.colors?.wall || '#CCBBAA').multiplyScalar(0.85),
            roughness: 0.9,
            metalness: 0.05,
            side: THREE.DoubleSide
        });

        const numFloors = config.numFloors || 3;
        const floorHeight = config.floorHeight || 3.5;
        const totalHeight = numFloors * floorHeight;

        // Build each wall segment
        for (let w = 0; w < localPts.length; w++) {
            const p1 = localPts[w];
            const p2 = localPts[(w + 1) % localPts.length];

            for (let f = 0; f < numFloors; f++) {
                const winConfig = this._getWindowConfig(config.floorConfigs, f, w);
                const doorConfig = (f === 0 && config.door && config.door.wallIndex === w)
                    ? config.door : null;

                const wallGroup = this._buildWallSegment(
                    p1, p2, f, floorHeight, winConfig, doorConfig,
                    wallMat, glassMat, frameMat
                );
                scene.add(wallGroup);
            }
        }

        // Floor plates
        for (let f = 0; f <= numFloors; f++) {
            const slab = this._buildFloorPlate(localPts, f * floorHeight, 0.15, slabMat);
            scene.add(slab);
        }

        // Roof
        const roofType = config.roofType || 'flat';
        const pitchAngle = config.roofPitch || 30; // degrees
        const roofColor = config.colors?.roof || config.colors?.wall || '#CCBBAA';
        const roofMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(roofColor).multiplyScalar(0.9),
            roughness: 0.7,
            metalness: 0.1,
            side: THREE.DoubleSide
        });

        if (roofType === 'flat') {
            // Flat roof with optional parapet
            if (config.parapet !== false) {
                const parapetH = config.parapetHeight || 0.6;
                const parapet = this._buildParapet(localPts, totalHeight, parapetH, wallMat);
                scene.add(parapet);
            }
        } else {
            // Pitched roof — compute OBB for ridge direction
            const roof = this._buildRoof(localPts, totalHeight, roofType, pitchAngle, roofMat, wallMat);
            scene.add(roof);
        }

        // Add ambient light for better default appearance
        scene.add(new THREE.AmbientLight(0xffffff, 0.4));

        return await this._exportToGLB(scene);
    },

    /**
     * Resolve window config for a specific floor and wall.
     * Priority: "floor:wall" > "floor:all" > "all:wall" > "all:all" > defaults
     */
    _getWindowConfig(floorConfigs, floor, wall) {
        const defaults = { count: 0, width: 1.2, height: 1.4, sillHeight: 0.9, offset: 0, recessDepth: 0.08 };
        if (!floorConfigs) return defaults;

        const keys = [`${floor}:${wall}`, `${floor}:all`, `all:${wall}`, 'all:all'];
        let merged = { ...defaults };
        // Apply from least specific to most specific
        for (const key of keys.reverse()) {
            if (floorConfigs[key]) {
                merged = { ...merged, ...floorConfigs[key] };
            }
        }
        return merged;
    },

    /**
     * Build a wall segment with window/door openings for one floor of one edge.
     */
    _buildWallSegment(p1, p2, floor, floorHeight, winConfig, doorConfig, wallMat, glassMat, frameMat) {
        const group = new THREE.Group();

        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const wallLen = Math.sqrt(dx * dx + dz * dz);
        const dirX = dx / wallLen;
        const dirZ = dz / wallLen;

        // Outward normal (cross product of wall direction and up)
        const normX = -dirZ;
        const normZ = dirX;

        const floorBase = floor * floorHeight;

        // Determine window positions along the wall
        const windows = this._calcWindowPositions(wallLen, winConfig, doorConfig);

        // If no windows/doors, just make one solid wall quad
        if (windows.length === 0 && !doorConfig) {
            const quad = this._makeWallQuad(
                p1, dirX, dirZ, normX, normZ,
                0, wallLen, floorBase, floorBase + floorHeight,
                wallMat
            );
            group.add(quad);
            return group;
        }

        // Build wall quads around openings
        // Sort openings by position
        const openings = [];
        for (const win of windows) {
            openings.push({
                left: win.center - win.width / 2,
                right: win.center + win.width / 2,
                bottom: floorBase + win.sillHeight,
                top: floorBase + win.sillHeight + win.height,
                type: 'window'
            });
        }
        if (doorConfig) {
            const doorCenter = doorConfig.position * wallLen;
            openings.push({
                left: doorCenter - doorConfig.width / 2,
                right: doorCenter + doorConfig.width / 2,
                bottom: floorBase,
                top: floorBase + doorConfig.height,
                type: 'door'
            });
        }
        openings.sort((a, b) => a.left - b.left);

        // Clamp openings to wall boundaries
        for (const op of openings) {
            op.left = Math.max(0.05, op.left);
            op.right = Math.min(wallLen - 0.05, op.right);
            if (op.right <= op.left) continue;
        }

        // Generate wall fill quads around openings
        // Vertical strips between openings
        let cursor = 0;
        for (const op of openings) {
            if (op.right <= op.left) continue;

            // Solid strip left of this opening (full height)
            if (op.left > cursor + 0.01) {
                group.add(this._makeWallQuad(
                    p1, dirX, dirZ, normX, normZ,
                    cursor, op.left, floorBase, floorBase + floorHeight,
                    wallMat
                ));
            }

            // Below opening
            if (op.bottom > floorBase + 0.01) {
                group.add(this._makeWallQuad(
                    p1, dirX, dirZ, normX, normZ,
                    op.left, op.right, floorBase, op.bottom,
                    wallMat
                ));
            }

            // Above opening
            if (op.top < floorBase + floorHeight - 0.01) {
                group.add(this._makeWallQuad(
                    p1, dirX, dirZ, normX, normZ,
                    op.left, op.right, op.top, floorBase + floorHeight,
                    wallMat
                ));
            }

            // Window recess & glass
            if (op.type === 'window') {
                const recess = this._makeWindowRecess(
                    p1, dirX, dirZ, normX, normZ,
                    op.left, op.right, op.bottom, op.top,
                    winConfig.recessDepth || 0.08,
                    glassMat, frameMat
                );
                group.add(recess);
            }

            // Door recess
            if (op.type === 'door') {
                const recess = this._makeDoorRecess(
                    p1, dirX, dirZ, normX, normZ,
                    op.left, op.right, op.bottom, op.top,
                    0.12, frameMat
                );
                group.add(recess);
            }

            cursor = op.right;
        }

        // Solid strip right of last opening
        if (cursor < wallLen - 0.01) {
            group.add(this._makeWallQuad(
                p1, dirX, dirZ, normX, normZ,
                cursor, wallLen, floorBase, floorBase + floorHeight,
                wallMat
            ));
        }

        return group;
    },

    /**
     * Calculate window center positions along a wall.
     */
    _calcWindowPositions(wallLen, winConfig, doorConfig) {
        if (!winConfig) return [];

        let count = winConfig.count;
        const winWidth = winConfig.width || 1.2;
        const minSpacing = winWidth + 0.5;

        // count=0 means auto
        if (!count || count <= 0) {
            count = Math.max(0, Math.floor((wallLen - 0.6) / minSpacing));
        }

        if (count === 0 || wallLen < winWidth + 0.4) return [];

        const spacing = wallLen / (count + 1);
        const offset = winConfig.offset || 0;
        const windows = [];

        for (let i = 0; i < count; i++) {
            const center = spacing * (i + 1) + offset;

            // Skip if window would overlap with door
            if (doorConfig) {
                const doorCenter = doorConfig.position * wallLen;
                const doorHalf = doorConfig.width / 2 + 0.2;
                if (Math.abs(center - doorCenter) < doorHalf + winWidth / 2) continue;
            }

            // Skip if out of bounds
            if (center - winWidth / 2 < 0.1 || center + winWidth / 2 > wallLen - 0.1) continue;

            windows.push({
                center,
                width: winWidth,
                height: winConfig.height || 1.4,
                sillHeight: winConfig.sillHeight || 0.9
            });
        }

        return windows;
    },

    /**
     * Create a flat wall quad between two U positions and two heights.
     */
    _makeWallQuad(origin, dirX, dirZ, normX, normZ, uStart, uEnd, yBottom, yTop, material) {
        const w = uEnd - uStart;
        const h = yTop - yBottom;
        if (w < 0.001 || h < 0.001) return new THREE.Group();

        const geom = new THREE.PlaneGeometry(w, h);
        const mesh = new THREE.Mesh(geom, material);

        // Position at center of the quad, on the wall plane
        const cx = origin.x + dirX * (uStart + w / 2) + normX * 0.001;
        const cz = origin.z + dirZ * (uStart + w / 2) + normZ * 0.001;
        const cy = yBottom + h / 2;
        mesh.position.set(cx, cy, cz);

        // Rotate to face outward along the normal
        const angle = Math.atan2(normX, normZ);
        mesh.rotation.y = angle;

        return mesh;
    },

    /**
     * Create a recessed window with glass pane and 4 reveal quads.
     */
    _makeWindowRecess(origin, dirX, dirZ, normX, normZ, uLeft, uRight, yBottom, yTop, depth, glassMat, frameMat) {
        const group = new THREE.Group();
        const w = uRight - uLeft;
        const h = yTop - yBottom;
        const angle = Math.atan2(normX, normZ);

        // Glass pane (recessed behind wall face)
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glassMat);
        const gcx = origin.x + dirX * (uLeft + w / 2) - normX * depth;
        const gcz = origin.z + dirZ * (uLeft + w / 2) - normZ * depth;
        glass.position.set(gcx, yBottom + h / 2, gcz);
        glass.rotation.y = angle;
        group.add(glass);

        // Reveal quads (top, bottom, left, right sides of the recess)
        // Top reveal
        const topReveal = new THREE.Mesh(new THREE.PlaneGeometry(w, depth), frameMat);
        topReveal.position.set(
            origin.x + dirX * (uLeft + w / 2) - normX * depth / 2,
            yTop,
            origin.z + dirZ * (uLeft + w / 2) - normZ * depth / 2
        );
        topReveal.rotation.y = angle;
        topReveal.rotation.x = Math.PI / 2;
        group.add(topReveal);

        // Bottom reveal (sill)
        const botReveal = new THREE.Mesh(new THREE.PlaneGeometry(w, depth), frameMat);
        botReveal.position.set(
            origin.x + dirX * (uLeft + w / 2) - normX * depth / 2,
            yBottom,
            origin.z + dirZ * (uLeft + w / 2) - normZ * depth / 2
        );
        botReveal.rotation.y = angle;
        botReveal.rotation.x = -Math.PI / 2;
        group.add(botReveal);

        // Left reveal
        const leftReveal = new THREE.Mesh(new THREE.PlaneGeometry(depth, h), frameMat);
        leftReveal.position.set(
            origin.x + dirX * uLeft - normX * depth / 2,
            yBottom + h / 2,
            origin.z + dirZ * uLeft - normZ * depth / 2
        );
        leftReveal.rotation.y = angle + Math.PI / 2;
        group.add(leftReveal);

        // Right reveal
        const rightReveal = new THREE.Mesh(new THREE.PlaneGeometry(depth, h), frameMat);
        rightReveal.position.set(
            origin.x + dirX * uRight - normX * depth / 2,
            yBottom + h / 2,
            origin.z + dirZ * uRight - normZ * depth / 2
        );
        rightReveal.rotation.y = angle - Math.PI / 2;
        group.add(rightReveal);

        return group;
    },

    /**
     * Create a door recess (opening with frame, no glass).
     */
    _makeDoorRecess(origin, dirX, dirZ, normX, normZ, uLeft, uRight, yBottom, yTop, depth, frameMat) {
        const group = new THREE.Group();
        const w = uRight - uLeft;
        const h = yTop - yBottom;
        const angle = Math.atan2(normX, normZ);

        // Top frame
        const topFrame = new THREE.Mesh(new THREE.PlaneGeometry(w, depth), frameMat);
        topFrame.position.set(
            origin.x + dirX * (uLeft + w / 2) - normX * depth / 2,
            yTop,
            origin.z + dirZ * (uLeft + w / 2) - normZ * depth / 2
        );
        topFrame.rotation.y = angle;
        topFrame.rotation.x = Math.PI / 2;
        group.add(topFrame);

        // Left frame
        const leftFrame = new THREE.Mesh(new THREE.PlaneGeometry(depth, h), frameMat);
        leftFrame.position.set(
            origin.x + dirX * uLeft - normX * depth / 2,
            yBottom + h / 2,
            origin.z + dirZ * uLeft - normZ * depth / 2
        );
        leftFrame.rotation.y = angle + Math.PI / 2;
        group.add(leftFrame);

        // Right frame
        const rightFrame = new THREE.Mesh(new THREE.PlaneGeometry(depth, h), frameMat);
        rightFrame.position.set(
            origin.x + dirX * uRight - normX * depth / 2,
            yBottom + h / 2,
            origin.z + dirZ * uRight - normZ * depth / 2
        );
        rightFrame.rotation.y = angle - Math.PI / 2;
        group.add(rightFrame);

        return group;
    },

    /**
     * Build a floor plate (thin slab of the footprint shape).
     */
    _buildFloorPlate(localPts, height, thickness, material) {
        const shape = new THREE.Shape();
        shape.moveTo(localPts[0].x, -localPts[0].z); // Three.js Shape is in XY
        for (let i = 1; i < localPts.length; i++) {
            shape.lineTo(localPts[i].x, -localPts[i].z);
        }
        shape.closePath();

        const geom = new THREE.ExtrudeGeometry(shape, {
            depth: thickness,
            bevelEnabled: false
        });

        const mesh = new THREE.Mesh(geom, material);
        // ExtrudeGeometry extrudes along Z in shape space; rotate to Y-up
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = height;

        return mesh;
    },

    /**
     * Build a parapet (short wall segments around the roof perimeter).
     */
    _buildParapet(localPts, roofHeight, parapetHeight, wallMat) {
        const group = new THREE.Group();

        for (let i = 0; i < localPts.length; i++) {
            const p1 = localPts[i];
            const p2 = localPts[(i + 1) % localPts.length];

            const dx = p2.x - p1.x;
            const dz = p2.z - p1.z;
            const len = Math.sqrt(dx * dx + dz * dz);
            const dirX = dx / len;
            const dirZ = dz / len;
            const normX = -dirZ;
            const normZ = dirX;

            // Outer face
            group.add(this._makeWallQuad(
                p1, dirX, dirZ, normX, normZ,
                0, len, roofHeight, roofHeight + parapetHeight,
                wallMat
            ));

            // Inner face
            group.add(this._makeWallQuad(
                p1, dirX, dirZ, -normX, -normZ,
                0, len, roofHeight, roofHeight + parapetHeight,
                wallMat
            ));
        }

        return group;
    },

    /**
     * Build a pitched roof on the footprint.
     * Uses the oriented bounding box to determine ridge direction.
     */
    _buildRoof(localPts, roofBase, roofType, pitchDeg, roofMat, wallMat) {
        const group = new THREE.Group();
        const pitchRad = pitchDeg * Math.PI / 180;

        // Compute oriented bounding box
        const obb = this._computeOBB(localPts);
        // obb: { center, halfW, halfH, angle, axisU:{x,z}, axisV:{x,z} }
        // axisU = along the longer dimension (ridge direction)
        // axisV = across the shorter dimension (slope direction)

        const ridgeHeight = obb.halfH * Math.tan(pitchRad);

        if (roofType === 'gable') {
            // Ridge line runs along axisU at center, elevated by ridgeHeight
            // Two sloped planes (left and right of ridge)
            // Two triangular gable walls at each end

            const ridgeStart = {
                x: obb.center.x - obb.axisU.x * obb.halfW,
                z: obb.center.z - obb.axisU.z * obb.halfW
            };
            const ridgeEnd = {
                x: obb.center.x + obb.axisU.x * obb.halfW,
                z: obb.center.z + obb.axisU.z * obb.halfW
            };

            // 4 eave corners
            const corners = this._obbCorners(obb);
            // corners: [front-left, front-right, back-right, back-left]
            // front = -axisU end, back = +axisU end
            // left = -axisV side, right = +axisV side

            const ry = roofBase + ridgeHeight;

            // Left slope (corners 0,3 at eave, ridge above)
            this._addTriangle(group,
                { x: corners[0].x, y: roofBase, z: corners[0].z },
                { x: ridgeStart.x, y: ry, z: ridgeStart.z },
                { x: corners[3].x, y: roofBase, z: corners[3].z },
                roofMat);
            this._addTriangle(group,
                { x: corners[3].x, y: roofBase, z: corners[3].z },
                { x: ridgeStart.x, y: ry, z: ridgeStart.z },
                { x: ridgeEnd.x, y: ry, z: ridgeEnd.z },
                roofMat);
            this._addTriangle(group,
                { x: corners[3].x, y: roofBase, z: corners[3].z },
                { x: ridgeEnd.x, y: ry, z: ridgeEnd.z },
                { x: corners[0].x, y: roofBase, z: corners[0].z },
                roofMat);

            // Right slope (corners 1,2 at eave, ridge above)
            this._addTriangle(group,
                { x: corners[1].x, y: roofBase, z: corners[1].z },
                { x: corners[2].x, y: roofBase, z: corners[2].z },
                { x: ridgeStart.x, y: ry, z: ridgeStart.z },
                roofMat);
            this._addTriangle(group,
                { x: corners[2].x, y: roofBase, z: corners[2].z },
                { x: ridgeEnd.x, y: ry, z: ridgeEnd.z },
                { x: ridgeStart.x, y: ry, z: ridgeStart.z },
                roofMat);
            this._addTriangle(group,
                { x: corners[2].x, y: roofBase, z: corners[2].z },
                { x: corners[1].x, y: roofBase, z: corners[1].z },
                { x: ridgeEnd.x, y: ry, z: ridgeEnd.z },
                roofMat);

            // Gable wall triangles (front and back ends)
            // Front gable (corners 0, 1, ridgeStart)
            this._addTriangle(group,
                { x: corners[0].x, y: roofBase, z: corners[0].z },
                { x: corners[1].x, y: roofBase, z: corners[1].z },
                { x: ridgeStart.x, y: ry, z: ridgeStart.z },
                wallMat);
            // Back gable (corners 3, 2, ridgeEnd)
            this._addTriangle(group,
                { x: corners[3].x, y: roofBase, z: corners[3].z },
                { x: ridgeEnd.x, y: ry, z: ridgeEnd.z },
                { x: corners[2].x, y: roofBase, z: corners[2].z },
                wallMat);

        } else if (roofType === 'hip') {
            // All four sides slope inward. Ridge is shorter than the building.
            const corners = this._obbCorners(obb);
            const ry = roofBase + ridgeHeight;

            // Ridge inset from ends
            const ridgeInset = Math.min(obb.halfH, obb.halfW * 0.8);
            const ridgeStart = {
                x: obb.center.x - obb.axisU.x * (obb.halfW - ridgeInset),
                z: obb.center.z - obb.axisU.z * (obb.halfW - ridgeInset)
            };
            const ridgeEnd = {
                x: obb.center.x + obb.axisU.x * (obb.halfW - ridgeInset),
                z: obb.center.z + obb.axisU.z * (obb.halfW - ridgeInset)
            };

            // Left slope (2 triangles forming a trapezoid: corners 0,3 at eave, ridge above)
            this._addTriangle(group,
                { x: corners[0].x, y: roofBase, z: corners[0].z },
                { x: ridgeStart.x, y: ry, z: ridgeStart.z },
                { x: ridgeEnd.x, y: ry, z: ridgeEnd.z },
                roofMat);
            this._addTriangle(group,
                { x: corners[0].x, y: roofBase, z: corners[0].z },
                { x: ridgeEnd.x, y: ry, z: ridgeEnd.z },
                { x: corners[3].x, y: roofBase, z: corners[3].z },
                roofMat);

            // Right slope
            this._addTriangle(group,
                { x: corners[1].x, y: roofBase, z: corners[1].z },
                { x: ridgeEnd.x, y: ry, z: ridgeEnd.z },
                { x: ridgeStart.x, y: ry, z: ridgeStart.z },
                roofMat);
            this._addTriangle(group,
                { x: corners[1].x, y: roofBase, z: corners[1].z },
                { x: corners[2].x, y: roofBase, z: corners[2].z },
                { x: ridgeEnd.x, y: ry, z: ridgeEnd.z },
                roofMat);

            // Front hip triangle (corners 0, 1, ridgeStart)
            this._addTriangle(group,
                { x: corners[0].x, y: roofBase, z: corners[0].z },
                { x: corners[1].x, y: roofBase, z: corners[1].z },
                { x: ridgeStart.x, y: ry, z: ridgeStart.z },
                roofMat);

            // Back hip triangle (corners 3, 2, ridgeEnd)
            this._addTriangle(group,
                { x: corners[3].x, y: roofBase, z: corners[3].z },
                { x: ridgeEnd.x, y: ry, z: ridgeEnd.z },
                { x: corners[2].x, y: roofBase, z: corners[2].z },
                roofMat);

        } else if (roofType === 'shed') {
            // Single slope: one side stays at roofBase, opposite rises
            const corners = this._obbCorners(obb);
            const shedHeight = obb.halfH * 2 * Math.tan(pitchRad);
            const highY = roofBase + shedHeight;

            // Low edge: corners 0,3 (left side), High edge: corners 1,2 (right side)
            // Two triangles forming a sloped quad
            this._addTriangle(group,
                { x: corners[0].x, y: roofBase, z: corners[0].z },
                { x: corners[1].x, y: highY, z: corners[1].z },
                { x: corners[2].x, y: highY, z: corners[2].z },
                roofMat);
            this._addTriangle(group,
                { x: corners[0].x, y: roofBase, z: corners[0].z },
                { x: corners[2].x, y: highY, z: corners[2].z },
                { x: corners[3].x, y: roofBase, z: corners[3].z },
                roofMat);

            // Triangular walls on front and back ends
            this._addTriangle(group,
                { x: corners[0].x, y: roofBase, z: corners[0].z },
                { x: corners[1].x, y: roofBase, z: corners[1].z },
                { x: corners[1].x, y: highY, z: corners[1].z },
                wallMat);
            this._addTriangle(group,
                { x: corners[3].x, y: roofBase, z: corners[3].z },
                { x: corners[2].x, y: highY, z: corners[2].z },
                { x: corners[2].x, y: roofBase, z: corners[2].z },
                wallMat);
        }

        return group;
    },

    /**
     * Compute oriented bounding box of local footprint points.
     * Returns {center, halfW, halfH, angle, axisU, axisV}
     * axisU = along longer axis, axisV = along shorter axis
     */
    _computeOBB(pts) {
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;

        let bestAngle = 0, bestArea = Infinity, bestW = 0, bestH = 0;
        for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            const edx = pts[j].x - pts[i].x;
            const edz = pts[j].z - pts[i].z;
            const angle = Math.atan2(edz, edx);
            const cosA = Math.cos(-angle), sinA = Math.sin(-angle);
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for (const p of pts) {
                const px = p.x - cx, pz = p.z - cz;
                const rx = px * cosA - pz * sinA;
                const rz = px * sinA + pz * cosA;
                if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
                if (rz < minZ) minZ = rz; if (rz > maxZ) maxZ = rz;
            }
            const area = (maxX - minX) * (maxZ - minZ);
            if (area < bestArea) {
                bestArea = area;
                bestAngle = angle;
                bestW = (maxX - minX) / 2;
                bestH = (maxZ - minZ) / 2;
            }
        }

        // Ensure W is the longer dimension (ridge runs along W)
        let axisU = { x: Math.cos(bestAngle), z: Math.sin(bestAngle) };
        let axisV = { x: -Math.sin(bestAngle), z: Math.cos(bestAngle) };
        let halfW = bestW, halfH = bestH;

        if (halfH > halfW) {
            // Swap so U is always the longer axis
            [halfW, halfH] = [halfH, halfW];
            [axisU, axisV] = [axisV, { x: -axisU.x, z: -axisU.z }];
        }

        return { center: { x: cx, z: cz }, halfW, halfH, axisU, axisV };
    },

    /**
     * Get 4 corners of the OBB.
     * Returns [front-left, front-right, back-right, back-left]
     * where front = -axisU end, left = -axisV side
     */
    _obbCorners(obb) {
        const { center, halfW, halfH, axisU, axisV } = obb;
        return [
            { x: center.x - axisU.x * halfW - axisV.x * halfH, z: center.z - axisU.z * halfW - axisV.z * halfH },
            { x: center.x - axisU.x * halfW + axisV.x * halfH, z: center.z - axisU.z * halfW + axisV.z * halfH },
            { x: center.x + axisU.x * halfW + axisV.x * halfH, z: center.z + axisU.z * halfW + axisV.z * halfH },
            { x: center.x + axisU.x * halfW - axisV.x * halfH, z: center.z + axisU.z * halfW - axisV.z * halfH },
        ];
    },

    /**
     * Add a single triangle (2 faces for DoubleSide) to a group.
     */
    _addTriangle(group, a, b, c, material) {
        const geom = new THREE.BufferGeometry();
        const vertices = new Float32Array([
            a.x, a.y, a.z,
            b.x, b.y, b.z,
            c.x, c.y, c.z
        ]);
        geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geom.computeVertexNormals();
        group.add(new THREE.Mesh(geom, material));
    },

    /**
     * Convert lat/lng footprint to local XZ coordinates in meters.
     * Centered at centroid, Y-up (Y is height).
     */
    _footprintToLocal(footprint) {
        const centLat = footprint.reduce((s, p) => s + p.lat, 0) / footprint.length;
        const centLng = footprint.reduce((s, p) => s + p.lng, 0) / footprint.length;
        const cosLat = Math.cos(centLat * Math.PI / 180);
        const DEG_TO_M = 111000;

        // X = east (longitude), Z = south (negative latitude)
        // glTF convention: -Z is forward (north), so we negate lat offset
        return footprint.map(p => ({
            x: (p.lng - centLng) * cosLat * DEG_TO_M,
            z: -(p.lat - centLat) * DEG_TO_M
        }));
    },

    /**
     * Check if polygon is clockwise (in XZ plane, Y-up).
     */
    _isClockwise(pts) {
        let sum = 0;
        for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            sum += (pts[j].x - pts[i].x) * (pts[j].z + pts[i].z);
        }
        return sum > 0;
    },

    /**
     * Export a Three.js scene to GLB and return a blob URL.
     */
    async _exportToGLB(scene) {
        const exporter = new GLTFExporter();
        const glb = await exporter.parseAsync(scene, { binary: true });
        const blob = new Blob([glb], { type: 'model/gltf-binary' });
        return URL.createObjectURL(blob);
    }
};

// Expose globally for non-module scripts
window.BuildingGenerator = BuildingGenerator;
window.dispatchEvent(new Event('building-generator-ready'));
console.log('BuildingGenerator module loaded successfully (Three.js r' + THREE.REVISION + ')');
