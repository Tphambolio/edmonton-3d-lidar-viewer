"""
Blender Python script: convert 3D model files to GLB.

Run inside Blender's embedded Python via:
    blender --background --python blender_convert.py -- --input file.obj --output file.glb

Supports: .obj, .fbx, .dae, .3ds, .stl, .ply, .usd
SKP (SketchUp) is NOT supported — users should export to OBJ or GLB from SketchUp.
"""

import bpy
import sys
import os
import argparse


def parse_args():
    """Parse arguments after the '--' separator."""
    argv = sys.argv
    if '--' in argv:
        argv = argv[argv.index('--') + 1:]
    else:
        argv = []
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    return parser.parse_args(argv)


def clear_scene():
    """Remove all default objects."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)


def import_file(filepath):
    """Import a 3D file based on extension."""
    ext = os.path.splitext(filepath)[1].lower()

    if ext == '.obj':
        bpy.ops.wm.obj_import(filepath=filepath)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=filepath)
    elif ext == '.dae':
        bpy.ops.wm.collada_import(filepath=filepath)
    elif ext == '.3ds':
        bpy.ops.import_scene.autodesk_3ds(filepath=filepath)
    elif ext == '.stl':
        bpy.ops.wm.stl_import(filepath=filepath)
    elif ext == '.ply':
        bpy.ops.wm.ply_import(filepath=filepath)
    elif ext in ('.usd', '.usda', '.usdc', '.usdz'):
        bpy.ops.wm.usd_import(filepath=filepath)
    else:
        raise RuntimeError(f'Unsupported format: {ext}')


def center_and_ground():
    """Center all imported objects at origin, base at Z=0."""
    import mathutils

    bpy.ops.object.select_all(action='SELECT')
    objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not objects:
        print('WARNING: No mesh objects found after import')
        return

    # Compute combined bounding box
    all_coords = []
    for obj in objects:
        for corner in obj.bound_box:
            all_coords.append(obj.matrix_world @ mathutils.Vector(corner))

    if not all_coords:
        return

    center = sum(all_coords, mathutils.Vector()) / len(all_coords)
    z_min = min(v.z for v in all_coords)

    # Shift so XY center is at origin and Z base is at 0
    offset = mathutils.Vector((-center.x, -center.y, -z_min))
    for obj in objects:
        obj.location += offset

    bbox_size = (
        max(v.x for v in all_coords) - min(v.x for v in all_coords),
        max(v.y for v in all_coords) - min(v.y for v in all_coords),
        max(v.z for v in all_coords) - min(v.z for v in all_coords),
    )
    print(f'Model size: {bbox_size[0]:.1f} x {bbox_size[1]:.1f} x {bbox_size[2]:.1f} m')


def export_glb(filepath):
    """Export scene as GLB."""
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format='GLB',
        use_selection=False,
        export_apply=True,
    )


def main():
    args = parse_args()
    print(f'Converting: {args.input} -> {args.output}')

    clear_scene()
    import_file(args.input)
    center_and_ground()
    export_glb(args.output)

    size_kb = os.path.getsize(args.output) / 1024
    print(f'Export complete: {args.output} ({size_kb:.1f} KB)')


if __name__ == '__main__':
    main()
