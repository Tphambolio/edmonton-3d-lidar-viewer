#!/usr/bin/env python3
"""
3D Model Conversion Service — converts SKP, OBJ, FBX, etc. to GLB via Blender.

Usage:
    python3 convert_service.py              # Start on port 5000
    python3 convert_service.py --port 8090  # Custom port

API:
    POST /convert   multipart file upload → GLB binary response
    GET  /health    service status check
"""

import os
import sys
import shutil
import subprocess
import tempfile
import argparse
from flask import Flask, request, send_file, jsonify
from flask_cors import CORS

app = Flask(__name__)

# CORS — allow the GitHub Pages viewer
CORS(app, resources={
    r'/convert': {
        'origins': [
            'https://tphambolio.github.io',
            'http://localhost:*',
            'http://127.0.0.1:*',
        ]
    }
})

# Config
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB
BLENDER_TIMEOUT = 120  # seconds
BLENDER_BIN = shutil.which('blender') or os.path.expanduser('~/opt/blender-4.3.2-linux-x64/blender')
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BLENDER_SCRIPT = os.path.join(SCRIPT_DIR, 'blender_convert.py')

SUPPORTED_EXTENSIONS = {'.obj', '.fbx', '.dae', '.3ds', '.stl', '.ply', '.usd'}
NATIVE_EXTENSIONS = {'.glb', '.gltf'}
# SKP requires SketchUp SDK (proprietary) — tell user to export as OBJ/GLB from SketchUp
SKP_MESSAGE = 'SketchUp (.skp) files cannot be converted directly. Please export as OBJ or GLB from SketchUp (File → Export → 3D Model).'


def get_blender_version():
    """Get Blender version string."""
    try:
        result = subprocess.run(
            [BLENDER_BIN, '--version'],
            capture_output=True, text=True, timeout=10
        )
        # First line: "Blender X.Y.Z"
        return result.stdout.strip().split('\n')[0]
    except Exception as e:
        return f'error: {e}'


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'blender': get_blender_version(),
        'supported_formats': sorted(SUPPORTED_EXTENSIONS),
        'max_file_size_mb': MAX_FILE_SIZE // (1024 * 1024),
    })


@app.route('/convert', methods=['POST'])
def convert():
    # Check file present
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    if not file.filename:
        return jsonify({'error': 'Empty filename'}), 400

    # Check extension
    ext = os.path.splitext(file.filename)[1].lower()
    if ext in NATIVE_EXTENSIONS:
        # Pass through GLB/glTF without conversion
        return send_file(file.stream, mimetype='model/gltf-binary',
                         download_name=file.filename)

    if ext == '.skp':
        return jsonify({'error': SKP_MESSAGE}), 400

    if ext not in SUPPORTED_EXTENSIONS:
        return jsonify({
            'error': f'Unsupported format: {ext}',
            'supported': sorted(SUPPORTED_EXTENSIONS)
        }), 400

    # Check file size
    file.seek(0, 2)
    size = file.tell()
    file.seek(0)
    if size > MAX_FILE_SIZE:
        return jsonify({
            'error': f'File too large: {size / 1024 / 1024:.1f}MB (max {MAX_FILE_SIZE // (1024 * 1024)}MB)'
        }), 413

    # Convert in temp directory
    tmpdir = tempfile.mkdtemp(prefix='convert_')
    try:
        input_path = os.path.join(tmpdir, f'input{ext}')
        output_path = os.path.join(tmpdir, 'output.glb')

        file.save(input_path)
        print(f'Converting {file.filename} ({size / 1024:.0f} KB) ...')

        # Run Blender headless
        cmd = [
            BLENDER_BIN,
            '--background',
            '--python', BLENDER_SCRIPT,
            '--',
            '--input', input_path,
            '--output', output_path,
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=BLENDER_TIMEOUT,
        )

        if result.returncode != 0:
            error_msg = result.stderr or result.stdout or 'Unknown error'
            # Trim to last 500 chars for readability
            if len(error_msg) > 500:
                error_msg = '...' + error_msg[-500:]
            print(f'Conversion failed: {error_msg}', file=sys.stderr)
            return jsonify({'error': 'Conversion failed', 'details': error_msg}), 422

        if not os.path.exists(output_path):
            return jsonify({'error': 'Conversion produced no output'}), 422

        output_size = os.path.getsize(output_path)
        print(f'Conversion OK: {file.filename} -> {output_size / 1024:.0f} KB GLB')

        # Build download filename
        base = os.path.splitext(file.filename)[0]
        return send_file(
            output_path,
            mimetype='model/gltf-binary',
            download_name=f'{base}.glb',
            as_attachment=False,
        )

    except subprocess.TimeoutExpired:
        return jsonify({'error': f'Conversion timed out ({BLENDER_TIMEOUT}s)'}), 504

    except Exception as e:
        print(f'Conversion error: {e}', file=sys.stderr)
        return jsonify({'error': str(e)}), 500

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='3D Model Conversion Service')
    parser.add_argument('--port', type=int, default=5000)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()

    print(f'Blender: {get_blender_version()}')
    print(f'Supported: {", ".join(sorted(SUPPORTED_EXTENSIONS))}')
    print(f'Listening on {args.host}:{args.port}')
    app.run(host=args.host, port=args.port, debug=False)
