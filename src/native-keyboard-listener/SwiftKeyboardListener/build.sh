#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/build"
EXECUTABLE="$OUTPUT_DIR/SwiftKeyboardListener"

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "Building SwiftKeyboardListener..."

# Compile the Swift source
# Using swiftc to compile into an executable
swiftc \
    -o "$EXECUTABLE" \
    "$SCRIPT_DIR/Sources/main.swift" \
    -framework CoreFoundation \
    -framework CoreGraphics \
    -O

echo "Built successfully at: $EXECUTABLE"

# Verify the executable exists
if [ -f "$EXECUTABLE" ]; then
    echo "✓ SwiftKeyboardListener executable created"
else
    echo "✗ Failed to create executable"
    exit 1
fi