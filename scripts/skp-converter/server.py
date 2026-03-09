"""
SKP → GLB Conversion Service (FastAPI)

Pipeline:
    1. Receive .skp upload
    2. Generate Ruby export script from template
    3. Run SketchUp 8 via xvfb-run + wine → produces .dae
    4. Run Blender headless → converts .dae → .glb
    5. Return .glb

SketchUp 8 (2012, free) can read SKP files up to version 2013 (v13).
Newer SKP files (2014+, versions 14–24) will fail with a clear error.
"""

import os
import re
import shutil
import struct
import subprocess
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

app = FastAPI(title="SKP Converter", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://tphambolio.github.io",
        "http://localhost:*",
        "http://127.0.0.1:*",
    ],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ── Config ───────────────────────────────────────────────────────────────────

MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
SKETCHUP_TIMEOUT = 180  # seconds — SketchUp 8 under Wine can be slow
BLENDER_TIMEOUT = 120

SKETCHUP_EXE = os.environ.get(
    "SKETCHUP_EXE",
    r"C:\Program Files\Google\Google SketchUp 8\SketchUp.exe",
)
BLENDER_BIN = os.environ.get("BLENDER_BIN", "blender")
RUBY_TEMPLATE = Path(__file__).parent / "scripts" / "skp_export.tmpl.rb"
if not RUBY_TEMPLATE.exists():
    RUBY_TEMPLATE = Path(__file__).parent / "skp_export.tmpl.rb"
BLENDER_SCRIPT = Path(__file__).parent / "scripts" / "blender_dae_to_glb.py"
if not BLENDER_SCRIPT.exists():
    BLENDER_SCRIPT = Path(__file__).parent / "blender_dae_to_glb.py"

# SketchUp 8 supports SKP file versions up to 13 (SketchUp 2013).
# Version 14+ (SketchUp 2014 through 2024) are NOT supported.
MAX_SKP_VERSION = 13

# ── SKP version detection ───────────────────────────────────────────────────

# SKP version mapping (file format version → SketchUp release)
SKP_VERSION_MAP = {
    3: "SketchUp 3", 4: "SketchUp 4", 5: "SketchUp 5",
    6: "SketchUp 6", 7: "SketchUp 7", 8: "SketchUp 8",
    13: "SketchUp 2013", 14: "SketchUp 2014", 15: "SketchUp 2015",
    16: "SketchUp 2016", 17: "SketchUp 2017", 18: "SketchUp 2018",
    19: "SketchUp 2019", 20: "SketchUp 2020", 21: "SketchUp 2021",
    22: "SketchUp 2022", 23: "SketchUp 2023", 24: "SketchUp 2024",
    25: "SketchUp 2025",
}


def detect_skp_version(filepath: str) -> dict:
    """
    Read the SKP file header to detect the format version.

    SKP files start with a text header like:
        {0xff\x00}SketchUp Model\n{binary data with version}

    The version number is embedded in the header as a string or can be
    found in the first ~100 bytes.
    """
    info = {"version": None, "release": "Unknown", "supported": False}

    try:
        with open(filepath, "rb") as f:
            header = f.read(256)

        # Look for version pattern in header text
        # SKP headers contain version info in various formats
        header_text = header.decode("latin-1", errors="replace")

        # Pattern 1: "SketchUp Model" followed by version data
        # The version number is typically in the binary portion
        # Try to find version string like "{ff 00}SketchUp Model"
        if "SketchUp Model" not in header_text:
            # Not a valid SKP file
            info["version"] = -1
            info["release"] = "Not a SketchUp file"
            return info

        # The file format version is typically encoded in bytes after the header
        # Try common offsets where version appears
        # In modern SKP files, search for version pattern
        version_match = re.search(
            rb'\{(\d+)\.\d+\.\d+\}', header
        )
        if version_match:
            info["version"] = int(version_match.group(1))
        else:
            # Fallback: scan for version-like integers after the header
            # The version is often a 32-bit int after the text header
            for offset in range(32, min(len(header) - 4, 200)):
                val = struct.unpack_from("<I", header, offset)[0]
                if 3 <= val <= 30:  # Reasonable SKP version range
                    info["version"] = val
                    break

        if info["version"] is not None:
            info["release"] = SKP_VERSION_MAP.get(
                info["version"], f"Version {info['version']}"
            )
            info["supported"] = info["version"] <= MAX_SKP_VERSION

    except Exception as e:
        info["release"] = f"Error reading file: {e}"

    return info


