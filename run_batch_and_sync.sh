#!/bin/bash
# Run batch tree extraction and periodically sync new GLBs to Cloudflare R2.
# Usage: ./run_batch_and_sync.sh

set -e
cd "$(dirname "$0")"

TILE_DIR="edmonton-3d-viewer/data/tree_tiles"
RCLONE="$HOME/bin/rclone"
REMOTE="r2:edmonton-tree-tiles"
SYNC_INTERVAL=300  # sync every 5 minutes

export GODEBUG=tlsrsakex=1

# Start the sync loop in the background
sync_loop() {
    while true; do
        sleep "$SYNC_INTERVAL"
        echo ""
        echo "=== SYNCING to R2 $(date) ==="
        "$RCLONE" copy "$TILE_DIR/" "$REMOTE/" \
            --include "*.glb" --include "*.json" \
            --transfers 8 --checkers 16 \
            --stats-one-line --stats 0 \
            2>&1 | tail -3
        echo "=== SYNC DONE ==="
    done
}

sync_loop &
SYNC_PID=$!

# Cleanup sync loop on exit
trap "kill $SYNC_PID 2>/dev/null; wait $SYNC_PID 2>/dev/null" EXIT

echo "Starting batch extraction (sync every ${SYNC_INTERVAL}s, PID $SYNC_PID)"
echo ""

# Run the batch processor
python3 batch_extract_trees.py --all

echo ""
echo "=== Batch complete. Running final sync... ==="
"$RCLONE" copy "$TILE_DIR/" "$REMOTE/" \
    --include "*.glb" --include "*.json" \
    --transfers 8 --checkers 16 \
    --progress \
    2>&1

echo ""
echo "=== ALL DONE ==="
