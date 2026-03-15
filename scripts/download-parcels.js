#!/usr/bin/env node
/**
 * Download Edmonton parcel boundaries from the City's ArcGIS MapServer,
 * tile them into a spatial grid, and output GeoJSON files for R2 upload.
 *
 * Usage:
 *   node scripts/download-parcels.js
 *
 * Output:
 *   edmonton-3d-viewer/data/parcels/  — tiled GeoJSON files
 *   e.g. parcels_53.520_-113.510.geojson (0.005° grid ≈ 550m × 335m)
 *
 * Then upload to R2:
 *   npx wrangler r2 object put edmonton-viewer/parcels/parcels_53.520_-113.510.geojson \
 *     --file edmonton-3d-viewer/data/parcels/parcels_53.520_-113.510.geojson
 *
 * Or bulk upload:
 *   for f in edmonton-3d-viewer/data/parcels/*.geojson; do
 *     name=$(basename "$f")
 *     npx wrangler r2 object put "edmonton-viewer/parcels/$name" --file "$f"
 *   done
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ArcGIS REST endpoint — Layer 21 = Parcels
const BASE_URL = 'https://gis.edmonton.ca/site1/rest/services/Overlay_Public/Common_Layers/MapServer/21/query';

// Edmonton bounding box (approximate city limits)
const EDMONTON_BOUNDS = {
    south: 53.39,
    north: 53.72,
    west: -113.72,
    east: -113.27
};

// Tile grid size in degrees (0.005° ≈ 550m lat × 335m lng at Edmonton's latitude)
const TILE_SIZE = 0.005;

// ArcGIS max records per request
const PAGE_SIZE = 1000;

// Output directory
const OUT_DIR = path.join(__dirname, '..', 'edmonton-3d-viewer', 'data', 'parcels');

function fetch(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`JSON parse error: ${e.message}\n${data.slice(0, 200)}`));
                }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function fetchParcels(south, west, north, east, offset = 0) {
    const envelope = `${west},${south},${east},${north}`;
    const params = new URLSearchParams({
        where: '1=1',
        geometry: envelope,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        outSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'OBJECTID',
        returnGeometry: 'true',
        f: 'geojson',
        resultRecordCount: String(PAGE_SIZE),
        resultOffset: String(offset)
    });

    return await fetch(`${BASE_URL}?${params}`);
}

function tileKey(lat, lng) {
    const tLat = (Math.floor(lat / TILE_SIZE) * TILE_SIZE).toFixed(3);
    const tLng = (Math.floor(lng / TILE_SIZE) * TILE_SIZE).toFixed(3);
    return `${tLat}_${tLng}`;
}

function featureCentroid(feature) {
    const coords = feature.geometry.type === 'MultiPolygon'
        ? feature.geometry.coordinates[0][0]
        : feature.geometry.coordinates[0];
    let sumLng = 0, sumLat = 0;
    for (const [lng, lat] of coords) {
        sumLng += lng;
        sumLat += lat;
    }
    return { lat: sumLat / coords.length, lng: sumLng / coords.length };
}

async function downloadArea(south, west, north, east) {
    const features = [];
    let offset = 0;
    while (true) {
        const geojson = await fetchParcels(south, west, north, east, offset);
        const batch = geojson.features || [];
        features.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
        // Small delay to be polite
        await new Promise(r => setTimeout(r, 200));
    }
    return features;
}

async function main() {
    console.log('Edmonton Parcel Downloader');
    console.log('=========================');
    console.log(`Bounds: ${JSON.stringify(EDMONTON_BOUNDS)}`);
    console.log(`Tile size: ${TILE_SIZE}° (≈${(TILE_SIZE * 111000).toFixed(0)}m × ${(TILE_SIZE * 111000 * Math.cos(53.5 * Math.PI / 180)).toFixed(0)}m)`);

    // Create output directory
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // We'll query in strips (chunks of latitude) to avoid overwhelming the server
    const QUERY_SIZE = 0.02; // ~2.2km strips
    const tiles = {}; // tileKey -> [features]
    let totalFeatures = 0;

    const { south, north, west, east } = EDMONTON_BOUNDS;

    for (let lat = south; lat < north; lat += QUERY_SIZE) {
        for (let lng = west; lng < east; lng += QUERY_SIZE) {
            const qSouth = lat;
            const qNorth = Math.min(lat + QUERY_SIZE, north);
            const qWest = lng;
            const qEast = Math.min(lng + QUERY_SIZE, east);

            process.stdout.write(`\rFetching [${qSouth.toFixed(3)}, ${qWest.toFixed(3)}] → [${qNorth.toFixed(3)}, ${qEast.toFixed(3)}]...`);

            try {
                const features = await downloadArea(qSouth, qWest, qNorth, qEast);
                totalFeatures += features.length;
                process.stdout.write(` ${features.length} parcels (total: ${totalFeatures})`);

                // Assign features to tiles
                for (const feat of features) {
                    if (!feat.geometry) continue;
                    const center = featureCentroid(feat);
                    const key = tileKey(center.lat, center.lng);
                    if (!tiles[key]) tiles[key] = [];
                    tiles[key].push(feat);
                }
            } catch (e) {
                process.stdout.write(` ERROR: ${e.message}`);
            }

            // Rate limiting
            await new Promise(r => setTimeout(r, 100));
        }
        console.log(); // newline after each strip
    }

    // Write tile files
    console.log(`\nWriting ${Object.keys(tiles).length} tile files...`);
    let written = 0;
    for (const [key, features] of Object.entries(tiles)) {
        const filename = `parcels_${key}.geojson`;
        const geojson = {
            type: 'FeatureCollection',
            features: features
        };
        fs.writeFileSync(path.join(OUT_DIR, filename), JSON.stringify(geojson));
        written++;
    }

    // Write tile index
    const index = Object.keys(tiles).map(key => {
        const [lat, lng] = key.split('_').map(Number);
        return { key, lat, lng, count: tiles[key].length };
    });
    fs.writeFileSync(
        path.join(OUT_DIR, 'index.json'),
        JSON.stringify({ tileSize: TILE_SIZE, tiles: index })
    );

    console.log(`Done! ${written} tile files, ${totalFeatures} total parcels`);
    console.log(`Output: ${OUT_DIR}`);
    console.log(`\nNext: upload to R2 with:`);
    console.log(`  for f in ${OUT_DIR}/*.geojson ${OUT_DIR}/index.json; do`);
    console.log(`    name=$(basename "$f")`);
    console.log(`    npx wrangler r2 object put "edmonton-viewer/parcels/$name" --file "$f"`);
    console.log(`  done`);
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
