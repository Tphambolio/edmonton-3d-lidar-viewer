#!/usr/bin/env python3
"""
Generate pre-built 3D building GLB models for the Edmonton 3D Viewer.

Models match Edmonton zoning dimensions:
  - 8-Plex Residential (s-RML zoning): 14m x 18m x 12m, 3 storeys
  - 2 Skinny Houses (infill pair): 2 x 5.5m x 14m x 9m on standard lot
  - Apartment (mid-rise): 20m x 25m x 18m, 6 storeys

All models centered at origin, Z-up, dimensions in meters.
Vertex colors (no textures) for CesiumJS compatibility.
"""

import os
import numpy as np
import trimesh


def colored_box(extents, transform=None, color=None):
    """Create a box mesh with uniform vertex color."""
    mesh = trimesh.creation.box(extents=extents, transform=transform)
    if color is not None:
        mesh.visual.vertex_colors = np.tile(color, (len(mesh.vertices), 1))
    return mesh


def window_grid(face_center, face_normal, face_width, face_height,
                cols, rows, win_w, win_h, color):
    """Create a grid of window rectangles on a building face."""
    windows = []
    # Determine the tangent directions based on face normal
    normal = np.array(face_normal, dtype=float)
    up = np.array([0, 0, 1], dtype=float)
    right = np.cross(up, normal)
    if np.linalg.norm(right) < 0.01:
        right = np.array([1, 0, 0], dtype=float)
    right = right / np.linalg.norm(right)

    for row in range(rows):
        for col in range(cols):
            # Evenly space windows
            cx = (col - (cols - 1) / 2) * (face_width / (cols + 1))
            cz = (row - (rows - 1) / 2) * (face_height / (rows + 1))
            pos = np.array(face_center) + right * cx + up * cz
            # Thin box protruding slightly from face
            T = trimesh.transformations.translation_matrix(pos)
            # Orient the window to face the same direction
            win = colored_box([win_w, 0.15, win_h], transform=T, color=color)
            # Rotate window to align with face
            if abs(face_normal[0]) > 0.5:
                # X-facing wall
                win = colored_box([0.15, win_w, win_h], transform=T, color=color)
            windows.append(win)
    return windows


def generate_8plex(output_path):
    """Generate an 8-plex residential building (s-RML zoning)."""
    parts = []

    # Colors
    stucco = [200, 184, 154, 255]       # #C8B89A warm stucco
    accent = [160, 148, 128, 255]       # darker accent for floor bands
    dark = [58, 58, 68, 255]            # #3A3A44 windows
    overhang_c = [140, 130, 115, 255]   # entrance overhang
    parapet_c = [120, 115, 105, 255]    # roof parapet

    W, D, H = 14.0, 24.0, 12.0  # width (X), depth (Y), height (Z)

    # Main body
    T = trimesh.transformations.translation_matrix([0, 0, H / 2])
    parts.append(colored_box([W, D, H], transform=T, color=stucco))

    # Floor band strips at 4m and 8m
    for z in [4.0, 8.0]:
        T = trimesh.transformations.translation_matrix([0, 0, z])
        parts.append(colored_box([W + 0.05, D + 0.05, 0.2], transform=T, color=accent))

    # Roof parapet (0.4m tall, inset 0.3m)
    T = trimesh.transformations.translation_matrix([0, 0, H + 0.2])
    parts.append(colored_box([W - 0.6, D - 0.6, 0.4], transform=T, color=parapet_c))

    # Entrance overhang (front face, Y = -D/2)
    T = trimesh.transformations.translation_matrix([0, -D / 2 - 0.5, 3.2])
    parts.append(colored_box([3.0, 1.5, 0.25], transform=T, color=overhang_c))

    # Windows — front face (Y = -D/2)
    for storey in range(3):
        z_base = storey * 4.0 + 2.5  # window center height per storey
        for col in range(4):
            cx = (col - 1.5) * 3.0
            T = trimesh.transformations.translation_matrix([cx, -D / 2 - 0.05, z_base])
            parts.append(colored_box([1.2, 0.15, 1.6], transform=T, color=dark))

    # Windows — back face (Y = +D/2)
    for storey in range(3):
        z_base = storey * 4.0 + 2.5
        for col in range(4):
            cx = (col - 1.5) * 3.0
            T = trimesh.transformations.translation_matrix([cx, D / 2 + 0.05, z_base])
            parts.append(colored_box([1.2, 0.15, 1.6], transform=T, color=dark))

    # Windows — side faces (X = ±W/2)
    for side in [-1, 1]:
        for storey in range(3):
            z_base = storey * 4.0 + 2.5
            for col in range(3):
                cy = (col - 1.0) * 4.5
                T = trimesh.transformations.translation_matrix([side * (W / 2 + 0.05), cy, z_base])
                parts.append(colored_box([0.15, 1.2, 1.6], transform=T, color=dark))

    mesh = trimesh.util.concatenate(parts)
    # Convert Z-up (trimesh) to Y-up (glTF spec) — rotate -90° around X axis
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    mesh.export(output_path, file_type='glb')
    print(f"  8-Plex: {os.path.getsize(output_path) / 1024:.1f} KB  ({len(mesh.vertices)} verts, {len(mesh.faces)} faces)")


