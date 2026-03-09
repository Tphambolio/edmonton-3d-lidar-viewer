#!/bin/sh
# Wait for a Wine process to finish (from docker-skp2dae by Jan Suchotzki)
[ $# -lt 2 ] && echo "Usage: $0 USER PROCESS-NAMES..." >&2 && exit 1
USER="$1"
shift
echo "Waiting for $@ to finish..."
while pgrep -u "$USER" "$@" > /dev/null; do
    sleep 1
done
echo "$@ completed"