# ── Conversion pipeline ─────────────────────────────────────────────────────


def linux_to_wine_path(linux_path: str) -> str:
    """Convert a Linux path to a Wine Z: drive path."""
    return "Z:" + linux_path.replace("/", "\\")


def run_sketchup_export(skp_path: str, dae_path: str) -> dict:
    """
    Run SketchUp 8 under Wine+Xvfb to export SKP → DAE.

    1. Generate Ruby script from template
    2. Launch: xvfb-run wine SketchUp.exe -RubyStartup script.rb
    3. Wait for DAE output or timeout
    """
    tmpdir = os.path.dirname(skp_path)

    # Generate Ruby script from template
    template = RUBY_TEMPLATE.read_text()
    script = template.replace(
        "__IMPORT_FILE__", linux_to_wine_path(skp_path)
    ).replace(
        "__EXPORT_FILE__", linux_to_wine_path(dae_path)
    )

    script_path = os.path.join(tmpdir, "export_script.rb")
    with open(script_path, "w") as f:
        f.write(script)

    wine_script_path = linux_to_wine_path(script_path)

    # Run SketchUp under xvfb-run + wine
    cmd = [
        "timelimit", "-p",
        f"-T{SKETCHUP_TIMEOUT + 60}",
        f"-t{SKETCHUP_TIMEOUT}",
        "xvfb-run", "-a",
        "-s", "-screen 0 1280x800x24",
        "wine", SKETCHUP_EXE,
        "-RubyStartup", wine_script_path,
    ]

    print(f"Running: {' '.join(cmd)}")
    start = time.time()

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=SKETCHUP_TIMEOUT + 120,  # generous outer timeout
        env={
            **os.environ,
            "WINEDEBUG": "-all",
            "DISPLAY": "",  # xvfb-run manages this
        },
    )

    elapsed = time.time() - start

    # Wait for wineserver to clean up
    try:
        subprocess.run(
            ["wineserver", "-w"],
            timeout=30,
            capture_output=True,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    return {
        "returncode": result.returncode,
        "elapsed": elapsed,
        "stdout": result.stdout[-1000:] if result.stdout else "",
        "stderr": result.stderr[-1000:] if result.stderr else "",
        "dae_exists": os.path.isfile(dae_path),
        "dae_size": os.path.getsize(dae_path) if os.path.isfile(dae_path) else 0,
    }


def run_blender_convert(dae_path: str, glb_path: str) -> dict:
    """Run Blender headless to convert DAE → GLB."""
    cmd = [
        BLENDER_BIN,
        "--background",
        "--python", str(BLENDER_SCRIPT),
        "--",
        dae_path,
        glb_path,
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=BLENDER_TIMEOUT,
    )

    return {
        "returncode": result.returncode,
        "stdout": result.stdout[-500:] if result.stdout else "",
        "stderr": result.stderr[-500:] if result.stderr else "",
        "glb_exists": os.path.isfile(glb_path),
        "glb_size": os.path.getsize(glb_path) if os.path.isfile(glb_path) else 0,
    }


# ── Endpoints ────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    # Check SketchUp exists in Wine prefix
    wine_prefix = os.environ.get("WINEPREFIX", os.path.expanduser("~/.wine"))
    su_path = os.path.join(
        wine_prefix,
        "drive_c/Program Files/Google/Google SketchUp 8/SketchUp.exe",
    )
    su_ok = os.path.isfile(su_path)

    # Check Blender
    try:
        r = subprocess.run(
            [BLENDER_BIN, "--version"],
            capture_output=True, text=True, timeout=10,
        )
        blender_version = r.stdout.strip().split("\n")[0]
    except Exception as e:
        blender_version = f"error: {e}"

    return {
        "status": "ok" if su_ok else "degraded",
        "sketchup": "available" if su_ok else "missing",
        "sketchup_path": su_path,
        "blender": blender_version,
        "max_skp_version": MAX_SKP_VERSION,
        "max_skp_release": SKP_VERSION_MAP.get(MAX_SKP_VERSION, "Unknown"),
        "max_file_size_mb": MAX_FILE_SIZE // (1024 * 1024),
        "pipeline": "SKP → DAE (SketchUp 8 / Wine) → GLB (Blender)",
    }


@app.post("/convert/skp")
async def convert_skp(file: UploadFile = File(...)):
    """
    Convert a SketchUp .skp file to GLB.

    Pipeline: SKP → DAE (SketchUp 8 via Wine) → GLB (Blender)

    Returns the GLB file directly. Errors return JSON with details.
    """
    # Validate filename
    if not file.filename:
        raise HTTPException(400, detail="Empty filename")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext != ".skp":
        raise HTTPException(
            400,
            detail={
                "error": f"Expected .skp file, got {ext}",
                "hint": "For OBJ/FBX/STL, use the Blender conversion service.",
            },
        )

    # Read file
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            413,
            detail=f"File too large: {len(content)/1024/1024:.1f}MB "
                   f"(max {MAX_FILE_SIZE // (1024*1024)}MB)",
        )

    # Create temp directory for this conversion
    tmpdir = tempfile.mkdtemp(prefix="skp_convert_")
    try:
        skp_path = os.path.join(tmpdir, "input.skp")
        dae_path = os.path.join(tmpdir, "input.dae")
        glb_path = os.path.join(tmpdir, "output.glb")

        # Write uploaded file
        with open(skp_path, "wb") as f:
            f.write(content)

        # Check SKP version
        version_info = detect_skp_version(skp_path)
        print(f"SKP version: {version_info}")

        if version_info["version"] == -1:
            raise HTTPException(
                400,
                detail="Not a valid SketchUp file. The file header does not "
                       "contain the SketchUp signature.",
            )

        if version_info["version"] is not None and not version_info["supported"]:
            raise HTTPException(
                422,
                detail={
                    "error": "SKP file version too new for SketchUp 8",
                    "file_version": version_info["version"],
                    "file_release": version_info["release"],
                    "max_supported": f"Version {MAX_SKP_VERSION} "
                                     f"({SKP_VERSION_MAP.get(MAX_SKP_VERSION)})",
                    "hint": "Please save-as an older version in SketchUp, or "
                            "export to OBJ/DAE/GLB from SketchUp directly.",
                },
            )

        file_size = len(content)
        print(f"Converting {file.filename} ({file_size/1024:.0f} KB, "
              f"{version_info['release']})...")

        # Step 1: SKP → DAE via SketchUp 8 + Wine
        su_result = run_sketchup_export(skp_path, dae_path)
        print(f"SketchUp result: rc={su_result['returncode']}, "
              f"elapsed={su_result['elapsed']:.1f}s, "
              f"dae_exists={su_result['dae_exists']}, "
              f"dae_size={su_result['dae_size']}")

        if not su_result["dae_exists"] or su_result["dae_size"] == 0:
            detail = "SketchUp failed to produce DAE output."
            if su_result["returncode"] in (128 + 9, 128 + 15):
                detail = (f"SketchUp timed out after {SKETCHUP_TIMEOUT}s. "
                          "The model may be too complex.")
            raise HTTPException(
                422,
                detail={
                    "error": detail,
                    "sketchup_returncode": su_result["returncode"],
                    "stderr": su_result["stderr"][-300:],
                },
            )

        # Step 2: DAE → GLB via Blender
        bl_result = run_blender_convert(dae_path, glb_path)
        print(f"Blender result: rc={bl_result['returncode']}, "
              f"glb_exists={bl_result['glb_exists']}, "
              f"glb_size={bl_result['glb_size']}")

        if not bl_result["glb_exists"] or bl_result["glb_size"] == 0:
            raise HTTPException(
                422,
                detail={
                    "error": "Blender failed to convert DAE to GLB",
                    "blender_returncode": bl_result["returncode"],
                    "stderr": bl_result["stderr"][-300:],
                },
            )

        # Return GLB
        base = os.path.splitext(file.filename)[0]
        return FileResponse(
            glb_path,
            media_type="model/gltf-binary",
            filename=f"{base}.glb",
            headers={"Content-Disposition": f'inline; filename="{base}.glb"'},
        )

    except HTTPException:
        raise
    except subprocess.TimeoutExpired:
        raise HTTPException(504, detail="Conversion timed out")
    except Exception as e:
        print(f"Conversion error: {e}")
        raise HTTPException(500, detail=str(e))
    finally:
        # Clean up after response is sent (FastAPI handles this)
        # Note: FileResponse reads the file before cleanup, so we use
        # a background task for cleanup
        pass


@app.on_event("shutdown")
def cleanup():
    """Clean up any leftover temp directories."""
    import glob
    for d in glob.glob(tempfile.gettempdir() + "/skp_convert_*"):
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    import uvicorn
    import argparse

    parser = argparse.ArgumentParser(description="SKP Conversion Service")
    parser.add_argument("--port", type=int, default=5001)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    print(f"SKP Converter starting on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)