def generate_skinny_houses(output_path):
    """Generate a pair of skinny infill houses on a standard lot."""
    parts = []

    # Colors
    siding = [212, 197, 169, 255]    # #D4C5A9 light beige
    siding2 = [188, 178, 160, 255]   # slightly different for house B
    roof_c = [90, 90, 90, 255]       # #5A5A5A dark gray shingle
    dark = [58, 58, 68, 255]         # windows
    step_c = [160, 155, 145, 255]    # concrete porch step
    door_c = [80, 60, 45, 255]       # door

    # Based on real Edmonton skinny houses at 10915/10917 127 St:
    # Each house: ~6.5m frontage × 18m deep × 9.3m tall
    house_w = 6.5   # street frontage per house (X)
    house_d = 18.0  # depth into lot (Y)
    wall_h = 7.5    # wall height (Z)
    gable_h = 2.0   # gable peak above walls (total ~9.5m)
    gap = 1.2       # between houses (0.6m setback each side)

    for i, (x_off, siding_color) in enumerate([
        (-(house_w + gap) / 2, siding),
        ((house_w + gap) / 2, siding2),
    ]):
        # Main box (walls)
        T = trimesh.transformations.translation_matrix([x_off, 0, wall_h / 2])
        parts.append(colored_box([house_w, house_d, wall_h], transform=T, color=siding_color))

        # Gable roof — triangular prism
        # Create a triangular cross-section in XZ, extruded along Y
        from shapely.geometry import Polygon as ShapelyPolygon
        half_w = house_w / 2
        roof_profile = ShapelyPolygon([
            (-half_w - 0.3, 0),       # left eave overhang
            (0, gable_h),              # peak
            (half_w + 0.3, 0),         # right eave overhang
        ])
        roof_mesh = trimesh.creation.extrude_polygon(roof_profile, house_d + 0.6)
        # The extrusion goes along Z by default; we need it along Y
        # Rotate 90 degrees around X to align extrusion with Y
        R = trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])
        roof_mesh.apply_transform(R)
        # Translate to correct position
        T = trimesh.transformations.translation_matrix([x_off, -(house_d + 0.6) / 2, wall_h])
        roof_mesh.apply_transform(T)
        roof_mesh.visual.vertex_colors = np.tile(roof_c, (len(roof_mesh.vertices), 1))
        parts.append(roof_mesh)

        # Front porch step
        T = trimesh.transformations.translation_matrix([x_off, -house_d / 2 - 0.75, 0.15])
        parts.append(colored_box([2.0, 1.5, 0.3], transform=T, color=step_c))

        # Front door
        T = trimesh.transformations.translation_matrix([x_off, -house_d / 2 - 0.05, 1.2])
        parts.append(colored_box([1.0, 0.15, 2.2], transform=T, color=door_c))

        # Front windows — 2 per storey, 2 storeys
        storey_heights = [2.8, 5.5]  # window centers well above ground
        for z_base in storey_heights:
            for col in [-1, 1]:
                cx = x_off + col * 1.5
                T = trimesh.transformations.translation_matrix([cx, -house_d / 2 - 0.05, z_base])
                parts.append(colored_box([0.9, 0.15, 1.2], transform=T, color=dark))

        # Side windows — 3 per storey per side
        for side in [-1, 1]:
            for z_base in storey_heights:
                for col in range(3):
                    cy = (col - 1.0) * 3.5
                    T = trimesh.transformations.translation_matrix([
                        x_off + side * (house_w / 2 + 0.05), cy, z_base
                    ])
                    parts.append(colored_box([0.15, 0.9, 1.2], transform=T, color=dark))

    mesh = trimesh.util.concatenate(parts)
    # Convert Z-up (trimesh) to Y-up (glTF spec) — rotate -90° around X axis
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    mesh.export(output_path, file_type='glb')
    print(f"  Skinny Houses: {os.path.getsize(output_path) / 1024:.1f} KB  ({len(mesh.vertices)} verts, {len(mesh.faces)} faces)")


