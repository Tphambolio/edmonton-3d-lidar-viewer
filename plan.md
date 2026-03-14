# Custom Building Tool — Implementation Plan

## Overview

Add a "Custom Building" tool that lets users draw a building footprint directly on the map and specify dimensions (width, depth, height, number of storeys) to create a parametric 3D building — no external model needed.

Currently, the app only supports **replacing** existing buildings with pre-made or uploaded 3D models. This new tool lets users **create buildings from scratch** at any location on the map.

## Current Architecture

- **Stack**: Vanilla JS + CesiumJS 1.120, no build tools
- **Pattern**: Module objects (`Buildings`, `Trees`, `Geocoder`) with methods
- **Rendering**: CesiumJS polygon extrusion for buildings, GLB models for replacements
- **UI**: Single left panel (`#searchPanel`) with controls, dark glassmorphism theme

## Implementation Plan

### Step 1: Create `js/building-tool.js` — Core Module

New module `BuildingTool` that manages the custom building creation workflow.

**State machine with 3 modes:**
1. **`idle`** — Tool not active
2. **`drawing`** — User is clicking points on the map to define the footprint polygon
3. **`configuring`** — Footprint is complete, user adjusts dimensions in a form

**Data model per custom building:**
```js
{
    id: string,           // unique ID (e.g., "custom_1")
    footprint: [{lat, lng}],  // polygon vertices (user-clicked points)
    width: number,        // auto-calculated from footprint (meters)
    depth: number,        // auto-calculated from footprint (meters)
    height: number,       // total height in meters (user input or storeys × 3.5)
    storeys: number,      // number of storeys (user input)
    roofType: string,     // "flat" (v1 — keep it simple)
    color: string,        // hex color for the building
    entity: CesiumEntity  // the rendered Cesium entity
}
```

**Key methods:**
- `activate()` / `deactivate()` — enter/exit drawing mode, swap click handler
- `addPoint(cartesian)` — add vertex to footprint polygon, update preview polyline
- `completeFootprint()` — close the polygon, calculate dimensions, show config panel
- `createBuilding(options)` — extrude the polygon as a CesiumJS entity
- `updateBuilding(id, options)` — live-update height/color when user adjusts sliders
- `deleteBuilding(id)` — remove a custom building
- `getFootprintDimensions(points)` — calculate width/depth via oriented bounding box (reuse `Buildings`' min-area OBB logic)

**Drawing interaction:**
- Left-click: add vertex (shown as small point entity)
- Double-click or "Done" button: close polygon
- Right-click: undo last vertex
- Live preview: dashed polyline connecting placed vertices + cursor position
- Minimum 3 vertices required

**Rendering:**
- Uses `Cesium.PolygonGraphics` with `extrudedHeight` (same approach as existing buildings)
- Terrain-clamped base height via `Buildings.getTerrainHeight()`
- Different default color (e.g., light blue with 0.8 alpha) to distinguish from SODA buildings

### Step 2: Add UI to `index.html`

Add a new collapsible section in `#searchPanel` below the existing "Replace Building Model" section:

```
┌─────────────────────────────┐
│ Custom Building Tool        │
│                             │
│ [Draw Building] [Cancel]    │
│                             │
│ (when drawing:)             │
│ Click map to place corners. │
│ Double-click to finish.     │
│ Points: 3  [Undo] [Done]   │
│                             │
│ (when configuring:)         │
│ Width:  14.2m (calculated)  │
│ Depth:  24.0m (calculated)  │
│ Height: ══════════ 12m      │
│ Storeys: [1] [2] [3] [4+]  │
│ Color:  [■ picker]          │
│ [Create Building] [Reset]   │
│                             │
│ Custom Buildings: 2         │
│ [List / manage...]          │
└─────────────────────────────┘
```

**UI elements:**
- **"Draw Building" button** — activates drawing mode, changes cursor to crosshair
- **Point counter + Undo** — shown during drawing
- **"Done" button** — completes the footprint (alternative to double-click)
- **Height slider** — range 3–100m, default based on storey count
- **Storey quick-select buttons** — 1/2/3/4/5/6+, sets height to storeys × 3.5m
- **Width & Depth display** — auto-calculated, read-only (from the oriented bounding box of the drawn polygon)
- **Color picker** — small input[type=color] for building color
- **"Create Building"** — finalizes and renders the building
- **"Reset"** — clears drawn footprint and starts over
- **Custom building list** — count + ability to click to fly-to or delete

### Step 3: Add Styles to `css/style.css`

Following the existing dark glassmorphism pattern:
- `.building-tool` section — same styling as `.upload-section`
- `.building-tool button.active` — highlighted state when drawing mode is on (e.g., green/teal accent)
- `.building-tool .dimension-display` — read-only dimension boxes
- `.building-tool .storey-btns` — horizontal button group for storey selection
- `.drawing-hint` — pulsing/highlighted instruction text during drawing mode
- Cursor override: `crosshair` on `#cesiumContainer` when in drawing mode

### Step 4: Wire Up in `app.js`

- Import and initialize `BuildingTool` in `init()`
- Add event listeners in `setupUI()` for all new UI elements
- Modify the existing click handler to route clicks to `BuildingTool.addPoint()` when in drawing mode (instead of building selection)
- Add double-click handler for completing the footprint
- Add right-click handler for undo during drawing
- Update `updateStats()` to include custom building count
- Ensure custom buildings persist across `loadScene()` calls (don't clear them when reloading SODA buildings)

### Step 5: Interactive Editing (post-creation)

After a custom building is created, clicking it should:
- Select it and show its properties in the info box (same pattern as SODA buildings)
- Re-enable the height slider and storey buttons to edit dimensions live
- Allow deletion via a "Delete" button
- Show width/depth/height/area in the info panel

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `js/building-tool.js` | **New** | Core module — drawing, configuration, rendering |
| `index.html` | **Edit** | Add Custom Building Tool UI section + script tag |
| `css/style.css` | **Edit** | Add styles for new UI elements |
| `js/app.js` | **Edit** | Wire up events, modify click handler, init tool |

## Technical Considerations

- **No new dependencies** — pure CesiumJS APIs (PolygonGraphics, PolylineGraphics, PointGraphics, ScreenSpaceEventHandler)
- **Reuse OBB logic** from `Buildings` for width/depth calculation (refactor into shared utility or call directly)
- **Terrain height** — sample at footprint centroid using existing `Buildings.getTerrainHeight()`
- **Conflict with existing click handler** — when drawing mode is active, intercept clicks before they reach the building-selection handler
- **Double-click** — CesiumJS fires both LEFT_CLICK and LEFT_DOUBLE_CLICK; need to debounce so the last point isn't added twice
- **Live preview** — use a `CallbackProperty` for the polyline positions so it updates as the mouse moves without creating/destroying entities
