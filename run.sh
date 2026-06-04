#!/usr/bin/env bash

# Exit on error
set -e

# Change to the directory of the script
cd "$(dirname "$0")"

# Ensure Python 3 is available
if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: python3 is not installed or not in PATH."
    exit 1
fi

echo "Starting Turbli GPS server..."
python3 server.py "$@"
