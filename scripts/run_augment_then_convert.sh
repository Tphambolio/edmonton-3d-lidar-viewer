#!/bin/bash
# Chain: wait for augmentation to finish, then batch-convert all GLBs to OBJ
# Usage: bash scripts/run_augment_then_convert.sh

set -e
cd "$(dirname "$0")/.."

echo "=== Step 1: Waiting for augment_index.py ==="
echo "(If already running in another process, this will run a second copy - check first!)"

# Check if augmentation is already done
AUGMENTED=$(python3 -c "
import json
with open('edmonton-3d-viewer/data/tree_tiles/index.json') as f:
    tiles = json.load(f)['tiles']
aug = sum(1 for t in tiles.values() if 'cx_3776' in t)
print(aug)
")

echo "Currently $AUGMENTED / 3135 tiles augmented"

if [ "$AUGMENTED" -lt 3100 ]; then
    echo "Augmentation not complete yet. Waiting..."
    # Poll every 30s until augmentation is done
    while [ "$AUGMENTED" -lt 3100 ]; do
        sleep 30
        AUGMENTED=$(python3 -c "
import json
with open('edmonton-3d-viewer/data/tree_tiles/index.json') as f:
    tiles = json.load(f)['tiles']
aug = sum(1 for t in tiles.values() if 'cx_3776' in t)
print(aug)
")
        echo "  $(date +%H:%M:%S) - $AUGMENTED / 3135 augmented"
    done
fi

echo ""
echo "=== Step 2: Converting all GLBs to OBJ ==="
python3 scripts/glb_to_obj_converter.py --all --skip-existing

echo ""
echo "=== Done ==="
echo "OBJ files in: obj_export/"
ls obj_export/*.obj 2>/dev/null | wc -l
echo "OBJ files ready"
