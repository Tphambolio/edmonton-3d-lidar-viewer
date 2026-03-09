"""
Blender Python script: convert DAE (COLLADA) to GLB.

Usage:
    blender --background --python blender_dae_to_glb.py -- input.dae output.glb

Centers the model at origin with Z base at 0, converts to meters.
"""

import bpy
import sys
import os


def parse_args():
    argv = sys.argv
    if '--' in argv:
        argv = argv[argv.index('--') + 1:]
    else:
        argv = []
    if len(argv) < 2:
        print("Usage: blender --background --python blender_dae_to_glb.py -- input.dae output.glb")
        sys.exit(1)
    return argv[0], argv[1]


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)


def center_and_ground():
    import mathutils
    bpy.ops.object.select_all(action='SELECT')
    objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not objects:
        print('WARNING: No mesh objects found after import')
        return

    all_coords = []
    for obj in objects:
        for corner in obj.bound_box:
            all_coords.append(obj.matrix_world @ mathutils.Vector(corner))

    if not all_coords:
        return

    center = sum(all_coords, mathutils.Vector()) / len(all_coords)
    z_min = min(v.z for v in all_coords)

    offset = mathutils.Vector((-center.x, -center.y, -z_min))
    for obj in objects:
        obj.location += offset

    bbox_size = (
        max(v.x for v in all_coords) - min(v.x for v in all_coords),
        max(v.y for v in all_coords) - min(v.y for v in all_coords),
        max(v.z for v in all_coords) - min(v.z for v in all_coords),
    )
    print(f'Model size: {bbox_size[0]:.2f} x {bbox_size[1]:.2f} x {bbox_size[2]:.2f}')


def main():
    input_path, output_path = parse_args()
    print(f'Converting: {input_path} -> {output_path}')

    clear_scene()

    # Import COLLADA
    bpy.ops.wm.collada_import(filepath=input_path)

    center_and_ground()

    # Export GLB
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        use_selection=False,
        export_apply=True,
    )

    size_kb = os.path.getsize(output_path) / 1024
    print(f'Export complete: {output_path} ({size_kb:.1f} KB)')


if __name__ == '__main__':
    main()