def generate_apartment(output_path):
    """Generate a mid-rise apartment building (6-storey)."""
    parts = []

    # Colors
    body_c = [136, 153, 170, 255]    # #8899AA steel blue-gray
    band_c = [115, 130, 145, 255]    # floor band darker
    dark = [58, 58, 68, 255]         # windows
    pent_c = [100, 100, 110, 255]    # mechanical penthouse

    W, D, H = 20.0, 30.0, 18.0  # 6 storeys at 3m each
    storey_h = 3.0

    # Main body
    T = trimesh.transformations.translation_matrix([0, 0, H / 2])
    parts.append(colored_box([W, D, H], transform=T, color=body_c))

    # Floor bands at each storey
    for s in range(1, 6):
        z = s * storey_h
        T = trimesh.transformations.translation_matrix([0, 0, z])
        parts.append(colored_box([W + 0.05, D + 0.05, 0.15], transform=T, color=band_c))

    # Mechanical penthouse
    T = trimesh.transformations.translation_matrix([0, 0, H + 1.0])
    parts.append(colored_box([5.0, 5.0, 2.0], transform=T, color=pent_c))

    # Windows — front and back faces
    for face_y, sign in [(-D / 2 - 0.05, -1), (D / 2 + 0.05, 1)]:
        for storey in range(6):
            z_base = storey * storey_h + storey_h / 2 + 0.3
            for col in range(6):
                cx = (col - 2.5) * 3.0
                T = trimesh.transformations.translation_matrix([cx, face_y, z_base])
                parts.append(colored_box([1.4, 0.15, 1.8], transform=T, color=dark))

    # Windows — side faces
    for face_x in [-W / 2 - 0.05, W / 2 + 0.05]:
        for storey in range(6):
            z_base = storey * storey_h + storey_h / 2 + 0.3
            for col in range(7):
                cy = (col - 3.0) * 3.2
                T = trimesh.transformations.translation_matrix([face_x, cy, z_base])
                parts.append(colored_box([0.15, 1.4, 1.8], transform=T, color=dark))

    mesh = trimesh.util.concatenate(parts)
    # Convert Z-up (trimesh) to Y-up (glTF spec) — rotate -90° around X axis
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    mesh.export(output_path, file_type='glb')
    print(f"  Apartment: {os.path.getsize(output_path) / 1024:.1f} KB  ({len(mesh.vertices)} verts, {len(mesh.faces)} faces)")


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models')
    os.makedirs(out_dir, exist_ok=True)

    print("Generating building models...")
    generate_8plex(os.path.join(out_dir, '8plex.glb'))
    generate_skinny_houses(os.path.join(out_dir, 'skinny_houses.glb'))
    generate_apartment(os.path.join(out_dir, 'apartment.glb'))
    print(f"\nModels written to {out_dir}/")


if __name__ == '__main__':
    main()
